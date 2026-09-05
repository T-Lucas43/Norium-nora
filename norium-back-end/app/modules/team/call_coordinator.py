"""Coordena o ciclo de vida e a sinalizacao das chamadas de equipe.

O modulo esconde as regras de chamada atras de uma interface pequena. HTTP e
WebSocket apenas adaptam transporte; persistencia, publicacao, diretorio de
membros e relogio entram por seams explicitas.
"""

from __future__ import annotations

import asyncio
import copy
import re
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Literal, Protocol

from app.modules.team.call_configuration import DEFAULT_MESH_MAX_PARTICIPANTS


CALL_ID_PATTERN = re.compile(r"call_[a-f0-9]{16,64}")
MEDIA_TRANSPORT_KINDS = frozenset({"mesh", "sfu"})
CALL_TIMEOUT = timedelta(seconds=90)
PARTICIPANT_DISCONNECT_GRACE = timedelta(seconds=8)
PARTICIPANT_HEARTBEAT_TIMEOUT = timedelta(seconds=30)
HOST_LEASE_DURATION = timedelta(seconds=35)
ENDED_CALL_RETENTION = timedelta(days=1)
CALL_REACTIONS = {"👍", "👏", "❤️", "😂", "😮", "🎉", "🙌"}
CALL_EVENT_TYPES = frozenset({
    "CALL_INVITE",
    "CALL_ACCEPT",
    "CALL_REJECT",
    "CALL_SIGNAL",
    "CALL_REACTION",
    "CALL_HAND_STATE",
    "CALL_MEDIA_STATE",
    "CALL_SCREEN_STARTED",
    "CALL_SCREEN_STOPPED",
    "CALL_LEAVE",
    "CALL_KICK",
    "CALL_END",
    "CALL_HEARTBEAT",
})
PERSISTED_EVENTS = {
    "CALL_INVITE", "CALL_ACCEPT", "CALL_LEAVE", "CALL_KICK", "CALL_HEARTBEAT", "CALL_HAND_STATE",
}


class CallError(Exception):
    """Erro de dominio que o adapter de transporte converte para seu protocolo."""

    def __init__(self, status_code: int, detail: str, *, code: str = "call_error") -> None:
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail
        self.code = code


@dataclass(frozen=True)
class CallActor:
    user_id: str
    team_id: str
    name: str
    avatar: str = ""
    attributes: dict[str, Any] = field(default_factory=dict, compare=False, repr=False)


@dataclass
class CallState:
    active_calls: list[dict[str, Any]] = field(default_factory=list)
    ended_call_ids: dict[str, str] = field(default_factory=dict)

    def clone(self) -> CallState:
        return CallState(copy.deepcopy(self.active_calls), dict(self.ended_call_ids))


class CallStateStore(Protocol):
    async def load(self, team_id: str) -> CallState: ...

    async def save(
        self,
        team_id: str,
        state: CallState,
        *,
        append_messages: tuple[dict[str, Any], ...] = (),
    ) -> None: ...


class CallEventPublisher(Protocol):
    async def send_to_users(self, team_id: str, user_ids: set[str], payload: dict[str, Any]) -> None: ...

    async def online_users(self, team_id: str) -> list[str]: ...


class TeamDirectory(Protocol):
    async def active_member_ids(self, actor: CallActor) -> set[str]: ...

    async def subteam_member_ids(self, actor: CallActor, subteam_id: str) -> set[str] | None: ...


class Clock(Protocol):
    def now(self) -> datetime: ...


class SystemClock:
    def now(self) -> datetime:
        return datetime.now(timezone.utc)


class TeamCallAuthorizer:
    """Concentra regras de equipe, conversa, participante e anfitriao."""

    def __init__(self, directory: TeamDirectory) -> None:
        self._directory = directory

    async def participants_for(
        self,
        actor: CallActor,
        scope: str,
        recipient_id: str | None,
        subteam_id: str | None,
    ) -> tuple[str, set[str]]:
        team_members = await self._directory.active_member_ids(actor)
        if scope == "team":
            return "team", team_members
        if scope == "direct":
            if not recipient_id or recipient_id not in team_members:
                raise CallError(404, "Membro da equipe nao encontrado.")
            return "direct:" + ":".join(sorted([actor.user_id, recipient_id])), {actor.user_id, recipient_id}
        if scope == "subteam":
            if not subteam_id:
                raise CallError(404, "Subequipe nao encontrada.")
            subteam_members = await self._directory.subteam_member_ids(actor, subteam_id)
            if subteam_members is None:
                raise CallError(404, "Subequipe nao encontrada.")
            if actor.user_id not in subteam_members:
                raise CallError(403, "Voce nao participa desta subequipe.")
            return f"subteam:{subteam_id}", subteam_members & team_members
        raise CallError(400, "Conversa invalida.")

    def require_participant(self, actor: CallActor, call: dict[str, Any]) -> None:
        if actor.user_id not in {str(item) for item in call.get("participantIds", [])}:
            raise CallError(403, "Voce nao participa desta conversa.")

    def require_host(self, actor: CallActor, call: dict[str, Any]) -> None:
        if str(call.get("hostUserId") or "") != actor.user_id:
            raise CallError(403, "Somente o organizador pode encerrar a reuniao.")

    async def eligible_participant_ids(self, actor: CallActor, call: dict[str, Any]) -> set[str]:
        active_members = await self._directory.active_member_ids(actor)
        eligible = {
            str(user_id)
            for user_id in call.get("participantIds", [])
            if str(user_id) in active_members
        }
        subteam_id = str(call.get("subteamId") or "")
        if str(call.get("scope") or "team") == "subteam" and subteam_id:
            subteam_members = await self._directory.subteam_member_ids(actor, subteam_id)
            eligible &= set(subteam_members or ())
        return eligible

    async def require_active_participant(self, actor: CallActor, call: dict[str, Any]) -> None:
        if actor.user_id not in await self.eligible_participant_ids(actor, call):
            raise CallError(403, "Seu acesso a esta chamada foi revogado.")


