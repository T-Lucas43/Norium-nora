"""Carga reproduzivel para sinalizacao, heartbeat e estado de chamadas.

Por padrao o runner inicia o fixture real em um processo isolado, abre 100
WebSockets (25 equipes x 4 membros), executa tres repeticoes e encerra o
processo. Somente medidas agregadas, classes de erro e posicoes do codigo sao
preservadas; enderecos, mensagens de erro e logs brutos nunca viram artefatos.
"""

from __future__ import annotations

import argparse
import asyncio
import ctypes
import json
import math
import os
import socket
import subprocess
import sys
import time
import traceback
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Awaitable, Callable

import httpx
import websockets


READINESS_DEADLINE_SECONDS = 20.0
EVENT_DEADLINE_SECONDS = 10.0
STATE_POLL_INTERVAL_SECONDS = 0.10
LIFECYCLE_POLL_INTERVAL_SECONDS = 0.20
RSS_SAMPLE_INTERVAL_SECONDS = 0.10
HEARTBEAT_KEEPALIVE_INTERVAL_SECONDS = 4.0


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, str(default)))
    except ValueError:
        return default


@dataclass(frozen=True)
class Thresholds:
    handshake_p95_ms: float
    handshake_p99_ms: float
    call_control_p95_ms: float
    call_control_p99_ms: float
    signal_p95_ms: float
    signal_p99_ms: float
    heartbeat_p95_ms: float
    heartbeat_p99_ms: float
    state_p95_ms: float
    state_p99_ms: float
    state_convergence_ms: float
    ghost_removal_seconds: float
    silent_socket_survival_seconds: float
    max_rss_mib: float
    max_rss_delta_mib: float
    max_residual_rss_delta_mib: float
    min_simultaneous_connections: int


class LoadFailure(RuntimeError):
    pass


def _available_loopback_port(host: str) -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as reservation:
        reservation.bind((host, 0))
        return int(reservation.getsockname()[1])


class SocketClient:
    def __init__(self, user_id: str, team_id: str, client_id: str, ws_base_url: str) -> None:
        self.user_id = user_id
        self.team_id = team_id
        self.client_id = client_id
        self.url = f"{ws_base_url.rstrip('/')}/api/team-chat/ws?ticket={user_id}"
        self.websocket: Any = None
        self.history: list[tuple[float, dict[str, Any]]] = []
        self.condition = asyncio.Condition()
        self.reader_task: asyncio.Task[None] | None = None
        self.closed = False
        self.reader_error: BaseException | None = None

    @property
    def cursor(self) -> int:
        return len(self.history)

    async def connect(self) -> float:
        started = time.perf_counter()
        self.websocket = await websockets.connect(
            self.url,
            open_timeout=EVENT_DEADLINE_SECONDS,
            close_timeout=2,
            max_size=256_000,
            proxy=None,
        )
        self.reader_task = asyncio.create_task(self._read(), name=f"load-reader-{self.user_id}")
        received_at, _ = await self.wait_for(
            lambda message: message.get("type") == "CONNECTED",
            after=0,
            timeout=EVENT_DEADLINE_SECONDS,
        )
        return (received_at - started) * 1000

    async def _read(self) -> None:
        try:
            async for raw in self.websocket:
                try:
                    message = json.loads(raw)
                except (TypeError, json.JSONDecodeError):
                    continue
                if not isinstance(message, dict):
                    continue
                async with self.condition:
                    self.history.append((time.perf_counter(), message))
                    self.condition.notify_all()
        except websockets.ConnectionClosed:
            pass
        except BaseException as error:
            self.reader_error = error
        finally:
            async with self.condition:
                self.closed = True
                self.condition.notify_all()

    async def wait_for(
        self,
        predicate: Callable[[dict[str, Any]], bool],
        *,
        after: int,
        timeout: float,
    ) -> tuple[float, dict[str, Any]]:
        deadline = asyncio.get_running_loop().time() + timeout
        next_index = after
        async with self.condition:
            while True:
                while next_index < len(self.history):
                    record = self.history[next_index]
                    next_index += 1
                    if predicate(record[1]):
                        return record
                if self.reader_error is not None:
                    raise LoadFailure(f"WebSocket {self.user_id} falhou: {self.reader_error}")
                if self.closed:
                    raise LoadFailure(f"WebSocket {self.user_id} fechou antes do evento esperado.")
                remaining = deadline - asyncio.get_running_loop().time()
                if remaining <= 0:
                    raise LoadFailure(f"Timeout aguardando evento para {self.user_id}.")
                try:
                    await asyncio.wait_for(self.condition.wait(), timeout=remaining)
                except TimeoutError as error:
                    raise LoadFailure(f"Timeout aguardando evento para {self.user_id}.") from error

    async def send(self, payload: dict[str, Any]) -> None:
        if self.websocket is None or self.closed:
            raise LoadFailure(f"WebSocket {self.user_id} nao esta aberto.")
        await self.websocket.send(json.dumps(payload, separators=(",", ":")))

    async def wait_ack(self, call_id: str, event_type: str, *, after: int) -> tuple[float, dict[str, Any]]:
        _, message = await self.wait_for(
            lambda item: (
                item.get("callId") == call_id
                and (
                    (item.get("type") == "CALL_ACK" and item.get("event") == event_type)
                    or item.get("type") in {"CALL_ERROR", "CALL_END"}
                )
            ),
            after=after,
            timeout=EVENT_DEADLINE_SECONDS,
        )
        if message.get("type") != "CALL_ACK":
            raise LoadFailure(
                f"{self.user_id} recebeu {message.get('type')} em vez de ACK para {event_type}: {message}"
            )
        return time.perf_counter(), message

    async def close(self) -> None:
        if self.websocket is not None and not self.closed:
            try:
                await self.websocket.close()
            except Exception:
                pass
        if self.reader_task is not None:
            try:
                await asyncio.wait_for(self.reader_task, timeout=3)
            except (TimeoutError, Exception):
                self.reader_task.cancel()
                await asyncio.gather(self.reader_task, return_exceptions=True)

    async def abort(self) -> None:
        if self.websocket is None or self.closed:
            return
        transport = getattr(self.websocket, "transport", None)
        if transport is not None:
            transport.abort()
        else:
            await self.websocket.close()
        if self.reader_task is not None:
            try:
                await asyncio.wait_for(self.reader_task, timeout=3)
            except TimeoutError:
                self.reader_task.cancel()
                await asyncio.gather(self.reader_task, return_exceptions=True)


