"""Politica e ciclo de vida das gravacoes de chamadas de equipe."""

from __future__ import annotations

import asyncio
from collections.abc import Mapping
from collections import defaultdict, deque
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
import hashlib
import os
from pathlib import Path
from typing import Any, Awaitable, Callable, Protocol
from urllib.parse import quote
import uuid


class RecordingError(Exception):
    def __init__(self, status_code: int, detail: str) -> None:
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


@dataclass(frozen=True)
class RecordingActor:
    user_id: str
    team_id: str
    name: str


@dataclass(frozen=True)
class RecordingStart:
    call_id: str
    client_id: str
    operation_id: str
    mime_type: str


@dataclass(frozen=True)
class RecordingUpload:
    client_id: str
    chunk_id: str
    content: bytes


@dataclass(frozen=True)
class RecordingComplete:
    client_id: str
    operation_id: str


@dataclass(frozen=True)
class RecordingAbort:
    client_id: str
    operation_id: str


@dataclass(frozen=True)
class CallRecordingContext:
    call_id: str
    host_user_id: str
    participant_ids: frozenset[str]
    participant_clients: dict[str, str] = field(default_factory=dict)
    thread_id: str = "team"
    scope: str = "team"
    recipient_id: str | None = None
    subteam_id: str | None = None


@dataclass(frozen=True)
class RecordingLimits:
    max_chunk_bytes: int = 16 * 1024 * 1024
    max_total_bytes: int = 512 * 1024 * 1024
    max_duration_seconds: int = 6 * 60 * 60
    max_concurrent_per_team: int = 2
    max_team_bytes: int = 2 * 1024 * 1024 * 1024
    request_limit: int = 60
    request_window_seconds: int = 60
    retention_hours: int = 24
    orphan_grace_seconds: int = 10 * 60

    @classmethod
    def from_env(cls, environ: Mapping[str, str] | None = None) -> RecordingLimits:
        defaults = cls()
        from app.modules.team.call_release import bounded_int
        source = os.environ if environ is None else environ

        def value(name: str, default: int) -> int:
            return bounded_int(source, name, default, 1, default * 4)

        return cls(
            max_chunk_bytes=value("TEAM_RECORDING_MAX_CHUNK_BYTES", defaults.max_chunk_bytes),
            max_total_bytes=value("TEAM_RECORDING_MAX_TOTAL_BYTES", defaults.max_total_bytes),
            max_duration_seconds=value("TEAM_RECORDING_MAX_DURATION_SECONDS", defaults.max_duration_seconds),
            max_concurrent_per_team=value(
                "TEAM_RECORDING_MAX_CONCURRENT_PER_TEAM", defaults.max_concurrent_per_team,
            ),
            max_team_bytes=value("TEAM_RECORDING_MAX_TEAM_BYTES", defaults.max_team_bytes),
            request_limit=value("TEAM_RECORDING_REQUEST_LIMIT", defaults.request_limit),
            request_window_seconds=value(
                "TEAM_RECORDING_REQUEST_WINDOW_SECONDS", defaults.request_window_seconds,
            ),
            retention_hours=value("TEAM_RECORDING_RETENTION_HOURS", defaults.retention_hours),
            orphan_grace_seconds=value(
                "TEAM_RECORDING_ORPHAN_GRACE_SECONDS", defaults.orphan_grace_seconds,
            ),
        )


class RecordingStore(Protocol):
    async def load(self, team_id: str) -> dict[str, Any]: ...

    async def transact(
        self,
        team_id: str,
        operation: Callable[[dict[str, Any]], Awaitable[Any]],
    ) -> Any: ...


class RecordingCallAccess(Protocol):
    async def authorize(
        self,
        actor: RecordingActor,
        call_id: str,
        client_id: str,
        *,
        require_host: bool,
    ) -> CallRecordingContext: ...


class RecordingEvents(Protocol):
    async def publish(self, team_id: str, recipients: set[str], payload: dict[str, Any]) -> None: ...

    async def audit(self, team_id: str, action: str, metadata: dict[str, Any]) -> None: ...