@dataclass(frozen=True)
class CallEventResult:
    direct_messages: tuple[dict[str, Any], ...] = ()


@dataclass
class _TeamRuntime:
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    loop: Any = None
    loaded: bool = False
    calls: dict[str, dict[str, Any]] = field(default_factory=dict)
    ended_call_ids: dict[str, str] = field(default_factory=dict)


@dataclass
class _Effects:
    publications: list[tuple[set[str], dict[str, Any]]] = field(default_factory=list)
    broadcast_state: bool = False

    def extend(self, other: _Effects) -> None:
        self.publications.extend(other.publications)
        self.broadcast_state = self.broadcast_state or other.broadcast_state


def parse_call_datetime(value: Any) -> datetime | None:
    try:
        parsed = datetime.fromisoformat(str(value or "").replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def active_call_for(store: dict[str, Any], call_id: str) -> dict[str, Any] | None:
    return next(
        (
            call
            for call in store.get("activeCalls", [])
            if isinstance(call, dict) and str(call.get("callId") or "") == call_id
        ),
        None,
    )


def _media_transport(call: dict[str, Any]) -> str:
    value = str(call.get("mediaTransport") or "mesh")
    return value if value in MEDIA_TRANSPORT_KINDS else "mesh"


def active_call_invite(call: dict[str, Any]) -> dict[str, Any]:
    sessions = _participant_sessions(call)
    return {
        "type": "CALL_INVITE",
        "callId": call.get("callId"),
        "scope": call.get("scope"),
        "threadId": call.get("threadId"),
        "recipientId": call.get("recipientId"),
        "subteamId": call.get("subteamId"),
        "fromUserId": call.get("hostUserId"),
        "fromUserName": call.get("hostUserName"),
        "joinedUserIds": sorted(call.get("joinedClients", {})),
        "joinedCount": len(sessions),
        "maxParticipants": int(call.get("maxParticipants") or DEFAULT_MESH_MAX_PARTICIPANTS),
        "mediaTransport": _media_transport(call),
        "raisedHands": copy.deepcopy(call.get("raisedHands", {})),
        "handRevision": int(call.get("handRevision") or 0),
        "mode": "audio",
        "startedAt": call.get("startedAt"),
        "createdAt": call.get("startedAt"),
    }


def call_message(
    call: dict[str, Any],
    sender_id: str,
    sender_name: str,
    action: Literal["call_started", "call_ended"],
    *,
    sender_avatar: str = "",
    created_at: str | None = None,
    message_id: str | None = None,
) -> dict[str, Any]:
    scope = str(call.get("scope") or "team")
    participant_ids = {str(item) for item in call.get("participantIds", []) if str(item)}
    return {
        "id": message_id or f"team_msg_{uuid.uuid4().hex}",
        "threadId": str(call.get("threadId") or "team"),
        "scope": scope,
        "senderId": sender_id,
        "senderName": sender_name,
        "senderAvatar": sender_avatar,
        "recipientId": call.get("recipientId") if scope == "direct" else None,
        "subteamId": call.get("subteamId") if scope == "subteam" else None,
        "memberIds": sorted(participant_ids) if scope == "subteam" else [],
        "text": "Iniciou uma reuniao." if action == "call_started" else "Encerrou a chamada.",
        "attachments": [],
        "metadata": {
            "action": action,
            "callId": str(call.get("callId") or ""),
            "mode": "audio",
            "readBy": {},
        },
        "createdAt": created_at or datetime.now(timezone.utc).isoformat(),
    }


def _prune_ended(ended_call_ids: dict[str, str], now: datetime) -> dict[str, str]:
    cutoff = now - ENDED_CALL_RETENTION
    return {
        str(call_id): str(ended_at)
        for call_id, ended_at in ended_call_ids.items()
        if (parsed := parse_call_datetime(ended_at)) and parsed > cutoff
    }


def _remember_ended(runtime: _TeamRuntime, call_id: str, now: datetime) -> None:
    runtime.ended_call_ids = _prune_ended(runtime.ended_call_ids, now)
    if call_id:
        runtime.ended_call_ids[call_id] = now.isoformat()


def _connection_id(actor: CallActor) -> str:
    return str(actor.attributes.get("connectionId") or "legacy")[:100]


def _participant_sessions(call: dict[str, Any]) -> dict[str, dict[str, Any]]:
    sessions = call.get("participantSessions")
    if not isinstance(sessions, dict):
        sessions = {}
        for user_id, client_id in dict(call.get("joinedClients") or {}).items():
            sessions[str(user_id)] = {
                "clientId": str(client_id or "legacy")[:100],
                "connectionId": "legacy",
                "lastHeartbeatAt": call.get("lastHeartbeatAt") or call.get("startedAt"),
                "disconnectedAt": None,
            }
        call["participantSessions"] = sessions
    return sessions


def _sync_joined_clients(call: dict[str, Any]) -> None:
    call["joinedClients"] = {
        user_id: str(session.get("clientId") or "legacy")[:100]
        for user_id, session in _participant_sessions(call).items()
        if isinstance(session, dict)
    }


def _call_ack(call: dict[str, Any], event_type: str) -> dict[str, Any]:
    invite = active_call_invite(call)
    return {
        "type": "CALL_ACK",
        "callId": invite["callId"],
        "event": event_type,
        "mediaTransport": invite["mediaTransport"],
        "joinedCount": invite["joinedCount"],
        "maxParticipants": invite["maxParticipants"],
    }


def _clear_raised_hand(call: dict[str, Any], user_id: str) -> None:
    hands = call.setdefault("raisedHands", {})
    if isinstance(hands, dict) and hands.pop(user_id, None) is not None:
        call["handRevision"] = int(call.get("handRevision") or 0) + 1


def _purge_stale_runtime(runtime: _TeamRuntime, now: datetime) -> list[dict[str, Any]]:
    cutoff = now - CALL_TIMEOUT
    retained: dict[str, dict[str, Any]] = {}
    seen_threads: set[str] = set()
    expired: list[dict[str, Any]] = []
    for call in reversed(list(runtime.calls.values())):
        heartbeat = parse_call_datetime(call.get("lastHeartbeatAt") or call.get("startedAt"))
        thread_id = str(call.get("threadId") or "")
        if not heartbeat or heartbeat < cutoff or thread_id in seen_threads:
            expired.append(call)
            _remember_ended(runtime, str(call.get("callId") or ""), now)
            continue
        seen_threads.add(thread_id)
        retained[str(call.get("callId") or "")] = call
    runtime.calls = dict(reversed(list(retained.items())))
    return expired


def purge_stale_active_calls(store: dict[str, Any], now: datetime | None = None) -> bool:
    """Compatibilidade para consumidores que operam sobre o documento legado."""

    current = now or datetime.now(timezone.utc)
    runtime = _TeamRuntime(
        loaded=True,
        calls={
            str(call.get("callId") or ""): copy.deepcopy(call)
            for call in store.get("activeCalls", [])
            if isinstance(call, dict) and str(call.get("callId") or "")
        },
        ended_call_ids=dict(store.get("endedCallIds", {})),
    )
    before = len(runtime.calls)
    expired = _purge_stale_runtime(runtime, current)
    store["activeCalls"] = list(runtime.calls.values())
    store["endedCallIds"] = runtime.ended_call_ids
    return bool(expired) or len(runtime.calls) != before


class CallCoordinator:
    """Modulo profundo para estado, regras e efeitos observaveis de chamadas."""

    def __init__(
        self,
        *,
        store: CallStateStore,
        publisher: CallEventPublisher,
        authorizer: TeamCallAuthorizer,
        clock: Clock | None = None,
        message_id_factory: Callable[[], str] | None = None,
        max_participants: int = DEFAULT_MESH_MAX_PARTICIPANTS,
        sfu_max_participants: int | None = None,
        media_transport_for_team: Callable[[str], str] | None = None,
        media_session_id_factory: Callable[[], str] | None = None,
    ) -> None:
        if max_participants < 2 or (
            sfu_max_participants is not None and sfu_max_participants < 2
        ):
            raise ValueError("limites de participantes devem ser maiores ou iguais a 2.")
        self._store = store
        self._publisher = publisher
        self._authorizer = authorizer
        self._clock = clock or SystemClock()
        self._message_id_factory = message_id_factory or (lambda: f"team_msg_{uuid.uuid4().hex}")
        self._max_participants = max_participants
        # A capacidade maior do SFU ainda nao e uma promessa de produto. Sem
        # injecao explicita, novas chamadas SFU de teste herdam o limite mesh.
        self._sfu_max_participants = (
            max_participants if sfu_max_participants is None else sfu_max_participants
        )
        self._media_transport_for_team = media_transport_for_team or (lambda _team_id: "mesh")
        self._media_session_id_factory = media_session_id_factory or (
            lambda: f"media_{uuid.uuid4().hex}"
        )
        self._teams: dict[str, _TeamRuntime] = {}

    def _new_call_transport(self, team_id: str) -> str:
        return "sfu" if self._media_transport_for_team(team_id) == "sfu" else "mesh"

    def _participant_limit(self, media_transport: str) -> int:
        return self._sfu_max_participants if media_transport == "sfu" else self._max_participants

    def _runtime(self, team_id: str) -> _TeamRuntime:
        loop = asyncio.get_running_loop()
        runtime = self._teams.get(team_id)
        if runtime is None or runtime.loop is not loop:
            runtime = _TeamRuntime(loop=loop)
            self._teams[team_id] = runtime
        return runtime

    def _now(self) -> datetime:
        value = self._clock.now()
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)

    @staticmethod
    def _validate_call_id(call_id: str) -> None:
        if not CALL_ID_PATTERN.fullmatch(call_id):
            raise CallError(400, "Identificador de chamada invalido.")

    async def _prepare_locked(
        self,
        team_id: str,
        runtime: _TeamRuntime,
        *,
        refresh: bool,
        expire: bool = True,
    ) -> _Effects:
        if refresh or not runtime.loaded:
            state = await self._store.load(team_id)
            runtime.calls = {
                str(call.get("callId") or ""): copy.deepcopy(call)
                for call in state.active_calls
                if isinstance(call, dict) and str(call.get("callId") or "")
            }
            runtime.ended_call_ids = dict(state.ended_call_ids)
            runtime.loaded = True
            for call in runtime.calls.values():
                call["mediaTransport"] = _media_transport(call)
                if not isinstance(call.get("maxParticipants"), int) or call["maxParticipants"] < 2:
                    call["maxParticipants"] = self._participant_limit(call["mediaTransport"])
                _participant_sessions(call)
                _sync_joined_clients(call)
        expired = _purge_stale_runtime(runtime, self._now()) if expire else []
        if expired:
            await self._persist_locked(team_id, runtime)
        effects = _Effects(broadcast_state=bool(expired))
        for call in expired:
            effects.publications.append((
                {str(item) for item in call.get("participantIds", [])},
                {**active_call_invite(call), "type": "CALL_END", "reason": "expired"},
            ))
        return effects

    async def _persist_locked(
        self,
        team_id: str,
        runtime: _TeamRuntime,
        *,
        messages: tuple[dict[str, Any], ...] = (),
    ) -> None:
        runtime.ended_call_ids = _prune_ended(runtime.ended_call_ids, self._now())
        await self._store.save(
            team_id,
            CallState(copy.deepcopy(list(runtime.calls.values())), dict(runtime.ended_call_ids)),
            append_messages=messages,
        )

    async def _publish(self, team_id: str, effects: _Effects) -> None:
        for recipients, payload in effects.publications:
            await self._publisher.send_to_users(team_id, recipients, payload)
        if effects.broadcast_state:
            await self.broadcast_state(team_id)

    async def _broadcast_snapshot(self, team_id: str, calls: list[dict[str, Any]]) -> None:
        for user_id in await self._publisher.online_users(team_id):
            await self._publisher.send_to_users(team_id, {user_id}, {
                "type": "CALLS_STATE",
                "calls": [active_call_invite(call) for call in calls if user_id in call.get("participantIds", [])],
            })

    async def snapshot(self, team_id: str, *, refresh: bool = False) -> list[dict[str, Any]]:
        runtime = self._runtime(team_id)
        async with runtime.lock:
            effects = await self._prepare_locked(team_id, runtime, refresh=refresh)
            calls = copy.deepcopy(list(runtime.calls.values()))
        await self._publish(team_id, effects)
        return calls

    async def active_calls_for(self, actor: CallActor, *, refresh: bool = False) -> list[dict[str, Any]]:
        calls = await self.snapshot(actor.team_id, refresh=refresh)
        return [active_call_invite(call) for call in calls if actor.user_id in call.get("participantIds", [])]

    async def recording_context(
        self,
        actor: CallActor,
        call_id: str,
        client_id: str,
        *,
        require_host: bool = True,
    ) -> dict[str, Any]:
        """Autoriza gravacao contra a chamada viva e sua sessao de cliente."""
        self._validate_call_id(call_id)
        runtime = self._runtime(actor.team_id)
        async with runtime.lock:
            effects = await self._prepare_locked(actor.team_id, runtime, refresh=True)
            call = runtime.calls.get(call_id)
            if not call:
                raise CallError(404, "Chamada ativa nao encontrada.")
            await self._authorizer.require_active_participant(actor, call)
            if require_host:
                self._authorizer.require_host(actor, call)
            session = _participant_sessions(call).get(actor.user_id)
            if not isinstance(session, dict) or str(session.get("clientId") or "") != client_id:
                raise CallError(409, "Cliente nao esta associado a chamada.")
            context = copy.deepcopy(call)
        await self._publish(actor.team_id, effects)
        return context

    async def media_context(
        self,
        actor: CallActor,
        call_id: str,
        client_id: str,
        *,
        expected_transport: str,
    ) -> dict[str, Any]:
        """Autoriza acesso a midia contra a chamada e a sessao vigentes."""
        self._validate_call_id(call_id)
        runtime = self._runtime(actor.team_id)
        async with runtime.lock:
            effects = await self._prepare_locked(actor.team_id, runtime, refresh=True)
            call = runtime.calls.get(call_id)
            if not call:
                raise CallError(404, "Chamada ativa nao encontrada.", code="call_not_found")
            await self._authorizer.require_active_participant(actor, call)
            session = _participant_sessions(call).get(actor.user_id)
            if not isinstance(session, dict) or str(session.get("clientId") or "") != client_id:
                raise CallError(
                    409,
                    "Cliente nao esta associado a chamada.",
                    code="call_session_mismatch",
                )
            if _media_transport(call) != expected_transport:
                raise CallError(
                    409,
                    "Esta chamada usa outro transporte de midia.",
                    code="call_transport_mismatch",
                )
            if not str(session.get("mediaSessionId") or ""):
                session["mediaSessionId"] = self._media_session_id_factory()
                await self._persist_locked(actor.team_id, runtime)
            context = copy.deepcopy(call)
        await self._publish(actor.team_id, effects)
        return context

    async def connection_closed(self, actor: CallActor, connection_id: str) -> None:
        if not connection_id:
            return
        runtime = self._runtime(actor.team_id)
        async with runtime.lock:
            effects = await self._prepare_locked(actor.team_id, runtime, refresh=True)
            changed = False
            disconnected_at = self._now().isoformat()
            for call in runtime.calls.values():
                session = _participant_sessions(call).get(actor.user_id)
                if isinstance(session, dict) and session.get("connectionId") == connection_id:
                    session["disconnectedAt"] = disconnected_at
                    changed = True
            if changed:
                await self._persist_locked(actor.team_id, runtime)
        await self._publish(actor.team_id, effects)

    async def reconcile(self, actor: CallActor) -> None:
        runtime = self._runtime(actor.team_id)
        async with runtime.lock:
            effects = await self._prepare_locked(actor.team_id, runtime, refresh=True)
            now = self._now()
            for call in list(runtime.calls.values()):
                sessions = _participant_sessions(call)
                eligible_users = await self._authorizer.eligible_participant_ids(actor, call)
                revoked_users = set(sessions) - eligible_users
                host_user_id = str(call.get("hostUserId") or "")
                if host_user_id in revoked_users:
                    end_effects, _ = await self._end_existing_locked(
                        actor,
                        runtime,
                        call,
                        reason="host_access_revoked",
                    )
                    effects.extend(end_effects)
                    continue
                if revoked_users:
                    for user_id in revoked_users:
                        sessions.pop(user_id, None)
                        _clear_raised_hand(call, user_id)
                    _sync_joined_clients(call)
                    await self._persist_locked(actor.team_id, runtime)
                    for user_id in revoked_users:
                        effects.publications.extend([
                            ({user_id}, {
                                **active_call_invite(call),
                                "type": "CALL_KICK",
                                "targetUserId": user_id,
                                "reason": "access_revoked",
                            }),
                            (set(sessions), {
                                **active_call_invite(call),
                                "type": "CALL_LEAVE",
                                "fromUserId": user_id,
                                "reason": "access_revoked",
                            }),
                        ])
                    effects.broadcast_state = True
                host_lease_expires_at = parse_call_datetime(call.get("hostLeaseExpiresAt"))
                if host_lease_expires_at is None:
                    host_heartbeat = parse_call_datetime(call.get("lastHeartbeatAt") or call.get("startedAt"))
                    host_lease_expires_at = host_heartbeat + HOST_LEASE_DURATION if host_heartbeat else now
                if host_lease_expires_at <= now:
                    end_effects, _ = await self._end_existing_locked(
                        actor,
                        runtime,
                        call,
                        reason="host_lease_expired",
                    )
                    effects.extend(end_effects)
                    continue
                expired_users: dict[str, str] = {}
                for user_id, session in sessions.items():
                    if not isinstance(session, dict):
                        continue
                    disconnected_at = parse_call_datetime(session.get("disconnectedAt"))
                    if disconnected_at and disconnected_at + PARTICIPANT_DISCONNECT_GRACE <= now:
                        expired_users[user_id] = "disconnected"
                        continue
                    heartbeat_at = parse_call_datetime(
                        session.get("lastHeartbeatAt") or call.get("startedAt")
                    )
                    if (
                        user_id != host_user_id
                        and heartbeat_at
                        and heartbeat_at + PARTICIPANT_HEARTBEAT_TIMEOUT <= now
                    ):
                        expired_users[user_id] = "heartbeat_expired"
                if not expired_users:
                    continue
                if host_user_id in expired_users:
                    end_effects, _ = await self._end_existing_locked(
                        actor,
                        runtime,
                        call,
                        reason="host_disconnected",
                    )
                    effects.extend(end_effects)
                    continue
                for user_id in expired_users:
                    sessions.pop(user_id, None)
                    _clear_raised_hand(call, user_id)
                _sync_joined_clients(call)
                await self._persist_locked(actor.team_id, runtime)
                for user_id in expired_users:
                    effects.publications.append((
                        set(sessions),
                        {
                            **active_call_invite(call),
                            "type": "CALL_LEAVE",
                            "fromUserId": user_id,
                            "reason": expired_users[user_id],
                        },
                    ))
                effects.broadcast_state = True
        await self._publish(actor.team_id, effects)

    async def broadcast_state(self, team_id: str) -> None:
        runtime = self._runtime(team_id)
        async with runtime.lock:
            calls = copy.deepcopy(list(runtime.calls.values()))
        await self._broadcast_snapshot(team_id, calls)

    async def end_call(self, actor: CallActor, call_id: str) -> dict[str, Any]:
        self._validate_call_id(call_id)
        runtime = self._runtime(actor.team_id)
        async with runtime.lock:
            # Encerrar explicitamente preserva a semantica historica mesmo se o
            # ultimo heartbeat ja estiver vencido; expiracao ocorre em consultas
            # e nos demais eventos.
            effects = await self._prepare_locked(actor.team_id, runtime, refresh=True, expire=False)
            call = runtime.calls.get(call_id)
            if not call:
                _remember_ended(runtime, call_id, self._now())
                await self._persist_locked(actor.team_id, runtime)
                result = {"callId": call_id, "ended": False, "deleted": True}
            else:
                await self._authorizer.require_active_participant(actor, call)
                self._authorizer.require_host(actor, call)
                end_effects, ended_message = await self._end_existing_locked(actor, runtime, call)
                effects.extend(end_effects)
                result = {"callId": call_id, "ended": True, "deleted": True}
        await self._publish(actor.team_id, effects)
        return result

    async def _end_existing_locked(
        self,
        actor: CallActor,
        runtime: _TeamRuntime,
        call: dict[str, Any],
        *,
        reason: str | None = None,
    ) -> tuple[_Effects, dict[str, Any]]:
        call_id = str(call.get("callId") or "")
        runtime.calls.pop(call_id, None)
        now = self._now()
        _remember_ended(runtime, call_id, now)
        message_actor = actor
        if reason:
            message_actor = CallActor(
                user_id=str(call.get("hostUserId") or actor.user_id),
                team_id=actor.team_id,
                name=str(call.get("hostUserName") or actor.name),
            )
        ended_message = call_message(
            call,
            message_actor.user_id,
            message_actor.name,
            "call_ended",
            sender_avatar=message_actor.avatar,
            created_at=now.isoformat(),
            message_id=self._message_id_factory(),
        )
        await self._persist_locked(actor.team_id, runtime, messages=(ended_message,))
        recipients = {str(item) for item in call.get("participantIds", [])}
        return _Effects(
            publications=[
                (recipients, {
                    **active_call_invite(call),
                    "type": "CALL_END",
                    **({"reason": reason} if reason else {}),
                }),
                (recipients, {"type": "TEAM_CHAT_MESSAGE", "message": ended_message}),
            ],
            broadcast_state=True,
        ), ended_message

    async def handle_event(self, actor: CallActor, payload: dict[str, Any]) -> CallEventResult:
        event_type = str(payload.get("type") or "")
        call_id = str(payload.get("callId") or "")
        if event_type not in CALL_EVENT_TYPES:
            raise CallError(400, "Evento de chamada invalido.")
        self._validate_call_id(call_id)
        if event_type == "CALL_END":
            await self.end_call(actor, call_id)
            return CallEventResult(({"type": "CALL_ACK", "callId": call_id, "event": event_type},))

        runtime = self._runtime(actor.team_id)
        direct: list[dict[str, Any]] = []
        async with runtime.lock:
            effects = await self._prepare_locked(
                actor.team_id,
                runtime,
                refresh=event_type in PERSISTED_EVENTS,
            )
            if call_id in runtime.ended_call_ids:
                direct.append({"type": "CALL_END", "callId": call_id, "fromUserId": actor.user_id})
            elif event_type == "CALL_INVITE":
                invite_effects, invite_direct = await self._invite_locked(actor, runtime, payload)
                effects.extend(invite_effects)
                direct.extend(invite_direct)
            else:
                call = runtime.calls.get(call_id)
                if not call:
                    direct.append({"type": "CALL_END", "callId": call_id, "fromUserId": actor.user_id})
                else:
                    self._authorizer.require_participant(actor, call)
                    if event_type != "CALL_SIGNAL":
                        await self._authorizer.require_active_participant(actor, call)
                    event_effects, event_direct = await self._route_existing_locked(actor, runtime, call, payload)
                    effects.extend(event_effects)
                    direct.extend(event_direct)
        await self._publish(actor.team_id, effects)
        return CallEventResult(tuple(direct))

    async def _invite_locked(
        self,
        actor: CallActor,
        runtime: _TeamRuntime,
        payload: dict[str, Any],
    ) -> tuple[_Effects, list[dict[str, Any]]]:
        call_id = str(payload.get("callId") or "")
        scope = str(payload.get("scope") or "team")
        recipient_id = str(payload.get("recipientId") or "") or None
        subteam_id = str(payload.get("subteamId") or "") or None
        thread_id, participants = await self._authorizer.participants_for(
            actor, scope, recipient_id, subteam_id,
        )
        existing = next((item for item in runtime.calls.values() if item.get("threadId") == thread_id), None)
        if existing:
            return _Effects(), [{
                **active_call_invite(existing),
                "type": "CALL_ACTIVE",
                "requestedCallId": call_id,
            }]
        now = self._now().isoformat()
        client_id = str(payload.get("clientId") or "legacy")[:100]
        media_transport = self._new_call_transport(actor.team_id)
        call = {
            "callId": call_id,
            "scope": scope,
            "threadId": thread_id,
            "recipientId": recipient_id,
            "subteamId": subteam_id,
            "participantIds": sorted(participants),
            "maxParticipants": self._participant_limit(media_transport),
            "mediaTransport": media_transport,
            "joinedClients": {actor.user_id: client_id},
            "participantSessions": {
                actor.user_id: {
                    "clientId": client_id,
                    "connectionId": _connection_id(actor),
                    "mediaSessionId": self._media_session_id_factory(),
                    "lastHeartbeatAt": now,
                    "disconnectedAt": None,
                },
            },
            "raisedHands": {},
            "handRevision": 0,
            "hostUserId": actor.user_id,
            "hostUserName": actor.name,
            "startedAt": now,
            "lastHeartbeatAt": now,
            "hostLeaseExpiresAt": (self._now() + HOST_LEASE_DURATION).isoformat(),
        }
        runtime.calls[call_id] = call
        started_message = call_message(
            call,
            actor.user_id,
            actor.name,
            "call_started",
            sender_avatar=actor.avatar,
            created_at=now,
            message_id=self._message_id_factory(),
        )
        await self._persist_locked(actor.team_id, runtime, messages=(started_message,))
        event = self._event_payload(call, actor, payload)
        effects = _Effects(
            publications=[
                ({actor.user_id}, {
                    "type": "CALL_SESSION",
                    "callId": call_id,
                    "clientId": client_id,
                    "fromUserId": actor.user_id,
                }),
                (participants - {actor.user_id}, event),
                (participants, {"type": "TEAM_CHAT_MESSAGE", "message": started_message}),
            ],
            broadcast_state=True,
        )
        return effects, [_call_ack(call, "CALL_INVITE")]

    async def _route_existing_locked(
        self,
        actor: CallActor,
        runtime: _TeamRuntime,
        call: dict[str, Any],
        payload: dict[str, Any],
    ) -> tuple[_Effects, list[dict[str, Any]]]:
        event_type = str(payload.get("type") or "")
        call_id = str(call.get("callId") or "")
        client_id = str(payload.get("clientId") or "legacy")[:100]
        connection_id = _connection_id(actor)
        sessions = _participant_sessions(call)
        session = sessions.get(actor.user_id)
        if event_type == "CALL_LEAVE" and not isinstance(session, dict):
            return _Effects(), [{"type": "CALL_ACK", "callId": call_id, "event": event_type}]
        if event_type == "CALL_ACCEPT":
            participant_limit = int(call.get("maxParticipants") or self._participant_limit(_media_transport(call)))
            if actor.user_id not in sessions and len(sessions) >= participant_limit:
                raise CallError(
                    409,
                    (
                        f"Esta chamada atingiu o limite de {participant_limit} participantes. "
                        "Tente novamente quando houver uma vaga."
                    ),
                    code="call_capacity_reached",
                )
            same_client_media_session_id = (
                str(session.get("mediaSessionId") or "")
                if isinstance(session, dict)
                and str(session.get("clientId") or "") == client_id
                else ""
            )
            session = {
                "clientId": client_id,
                "connectionId": connection_id,
                "mediaSessionId": same_client_media_session_id or self._media_session_id_factory(),
                "lastHeartbeatAt": self._now().isoformat(),
                "disconnectedAt": None,
            }
            sessions[actor.user_id] = session
            _sync_joined_clients(call)
        elif event_type not in {"CALL_INVITE", "CALL_REJECT"}:
            if not isinstance(session, dict) or str(session.get("clientId") or "") != client_id:
                return _Effects(), [{
                    "type": "CALL_SESSION",
                    "callId": call_id,
                    "clientId": session.get("clientId") if isinstance(session, dict) else None,
                    "fromUserId": actor.user_id,
                }]
            bound_connection_id = str(session.get("connectionId") or "legacy")
            reconnecting_same_client = event_type == "CALL_HEARTBEAT"
            if bound_connection_id != connection_id and not reconnecting_same_client:
                return _Effects(), [{
                    "type": "CALL_SESSION",
                    "callId": call_id,
                    "clientId": session.get("clientId"),
                    "fromUserId": actor.user_id,
                }]
            if reconnecting_same_client:
                session["connectionId"] = connection_id
                session["disconnectedAt"] = None

        if event_type == "CALL_LEAVE" and str(call.get("hostUserId") or "") == actor.user_id:
            effects, _ = await self._end_existing_locked(actor, runtime, call)
            return effects, []

        if event_type == "CALL_KICK":
            self._authorizer.require_host(actor, call)
            target_user_id = str(payload.get("targetUserId") or "")
            if not target_user_id or target_user_id == actor.user_id:
                raise CallError(400, "Participante para expulsao invalido.")
            if target_user_id not in sessions:
                return _Effects(), [{"type": "CALL_ACK", "callId": call_id, "event": event_type}]
            sessions.pop(target_user_id, None)
            _clear_raised_hand(call, target_user_id)
            _sync_joined_clients(call)
            await self._persist_locked(actor.team_id, runtime)
            kicked = {
                **active_call_invite(call),
                "type": "CALL_KICK",
                "fromUserId": actor.user_id,
                "targetUserId": target_user_id,
                "reason": "kicked",
            }
            left = {
                **active_call_invite(call),
                "type": "CALL_LEAVE",
                "fromUserId": target_user_id,
                "reason": "kicked",
            }
            return _Effects(
                publications=[({target_user_id}, kicked), (set(sessions), left)],
                broadcast_state=True,
            ), [{"type": "CALL_ACK", "callId": call_id, "event": event_type}]

        changed = False
        if event_type == "CALL_LEAVE":
            sessions.pop(actor.user_id, None)
            _clear_raised_hand(call, actor.user_id)
            _sync_joined_clients(call)
            changed = True
        elif event_type == "CALL_HEARTBEAT":
            now = self._now().isoformat()
            if isinstance(session, dict):
                session["lastHeartbeatAt"] = now
                session["connectionId"] = connection_id
                session["disconnectedAt"] = None
            if str(call.get("hostUserId") or "") == actor.user_id:
                call["lastHeartbeatAt"] = now
                call["hostLeaseExpiresAt"] = (self._now() + HOST_LEASE_DURATION).isoformat()
            changed = True
        elif event_type == "CALL_HAND_STATE":
            if not isinstance(payload.get("raised"), bool):
                raise CallError(400, "Estado de mao levantada invalido.")
            hands = call.setdefault("raisedHands", {})
            if not isinstance(hands, dict):
                hands = {}
                call["raisedHands"] = hands
            if payload["raised"]:
                hands.setdefault(actor.user_id, self._now().isoformat())
            else:
                hands.pop(actor.user_id, None)
            call["handRevision"] = int(call.get("handRevision") or 0) + 1
            changed = True

        event = self._event_payload(call, actor, payload)
        recipients = set(sessions) - {actor.user_id}
        if event_type == "CALL_SIGNAL":
            target = str(payload.get("targetUserId") or "")
            if target not in sessions or target == actor.user_id or not isinstance(payload.get("signal"), dict):
                raise CallError(400, "Destino de sinalizacao invalido.")
            recipients = {target}
            event["signal"] = payload["signal"]
        elif event_type == "CALL_REACTION":
            emoji = str(payload.get("emoji") or "")
            if emoji not in CALL_REACTIONS:
                raise CallError(400, "Reacao invalida.")
            event["emoji"] = emoji
        elif event_type == "CALL_MEDIA_STATE":
            if not isinstance(payload.get("cameraEnabled"), bool) or not isinstance(
                payload.get("screenSharing"), bool,
            ):
                raise CallError(400, "Estado de midia invalido.")
            event["cameraEnabled"] = payload["cameraEnabled"]
            event["screenSharing"] = payload["screenSharing"]

        if event_type == "CALL_HAND_STATE":
            recipients = set(sessions)

        if event_type == "CALL_ACCEPT":
            changed = True
        if changed:
            await self._persist_locked(actor.team_id, runtime)

        publications: list[tuple[set[str], dict[str, Any]]] = []
        if event_type == "CALL_ACCEPT":
            publications.append(({actor.user_id}, {
                "type": "CALL_SESSION",
                "callId": call_id,
                "clientId": client_id,
                "fromUserId": actor.user_id,
            }))
        if event_type != "CALL_HEARTBEAT":
            publications.append((recipients, event))
        direct_message = (
            _call_ack(call, event_type)
            if event_type == "CALL_ACCEPT"
            else {"type": "CALL_ACK", "callId": call_id, "event": event_type}
        )
        return _Effects(
            publications=publications,
            broadcast_state=event_type in {"CALL_ACCEPT", "CALL_LEAVE"},
        ), [direct_message]

    def _event_payload(
        self,
        call: dict[str, Any],
        actor: CallActor,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        return {
            **active_call_invite(call),
            "type": str(payload.get("type") or ""),
            "fromUserId": actor.user_id,
            "fromUserName": actor.name,
            "clientId": str(payload.get("clientId") or "legacy")[:100],
            "createdAt": self._now().isoformat(),
        }