@dataclass
class LoadTeam:
    team_id: str
    call_id: str
    clients: list[SocketClient]

    @property
    def owner(self) -> SocketClient:
        return self.clients[0]


class ManagedFixture:
    def __init__(self, backend_root: Path, host: str, port: int, teams: int, participants: int, log_dir: Path) -> None:
        self.backend_root = backend_root
        self.host = host
        self.port = port
        self.teams = teams
        self.participants = participants
        self.log_dir = log_dir
        self.process: subprocess.Popen[bytes] | None = None
        self.log_path: Path | None = None
        self.log_stream: Any = None

    def start(self) -> None:
        self.log_dir.mkdir(parents=True, exist_ok=True)
        environment = dict(os.environ)
        environment["TEAM_CALL_FIXTURE_LOAD_TEAMS"] = str(self.teams)
        environment["TEAM_CALL_FIXTURE_USERS_PER_TEAM"] = str(self.participants)
        command = [
            sys.executable,
            "-m",
            "uvicorn",
            "tests.team_call_browser_app:app",
            "--host",
            self.host,
            "--port",
            str(self.port),
            "--log-level",
            "warning",
            "--no-access-log",
        ]
        self.process = subprocess.Popen(
            command,
            cwd=self.backend_root,
            env=environment,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.STDOUT,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )

    async def wait_ready(self, base_url: str) -> None:
        deadline = asyncio.get_running_loop().time() + READINESS_DEADLINE_SECONDS
        last_error: BaseException | None = None
        async with httpx.AsyncClient(timeout=1) as client:
            while asyncio.get_running_loop().time() < deadline:
                if self.process is not None and self.process.poll() is not None:
                    raise LoadFailure(f"Fixture encerrou durante a inicializacao (exit {self.process.returncode}).")
                try:
                    response = await client.get(f"{base_url}/openapi.json")
                    if response.status_code == 200:
                        return
                except (httpx.HTTPError, OSError) as error:
                    last_error = error
                await asyncio.sleep(STATE_POLL_INTERVAL_SECONDS)
        raise LoadFailure(f"Fixture nao ficou pronto em {READINESS_DEADLINE_SECONDS}s: {last_error}")

    def stop(self, *, passed: bool, artifacts_dir: Path) -> None:
        if self.process is not None and self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=8)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=3)
        if self.log_stream is not None:
            self.log_stream.close()
        if not passed:
            artifacts_dir.mkdir(parents=True, exist_ok=True)
            (artifacts_dir / "backend-failure.json").write_text(json.dumps({
                "status": "failed", "exitCode": self.process.returncode if self.process else None,
                "rawLogsRetained": False,
            }), encoding="utf-8")
        if self.log_path is None:
            return
        removal_deadline = time.monotonic() + 2.0
        while self.log_path.exists():
            try:
                self.log_path.unlink()
                break
            except PermissionError:
                if time.monotonic() >= removal_deadline:
                    raise
                time.sleep(0.05)