class RecordingClock(Protocol):
    def now(self) -> datetime: ...


class LocalRecordingFiles:
    def __init__(self, root: Path) -> None:
        self.root = root

    def _path(self, name: str) -> Path:
        return self.root / Path(name).name

    async def append_at(self, name: str, offset: int, content: bytes) -> None:
        path = self._path(name)
        self.root.mkdir(parents=True, exist_ok=True)

        def write() -> None:
            mode = "r+b" if path.exists() else "w+b"
            with path.open(mode) as output:
                output.truncate(offset)
                output.seek(offset)
                output.write(content)
                output.flush()

        await asyncio.to_thread(write)

    async def delete(self, name: str) -> None:
        if not name:
            return
        await asyncio.to_thread(self._path(name).unlink, True)

    async def exists(self, name: str) -> bool:
        return bool(name) and await asyncio.to_thread(self._path(name).is_file)

    async def move(self, source: str, destination: str) -> None:
        if not source or not destination:
            raise RecordingError(500, "Arquivo da gravacao indisponivel.")
        await asyncio.to_thread(self._path(source).replace, self._path(destination))

    async def list_parts(self) -> list[tuple[str, datetime]]:
        if not self.root.exists():
            return []

        def scan() -> list[tuple[str, datetime]]:
            return [
                (path.name, datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc))
                for path in self.root.iterdir()
                if path.is_file() and not path.is_symlink() and (path.suffix == ".part"
                    or (path.name.startswith("team-recording-") and path.suffix in {".webm", ".mp4"}))
            ]

        return await asyncio.to_thread(scan)