def _read_rss_bytes(process_id: int) -> int | None:
    if process_id <= 0:
        return None
    proc_status = Path(f"/proc/{process_id}/status")
    if proc_status.is_file():
        try:
            for line in proc_status.read_text(encoding="utf-8").splitlines():
                if line.startswith("VmRSS:"):
                    return int(line.split()[1]) * 1024
        except (OSError, ValueError, IndexError):
            return None
    if os.name != "nt":
        return None

    class ProcessMemoryCounters(ctypes.Structure):
        _fields_ = [
            ("cb", ctypes.c_ulong),
            ("PageFaultCount", ctypes.c_ulong),
            ("PeakWorkingSetSize", ctypes.c_size_t),
            ("WorkingSetSize", ctypes.c_size_t),
            ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
            ("QuotaPagedPoolUsage", ctypes.c_size_t),
            ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
            ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
            ("PagefileUsage", ctypes.c_size_t),
            ("PeakPagefileUsage", ctypes.c_size_t),
        ]

    kernel32 = ctypes.windll.kernel32
    psapi = ctypes.windll.psapi
    kernel32.OpenProcess.argtypes = [ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
    kernel32.OpenProcess.restype = ctypes.c_void_p
    kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
    kernel32.CloseHandle.restype = ctypes.c_int
    psapi.GetProcessMemoryInfo.argtypes = [
        ctypes.c_void_p,
        ctypes.POINTER(ProcessMemoryCounters),
        ctypes.c_ulong,
    ]
    psapi.GetProcessMemoryInfo.restype = ctypes.c_int
    process = kernel32.OpenProcess(0x0400 | 0x0010, False, process_id)
    if not process:
        return None
    counters = ProcessMemoryCounters()
    counters.cb = ctypes.sizeof(counters)
    try:
        success = psapi.GetProcessMemoryInfo(
            process,
            ctypes.byref(counters),
            counters.cb,
        )
        return int(counters.WorkingSetSize) if success else None
    finally:
        kernel32.CloseHandle(process)


class RssSampler:
    def __init__(self, process_id: int) -> None:
        self.process_id = process_id
        self.samples: list[int] = []
        self.stop_event = asyncio.Event()
        self.task: asyncio.Task[None] | None = None

    def start(self) -> None:
        self.task = asyncio.create_task(self._sample(), name="team-call-rss-sampler")

    async def _sample(self) -> None:
        while not self.stop_event.is_set():
            value = _read_rss_bytes(self.process_id)
            if value is not None:
                self.samples.append(value)
            try:
                await asyncio.wait_for(self.stop_event.wait(), timeout=RSS_SAMPLE_INTERVAL_SECONDS)
            except TimeoutError:
                pass

    async def stop(self) -> None:
        self.stop_event.set()
        if self.task is not None:
            await self.task


def _percentile(values: list[float], percentile: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = max(0, math.ceil((percentile / 100) * len(ordered)) - 1)
    return ordered[index]


def _distribution(values: list[float]) -> dict[str, float | int]:
    return {
        "count": len(values),
        "min": round(min(values), 3) if values else 0.0,
        "p50": round(_percentile(values, 50), 3),
        "p95": round(_percentile(values, 95), 3),
        "p99": round(_percentile(values, 99), 3),
        "max": round(max(values), 3) if values else 0.0,
    }


async def _poll_until(
    probe: Callable[[], Awaitable[Any]],
    predicate: Callable[[Any], bool],
    *,
    deadline_seconds: float,
    interval_seconds: float,
    description: str,
) -> tuple[Any, float]:
    started = time.perf_counter()
    deadline = asyncio.get_running_loop().time() + deadline_seconds
    last_value: Any = None
    while True:
        last_value = await probe()
        if predicate(last_value):
            return last_value, time.perf_counter() - started
        if asyncio.get_running_loop().time() >= deadline:
            raise LoadFailure(f"Prazo excedido para {description}; ultimo estado: {last_value}")
        await asyncio.sleep(interval_seconds)


async def _json_request(
    client: httpx.AsyncClient,
    method: str,
    url: str,
    **kwargs: Any,
) -> tuple[dict[str, Any], float]:
    started = time.perf_counter()
    response = await client.request(method, url, **kwargs)
    elapsed_ms = (time.perf_counter() - started) * 1000
    if response.status_code >= 400:
        raise LoadFailure(f"{method} {url} retornou {response.status_code}: {response.text[:500]}")
    payload = response.json()
    if not isinstance(payload, dict):
        raise LoadFailure(f"{method} {url} nao retornou um objeto JSON.")
    return payload, elapsed_ms


def _build_teams(team_count: int, participants: int, iteration: int, ws_base_url: str) -> list[LoadTeam]:
    teams: list[LoadTeam] = []
    for team_index in range(team_count):
        team_id = f"load-{team_index:03d}-owner"
        user_ids = [team_id] + [
            f"load-{team_index:03d}-user-{participant_index}"
            for participant_index in range(1, participants)
        ]
        clients = [
            SocketClient(user_id, team_id, f"load-client-{iteration}-{user_id}", ws_base_url)
            for user_id in user_ids
        ]
        call_number = (iteration + 1) * 100_000 + team_index
        teams.append(LoadTeam(team_id, f"call_{call_number:016x}", clients))
    return teams


async def _send_event_and_wait_ack(
    client: SocketClient,
    call_id: str,
    event_type: str,
    **extra: Any,
) -> float:
    cursor = client.cursor
    started = time.perf_counter()
    await client.send({
        "type": event_type,
        "callId": call_id,
        "clientId": client.client_id,
        **extra,
    })
    await client.wait_ack(call_id, event_type, after=cursor)
    return (time.perf_counter() - started) * 1000


async def _active_calls(
    http: httpx.AsyncClient,
    base_url: str,
    owner_id: str,
) -> tuple[dict[str, Any], float]:
    return await _json_request(
        http,
        "GET",
        f"{base_url}/api/team-chat/calls/active",
        headers={"Authorization": f"Bearer {owner_id}"},
    )


async def _fixture_state(
    http: httpx.AsyncClient,
    base_url: str,
    team_id: str,
) -> dict[str, Any]:
    payload, _ = await _json_request(
        http,
        "GET",
        f"{base_url}/__test__/state",
        params={"teamId": team_id},
    )
    return payload


async def _keep_participants_alive(
    clients: list[SocketClient],
    calls_by_team: dict[str, str],
    stop_event: asyncio.Event,
) -> None:
    while not stop_event.is_set():
        await asyncio.gather(*(
            client.send({
                "type": "CALL_HEARTBEAT",
                "callId": calls_by_team[client.team_id],
                "clientId": client.client_id,
            })
            for client in clients
            if not client.closed
        ), return_exceptions=True)
        try:
            await asyncio.wait_for(stop_event.wait(), timeout=HEARTBEAT_KEEPALIVE_INTERVAL_SECONDS)
        except TimeoutError:
            pass


async def _run_iteration(
    iteration: int,
    *,
    team_count: int,
    participants: int,
    base_url: str,
    ws_base_url: str,
    http: httpx.AsyncClient,
    process_id: int,
    measure_silent_timeout: bool,
    ghost_deadline: float,
    silent_duration: float,
) -> dict[str, Any]:
    reset, _ = await _json_request(http, "POST", f"{base_url}/__test__/reset")
    if not reset.get("reset"):
        raise LoadFailure("Fixture nao confirmou reset.")

    baseline_rss = _read_rss_bytes(process_id)
    if baseline_rss is None:
        raise LoadFailure("Nao foi possivel medir RSS do processo do backend.")
    rss_sampler = RssSampler(process_id)
    rss_sampler.start()
    teams = _build_teams(team_count, participants, iteration, ws_base_url)
    clients = [client for load_team in teams for client in load_team.clients]
    ghost_seconds: float | None = None
    silent_survival_seconds: float | None = None
    silent_disconnect_seconds: float | None = None
    keepalive_stop = asyncio.Event()
    keepalive_task: asyncio.Task[None] | None = None

    try:
        handshake_ms = list(await asyncio.gather(*(client.connect() for client in clients)))
        state = await _fixture_state(http, base_url, teams[0].team_id)
        retained_connections = int(state.get("connectionCount") or 0)
        if retained_connections != len(clients):
            raise LoadFailure(
                f"Esperadas {len(clients)} conexoes simultaneas, fixture reteve {retained_connections}."
            )

        invite_ms = list(await asyncio.gather(*(
            _send_event_and_wait_ack(
                load_team.owner,
                load_team.call_id,
                "CALL_INVITE",
                scope="team",
            )
            for load_team in teams
        )))
        accept_ms = list(await asyncio.gather(*(
            _send_event_and_wait_ack(client, load_team.call_id, "CALL_ACCEPT")
            for load_team in teams
            for client in load_team.clients[1:]
        )))

        async def wait_team_convergence(load_team: LoadTeam) -> float:
            async def probe() -> dict[str, Any]:
                payload, _ = await _active_calls(http, base_url, load_team.owner.user_id)
                return payload

            _, elapsed = await _poll_until(
                probe,
                lambda payload: any(
                    call.get("callId") == load_team.call_id
                    and int(call.get("joinedCount") or 0) == participants
                    for call in payload.get("calls", [])
                ),
                deadline_seconds=EVENT_DEADLINE_SECONDS,
                interval_seconds=STATE_POLL_INTERVAL_SECONDS,
                description=f"convergencia da chamada {load_team.call_id}",
            )
            return elapsed * 1000

        state_convergence_ms = list(await asyncio.gather(*(wait_team_convergence(team_) for team_ in teams)))

        async def signal_to_owner(load_team: LoadTeam, sender: SocketClient) -> float:
            marker = f"signal-{iteration}-{sender.user_id}"
            cursor = load_team.owner.cursor
            started = time.perf_counter()
            await sender.send({
                "type": "CALL_SIGNAL",
                "callId": load_team.call_id,
                "clientId": sender.client_id,
                "targetUserId": load_team.owner.user_id,
                "signal": {"benchmarkId": marker},
            })
            received_at, _ = await load_team.owner.wait_for(
                lambda message: (
                    message.get("type") == "CALL_SIGNAL"
                    and (message.get("signal") or {}).get("benchmarkId") == marker
                ),
                after=cursor,
                timeout=EVENT_DEADLINE_SECONDS,
            )
            return (received_at - started) * 1000

        signal_ms = list(await asyncio.gather(*(
            signal_to_owner(load_team, sender)
            for load_team in teams
            for sender in load_team.clients[1:]
        )))
        heartbeat_ms = list(await asyncio.gather(*(
            _send_event_and_wait_ack(client, load_team.call_id, "CALL_HEARTBEAT")
            for load_team in teams
            for client in load_team.clients
        )))
        state_ms = [
            elapsed
            for _, elapsed in await asyncio.gather(*(
                _active_calls(http, base_url, load_team.owner.user_id)
                for load_team in teams
            ))
        ]

        ghost_team = teams[0]
        ghost_client = ghost_team.clients[-1]
        ghost_started = time.perf_counter()
        await ghost_client.abort()

        def ghost_removed(payload: dict[str, Any]) -> bool:
            call = next(
                (item for item in payload.get("calls", []) if item.get("callId") == ghost_team.call_id),
                None,
            )
            return isinstance(call, dict) and ghost_client.user_id not in call.get("participantIds", [])

        _, ghost_seconds = await _poll_until(
            lambda: _fixture_state(http, base_url, ghost_team.team_id),
            ghost_removed,
            deadline_seconds=ghost_deadline,
            interval_seconds=LIFECYCLE_POLL_INTERVAL_SECONDS,
            description=f"remocao fantasma de {ghost_client.user_id}",
        )
        # Mede desde o abort, nao desde a primeira consulta HTTP.
        ghost_seconds = time.perf_counter() - ghost_started

        if measure_silent_timeout:
            silent_team = teams[1] if len(teams) > 1 else teams[0]
            candidates = [client for client in silent_team.clients[1:] if not client.closed]
            if not candidates:
                raise LoadFailure("Nao ha participante para medir sobrevivencia sem heartbeat.")
            silent_client = candidates[0]
            await _send_event_and_wait_ack(silent_client, silent_team.call_id, "CALL_HEARTBEAT")
            keepalive_clients = [
                client for client in clients
                if client is not silent_client and client is not ghost_client and not client.closed
            ]
            calls_by_team = {load_team.team_id: load_team.call_id for load_team in teams}
            keepalive_task = asyncio.create_task(
                _keep_participants_alive(keepalive_clients, calls_by_team, keepalive_stop),
                name="team-call-load-keepers",
            )
            silent_started = time.perf_counter()

            def silent_present(payload: dict[str, Any]) -> bool:
                call = next(
                    (item for item in payload.get("calls", []) if item.get("callId") == silent_team.call_id),
                    None,
                )
                return isinstance(call, dict) and silent_client.user_id in call.get("participantIds", [])

            def silent_removed(payload: dict[str, Any]) -> bool:
                call = next(
                    (item for item in payload.get("calls", []) if item.get("callId") == silent_team.call_id),
                    None,
                )
                return isinstance(call, dict) and silent_client.user_id not in call.get("participantIds", [])

            # Um socket ativo comprova presenca mesmo quando timers do navegador
            # param de enviar CALL_HEARTBEAT em segundo plano.
            while True:
                state = await _fixture_state(http, base_url, silent_team.team_id)
                if not silent_present(state):
                    raise LoadFailure(f"Socket vivo de {silent_client.user_id} foi removido sem heartbeat.")
                elapsed = time.perf_counter() - silent_started
                if elapsed >= silent_duration:
                    break
                await asyncio.sleep(min(LIFECYCLE_POLL_INTERVAL_SECONDS, silent_duration - elapsed))
            silent_survival_seconds = time.perf_counter() - silent_started
            await silent_client.close()
            disconnected_at = time.perf_counter()
            await _poll_until(
                lambda: _fixture_state(http, base_url, silent_team.team_id),
                silent_removed,
                deadline_seconds=ghost_deadline,
                interval_seconds=LIFECYCLE_POLL_INTERVAL_SECONDS,
                description=f"remocao apos desconexao de {silent_client.user_id}",
            )
            silent_disconnect_seconds = time.perf_counter() - disconnected_at

        final_state = await _fixture_state(http, base_url, teams[0].team_id)
        retained_after_load = int(final_state.get("connectionCount") or 0)
        expected_after_abort = len(clients) - 1 - int(measure_silent_timeout)
        if retained_after_load != expected_after_abort:
            raise LoadFailure(
                f"Apos abort esperado {expected_after_abort} sockets, fixture reportou {retained_after_load}."
            )
    finally:
        keepalive_stop.set()
        if keepalive_task is not None:
            await asyncio.gather(keepalive_task, return_exceptions=True)
        await asyncio.gather(*(client.close() for client in clients), return_exceptions=True)
        try:
            await _json_request(http, "POST", f"{base_url}/__test__/reset")
        finally:
            await rss_sampler.stop()

    residual_rss = _read_rss_bytes(process_id)
    if residual_rss is None:
        raise LoadFailure("Nao foi possivel medir RSS residual do backend.")
    peak_rss = max([baseline_rss, residual_rss, *rss_sampler.samples])
    mib = 1024 * 1024
    return {
        "iteration": iteration + 1,
        "requestedConnections": len(clients),
        "retainedConnections": retained_connections,
        "retainedAfterAbruptClose": retained_after_load,
        "handshakeMs": handshake_ms,
        "callControlMs": [*invite_ms, *accept_ms],
        "signalMs": signal_ms,
        "heartbeatMs": heartbeat_ms,
        "stateQueryMs": state_ms,
        "stateConvergenceMs": state_convergence_ms,
        "ghostRemovalSeconds": ghost_seconds,
        "silentSocketSurvivalSeconds": silent_survival_seconds,
        "silentDisconnectRemovalSeconds": silent_disconnect_seconds,
        "memory": {
            "baselineRssMiB": round(baseline_rss / mib, 3),
            "peakRssMiB": round(peak_rss / mib, 3),
            "peakDeltaMiB": round((peak_rss - baseline_rss) / mib, 3),
            "residualRssMiB": round(residual_rss / mib, 3),
            "residualDeltaMiB": round((residual_rss - baseline_rss) / mib, 3),
            "sampleCount": len(rss_sampler.samples),
        },
    }


def _aggregate(iterations: list[dict[str, Any]]) -> dict[str, Any]:
    def flatten(name: str) -> list[float]:
        return [float(value) for iteration in iterations for value in iteration[name]]

    ghost_values = [float(item["ghostRemovalSeconds"]) for item in iterations]
    silent_survival_values = [
        float(item["silentSocketSurvivalSeconds"])
        for item in iterations
        if item["silentSocketSurvivalSeconds"] is not None
    ]
    silent_disconnect_values = [
        float(item["silentDisconnectRemovalSeconds"])
        for item in iterations
        if item["silentDisconnectRemovalSeconds"] is not None
    ]
    return {
        "connections": {
            "requested": max(int(item["requestedConnections"]) for item in iterations),
            "minimumRetained": min(int(item["retainedConnections"]) for item in iterations),
        },
        "handshakeMs": _distribution(flatten("handshakeMs")),
        "callControlMs": _distribution(flatten("callControlMs")),
        "signalMs": _distribution(flatten("signalMs")),
        "heartbeatMs": _distribution(flatten("heartbeatMs")),
        "stateQueryMs": _distribution(flatten("stateQueryMs")),
        "stateConvergenceMs": _distribution(flatten("stateConvergenceMs")),
        "ghostRemovalSeconds": _distribution(ghost_values),
        "silentSocketSurvivalSeconds": _distribution(silent_survival_values),
        "silentDisconnectRemovalSeconds": _distribution(silent_disconnect_values),
        "memory": {
            "maxPeakRssMiB": max(float(item["memory"]["peakRssMiB"]) for item in iterations),
            "maxPeakDeltaMiB": max(float(item["memory"]["peakDeltaMiB"]) for item in iterations),
            "maxResidualDeltaMiB": max(float(item["memory"]["residualDeltaMiB"]) for item in iterations),
        },
    }


def _evaluate(aggregate: dict[str, Any], thresholds: Thresholds) -> list[str]:
    violations: list[str] = []

    def at_most(label: str, actual: float, limit: float) -> None:
        if actual > limit:
            violations.append(f"{label}: {actual:.3f} > {limit:.3f}")

    retained = int(aggregate["connections"]["minimumRetained"])
    if retained < thresholds.min_simultaneous_connections:
        violations.append(
            f"conexoes simultaneas: {retained} < {thresholds.min_simultaneous_connections}"
        )
    at_most("handshake p95 ms", float(aggregate["handshakeMs"]["p95"]), thresholds.handshake_p95_ms)
    at_most("handshake p99 ms", float(aggregate["handshakeMs"]["p99"]), thresholds.handshake_p99_ms)
    at_most(
        "controle de chamada p95 ms",
        float(aggregate["callControlMs"]["p95"]),
        thresholds.call_control_p95_ms,
    )
    at_most(
        "controle de chamada p99 ms",
        float(aggregate["callControlMs"]["p99"]),
        thresholds.call_control_p99_ms,
    )
    at_most("sinal p95 ms", float(aggregate["signalMs"]["p95"]), thresholds.signal_p95_ms)
    at_most("sinal p99 ms", float(aggregate["signalMs"]["p99"]), thresholds.signal_p99_ms)
    at_most("heartbeat p95 ms", float(aggregate["heartbeatMs"]["p95"]), thresholds.heartbeat_p95_ms)
    at_most("heartbeat p99 ms", float(aggregate["heartbeatMs"]["p99"]), thresholds.heartbeat_p99_ms)
    at_most("estado p95 ms", float(aggregate["stateQueryMs"]["p95"]), thresholds.state_p95_ms)
    at_most("estado p99 ms", float(aggregate["stateQueryMs"]["p99"]), thresholds.state_p99_ms)
    at_most(
        "convergencia de estado max ms",
        float(aggregate["stateConvergenceMs"]["max"]),
        thresholds.state_convergence_ms,
    )
    at_most(
        "remocao fantasma max s",
        float(aggregate["ghostRemovalSeconds"]["max"]),
        thresholds.ghost_removal_seconds,
    )
    if float(aggregate["silentSocketSurvivalSeconds"]["min"]) < thresholds.silent_socket_survival_seconds:
        violations.append("socket vivo nao sobreviveu sem heartbeat pelo tempo minimo")
    at_most(
        "remocao apos desconexao max s",
        float(aggregate["silentDisconnectRemovalSeconds"]["max"]),
        thresholds.ghost_removal_seconds,
    )
    at_most("RSS pico MiB", float(aggregate["memory"]["maxPeakRssMiB"]), thresholds.max_rss_mib)
    at_most(
        "RSS delta pico MiB",
        float(aggregate["memory"]["maxPeakDeltaMiB"]),
        thresholds.max_rss_delta_mib,
    )
    at_most(
        "RSS delta residual MiB",
        float(aggregate["memory"]["maxResidualDeltaMiB"]),
        thresholds.max_residual_rss_delta_mib,
    )
    return violations


def _thresholds(arguments: argparse.Namespace) -> Thresholds:
    requested = arguments.teams * arguments.participants
    return Thresholds(
        handshake_p95_ms=arguments.handshake_p95_ms,
        handshake_p99_ms=arguments.handshake_p99_ms,
        call_control_p95_ms=arguments.call_control_p95_ms,
        call_control_p99_ms=arguments.call_control_p99_ms,
        signal_p95_ms=arguments.signal_p95_ms,
        signal_p99_ms=arguments.signal_p99_ms,
        heartbeat_p95_ms=arguments.heartbeat_p95_ms,
        heartbeat_p99_ms=arguments.heartbeat_p99_ms,
        state_p95_ms=arguments.state_p95_ms,
        state_p99_ms=arguments.state_p99_ms,
        state_convergence_ms=arguments.state_convergence_ms,
        ghost_removal_seconds=arguments.ghost_removal_seconds,
        silent_socket_survival_seconds=arguments.silent_socket_survival_seconds,
        max_rss_mib=arguments.max_rss_mib,
        max_rss_delta_mib=arguments.max_rss_delta_mib,
        max_residual_rss_delta_mib=arguments.max_residual_rss_delta_mib,
        min_simultaneous_connections=(
            arguments.min_simultaneous_connections
            if arguments.min_simultaneous_connections is not None
            else requested
        ),
    )


async def _run(arguments: argparse.Namespace) -> tuple[dict[str, Any], ManagedFixture | None]:
    backend_root = Path(__file__).resolve().parents[1]
    resolved_port = arguments.port or _available_loopback_port(arguments.host)
    base_url = arguments.base_url or f"http://{arguments.host}:{resolved_port}"
    ws_base_url = arguments.ws_url or base_url.replace("https://", "wss://").replace("http://", "ws://")
    managed: ManagedFixture | None = None
    if arguments.external_server:
        process_id = arguments.server_pid
    else:
        managed = ManagedFixture(
            backend_root,
            arguments.host,
            resolved_port,
            arguments.teams,
            arguments.participants,
            arguments.artifacts_dir.resolve(),
        )
        try:
            managed.start()
            await managed.wait_ready(base_url)
        except BaseException:
            managed.stop(passed=False, artifacts_dir=arguments.artifacts_dir.resolve())
            raise
        if managed.process is None:
            raise LoadFailure("Fixture gerenciado nao iniciou.")
        process_id = managed.process.pid

    try:
        thresholds = _thresholds(arguments)
        iterations: list[dict[str, Any]] = []
        async with httpx.AsyncClient(timeout=EVENT_DEADLINE_SECONDS) as http:
            fixture_identity, _ = await _json_request(
                http,
                "GET",
                f"{base_url.rstrip('/')}/__test__/state",
                params={"teamId": "owner"},
            )
            # Em alguns ambientes Windows o executavel do venv e um launcher;
            # o PID exposto pelo fixture identifica o processo Python que
            # realmente detem sockets e estado.
            reported_process_id = int(fixture_identity.get("processId") or 0)
            process_id = reported_process_id or process_id
            if process_id <= 0:
                raise LoadFailure("Fixture nao informou PID para o gate de memoria.")
            for iteration in range(arguments.repeat):
                iterations.append(await _run_iteration(
                    iteration,
                    team_count=arguments.teams,
                    participants=arguments.participants,
                    base_url=base_url.rstrip("/"),
                    ws_base_url=ws_base_url.rstrip("/"),
                    http=http,
                    process_id=process_id,
                    measure_silent_timeout=iteration == 0,
                    ghost_deadline=thresholds.ghost_removal_seconds + 1.0,
                    silent_duration=thresholds.silent_socket_survival_seconds,
                ))
        aggregate = _aggregate(iterations)
        violations = _evaluate(aggregate, thresholds)
        result = {
            "schemaVersion": 1,
            "status": "failed" if violations else "passed",
            "configuration": {
                "target": "external-fixture" if arguments.external_server else "managed-local-fixture",
                "teams": arguments.teams,
                "participantsPerTeam": arguments.participants,
                "repeat": arguments.repeat,
                "managedFixture": not arguments.external_server,
            },
            "thresholds": asdict(thresholds),
            "aggregate": aggregate,
            "iterations": iterations,
            "violations": violations,
        }
        return result, managed
    except BaseException:
        if managed is not None:
            managed.stop(passed=False, artifacts_dir=arguments.artifacts_dir.resolve())
        raise


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=0, help="0 escolhe uma porta loopback livre.")
    parser.add_argument("--base-url")
    parser.add_argument("--ws-url", help="Base ws://host:port; o path do team-chat e adicionado.")
    parser.add_argument("--external-server", action="store_true")
    parser.add_argument("--server-pid", type=int, default=0)
    parser.add_argument("--teams", type=int, default=25)
    parser.add_argument("--participants", type=int, default=4)
    parser.add_argument("--repeat", type=int, default=3)
    parser.add_argument("--artifacts-dir", type=Path, default=Path("output/team-call-quality/load"))
    parser.add_argument("--handshake-p95-ms", type=float, default=_env_float("TEAM_CALL_LOAD_HANDSHAKE_P95_MS", 1500))
    parser.add_argument("--handshake-p99-ms", type=float, default=_env_float("TEAM_CALL_LOAD_HANDSHAKE_P99_MS", 3000))
    parser.add_argument("--call-control-p95-ms", type=float, default=_env_float("TEAM_CALL_LOAD_CONTROL_P95_MS", 750))
    parser.add_argument("--call-control-p99-ms", type=float, default=_env_float("TEAM_CALL_LOAD_CONTROL_P99_MS", 1200))
    parser.add_argument("--signal-p95-ms", type=float, default=_env_float("TEAM_CALL_LOAD_SIGNAL_P95_MS", 400))
    parser.add_argument("--signal-p99-ms", type=float, default=_env_float("TEAM_CALL_LOAD_SIGNAL_P99_MS", 1000))
    parser.add_argument("--heartbeat-p95-ms", type=float, default=_env_float("TEAM_CALL_LOAD_HEARTBEAT_P95_MS", 750))
    parser.add_argument("--heartbeat-p99-ms", type=float, default=_env_float("TEAM_CALL_LOAD_HEARTBEAT_P99_MS", 1000))
    parser.add_argument("--state-p95-ms", type=float, default=_env_float("TEAM_CALL_LOAD_STATE_P95_MS", 500))
    parser.add_argument("--state-p99-ms", type=float, default=_env_float("TEAM_CALL_LOAD_STATE_P99_MS", 1200))
    parser.add_argument("--state-convergence-ms", type=float, default=_env_float("TEAM_CALL_LOAD_STATE_CONVERGENCE_MS", 2000))
    parser.add_argument("--ghost-removal-seconds", type=float, default=_env_float("TEAM_CALL_LOAD_GHOST_SECONDS", 12))
    parser.add_argument(
        "--silent-socket-survival-seconds", "--silent-heartbeat-removal-seconds",
        dest="silent_socket_survival_seconds",
        type=float,
        default=_env_float("TEAM_CALL_LOAD_SILENT_SOCKET_SECONDS", _env_float("TEAM_CALL_LOAD_SILENT_HEARTBEAT_SECONDS", 36)),
    )
    parser.add_argument("--max-rss-mib", type=float, default=_env_float("TEAM_CALL_LOAD_MAX_RSS_MIB", 768))
    parser.add_argument("--max-rss-delta-mib", type=float, default=_env_float("TEAM_CALL_LOAD_MAX_RSS_DELTA_MIB", 256))
    parser.add_argument(
        "--max-residual-rss-delta-mib",
        type=float,
        default=_env_float("TEAM_CALL_LOAD_MAX_RESIDUAL_RSS_DELTA_MIB", 96),
    )
    parser.add_argument("--min-simultaneous-connections", type=int)
    return parser


def main() -> int:
    parser = _parser()
    arguments = parser.parse_args()
    if arguments.teams < 1 or arguments.participants < 2 or arguments.repeat < 1:
        parser.error("--teams >= 1, --participants >= 2 e --repeat >= 1 sao obrigatorios.")
    artifacts_dir = arguments.artifacts_dir.resolve()
    artifacts_dir.mkdir(parents=True, exist_ok=True)
    managed: ManagedFixture | None = None
    passed = False
    try:
        result, managed = asyncio.run(_run(arguments))
        passed = result["status"] == "passed"
    except BaseException as error:
        result = {
            "schemaVersion": 1,
            "status": "failed",
            "error": type(error).__name__,
            "traceback": [f"{Path(frame.filename).name}:{frame.lineno}"
                          for frame in traceback.extract_tb(error.__traceback__)[-40:]],
        }
        # Se a excecao ocorreu depois do start mas antes do retorno de _run,
        # recupera o processo gerenciado pela porta para o bloco finally nao e
        # seguro; _run mantem ownership apenas quando retorna. Esse caso e
        # evitado abaixo executando shutdown no wrapper de task.
    finally:
        if managed is not None:
            managed.stop(passed=passed, artifacts_dir=artifacts_dir)
    output_path = artifacts_dir / "team-call-load.json"
    output_path.write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    if passed:
        aggregate = result["aggregate"]
        print(json.dumps({
            "status": "passed",
            "connections": aggregate["connections"],
            "signalP95Ms": aggregate["signalMs"]["p95"],
            "heartbeatP95Ms": aggregate["heartbeatMs"]["p95"],
            "ghostMaxSeconds": aggregate["ghostRemovalSeconds"]["max"],
            "rssPeakMiB": aggregate["memory"]["maxPeakRssMiB"],
            "result": str(output_path),
        }, ensure_ascii=False))
        return 0
    print(json.dumps({"status": "failed", "result": str(output_path), "details": result.get("violations") or result.get("error")}, ensure_ascii=False))
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