class RecordingCoordinator:
    """Modulo profundo que impoe a politica de gravacao no servidor."""

    def __init__(
        self,
        *,
        store: RecordingStore,
        files: LocalRecordingFiles,
        call_access: RecordingCallAccess,
        events: RecordingEvents,
        clock: RecordingClock,
        limits: RecordingLimits,
        attachment_url: Callable[[str], str] | None = None,
        avatar_url: Callable[[str], str] | None = None,
    ) -> None:
        self._store = store
        self._files = files
        self._call_access = call_access
        self._events = events
        self._clock = clock
        self._limits = limits
        self._attachment_url = attachment_url or (
            lambda name: f"/api/team-chat/attachments/{quote(name)}"
        )
        self._avatar_url = avatar_url or (lambda _user_id: "")
        self._request_times: dict[tuple[str, str], deque[datetime]] = defaultdict(deque)
        self._request_lock = asyncio.Lock()

    @property
    def limits(self) -> RecordingLimits:
        return self._limits

    def _now(self) -> datetime:
        now = self._clock.now()
        return now if now.tzinfo else now.replace(tzinfo=timezone.utc)

    @staticmethod
    def _parse_datetime(value: Any) -> datetime | None:
        try:
            parsed = datetime.fromisoformat(str(value or "").replace("Z", "+00:00"))
        except (TypeError, ValueError):
            return None
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)

    async def _check_rate(self, actor: RecordingActor) -> None:
        now = self._now()
        cutoff = now - timedelta(seconds=max(1, self._limits.request_window_seconds))
        key = (actor.team_id, actor.user_id)
        async with self._request_lock:
            requests = self._request_times[key]
            while requests and requests[0] <= cutoff:
                requests.popleft()
            if len(requests) >= max(1, self._limits.request_limit):
                raise RecordingError(429, "Frequencia de requisicoes de gravacao acima do limite.")
            requests.append(now)

    def _require_within_duration(self, recording: dict[str, Any]) -> None:
        started_at = self._parse_datetime(recording.get("startedAt"))
        if started_at and started_at + timedelta(seconds=self._limits.max_duration_seconds) < self._now():
            raise RecordingError(410, "Duracao maxima da gravacao atingida.")

    async def start(self, actor: RecordingActor, request: RecordingStart) -> dict[str, Any]:
        existing_document = await self._store.load(actor.team_id)
        repeated = next((
            item for item in existing_document.get("recordings", [])
            if isinstance(item, dict)
            and item.get("startOperationId") == request.operation_id
            and item.get("createdBy") == actor.user_id
            and item.get("clientId") == request.client_id
        ), None)
        if repeated:
            if repeated.get("callId") != request.call_id or repeated.get("clientId") != request.client_id:
                await self._events.audit(actor.team_id, "recording_failed", {
                    "callId": request.call_id,
                    "actorId": actor.user_id,
                    "failureCode": "operation_id_conflict",
                })
                raise RecordingError(409, "Identificador de operacao ja usado em outra chamada.")
            public = {key: value for key, value in repeated.items() if key != "tempStoredName"}
            return {"recording": public, "reused": True}
        try:
            await self._check_rate(actor)
            context = await self._call_access.authorize(
                actor,
                request.call_id,
                request.client_id,
                require_host=True,
            )
            mime_type = request.mime_type.split(";", 1)[0].strip().lower()
            if mime_type not in {"video/webm", "audio/webm", "video/mp4", "audio/mp4"}:
                raise RecordingError(400, "Formato de gravacao nao suportado.")
        except RecordingError as error:
            await self._events.audit(actor.team_id, "recording_failed", {
                "callId": request.call_id,
                "actorId": actor.user_id,
                "failureCode": f"http_{error.status_code}",
            })
            raise

        async def create(document: dict[str, Any]) -> tuple[dict[str, Any], bool]:
            recordings = document.setdefault("recordings", [])
            repeated = next((
                item for item in recordings
                if isinstance(item, dict)
                and item.get("startOperationId") == request.operation_id
                and item.get("createdBy") == actor.user_id
            ), None)
            if repeated:
                return repeated, False
            active = next((
                item for item in recordings
                if isinstance(item, dict)
                and item.get("callId") == request.call_id
                and item.get("status") in {"recording", "finalizing"}
            ), None)
            if active:
                return active, False
            active_count = sum(
                1 for item in recordings
                if isinstance(item, dict) and item.get("status") in {"recording", "finalizing"}
            )
            if active_count >= self._limits.max_concurrent_per_team:
                raise RecordingError(429, "Limite de gravacoes simultaneas da equipe atingido.")
            now = self._now()
            recording_id = f"meeting_rec_{uuid.uuid4().hex}"
            extension = "mp4" if "mp4" in mime_type else "webm"
            stored_name = f"team-recording-{uuid.uuid4().hex}.{extension}"
            recording = {
                "id": recording_id,
                "callId": request.call_id,
                "clientId": request.client_id,
                "startOperationId": request.operation_id,
                "scope": context.scope,
                "threadId": context.thread_id,
                "recipientId": context.recipient_id,
                "subteamId": context.subteam_id,
                "participantIds": sorted(context.participant_ids),
                "createdBy": actor.user_id,
                "createdByName": actor.name,
                "mimeType": mime_type,
                "storedName": stored_name,
                "tempStoredName": f"{stored_name}.part",
                "acceptedChunks": {},
                "size": 0,
                "status": "recording",
                "startedAt": now.isoformat(),
            }
            recordings.append(recording)
            return recording, True

        try:
            recording, created = await self._store.transact(actor.team_id, create)
        except RecordingError as error:
            await self._events.audit(actor.team_id, "recording_failed", {
                "callId": request.call_id,
                "actorId": actor.user_id,
                "failureCode": f"http_{error.status_code}",
            })
            raise
        except Exception as error:
            await self._events.audit(actor.team_id, "recording_failed", {
                "callId": request.call_id,
                "actorId": actor.user_id,
                "failureCode": "storage_error",
            })
            raise RecordingError(500, "Falha ao iniciar a gravacao.") from error
        public = {key: value for key, value in recording.items() if key != "tempStoredName"}
        if created:
            await self._events.publish(actor.team_id, set(context.participant_ids), {
                "type": "CALL_RECORDING_STARTED",
                "callId": request.call_id,
                "recordingId": recording["id"],
                "fromUserId": actor.user_id,
                "fromUserName": actor.name,
            })
            await self._events.audit(actor.team_id, "recording_started", {
                "callId": request.call_id,
                "recordingId": recording["id"],
                "actorId": actor.user_id,
            })
        return {"recording": public, "reused": not created}

    @staticmethod
    def _find_recording(document: dict[str, Any], recording_id: str) -> dict[str, Any]:
        recording = next((
            item for item in document.get("recordings", [])
            if isinstance(item, dict) and str(item.get("id") or "") == recording_id
        ), None)
        if not recording:
            raise RecordingError(404, "Gravacao nao encontrada.")
        return recording

    async def _authorized_recording(
        self,
        actor: RecordingActor,
        recording_id: str,
        client_id: str,
    ) -> dict[str, Any]:
        recording = await self._owned_recording(actor, recording_id, client_id)
        await self._call_access.authorize(
            actor,
            str(recording.get("callId") or ""),
            client_id,
            require_host=True,
        )
        return recording

    async def _owned_recording(
        self,
        actor: RecordingActor,
        recording_id: str,
        client_id: str,
    ) -> dict[str, Any]:
        document = await self._store.load(actor.team_id)
        recording = self._find_recording(document, recording_id)
        if str(recording.get("createdBy") or "") != actor.user_id:
            raise RecordingError(403, "Somente o anfitriao que iniciou a gravacao pode envia-la.")
        if str(recording.get("clientId") or "") != client_id:
            raise RecordingError(409, "Cliente nao esta associado a gravacao.")
        return recording

    async def upload(
        self,
        actor: RecordingActor,
        recording_id: str,
        request: RecordingUpload,
    ) -> dict[str, Any]:
        owned = await self._owned_recording(actor, recording_id, request.client_id)
        accepted = owned.get("acceptedChunks", {})
        if isinstance(accepted, dict) and request.chunk_id in accepted:
            await self._check_rate(actor)
            accepted_chunk = accepted[request.chunk_id]
            accepted_size = int(
                accepted_chunk.get("size") if isinstance(accepted_chunk, dict) else accepted_chunk
            )
            if isinstance(accepted_chunk, dict) and (
                accepted_chunk.get("digest") != hashlib.sha256(request.content).hexdigest()
            ):
                await self._terminate(
                    actor.team_id,
                    recording_id,
                    status="failed",
                    reason="failed",
                    audit_action="recording_failed",
                    failure_code="chunk_id_conflict",
                )
                raise RecordingError(409, "Identificador de trecho reutilizado com outro conteudo.")
            return {
                "received": accepted_size,
                "size": int(owned.get("size") or 0),
                "reused": True,
            }
        await self._authorized_recording(actor, recording_id, request.client_id)
        try:
            await self._check_rate(actor)
            if not request.chunk_id or len(request.chunk_id) > 120:
                raise RecordingError(400, "Identificador de trecho invalido.")
        except RecordingError as error:
            await self._terminate(
                actor.team_id,
                recording_id,
                status="failed",
                reason="failed",
                audit_action="recording_failed",
                failure_code="rate_limit" if error.status_code == 429 else f"http_{error.status_code}",
            )
            raise

        async def append(document: dict[str, Any]) -> dict[str, Any]:
            recording = self._find_recording(document, recording_id)
            if recording.get("status") != "recording":
                raise RecordingError(409, "Esta gravacao ja foi encerrada.")
            self._require_within_duration(recording)
            accepted = recording.setdefault("acceptedChunks", {})
            if request.chunk_id in accepted:
                accepted_chunk = accepted[request.chunk_id]
                accepted_size = int(
                    accepted_chunk.get("size") if isinstance(accepted_chunk, dict) else accepted_chunk
                )
                if isinstance(accepted_chunk, dict) and (
                    accepted_chunk.get("digest") != hashlib.sha256(request.content).hexdigest()
                ):
                    raise RecordingError(409, "Identificador de trecho reutilizado com outro conteudo.")
                return {
                    "received": accepted_size,
                    "size": int(recording.get("size") or 0),
                    "reused": True,
                }
            chunk_size = len(request.content)
            if chunk_size > self._limits.max_chunk_bytes:
                raise RecordingError(413, "Trecho da gravacao acima do limite configurado.")
            next_size = int(recording.get("size") or 0) + chunk_size
            if next_size > self._limits.max_total_bytes:
                raise RecordingError(413, "Gravacao acima do limite total configurado.")
            now = self._now()
            team_usage = sum(
                int(item.get("size") or 0)
                for item in document.get("recordings", [])
                if isinstance(item, dict)
                and item.get("status") in {"recording", "finalizing", "completed"}
                and (
                    item.get("status") != "completed"
                    or self._parse_datetime(item.get("expiresAt")) is None
                    or self._parse_datetime(item.get("expiresAt")) > now
                )
            )
            if team_usage + chunk_size > self._limits.max_team_bytes:
                raise RecordingError(413, "Consumo de gravacoes da equipe acima do limite configurado.")
            temp_name = str(recording.get("tempStoredName") or "")
            if not temp_name:
                raise RecordingError(500, "Arquivo temporario da gravacao indisponivel.")
            await self._files.append_at(temp_name, int(recording.get("size") or 0), request.content)
            accepted[request.chunk_id] = {
                "size": chunk_size,
                "digest": hashlib.sha256(request.content).hexdigest(),
            }
            recording["size"] = next_size
            return {"received": chunk_size, "size": next_size, "reused": False}

        try:
            return await self._store.transact(actor.team_id, append)
        except RecordingError as error:
            await self._terminate(
                actor.team_id,
                recording_id,
                status="failed",
                reason="failed",
                audit_action="recording_failed",
                failure_code=f"http_{error.status_code}",
            )
            raise
        except Exception as error:
            await self._terminate(
                actor.team_id,
                recording_id,
                status="failed",
                reason="failed",
                audit_action="recording_failed",
                failure_code="storage_error",
            )
            raise RecordingError(500, "Falha ao armazenar a gravacao.") from error

    async def complete(
        self,
        actor: RecordingActor,
        recording_id: str,
        request: RecordingComplete,
    ) -> dict[str, Any]:
        owned = await self._owned_recording(actor, recording_id, request.client_id)
        if owned.get("status") == "completed":
            document = await self._store.load(actor.team_id)
            message = next((
                item for item in document.get("messages", [])
                if isinstance(item, dict) and item.get("id") == owned.get("messageId")
            ), None)
            if not message:
                raise RecordingError(500, "Mensagem da gravacao indisponivel.")
            return {"message": message, "expiresAt": owned.get("expiresAt")}
        await self._authorized_recording(actor, recording_id, request.client_id)
        try:
            await self._check_rate(actor)
        except RecordingError as error:
            await self._terminate(
                actor.team_id,
                recording_id,
                status="failed",
                reason="failed",
                audit_action="recording_failed",
                failure_code="rate_limit",
            )
            raise error
        moved: tuple[str, str] | None = None

        async def finalize(document: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any], bool]:
            nonlocal moved
            recording = self._find_recording(document, recording_id)
            if recording.get("status") == "completed":
                message = next((
                    item for item in document.get("messages", [])
                    if isinstance(item, dict) and item.get("id") == recording.get("messageId")
                ), None)
                if not message:
                    raise RecordingError(500, "Mensagem da gravacao indisponivel.")
                return recording, message, False
            if recording.get("status") != "recording":
                raise RecordingError(409, "Esta gravacao ja foi encerrada.")
            self._require_within_duration(recording)
            if int(recording.get("size") or 0) <= 0:
                raise RecordingError(400, "A gravacao nao possui conteudo.")
            temp_name = str(recording.get("tempStoredName") or "")
            stored_name = str(recording.get("storedName") or "")
            if not await self._files.exists(temp_name):
                raise RecordingError(400, "A gravacao nao possui conteudo.")
            recording["status"] = "finalizing"
            recording["completeOperationId"] = request.operation_id
            await self._files.move(temp_name, stored_name)
            moved = (stored_name, temp_name)
            now = self._now()
            expires_at = now + timedelta(hours=self._limits.retention_hours)
            participant_ids = {str(item) for item in recording.get("participantIds", []) if str(item)}
            suffix = Path(stored_name).suffix.lstrip(".") or "webm"
            attachment = {
                "id": f"team_att_{uuid.uuid4().hex}",
                "name": f"gravacao-reuniao.{suffix}",
                "mimeType": recording.get("mimeType") or "video/webm",
                "size": int(recording.get("size") or 0),
                "url": self._attachment_url(stored_name),
                "storedName": stored_name,
                "recordingId": recording_id,
                "callId": recording.get("callId"),
                "createdAt": now.isoformat(),
                "expiresAt": expires_at.isoformat(),
            }
            message = {
                "id": f"team_msg_{uuid.uuid4().hex}",
                "threadId": recording.get("threadId"),
                "scope": recording.get("scope"),
                "senderId": actor.user_id,
                "senderName": recording.get("createdByName") or actor.name,
                "senderAvatar": self._avatar_url(actor.user_id),
                "recipientId": recording.get("recipientId"),
                "subteamId": recording.get("subteamId"),
                "memberIds": sorted(participant_ids) if recording.get("scope") == "subteam" else [],
                "text": f"Gravacao da reuniao disponivel por {self._limits.retention_hours} horas.",
                "attachments": [attachment],
                "metadata": {
                    "action": "meeting_recording",
                    "callId": recording.get("callId"),
                    "recordingId": recording_id,
                    "expiresAt": expires_at.isoformat(),
                    "readBy": {},
                },
                "createdAt": now.isoformat(),
            }
            document.setdefault("messages", []).append(message)
            document["messages"] = document["messages"][-2000:]
            recording.update({
                "status": "completed",
                "completedAt": now.isoformat(),
                "expiresAt": expires_at.isoformat(),
                "messageId": message["id"],
            })
            return recording, message, True

        try:
            recording, message, changed = await self._store.transact(actor.team_id, finalize)
        except Exception as error:
            if moved:
                try:
                    await self._files.move(*moved)
                except Exception:
                    await self._files.delete(moved[0])
            if isinstance(error, RecordingError):
                failure = error
            else:
                failure = RecordingError(500, "Falha ao finalizar a gravacao.")
            await self._terminate(
                actor.team_id,
                recording_id,
                status="failed",
                reason="failed",
                audit_action="recording_failed",
                failure_code=f"http_{failure.status_code}",
            )
            raise failure from (None if isinstance(error, RecordingError) else error)

        result = {"message": message, "expiresAt": recording.get("expiresAt")}
        if not changed:
            return result
        participants = {str(item) for item in recording.get("participantIds", []) if str(item)}
        await self._events.publish(actor.team_id, participants, {
            "type": "TEAM_CHAT_MESSAGE",
            "message": message,
        })
        await self._events.publish(actor.team_id, participants, {
            "type": "CALL_RECORDING_AVAILABLE",
            "callId": recording.get("callId"),
            "recordingId": recording_id,
            "expiresAt": recording.get("expiresAt"),
            "fromUserId": actor.user_id,
            "fromUserName": recording.get("createdByName") or actor.name,
        })
        await self._events.publish(actor.team_id, participants, {
            "type": "CALL_RECORDING_STOPPED",
            "callId": recording.get("callId"),
            "recordingId": recording_id,
            "reason": "completed",
        })
        await self._events.audit(actor.team_id, "recording_stopped", {
            "callId": recording.get("callId"),
            "recordingId": recording_id,
            "actorId": actor.user_id,
            "reason": "completed",
        })
        return result

    async def reject_upload(
        self,
        actor: RecordingActor,
        recording_id: str,
        client_id: str,
        *,
        status_code: int,
        detail: str,
        failure_code: str,
    ) -> None:
        await self._authorized_recording(actor, recording_id, client_id)
        try:
            await self._check_rate(actor)
        except RecordingError:
            failure_code = "rate_limit"
            status_code = 429
            detail = "Frequencia de requisicoes de gravacao acima do limite."
        await self._terminate(
            actor.team_id,
            recording_id,
            status="failed",
            reason="failed",
            audit_action="recording_failed",
            failure_code=failure_code,
        )
        raise RecordingError(status_code, detail)

    async def abort(
        self,
        actor: RecordingActor,
        recording_id: str,
        request: RecordingAbort,
    ) -> dict[str, bool]:
        owned = await self._owned_recording(actor, recording_id, request.client_id)
        if owned.get("status") == "aborted":
            return {"ok": True}
        await self._authorized_recording(actor, recording_id, request.client_id)
        try:
            await self._check_rate(actor)
        except RecordingError:
            await self._terminate(
                actor.team_id,
                recording_id,
                status="aborted",
                reason="rate_limited",
                audit_action="recording_stopped",
            )
            raise
        await self._terminate(
            actor.team_id,
            recording_id,
            status="aborted",
            reason="aborted",
            audit_action="recording_stopped",
        )
        return {"ok": True}

    async def maintain(self, team_ids: list[str], *, inventory_complete: bool = True) -> dict[str, int]:
        total = {"expiredActive": 0, "deletedCompleted": 0, "deletedOrphans": 0}
        referenced: set[str] = set()
        errors: list[Exception] = []
        for team_id in dict.fromkeys(team_ids):
            try:
                result, parts = await self._maintain_team(team_id)
                for key, value in result.items():
                    total[key] += value
                referenced.update(parts)
            except Exception as error:
                errors.append(error)
        # Never infer that a file is orphaned from an incomplete directory scan.
        # One broken team's store must still allow retention for other teams.
        if errors:
            raise errors[0]
        if not inventory_complete:
            raise OSError("Inventario de gravacoes secundarias pendente; limpeza de orfaos suspensa.")
        orphan_cutoff = self._now() - timedelta(seconds=self._limits.orphan_grace_seconds)
        for name, modified_at in await self._files.list_parts():
            if name not in referenced and modified_at <= orphan_cutoff:
                await self._files.delete(name)
                total["deletedOrphans"] += 1
        return total

    async def _maintain_team(self, team_id: str) -> tuple[dict[str, int], set[str]]:
        now = self._now()
        expired_active = 0
        deleted_completed = 0
        referenced_parts: set[str] = set()
        document = await self._store.load(team_id)
        active_recordings = [
            item
            for item in document.get("recordings", [])
            if isinstance(item, dict)
            and item.get("status") in {"recording", "finalizing"}
        ]
        for recording in active_recordings:
            recording_id = str(recording.get("id") or "")
            failure_code = ""
            reason = ""
            try:
                await self._call_access.authorize(
                    RecordingActor(
                        user_id=str(recording.get("createdBy") or ""),
                        team_id=team_id,
                        name=str(recording.get("createdByName") or "Membro"),
                    ),
                    str(recording.get("callId") or ""),
                    str(recording.get("clientId") or ""),
                    require_host=True,
                )
            except RecordingError:
                failure_code = "call_access_revoked"
                reason = "access_revoked"
            started = self._parse_datetime(recording.get("startedAt"))
            if not failure_code and started and (
                started + timedelta(seconds=self._limits.max_duration_seconds) < now
            ):
                failure_code = "duration_expired"
                reason = "expired"
            if failure_code:
                await self._terminate(
                    team_id,
                    recording_id,
                    status="failed",
                    reason=reason,
                    audit_action="recording_failed",
                    failure_code=failure_code,
                )
                expired_active += 1

        async def expire_completed(document: dict[str, Any]) -> list[dict[str, Any]]:
            expired: list[dict[str, Any]] = []
            for recording in document.get("recordings", []):
                if not isinstance(recording, dict):
                    continue
                if recording.get("status") in {"recording", "finalizing"}:
                    temp_name = str(recording.get("tempStoredName") or "")
                    if temp_name:
                        referenced_parts.add(Path(temp_name).name)
                expires_at = self._parse_datetime(recording.get("expiresAt"))
                if recording.get("status") in {"deleted", "aborted", "failed"} and not recording.get("filesDeletedAt"):
                    expired.append(dict(recording))
                    continue
                if recording.get("status") != "completed" or not expires_at or expires_at > now:
                    continue
                recording.update({"status": "deleted", "deletedAt": now.isoformat()})
                expired.append(dict(recording))
                for message in document.get("messages", []):
                    if not isinstance(message, dict) or message.get("id") != recording.get("messageId"):
                        continue
                    message["attachments"] = [
                        attachment for attachment in message.get("attachments", [])
                        if not isinstance(attachment, dict)
                        or attachment.get("recordingId") != recording.get("id")
                    ]
                    metadata = message.setdefault("metadata", {})
                    if isinstance(metadata, dict):
                        metadata["recordingExpired"] = True
            return expired

        expired = await self._store.transact(team_id, expire_completed)
        for recording in expired:
            await self._files.delete(str(recording.get("storedName") or ""))
            await self._files.delete(str(recording.get("tempStoredName") or ""))
            async def mark_files_deleted(document: dict[str, Any]) -> None:
                current = self._find_recording(document, str(recording["id"]))
                current["filesDeletedAt"] = now.isoformat()
            await self._store.transact(team_id, mark_files_deleted)
            if recording.get("status") != "deleted":
                continue
            await self._events.audit(team_id, "recording_deleted", {
                "callId": recording.get("callId"),
                "recordingId": recording.get("id"),
                "actorId": recording.get("createdBy"),
                "reason": "retention_expired",
            })
            deleted_completed += 1

        # Protect final files as well as upload parts, including pending retries.
        # This also lets maintenance remove legacy media whose metadata was pruned.
        current_document = await self._store.load(team_id)
        for item in current_document.get("recordings", []):
            if not item.get("filesDeletedAt"):
                referenced_parts.update(str(item.get(field) or "")
                                        for field in ("storedName", "tempStoredName"))
        return {
            "expiredActive": expired_active,
            "deletedCompleted": deleted_completed,
        }, referenced_parts

    async def _terminate(
        self,
        team_id: str,
        recording_id: str,
        *,
        status: str,
        reason: str,
        audit_action: str,
        failure_code: str | None = None,
    ) -> dict[str, Any]:
        async def mark(document: dict[str, Any]) -> tuple[dict[str, Any], bool]:
            recording = self._find_recording(document, recording_id)
            if recording.get("status") not in {"recording", "finalizing"}:
                return recording, False
            now = self._clock.now()
            if now.tzinfo is None:
                now = now.replace(tzinfo=timezone.utc)
            recording.update({
                "status": status,
                f"{status}At": now.isoformat(),
                "stopReason": reason,
            })
            return recording, True

        recording, changed = await self._store.transact(team_id, mark)
        if not changed:
            return recording
        await self._files.delete(str(recording.get("tempStoredName") or ""))
        if status != "completed":
            await self._files.delete(str(recording.get("storedName") or ""))
        participants = {str(item) for item in recording.get("participantIds", []) if str(item)}
        await self._events.publish(team_id, participants, {
            "type": "CALL_RECORDING_STOPPED",
            "callId": recording.get("callId"),
            "recordingId": recording_id,
            "reason": reason,
        })
        metadata = {
            "callId": recording.get("callId"),
            "recordingId": recording_id,
            "actorId": recording.get("createdBy"),
            "reason": reason,
        }
        if failure_code:
            metadata["failureCode"] = failure_code
        await self._events.audit(team_id, audit_action, metadata)
        return recording
