"""Hermetic browser quality gate for team calls.

The suite starts the real FastAPI fixture, Vite and (unless ``--external-turn``
is supplied) the local test TURN process. Chromium receives deterministic WAV
and Y4M files through its native fake-media device. Signalling, HTTP, WebSocket,
RTCPeerConnection, RTP and permission decisions remain browser/server native.

Only aggregate diagnostics, error classes and source positions are preserved.
Raw service output, media, traces, addresses and exception text are discarded.
``summary.json`` is always written because it is the CI result.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import json
import math
import os
import secrets
import shutil
import socket
import struct
import subprocess
import sys
import time
import traceback
import urllib.error
import urllib.request
import wave
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Awaitable, Callable

from playwright.async_api import Browser, BrowserContext, Page, async_playwright, expect


BROWSER_DIR = Path(__file__).resolve().parent
FRONTEND_DIR = BROWSER_DIR.parents[1]
WORKTREE = FRONTEND_DIR.parent
BACKEND_DIR = WORKTREE / "norium-back-end"
FRONTEND_HOST = "127.0.0.2"  # lets runtime API_URL override the fixed local-dev URL
BACKEND_HOST = "127.0.0.1"
DEFAULT_TIMEOUT_MS = 15_000
# Browser tab teardown can take one server receive cycle (5s) before the
# coordinator's explicit 8s disconnect grace starts.
GHOST_DEADLINE_SECONDS = 18.0


@contextlib.contextmanager
def disposable_workspace(parent: Path):
    path = parent / f"norium-team-call-e2e-{secrets.token_hex(8)}"
    path.mkdir(parents=True, exist_ok=False)
    try:
        yield path
    finally:
        if path.exists():
            remove_disposable_workspace(path)


def remove_disposable_workspace(path: Path) -> None:
    deadline = time.monotonic() + 3
    while path.exists():
        try:
            shutil.rmtree(path)
            break
        except PermissionError:
            if time.monotonic() >= deadline:
                raise
            time.sleep(0.05)


def reserve_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", 0))
        return int(listener.getsockname()[1])


def reserve_dual_port() -> int:
    """Find a port currently bindable for both TURN UDP and TCP listeners."""
    # Windows commonly reserves chunks of its dynamic UDP range for Hyper-V,
    # even when the same ephemeral TCP port was available.
    for _ in range(500):
        port = 20_000 + secrets.randbelow(20_000)
        tcp = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        udp = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            tcp.bind(("127.0.0.1", port))
            udp.bind(("127.0.0.1", port))
            return port
        except OSError:
            continue
        finally:
            tcp.close()
            udp.close()
    raise RuntimeError("could not reserve a TCP/UDP port for TURN")


def write_json_atomic(path: Path, payload: dict[str, Any]) -> None:
    temporary = path.with_name(f".{path.name}.{secrets.token_hex(4)}.tmp")
    try:
        temporary.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
        os.replace(temporary, path)
    finally:
        with contextlib.suppress(FileNotFoundError):
            temporary.unlink()


def write_fake_audio(path: Path, seconds: int = 30) -> None:
    rate = 48_000
    with wave.open(str(path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(rate)
        frames = bytearray()
        for index in range(rate * seconds):
            value = int(7_000 * math.sin(2 * math.pi * 440 * index / rate))
            frames.extend(struct.pack("<h", value))
        output.writeframes(frames)


def write_fake_video(path: Path, seconds: int = 30) -> None:
    width, height, fps = 160, 120, 10
    with path.open("wb") as output:
        output.write(f"YUV4MPEG2 W{width} H{height} F{fps}:1 Ip A1:1 C420jpeg\n".encode())
        for index in range(seconds * fps):
            output.write(b"FRAME\n")
            luminance = bytes(((x + index * 3) % 180 + 40 for x in range(width)))
            output.write(luminance * height)
            output.write(bytes([90 + index % 30]) * (width * height // 4))
            output.write(bytes([160 - index % 30]) * (width * height // 4))


def _http_json(method: str, url: str, payload: dict[str, Any] | None = None) -> tuple[int, Any]:
    data = json.dumps(payload).encode() if payload is not None else None
    request = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={"Content-Type": "application/json"} if data is not None else {},
    )
    try:
        with urllib.request.urlopen(request, timeout=3) as response:
            body = response.read()
            if not body:
                return response.status, None
            with contextlib.suppress(json.JSONDecodeError):
                return response.status, json.loads(body)
            return response.status, body.decode(errors="replace")
    except urllib.error.HTTPError as error:
        body = error.read()
        with contextlib.suppress(Exception):
            return error.code, json.loads(body)
        return error.code, body.decode(errors="replace")


async def http_json(method: str, url: str, payload: dict[str, Any] | None = None) -> tuple[int, Any]:
    return await asyncio.to_thread(_http_json, method, url, payload)


@dataclass
class ManagedProcess:
    name: str
    command: list[str]
    cwd: Path
    environment: dict[str, str]
    log_path: Path
    process: subprocess.Popen[bytes] | None = None
    _log: Any = None

    def start(self) -> None:
        self.log_path.parent.mkdir(parents=True, exist_ok=True)
        self._log = self.log_path.open("wb")
        self.process = subprocess.Popen(
            self.command,
            cwd=self.cwd,
            env=self.environment,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.STDOUT,
        )

    async def stop(self) -> None:
        try:
            if self.process and self.process.poll() is None:
                self.process.terminate()
                try:
                    await asyncio.wait_for(asyncio.to_thread(self.process.wait), 5)
                except asyncio.TimeoutError:
                    self.process.kill()
                    await asyncio.wait_for(asyncio.to_thread(self.process.wait), 5)
        except Exception:
            if self.process and self.process.poll() is None:
                with contextlib.suppress(Exception):
                    self.process.kill()
                    await asyncio.wait_for(asyncio.to_thread(self.process.wait), 5)
            raise
        finally:
            if self._log:
                self._log.close()

    def assert_alive(self) -> None:
        if self.process and self.process.poll() is not None:
            raise RuntimeError(f"{self.name} exited with {self.process.returncode}")


async def wait_http(url: str, process: ManagedProcess, timeout: float = 30) -> None:
    deadline = time.monotonic() + timeout
    last_status: int | None = None
    while time.monotonic() < deadline:
        process.assert_alive()
        try:
            last_status, _ = await http_json("GET", url)
            if last_status == 200:
                return
        except (OSError, TimeoutError, urllib.error.URLError):
            pass
        await asyncio.sleep(0.1)
    raise TimeoutError(f"{process.name} did not become ready at {url}; last status={last_status}")


@dataclass
class Services:
    temporary: Path
    api_port: int
    frontend_port: int
    turn_port: int | None
    processes: list[ManagedProcess]
    api_url: str
    frontend_url: str
    ws_url: str
    turn_mode: str
    turn_health_url: str | None = None

    async def stop(self) -> list[str]:
        errors: list[str] = []
        for process in reversed(self.processes):
            try:
                await process.stop()
            except Exception as error:
                errors.append(f"{process.name}: {type(error).__name__}")
        return errors


def copy_service_logs(processes: list[ManagedProcess], destination: Path) -> list[str]:
    errors: list[str] = []
    try:
        destination.mkdir(parents=True, exist_ok=True)
        for process in processes:
            if not process.log_path.exists():
                continue
            try:
                # Raw service logs can contain ticket URLs or network addresses.
                lines = process.log_path.read_text(errors="replace").splitlines()
                (destination / (process.name + ".json")).write_text(json.dumps({
                    "lines": len(lines), "errorLines": sum("error" in line.lower() for line in lines),
                    "rawLogsRetained": False,
                }), encoding="utf-8")
            except Exception as error:
                errors.append(f"{process.name}: {type(error).__name__}")
    except Exception as error:
        errors.append(f"failure directory: {type(error).__name__}")
    return errors


_STARTUP_PROCESSES: list[ManagedProcess] = []


async def start_services(args: argparse.Namespace, temporary: Path) -> Services:
    api_port = args.api_port or reserve_port()
    frontend_port = args.frontend_port or reserve_port()
    processes: list[ManagedProcess] = []
    _STARTUP_PROCESSES.clear()
    backend_env = os.environ.copy()
    # The fixture cohort is isolated from the production rollout configuration.
    backend_env.update({"TEAM_CALL_ENABLED": "true", "TEAM_CALL_ROLLOUT_PERCENT": "100",
                        "TEAM_CALL_RECORDING_ENABLED": "true"})
    turn_port: int | None = None
    turn_mode = "external"
    turn_health_url: str | None = None

    if not args.external_turn:
        turn_mode = "local-udp"
        turn_port = args.turn_port or reserve_dual_port()
        health_port = reserve_port()
        unused_tls_port = reserve_port()
        secret = secrets.token_urlsafe(36)
        turn_env = os.environ.copy()
        turn_env.update({
            "TURN_TEST_SECRET": secret,
            "TURN_TEST_REALM": "team-calls.test",
            "TURN_TEST_HOST": "127.0.0.1",
            "TURN_TEST_EXTERNAL_IP": "127.0.0.1",
            "TURN_TEST_PORT": str(turn_port),
            "TURN_TEST_HEALTH_PORT": str(health_port),
        })
        turn = ManagedProcess(
            "TURN",
            [args.node, str(BROWSER_DIR / "local_turn_server.mjs")],
            FRONTEND_DIR,
            turn_env,
            temporary / "services" / "turn.log",
        )
        turn.start()
        processes.append(turn)
        _STARTUP_PROCESSES.append(turn)
        turn_health_url = f"http://127.0.0.1:{health_port}/healthz"
        await wait_http(turn_health_url, turn)
        backend_env.update({
            "TEAM_CALL_TURN_REQUIRED": "true",
            "TEAM_CALL_STUN_URLS": f"stun:127.0.0.1:{turn_port}",
            # The UDP endpoint is exercised. The unavailable TLS URL keeps the
            # product contract honest, but this suite never reports TLS proven.
            "TEAM_CALL_TURN_URLS": (
                f"turn:127.0.0.1:{turn_port}?transport=udp,"
                f"turns:127.0.0.1:{unused_tls_port}?transport=tcp"
            ),
            "TEAM_CALL_TURN_SHARED_SECRET": secret,
            "TEAM_CALL_TURN_TTL_SECONDS": "300",
            "TEAM_CALL_TURN_REFRESH_MARGIN_SECONDS": "60",
        })
    else:
        urls = backend_env.get("TEAM_CALL_TURN_URLS", "")
        secret = backend_env.get("TEAM_CALL_TURN_SHARED_SECRET", "")
        if not urls or not secret:
            raise RuntimeError("--external-turn requires TEAM_CALL_TURN_URLS and TEAM_CALL_TURN_SHARED_SECRET")
        backend_env["TEAM_CALL_TURN_REQUIRED"] = "true"

    backend = ManagedProcess(
        "backend",
        [sys.executable, "-m", "uvicorn", "tests.team_call_browser_app:app", "--host", BACKEND_HOST, "--port", str(api_port)],
        BACKEND_DIR,
        backend_env,
        temporary / "services" / "backend.log",
    )
    backend.start()
    processes.append(backend)
    _STARTUP_PROCESSES.append(backend)
    await wait_http(f"http://{BACKEND_HOST}:{api_port}/openapi.json", backend)

    vite_entry = FRONTEND_DIR / "node_modules" / "vite" / "bin" / "vite.js"
    frontend = ManagedProcess(
        "frontend",
        [args.node, str(vite_entry), "--host", "0.0.0.0", "--port", str(frontend_port), "--strictPort"],
        FRONTEND_DIR,
        os.environ.copy(),
        temporary / "services" / "frontend.log",
    )
    frontend.start()
    processes.append(frontend)
    _STARTUP_PROCESSES.append(frontend)
    await wait_http(f"http://{FRONTEND_HOST}:{frontend_port}/tests/browser/calls.html", frontend)

    services = Services(
        temporary=temporary,
        api_port=api_port,
        frontend_port=frontend_port,
        turn_port=turn_port,
        processes=processes,
        api_url=f"http://{BACKEND_HOST}:{api_port}",
        frontend_url=f"http://{FRONTEND_HOST}:{frontend_port}",
        ws_url=f"ws://{BACKEND_HOST}:{api_port}",
        turn_mode=turn_mode,
        turn_health_url=turn_health_url,
    )
    _STARTUP_PROCESSES.clear()
    return services


INIT_SCRIPT = """
({apiUrl, wsUrl}) => {
  window.__NORIUM_CONFIG__ = { API_URL: apiUrl, WS_URL: wsUrl };
  window.__peerConnections = [];
  const NativePeerConnection = window.RTCPeerConnection;
  window.RTCPeerConnection = class FixturePeerConnection extends NativePeerConnection {
    constructor(configuration) {
      super(configuration);
      this.__stateHistory = [];
      const capture = () => this.__stateHistory.push({
        connectionState: this.connectionState,
        iceConnectionState: this.iceConnectionState,
        signalingState: this.signalingState,
        at: performance.now(),
      });
      for (const event of ['connectionstatechange', 'iceconnectionstatechange', 'signalingstatechange']) {
        this.addEventListener(event, capture);
      }
      capture();
      window.__peerConnections.push(this);
    }
  };
}
"""


@dataclass
class BrowserSession:
    name: str
    user: str
    context: BrowserContext
    page: Page
    raw_dir: Path
    console: list[str] = field(default_factory=list)


def register_browser_diagnostics(page: Page, events: list[str]) -> None:
    """Retain bounded event categories, never request URLs or raw errors."""
    def record(category: str) -> None:
        if len(events) < 256:
            events.append(category)

    page.on("console", lambda message: record(
        "console.error" if message.type == "error" else "console.other"
    ))
    page.on("pageerror", lambda _error: record("pageerror"))
    page.on("requestfailed", lambda _request: record("requestfailed"))


def sanitized_call_state(value: dict[str, Any]) -> dict[str, str]:
    """Project only known enum values; discard notices, identifiers and media."""
    allowed = {
        "phase": {"idle", "prejoin", "joining", "connected", "reconnecting", "ending", "failed"},
        "socketState": {"connecting", "open", "reconnecting", "closed"},
        "microphonePermission": {"unknown", "requesting", "granted", "denied", "unavailable"},
        "cameraPermission": {"unknown", "requesting", "granted", "denied", "unavailable"},
    }
    return {
        key: item if isinstance(item := value.get(key), str) and item in choices else "unknown"
        for key, choices in allowed.items()
    }


class ScenarioRuntime:
    def __init__(self, browser: Browser, services: Services, raw_dir: Path, *, record_video: bool):
        self.browser = browser
        self.services = services
        self.raw_dir = raw_dir
        self.record_video = False  # Release privacy policy excludes media artifacts.
        self.sessions: list[BrowserSession] = []

    async def page(
        self,
        user: str,
        *,
        name: str | None = None,
        relay: bool = False,
        drawer: bool = False,
        context: BrowserContext | None = None,
        grant_media: bool = True,
    ) -> BrowserSession:
        session_name = name or user
        video_dir = self.raw_dir / session_name / "video"
        video_dir.mkdir(parents=True, exist_ok=True)
        own_context = context is None
        registered = False
        try:
            if context is None:
                context_options: dict[str, Any] = {"viewport": {"width": 1280, "height": 800}}
                if self.record_video:
                    context_options["record_video_dir"] = str(video_dir)
                context = await self.browser.new_context(**context_options)
            if grant_media:
                await context.grant_permissions(["microphone", "camera"], origin=self.services.frontend_url)
            page = await context.new_page()
            config = json.dumps({"apiUrl": self.services.api_url, "wsUrl": self.services.ws_url})
            await page.add_init_script(f"({INIT_SCRIPT})({config})")
            messages: list[str] = []
            register_browser_diagnostics(page, messages)
            session = BrowserSession(session_name, user, context, page, video_dir.parent, messages)
            # Register before navigation so a startup failure still yields its
            # screenshot, trace and browser diagnostics.
            self.sessions.append(session)
            registered = True
            suffix = f"user={user}&relay={int(relay)}&drawer={int(drawer)}"
            response = await page.goto(
                f"{self.services.frontend_url}/tests/browser/calls.html?{suffix}",
                wait_until="networkidle",
            )
            if response is None or response.status >= 400:
                status = "no response" if response is None else str(response.status)
                raise AssertionError(f"Browser fixture navigation failed ({status}).")
            await expect(page.get_by_test_id("fixture-ready")).to_have_text("ready", timeout=DEFAULT_TIMEOUT_MS)
            return session
        except Exception:
            # A failure before registration would otherwise hide a context leak
            # from the scenario cleanup accounting.
            if own_context and context is not None and not registered:
                with contextlib.suppress(Exception):
                    await context.tracing.stop()
                with contextlib.suppress(Exception):
                    await context.close()
            raise

    async def preserve_failure(
        self,
        failure_dir: Path,
        *,
        screenshots: bool = True,
        copy_raw: bool = True,
    ) -> None:
        failure_dir.mkdir(parents=True, exist_ok=True)
        logs = [
            f"[{session.name}] {line}"
            for session in self.sessions
            for line in session.console
        ]
        if logs:
            (failure_dir / "browser.log").write_text("\n".join(logs), encoding="utf-8")
        states = []
        for session in self.sessions:
            if session.page.is_closed():
                continue
            with contextlib.suppress(Exception):
                states.append(sanitized_call_state(await diagnostics(session.page)))
        if states:
            write_json_atomic(failure_dir / "call-states.json", {"sessions": states})
        # Intentionally no screenshots, recordings, traces or network bodies.

    async def close(self, failure_dir: Path | None) -> None:
        # Capture every tab before closing any shared context.
        if failure_dir:
            await self.preserve_failure(failure_dir, screenshots=True, copy_raw=False)
        seen_contexts: set[int] = set()
        context_close_errors: list[str] = []
        for session in self.sessions:
            key = id(session.context)
            if key in seen_contexts:
                continue
            seen_contexts.add(key)
            try:
                await asyncio.wait_for(session.context.close(), timeout=8)
            except Exception as error:
                context_close_errors.append(f"{session.name}: {type(error).__name__}")
        if failure_dir:
            await self.preserve_failure(failure_dir, screenshots=False)
        leaked = list(self.browser.contexts)
        if leaked:
            detail = "; ".join(context_close_errors) or "context remained open without a close error"
            raise RuntimeError(f"Browser context cleanup failed: {detail}")


async def diagnostics(page: Page) -> dict[str, Any]:
    return json.loads(await page.get_by_test_id("diagnostics").inner_text())


async def wait_rtp(page: Page, direction: str, kind: str = "audio") -> dict[str, int]:
    report_type = f"{direction}-rtp"
    return await page.evaluate(
        """async ({reportType, kind, timeoutMs}) => {
          const deadline = performance.now() + timeoutMs;
          while (performance.now() < deadline) {
            let bytes = 0;
            let packets = 0;
            for (const pc of window.__peerConnections || []) {
              for (const report of (await pc.getStats()).values()) {
                const mediaKind = report.kind || report.mediaType;
                if (report.type !== reportType || mediaKind !== kind) continue;
                bytes += report.bytesReceived || report.bytesSent || 0;
                packets += report.packetsReceived || report.packetsSent || 0;
              }
            }
            if (bytes > 0 && packets > 0) return {bytes, packets};
            await new Promise(resolve => setTimeout(resolve, 50));
          }
          throw new Error(`No ${reportType} ${kind} packets before ${timeoutMs}ms deadline.`);
        }""",
        {"reportType": report_type, "kind": kind, "timeoutMs": DEFAULT_TIMEOUT_MS},
    )


async def wait_diagnostic(page: Page, expression: str, argument: Any = None, timeout: int = DEFAULT_TIMEOUT_MS) -> None:
    await page.wait_for_function(
        """({expression, argument}) => {
          const node = document.querySelector('[data-testid="diagnostics"]');
          if (!node) return false;
          const value = JSON.parse(node.textContent || '{}');
          return Function('value', 'argument', `return (${expression})`)(value, argument);
        }""",
        arg={"expression": expression, "argument": argument},
        timeout=timeout,
    )


async def click_visible(locator: Any) -> None:
    await locator.filter(visible=True).first.click(timeout=DEFAULT_TIMEOUT_MS)


async def configure_entry(page: Page, mode: str = "muted", camera: bool = False) -> None:
    labels = {
        "on": "Entrar com microfone ligado",
        "muted": "Entrar com microfone desligado",
        "listen-only": "Entrar somente para escutar",
    }
    await expect(page.get_by_role("button", name="Entrar na chamada", exact=True)).to_be_visible()
    await page.get_by_role("radio", name=labels[mode], exact=True).check()
    checkbox = page.get_by_role("checkbox", name="Entrar com câmera ligada", exact=True)
    if camera:
        await checkbox.check()
    else:
        await expect(checkbox).not_to_be_checked()


async def enter_prejoin(
    page: Page,
    mode: str = "muted",
    camera: bool = False,
    *,
    waiting_for_peer_is_settled: bool = False,
) -> None:
    await configure_entry(page, mode, camera)
    await page.get_by_role("button", name="Entrar na chamada", exact=True).click()
    expression = (
        "value.callId && ['connected', 'reconnecting'].includes(value.phase)"
        if waiting_for_peer_is_settled
        else "value.callId && value.phase === 'connected'"
    )
    await wait_diagnostic(page, expression)


async def start_call(page: Page, target: str = "group", mode: str = "muted", camera: bool = False) -> str:
    await page.get_by_test_id(f"start-{target}").click()
    await enter_prejoin(page, mode, camera, waiting_for_peer_is_settled=True)
    return (await diagnostics(page))["callId"]


async def join_call(page: Page, mode: str = "muted", camera: bool = False) -> str:
    incoming = page.get_by_role("button", name="Entrar na reunião", exact=True)
    # A visible incoming-call overlay covers the active-call card. Exclude the
    # covered entry point dynamically so retries always choose the invitation.
    active = page.locator("body").filter(has_not=incoming.filter(visible=True)).get_by_role(
        "button", name="Ingressar na reunião", exact=True)
    # The invite can arrive after the host's acknowledgement. Wait for either
    # entry point instead of making a one-time decision before it is rendered.
    await click_visible(incoming.or_(active))
    await enter_prejoin(page, mode, camera)
    return (await diagnostics(page))["callId"]


async def end_host_call(page: Page) -> None:
    control = page.get_by_role("button", name="Encerrar reunião", exact=True)
    if await control.count() and await control.first.is_visible():
        await control.first.click()
        await wait_diagnostic(page, "!value.callId && value.phase === 'idle'")


async def reset_fixture(services: Services) -> None:
    status, payload = await http_json("POST", f"{services.api_url}/__test__/reset", {})
    if status != 200 or not payload.get("reset"):
        raise AssertionError(f"fixture reset failed: {status} {payload}")


async def scenario_group_media(runtime: ScenarioRuntime) -> dict[str, Any]:
    owner = await runtime.page("owner")
    member = await runtime.page("member")
    other = await runtime.page("other")
    call_id = await start_call(owner.page, "group", "muted")
    assert (await diagnostics(owner.page))["localTrackStates"] == [
        {"kind": "audio", "enabled": False, "readyState": "live"}
    ]
    assert await join_call(member.page, "on") == call_id
    assert await join_call(other.page, "listen-only") == call_id
    await wait_diagnostic(owner.page, "value.remoteUserIds.includes('member') && value.participantIds.includes('other')")
    await wait_diagnostic(member.page, "value.remoteUserIds.includes('owner')")
    inbound = await wait_rtp(owner.page, "inbound")
    outbound = await wait_rtp(member.page, "outbound")
    await end_host_call(owner.page)
    return {"callId": call_id, "participants": 3, "nativeRtp": True, "inbound": inbound, "outbound": outbound}


async def scenario_entry_modes(runtime: ScenarioRuntime) -> dict[str, Any]:
    owner = await runtime.page("owner")
    await start_call(owner.page, "group", "on")
    first = await diagnostics(owner.page)
    assert first["mediaRequests"], "audio-only entry did not request a microphone"
    assert all(not request["video"] for request in first["mediaRequests"]), first["mediaRequests"]
    assert any(track["kind"] == "audio" and track["enabled"] for track in first["localTrackStates"])
    await end_host_call(owner.page)

    before = len((await diagnostics(owner.page))["mediaRequests"])
    await start_call(owner.page, "group", "listen-only")
    listen_only = await diagnostics(owner.page)
    assert len(listen_only["mediaRequests"]) == before, listen_only["mediaRequests"]
    assert listen_only["listenOnly"] and not listen_only["localTrackStates"]
    await end_host_call(owner.page)
    return {"cameraRequested": False, "listenOnlyRequestedMedia": False}


async def scenario_direct_chat_context(runtime: ScenarioRuntime) -> dict[str, Any]:
    owner = await runtime.page("owner", drawer=True)
    member = await runtime.page("member")
    other = await runtime.page("other")
    call_id = await start_call(owner.page, "direct-member", "on")
    assert await join_call(member.page, "on") == call_id
    await wait_fixture_state(
        runtime.services,
        lambda value: bool(value["calls"]) and value["calls"][0]["participantCount"] == 2,
        timeout=5,
    )

    # Move the drawer to a different direct conversation while the call overlay
    # remains bound to the immutable CallSession conversation.
    await owner.page.get_by_role("button", name="Abrir conversa Other", exact=True).click(force=True)
    await wait_diagnostic(owner.page, "value.recipientId === 'member'")
    await owner.page.get_by_role("button", name="Abrir chat da reunião", exact=True).click()
    await member.page.get_by_role("button", name="Abrir chat da reunião", exact=True).click()
    sentinel = f"direct-call-{secrets.token_hex(6)}"
    await owner.page.get_by_placeholder("Digite uma mensagem", exact=True).fill(sentinel)
    await owner.page.get_by_role("button", name="Enviar mensagem", exact=True).click()
    await expect(member.page.get_by_text(sentinel, exact=True)).to_be_visible()
    await expect(other.page.get_by_text(sentinel, exact=True)).to_have_count(0)
    other_events = await other.page.evaluate("window.__callFixture.socketEvents.map(event => event.type)")
    assert "CALL_CHAT_MESSAGE" not in other_events
    await owner.page.get_by_role("button", name="Fechar painel", exact=True).click()
    await end_host_call(owner.page)
    return {"callId": call_id, "recipient": "member", "wrongRecipientObserved": False}


async def selected_candidate_types(page: Page) -> list[dict[str, str]]:
    return await page.evaluate("""async () => {
      const paths = [];
      for (const pc of window.__peerConnections || []) {
        const stats = await pc.getStats();
        const entries = [...stats.values()];
        const transport = entries.find(item => item.type === 'transport' && item.selectedCandidatePairId);
        const report = transport
          ? stats.get(transport.selectedCandidatePairId)
          : entries.find(item => item.type === 'candidate-pair' && item.state === 'succeeded' && (item.nominated || item.selected));
        if (!report) continue;
        const local = stats.get(report.localCandidateId);
        const remote = stats.get(report.remoteCandidateId);
        paths.push({
          localType: local?.candidateType || '',
          remoteType: remote?.candidateType || '',
          protocol: local?.relayProtocol || local?.protocol || '',
        });
      }
      return paths;
    }""")


async def scenario_relay_only(runtime: ScenarioRuntime) -> dict[str, Any]:
    owner = await runtime.page("owner", relay=True)
    member = await runtime.page("member", relay=True)
    await wait_diagnostic(owner.page, "value.iceService === 'ready'")
    call_id = await start_call(owner.page, "group", "on")
    assert await join_call(member.page, "on") == call_id
    try:
        await wait_diagnostic(owner.page, "value.relayObserved === true", timeout=25_000)
        await wait_diagnostic(member.page, "value.relayObserved === true", timeout=25_000)
    except Exception as error:
        raise AssertionError(json.dumps({
            "owner": await diagnostics(owner.page),
            "member": await diagnostics(member.page),
            "ownerPeers": await peer_state(owner.page),
            "memberPeers": await peer_state(member.page),
            "ownerPaths": await selected_candidate_types(owner.page),
            "memberPaths": await selected_candidate_types(member.page),
            "turnHealth": (await http_json("GET", runtime.services.turn_health_url))[1]
                if runtime.services.turn_health_url else None,
        }, default=str)) from error
    await owner.page.wait_for_function("""async () => {
      for (const pc of window.__peerConnections || []) {
        const stats = await pc.getStats();
        const entries = [...stats.values()];
        const transport = entries.find(item => item.type === 'transport' && item.selectedCandidatePairId);
        const report = transport
          ? stats.get(transport.selectedCandidatePairId)
          : entries.find(item => item.type === 'candidate-pair' && item.state === 'succeeded' && (item.nominated || item.selected));
        if (report && stats.get(report.localCandidateId)?.candidateType === 'relay') return true;
      }
      return false;
    }""", timeout=25_000)
    owner_paths = await selected_candidate_types(owner.page)
    member_paths = await selected_candidate_types(member.page)
    assert owner_paths and member_paths
    assert all(path["localType"] == "relay" for path in owner_paths + member_paths)
    relay_rtp = await wait_rtp(owner.page, "inbound")
    await end_host_call(owner.page)
    return {"paths": owner_paths + member_paths, "rtp": relay_rtp, "turnTlsVerified": False}


async def deny_capture_permissions(session: BrowserSession, origin: str) -> None:
    cdp = await session.context.new_cdp_session(session.page)
    target = await cdp.send("Target.getTargetInfo")
    browser_context_id = target.get("targetInfo", {}).get("browserContextId")
    # Browser.setPermission consumes PermissionDescriptor names, not the
    # protocol's legacy PermissionType aliases.
    for permission in ("microphone", "camera"):
        arguments: dict[str, Any] = {
            "permission": {"name": permission},
            "setting": "denied",
            "origin": origin,
        }
        if browser_context_id:
            arguments["browserContextId"] = browser_context_id
        await cdp.send("Browser.setPermission", arguments)
    await cdp.detach()


async def scenario_permission_denied(runtime: ScenarioRuntime) -> dict[str, Any]:
    owner = await runtime.page("owner", grant_media=False)
    await deny_capture_permissions(owner, runtime.services.frontend_url)
    await owner.page.get_by_test_id("start-group").click()
    await configure_entry(owner.page, "on")
    await owner.page.get_by_role("button", name="Entrar na chamada", exact=True).click()
    await wait_diagnostic(
        owner.page,
        "value.phase === 'failed' && value.microphonePermission === 'denied'",
    )
    await expect(owner.page.get_by_role("alert").filter(has_text="microfone")).to_be_visible()
    denied = await diagnostics(owner.page)
    assert denied["mediaRequests"] and all(not item["video"] for item in denied["mediaRequests"])
    status, state = await http_json("GET", f"{runtime.services.api_url}/__test__/state?teamId=owner")
    assert status == 200 and state["activeCallCount"] == 0
    return {"nativePermissionDecision": "denied", "callCreated": False}


async def wait_video(page: Page, label: str) -> None:
    await page.wait_for_function(
        """label => {
          const video = [...document.querySelectorAll('video')]
            .find(item => item.getAttribute('aria-label') === label);
          return Boolean(
            video
            && video.srcObject
            && video.readyState >= 2
            && video.videoWidth > 0
            && getComputedStyle(video).visibility !== 'hidden'
          );
        }""",
        arg=label,
        timeout=DEFAULT_TIMEOUT_MS,
    )


async def peer_state(page: Page) -> list[dict[str, Any]]:
    return await page.evaluate("""() => (window.__peerConnections || []).map(pc => ({
      connectionState: pc.connectionState,
      iceConnectionState: pc.iceConnectionState,
      signalingState: pc.signalingState,
      history: pc.__stateHistory || [],
    }))""")


async def scenario_simultaneous_offer(runtime: ScenarioRuntime) -> dict[str, Any]:
    owner = await runtime.page("owner")
    member = await runtime.page("member")
    call_id = await start_call(owner.page, "group", "on")
    assert await join_call(member.page, "on") == call_id
    await wait_diagnostic(owner.page, "value.remoteUserIds.includes('member')")
    await asyncio.gather(
        owner.page.get_by_role("button", name="Ativar câmera", exact=True).click(),
        member.page.get_by_role("button", name="Ativar câmera", exact=True).click(),
    )
    await asyncio.gather(
        wait_video(owner.page, "Câmera de Member"),
        wait_video(member.page, "Câmera de Owner"),
    )
    await owner.page.wait_for_function("""() => (window.__peerConnections || []).every(pc =>
      pc.signalingState === 'stable' && ['connected', 'completed'].includes(pc.iceConnectionState)
    )""", timeout=DEFAULT_TIMEOUT_MS)
    await member.page.wait_for_function("""() => (window.__peerConnections || []).every(pc =>
      pc.signalingState === 'stable' && ['connected', 'completed'].includes(pc.iceConnectionState)
    )""", timeout=DEFAULT_TIMEOUT_MS)
    states = (await peer_state(owner.page)) + (await peer_state(member.page))
    assert len(states) >= 2
    assert all(any(item["signalingState"] == "have-local-offer" for item in state["history"]) for state in states)
    await end_host_call(owner.page)
    return {"callId": call_id, "offerers": 2, "stablePeers": len(states)}


async def scenario_reconnect(runtime: ScenarioRuntime) -> dict[str, Any]:
    owner = await runtime.page("owner")
    member = await runtime.page("member")
    call_id = await start_call(owner.page, "group", "on")
    assert await join_call(member.page, "on") == call_id
    baseline = len((await diagnostics(owner.page))["stateHistory"])
    status, response = await http_json("POST", f"{runtime.services.api_url}/__test__/connections/owner/close", {})
    assert status == 200 and response["closedConnections"] >= 1
    await wait_diagnostic(
        owner.page,
        "value.stateHistory.slice(argument).some(item => item.socketState !== 'open')",
        baseline,
    )
    await wait_diagnostic(owner.page, "value.socketState === 'open' && value.callId === argument", call_id, timeout=20_000)
    state = await diagnostics(owner.page)
    assert all(track["readyState"] == "live" for track in state["localTrackStates"])
    await end_host_call(owner.page)
    return {"callIdPreserved": True, "socketReopened": True}


async def scenario_temporary_network_loss(runtime: ScenarioRuntime) -> dict[str, Any]:
    owner = await runtime.page("owner")
    member = await runtime.page("member")
    call_id = await start_call(owner.page, "group", "on")
    assert await join_call(member.page, "on") == call_id
    await owner.context.set_offline(True)
    offline_fetch_rejected = False
    try:
        await wait_diagnostic(owner.page, "value.connectionQuality === 'offline'", timeout=5_000)
        offline_fetch_rejected = bool(await owner.page.evaluate(
            """async url => {
              try {
                await Promise.race([
                  fetch(`${url}/__test__/state?teamId=owner&probe=${Date.now()}`, {cache: 'no-store'}),
                  new Promise((_, reject) => setTimeout(() => reject(new Error('offline probe timeout')), 3000)),
                ]);
                return false;
              } catch {
                return true;
              }
            }""",
            runtime.services.api_url,
        ))
        assert offline_fetch_rejected
        # Chromium does not guarantee that toggling offline tears down an
        # already-established WebSocket. Closing the server half while new
        # connections are blocked makes the temporary outage deterministic.
        status, response = await http_json(
            "POST",
            f"{runtime.services.api_url}/__test__/connections/owner/close",
            {},
        )
        assert status == 200 and response["closedConnections"] >= 1
    finally:
        await owner.context.set_offline(False)
    await wait_diagnostic(owner.page, "value.socketState === 'open' && value.callId === argument", call_id, timeout=20_000)
    await wait_diagnostic(owner.page, "value.connectionQuality !== 'offline'", timeout=20_000)
    state = await diagnostics(owner.page)
    assert state["localTrackStates"] and all(track["readyState"] == "live" for track in state["localTrackStates"])
    await end_host_call(owner.page)
    return {"callIdPreserved": True, "mediaTracksPreserved": True, "offlineFetchRejected": offline_fetch_rejected}


async def wait_fixture_state(
    services: Services,
    predicate: Callable[[dict[str, Any]], bool],
    *,
    timeout: float,
) -> tuple[dict[str, Any], float]:
    started = time.monotonic()
    deadline = started + timeout
    latest: dict[str, Any] = {}
    while time.monotonic() < deadline:
        status, value = await http_json("GET", f"{services.api_url}/__test__/state?teamId=owner")
        if status == 200:
            latest = value
            if predicate(value):
                return value, time.monotonic() - started
        await asyncio.sleep(0.1)
    raise AssertionError(f"fixture state missed {timeout:.1f}s deadline: {latest}")


async def scenario_multiple_tabs(runtime: ScenarioRuntime) -> dict[str, Any]:
    first = await runtime.page("owner", name="owner-tab-1")
    member = await runtime.page("member")
    call_id = await start_call(first.page, "group", "on")
    assert await join_call(member.page, "on") == call_id
    second = await runtime.page("owner", name="owner-tab-2", context=first.context)
    assert await join_call(second.page, "on") == call_id
    await wait_diagnostic(second.page, "value.remoteUserIds.includes('member')")
    state, _ = await wait_fixture_state(
        runtime.services,
        lambda value: value["participantCount"] == 2,
        timeout=5,
    )
    assert state["calls"][0]["participantIds"] == ["member", "owner"]
    await close_page(first)
    state, _ = await wait_fixture_state(
        runtime.services,
        lambda value: bool(value["calls"]) and "owner" in value["calls"][0]["participantIds"],
        timeout=3,
    )
    assert state["participantCount"] == 2
    await end_host_call(second.page)
    return {"uniqueParticipants": 2, "oldTabClosePreservedOwner": True}


async def crash_page(session: BrowserSession) -> None:
    crashed = asyncio.Event()
    session.page.once("crash", lambda _: crashed.set())
    # Ubuntu's crash handler can delay the event after navigation rejects.
    # Share the scenario's existing end-to-end deadline; the caller subtracts
    # this elapsed time from the participant-removal wait and checks the total.
    async with asyncio.timeout(GHOST_DEADLINE_SECONDS):
        try:
            # Chromium's own crash URL terminates only this renderer and leaves
            # no unresolved DevTools Page.crash command that can poison the driver.
            await session.page.goto("chrome://crash", wait_until="commit", timeout=5_000)
        except Exception:
            # Navigation is expected to reject because the target renderer exits.
            pass
        await crashed.wait()


async def close_page(session: BrowserSession) -> None:
    """Wait until Chromium confirms the tab has closed and released its socket."""
    await asyncio.wait_for(session.page.close(run_before_unload=False), timeout=5)


async def scenario_tab_close_and_crash(runtime: ScenarioRuntime) -> dict[str, Any]:
    owner = await runtime.page("owner")
    member = await runtime.page("member")
    call_id = await start_call(owner.page, "group", "on")
    assert await join_call(member.page, "on") == call_id
    await close_page(member)
    _, close_seconds = await wait_fixture_state(
        runtime.services,
        lambda value: bool(value["calls"]) and "member" not in value["calls"][0]["participantIds"],
        timeout=GHOST_DEADLINE_SECONDS,
    )

    other = await runtime.page("other")
    assert await join_call(other.page, "on") == call_id
    crash_started = time.monotonic()
    await crash_page(other)
    await wait_fixture_state(
        runtime.services,
        lambda value: bool(value["calls"]) and "other" not in value["calls"][0]["participantIds"],
        timeout=max(0.1, GHOST_DEADLINE_SECONDS - (time.monotonic() - crash_started)),
    )
    crash_seconds = time.monotonic() - crash_started
    assert close_seconds <= GHOST_DEADLINE_SECONDS and crash_seconds <= GHOST_DEADLINE_SECONDS
    await end_host_call(owner.page)
    return {
        "closeGhostRemovalSeconds": round(close_seconds, 3),
        "crashGhostRemovalSeconds": round(crash_seconds, 3),
        "deadlineSeconds": GHOST_DEADLINE_SECONDS,
    }


async def scenario_screen_share(runtime: ScenarioRuntime) -> dict[str, Any]:
    owner = await runtime.page("owner")
    member = await runtime.page("member")
    call_id = await start_call(owner.page, "group", "on")
    assert await join_call(member.page, "on") == call_id
    await owner.page.get_by_role("button", name="Transmitir tela", exact=True).click()
    await wait_diagnostic(owner.page, "value.sharingScreen === true && value.displayRequests === 1")
    screen_rtp = await wait_rtp(member.page, "inbound", "video")
    await wait_video(member.page, "Tela compartilhada por Owner")
    await owner.page.get_by_role("button", name="Parar transmissão de tela", exact=True).click()
    await wait_diagnostic(owner.page, "value.sharingScreen === false")
    await expect(member.page.get_by_label("Tela compartilhada por Owner", exact=True)).to_have_count(0)
    await end_host_call(owner.page)
    return {"syntheticSelectionBoundary": True, "nativeScreenRtp": True, "rtp": screen_rtp}


async def tracks_ended(page: Page) -> bool:
    return bool(await page.evaluate("""() => window.__callFixture.userMediaStreams
      .flatMap(stream => stream.getTracks()).every(track => track.readyState === 'ended')"""))


async def close_context(browser: Browser, context: BrowserContext) -> None:
    await asyncio.wait_for(context.close(), timeout=8)
    if any(current is context for current in browser.contexts):
        raise RuntimeError("Browser context remained connected after close().")


async def scenario_user_and_team_revocation(runtime: ScenarioRuntime) -> dict[str, Any]:
    owner = await runtime.page("owner", name="owner-user-revocation")
    member = await runtime.page("member", name="member-user-revocation")
    call_id = await start_call(owner.page, "group", "on")
    assert await join_call(member.page, "on") == call_id
    started = time.monotonic()
    status, _ = await http_json(
        "POST",
        f"{runtime.services.api_url}/__test__/users/member/team",
        {"teamOwnerId": "other"},
    )
    assert status == 200
    await wait_diagnostic(member.page, "!value.callId", timeout=7_000)
    await wait_fixture_state(
        runtime.services,
        lambda value: not value["calls"] or "member" not in value["calls"][0]["participantIds"],
        timeout=max(0.1, 7 - (time.monotonic() - started)),
    )
    user_seconds = time.monotonic() - started
    assert await tracks_ended(member.page)
    await end_host_call(owner.page)
    await close_context(runtime.browser, owner.context)
    await close_context(runtime.browser, member.context)

    await reset_fixture(runtime.services)
    owner = await runtime.page("owner", name="owner-team-disabled")
    member = await runtime.page("member", name="member-team-disabled")
    call_id = await start_call(owner.page, "group", "on")
    assert await join_call(member.page, "on") == call_id
    disabled_started = time.monotonic()
    for user in ("owner", "member", "other"):
        status, _ = await http_json(
            "POST",
            f"{runtime.services.api_url}/__test__/users/{user}/status",
            {"status": "inativo"},
        )
        assert status == 200
    await wait_fixture_state(
        runtime.services,
        lambda value: value["activeCallCount"] == 0,
        timeout=7,
    )
    await wait_diagnostic(member.page, "!value.callId", timeout=max(100, int((7 - (time.monotonic() - disabled_started)) * 1000)))
    assert await tracks_ended(member.page)
    team_seconds = time.monotonic() - disabled_started
    return {
        "userRevocationSeconds": round(user_seconds, 3),
        "teamDeactivationSeconds": round(team_seconds, 3),
        "deadlineSeconds": 7,
        "teamDeactivationModel": "all members inactive",
    }


async def recording_fetch(
    page: Page,
    api_url: str,
    method: str,
    path: str,
    *,
    headers: dict[str, str] | None = None,
    body: dict[str, Any] | list[int] | None = None,
) -> dict[str, Any]:
    return await page.evaluate(
        """async ({apiUrl, method, path, headers, body}) => {
          const options = { method, headers: { Authorization: 'Bearer owner', ...(headers || {}) } };
          if (Array.isArray(body)) options.body = new Uint8Array(body);
          else if (body !== null) {
            options.headers['Content-Type'] = 'application/json';
            options.body = JSON.stringify(body);
          }
          const response = await fetch(apiUrl + path, options);
          const text = await response.text();
          let payload = text;
          try { payload = text ? JSON.parse(text) : null; } catch {}
          return { status: response.status, payload };
        }""",
        {"apiUrl": api_url, "method": method, "path": path, "headers": headers, "body": body},
    )


async def recording_client_id(page: Page, call_id: str) -> str:
    await page.wait_for_function(
        """callId => window.__callFixture.socketEvents.some(event =>
          event.type === 'CALL_SESSION' && event.callId === callId && event.clientId
        )""",
        arg=call_id,
    )
    return str(await page.evaluate(
        """callId => [...window.__callFixture.socketEvents].reverse().find(event =>
          event.type === 'CALL_SESSION' && event.callId === callId
        ).clientId""",
        call_id,
    ))


async def start_recording_api(page: Page, api_url: str, call_id: str, client_id: str, label: str) -> str:
    response = await recording_fetch(
        page,
        api_url,
        "POST",
        "/api/team-chat/recordings/start",
        body={
            "callId": call_id,
            "clientId": client_id,
            "operationId": f"start-{label}-{secrets.token_hex(4)}",
            "mimeType": "video/webm",
        },
    )
    assert response["status"] == 200, response
    return str(response["payload"]["recording"]["id"])


async def wait_recording_stopped(page: Page, recording_id: str) -> None:
    await page.wait_for_function(
        """recordingId => window.__callFixture.socketEvents.some(event =>
          event.type === 'CALL_RECORDING_STOPPED' && event.recordingId === recordingId
        )""",
        arg=recording_id,
        timeout=DEFAULT_TIMEOUT_MS,
    )


async def scenario_recording_failure_quota_abort(runtime: ScenarioRuntime) -> dict[str, Any]:
    owner = await runtime.page("owner")
    member = await runtime.page("member")
    call_id = await start_call(owner.page, "group", "on")
    assert await join_call(member.page, "on") == call_id
    client_id = await recording_client_id(owner.page, call_id)

    recording_id = await start_recording_api(owner.page, runtime.services.api_url, call_id, client_id, "conflict")
    headers = {"X-Call-Client-Id": client_id, "X-Recording-Chunk-Id": "same-chunk"}
    first = await recording_fetch(owner.page, runtime.services.api_url, "PUT", f"/api/team-chat/recordings/{recording_id}/chunks", headers=headers, body=[1, 2, 3])
    conflict = await recording_fetch(owner.page, runtime.services.api_url, "PUT", f"/api/team-chat/recordings/{recording_id}/chunks", headers=headers, body=[3, 2, 1])
    assert first["status"] == 200 and conflict["status"] == 409, (first, conflict)
    await wait_recording_stopped(member.page, recording_id)

    status, _ = await http_json(
        "POST",
        f"{runtime.services.api_url}/__test__/recording-limits",
        {"maxChunkBytes": 32, "maxTotalBytes": 4, "maxTeamBytes": 128},
    )
    assert status == 200
    recording_id = await start_recording_api(owner.page, runtime.services.api_url, call_id, client_id, "quota")
    quota = await recording_fetch(
        owner.page,
        runtime.services.api_url,
        "PUT",
        f"/api/team-chat/recordings/{recording_id}/chunks",
        headers={"X-Call-Client-Id": client_id, "X-Recording-Chunk-Id": "quota-chunk"},
        body=list(range(8)),
    )
    assert quota["status"] == 413, quota
    await wait_recording_stopped(member.page, recording_id)

    recording_id = await start_recording_api(owner.page, runtime.services.api_url, call_id, client_id, "abort")
    uploaded = await recording_fetch(
        owner.page,
        runtime.services.api_url,
        "PUT",
        f"/api/team-chat/recordings/{recording_id}/chunks",
        headers={"X-Call-Client-Id": client_id, "X-Recording-Chunk-Id": "abort-chunk"},
        body=[1, 2, 3, 4],
    )
    assert uploaded["status"] == 200, uploaded
    abort_headers = {"X-Call-Client-Id": client_id, "X-Recording-Operation-Id": "abort-browser"}
    aborted = await recording_fetch(owner.page, runtime.services.api_url, "DELETE", f"/api/team-chat/recordings/{recording_id}", headers=abort_headers)
    repeated = await recording_fetch(owner.page, runtime.services.api_url, "DELETE", f"/api/team-chat/recordings/{recording_id}", headers=abort_headers)
    assert aborted["status"] == 200 and repeated["status"] == 200
    await wait_recording_stopped(member.page, recording_id)
    state, _ = await wait_fixture_state(runtime.services, lambda value: value["partFileCount"] == 0, timeout=3)
    assert not state["partFiles"]
    await end_host_call(owner.page)
    return {"conflictStatus": 409, "quotaStatus": 413, "abortIdempotent": True, "orphanParts": 0}


async def scenario_call_studio(runtime: ScenarioRuntime) -> dict[str, Any]:
    owner = await runtime.page("owner")
    member = await runtime.page("member")
    call_id = await start_call(owner.page, "group", "on", camera=True)
    assert await join_call(member.page, "on", camera=True) == call_id
    await wait_rtp(owner.page, "inbound")
    await owner.page.get_by_role("button", name="Abrir estúdio da chamada").click()
    await owner.page.get_by_label("Nome da sessão").fill("Planejamento compartilhado")
    await owner.page.get_by_role("button", name="Abrir sessão para todos").click()
    await expect(member.page.get_by_role("heading", name="Planejamento compartilhado")).to_be_visible()
    await expect(member.page.get_by_role("button", name="Encerrar estúdio", exact=True)).to_have_count(0)

    await owner.page.get_by_role("button", name="Cartão", exact=True).click()
    await owner.page.get_by_label("Título do cartão").fill("Decisão da equipe")
    await owner.page.get_by_role("button", name="Salvar cartão", exact=True).click()
    await expect(member.page.locator(".brainstorm-node").filter(has_text="Decisão da equipe")).to_have_count(1)
    await member.page.get_by_role("button", name="Cartão", exact=True).click()
    await member.page.get_by_label("Título do cartão").fill("Contribuição do participante")
    await member.page.get_by_role("button", name="Salvar cartão", exact=True).click()
    await expect(owner.page.locator(".brainstorm-node").filter(has_text="Contribuição do participante")).to_have_count(1)

    # Edit two different cards concurrently, then prove both changes survive.
    await owner.page.get_by_label("Descrição", exact=True).fill("Descrição do organizador")
    await member.page.get_by_label("Descrição", exact=True).fill("Descrição do participante")
    await asyncio.gather(owner.page.get_by_role("button", name="Salvar cartão", exact=True).click(),
                         member.page.get_by_role("button", name="Salvar cartão", exact=True).click())
    await expect(owner.page.locator(".brainstorm-node").filter(has_text="Descrição do participante")).to_have_count(1)
    await expect(member.page.locator(".brainstorm-node").filter(has_text="Descrição do organizador")).to_have_count(1)
    await member.page.get_by_role("button", name="Votar (0)", exact=True).click()
    await member.page.get_by_label("Novo comentário").fill("Participante presente na decisão")
    await member.page.get_by_role("button", name="Comentar", exact=True).click()
    await expect(member.page.locator(".team-call-studio-comment")).to_contain_text("Participante presente na decisão")

    # Hiding the board must retain native media elements and RTP delivery.
    await owner.page.evaluate("window.__studioAudio = [...document.querySelectorAll('audio')]")
    await owner.page.get_by_role("button", name="Voltar aos vídeos", exact=True).click()
    assert await owner.page.evaluate("window.__studioAudio.length > 0 && window.__studioAudio.every(element => element.isConnected)")
    await owner.page.get_by_role("button", name="Abrir estúdio da chamada").click()
    await wait_rtp(owner.page, "inbound", "video")
    await expect(owner.page.get_by_role("button", name="Silenciar microfone", exact=True)).to_be_visible()

    other = await runtime.page("other")
    assert await join_call(other.page, "listen-only") == call_id
    await expect(other.page.get_by_role("heading", name="Planejamento compartilhado")).to_be_visible()
    await expect(other.page.locator(".brainstorm-node")).to_have_count(2)
    await member.page.set_viewport_size({"width": 390, "height": 844})
    await expect(member.page.get_by_role("button", name="Voltar aos vídeos", exact=True)).to_be_visible()
    assert await member.page.evaluate("document.documentElement.scrollWidth <= innerWidth")
    await member.page.get_by_label("Descrição", exact=True).fill("Contribuição pelo celular")
    await member.page.get_by_role("button", name="Salvar cartão", exact=True).click()
    await expect(owner.page.locator(".brainstorm-node").filter(has_text="Contribuição pelo celular")).to_have_count(1)
    await member.page.set_viewport_size({"width": 1280, "height": 800})

    baseline = len((await diagnostics(member.page))["stateHistory"])
    status, _ = await http_json("POST", f"{runtime.services.api_url}/__test__/connections/member/close", {})
    assert status == 200
    await wait_diagnostic(member.page, "value.stateHistory.slice(argument).some(item => item.socketState !== 'open')", baseline)
    await wait_diagnostic(member.page, "value.socketState === 'open' && value.callId === argument", call_id, timeout=20_000)
    await owner.page.get_by_role("button", name="Encerrar estúdio", exact=True).click()
    await expect(owner.page.get_by_role("dialog", name="Salvar esta sessão no Estúdio?")).to_be_visible()
    await owner.page.get_by_role("button", name="Encerrar sem salvar", exact=True).click()
    await expect(member.page.get_by_role("button", name="Cartão", exact=True)).to_be_disabled()
    await owner.page.get_by_role("button", name="Reabrir estúdio", exact=True).click()
    await expect(member.page.get_by_role("button", name="Cartão", exact=True)).to_be_enabled()
    await expect(member.page.locator(".brainstorm-node")).to_have_count(2)
    await owner.page.get_by_role("button", name="Nora", exact=True).click()
    await owner.page.get_by_label("Pedido para a Nora").fill("Organize os próximos passos a partir do quadro.")
    await owner.page.get_by_role("button", name="Pedir à Nora", exact=True).click()
    await expect(member.page.locator(".brainstorm-node").filter(has_text="Nora · Resposta")).to_have_count(1)
    await member.page.get_by_role("button", name="Nora", exact=True).click()
    await expect(member.page.locator(".team-call-studio-comment").filter(has_text="Plano sugerido pela Nora")).to_have_count(1)
    await owner.page.get_by_role("button", name="Encerrar reunião", exact=True).click()
    await expect(owner.page.get_by_role("dialog", name="Salvar esta sessão no Estúdio?")).to_be_visible()
    await owner.page.get_by_role("button", name="Cancelar", exact=True).click()
    await wait_diagnostic(owner.page, "value.callId === argument", call_id)
    await owner.page.get_by_role("button", name="Minimizar chamada", exact=True).click()
    await owner.page.get_by_role("button", name="Encerrar reunião", exact=True).click()
    await owner.page.get_by_role("button", name="Salvar no Estúdio e encerrar", exact=True).click()
    await wait_diagnostic(owner.page, "!value.callId && value.phase === 'idle'")
    saved = await owner.page.evaluate("""async (url) => (await fetch(url + '/__test__/studio-library', {headers: {Authorization: 'Bearer owner'}})).json()""", runtime.services.api_url)
    assert len(saved["sessions"]) == 1 and saved["sessions"][0]["nodeCount"] == 3
    await end_host_call(owner.page)
    return {"participants": 3, "sharedCards": 2, "independentEditsPreserved": True,
            "lateJoinSynced": True, "mediaPreserved": True, "mobileOverflow": False, "mobileEditSaved": True,
            "hostControlsSession": True, "noraResponseShared": True, "saveDecisionRespected": True}


SCENARIOS: dict[str, Callable[[ScenarioRuntime], Awaitable[dict[str, Any]]]] = {
    "call_studio": scenario_call_studio,
    "group_media": scenario_group_media,
    "entry_modes": scenario_entry_modes,
    "direct_chat_context": scenario_direct_chat_context,
    "permission_denied": scenario_permission_denied,
    "simultaneous_offer": scenario_simultaneous_offer,
    "relay_only": scenario_relay_only,
    "reconnect": scenario_reconnect,
    "temporary_network_loss": scenario_temporary_network_loss,
    "multiple_tabs": scenario_multiple_tabs,
    "tab_close_and_crash": scenario_tab_close_and_crash,
    "screen_share": scenario_screen_share,
    "user_and_team_revocation": scenario_user_and_team_revocation,
    "recording_failure_quota_abort": scenario_recording_failure_quota_abort,
}


def browser_candidates(args: argparse.Namespace) -> list[dict[str, Any]]:
    if args.browser_executable:
        return [{"executable_path": args.browser_executable}]
    if args.browser_channel:
        return [{"channel": args.browser_channel}]
    # Use the full bundled browser's new headless mode: headless shell 151
    # rejects native fake-device capture with NotSupportedError. Never silently
    # substitute installed Chrome, which hid this CI failure on Windows.
    return [{"channel": "chromium"}]


async def launch_browser(playwright: Any, args: argparse.Namespace, media_dir: Path) -> tuple[Browser, str]:
    launch_args = [
        "--autoplay-policy=no-user-gesture-required",
        # Chromium omits loopback interfaces from PeerConnection by default.
        # The hermetic TURN server intentionally binds to loopback, so enable
        # that interface only in this test browser process.
        "--allow-loopback-in-peer-connection",
        "--use-fake-device-for-media-stream",
        f"--use-file-for-fake-audio-capture={media_dir / 'microphone.wav'}",
        f"--use-file-for-fake-video-capture={media_dir / 'camera.y4m'}",
    ]
    errors: list[str] = []
    for candidate in browser_candidates(args):
        try:
            browser = await playwright.chromium.launch(headless=True, args=launch_args, **candidate)
            identity = candidate.get("channel") or candidate.get("executable_path") or "playwright-chromium"
            return browser, str(identity)
        except Exception as error:
            errors.append(type(error).__name__)
    raise RuntimeError("No usable Chromium browser: " + " | ".join(errors))


async def run(args: argparse.Namespace) -> int:
    artifacts = Path(args.artifacts_dir).resolve()
    artifacts.mkdir(parents=True, exist_ok=True)
    selected = args.scenario or list(SCENARIOS)
    unknown = sorted(set(selected) - set(SCENARIOS))
    if unknown:
        raise SystemExit(f"unknown scenario(s): {', '.join(unknown)}")

    started = time.time()
    run_id = f"{time.strftime('%Y%m%dT%H%M%SZ', time.gmtime(started))}-{secrets.token_hex(4)}"
    failure_root = artifacts / "failures" / run_id
    summary_path = artifacts / "summary.json"
    write_json_atomic(summary_path, {
        "schemaVersion": 1,
        "status": "running",
        "runId": run_id,
        "startedAtUnix": started,
        "repeat": args.repeat,
        "scenarios": selected,
    })
    results: list[dict[str, Any]] = []
    temporary_root = artifacts.parent / ".tmp"
    temporary_root.mkdir(parents=True, exist_ok=True)
    with disposable_workspace(temporary_root) as temporary:
        media_dir = temporary / "media"
        media_dir.mkdir()
        write_fake_audio(media_dir / "microphone.wav")
        write_fake_video(media_dir / "camera.y4m")
        services: Services | None = None
        browser_identity = "not-started"
        browser_version = "not-started"
        processes_for_artifacts: list[ManagedProcess] = []
        stop_errors: list[str] = []
        try:
            services = await start_services(args, temporary)
            async with async_playwright() as playwright:
                for repetition in range(1, args.repeat + 1):
                    # Re-launch per repetition so an exhausted renderer from a
                    # previous cycle cannot contaminate the next independent run.
                    browser, browser_identity = await launch_browser(playwright, args, media_dir)
                    browser_version = browser.version
                    record_video = (
                        browser_identity == "playwright-chromium"
                        or os.environ.get("TEAM_CALL_E2E_RECORD_VIDEO") == "1"
                    )
                    cleanup_failure_raws: list[tuple[ScenarioRuntime, Path]] = []
                    try:
                        for name in selected:
                            await reset_fixture(services)
                            raw_dir = temporary / "browser" / f"repeat-{repetition}" / name
                            runtime = ScenarioRuntime(browser, services, raw_dir, record_video=record_video)
                            failure_dir: Path | None = None
                            scenario_started = time.monotonic()
                            try:
                                details = await SCENARIOS[name](runtime)
                                result = {
                                    "scenario": name,
                                    "repetition": repetition,
                                    "status": "passed",
                                    "durationSeconds": round(time.monotonic() - scenario_started, 3),
                                    "details": details,
                                }
                            except Exception as error:
                                failure_dir = failure_root / f"repeat-{repetition}" / name
                                failure_dir.mkdir(parents=True, exist_ok=True)
                                result = {
                                    "scenario": name,
                                    "repetition": repetition,
                                    "status": "failed",
                                    "durationSeconds": round(time.monotonic() - scenario_started, 3),
                                    "error": f"{type(error).__name__}",
                                    "traceback": [f"{Path(frame.filename).name}:{frame.lineno}" for frame in traceback.extract_tb(sys.exception().__traceback__)[-20:]],
                                }
                            cleanup_failure: str | None = None
                            try:
                                await runtime.close(failure_dir)
                            except Exception as cleanup_error:
                                cleanup_failure = type(cleanup_error).__name__
                                cleanup_traceback = [f"{Path(frame.filename).name}:{frame.lineno}" for frame in traceback.extract_tb(sys.exception().__traceback__)[-20:]]
                                if failure_dir is None:
                                    failure_dir = failure_root / f"repeat-{repetition}" / name
                                    failure_dir.mkdir(parents=True, exist_ok=True)
                                    with contextlib.suppress(Exception):
                                        await runtime.preserve_failure(failure_dir)
                                if result["status"] == "passed":
                                    result = {
                                        "scenario": name,
                                        "repetition": repetition,
                                        "status": "failed",
                                        "durationSeconds": round(time.monotonic() - scenario_started, 3),
                                        "error": f"cleanup: {type(cleanup_error).__name__}",
                                        "traceback": cleanup_traceback,
                                    }
                                else:
                                    result["error"] += (
                                        f"; cleanup: {type(cleanup_error).__name__}"
                                    )
                                    result["traceback"] = (result["traceback"] + cleanup_traceback)[-40:]
                                assert failure_dir is not None
                                cleanup_failure_raws.append((runtime, failure_dir))
                            results.append(result)
                            print(json.dumps(result, ensure_ascii=False), flush=True)
                            if cleanup_failure:
                                raise RuntimeError(
                                    f"Scenario {name} could not establish an isolated cleanup: {cleanup_failure}"
                                )
                    finally:
                        browser_close_failure: str | None = None
                        try:
                            await asyncio.wait_for(browser.close(), timeout=10)
                            if browser.is_connected():
                                raise RuntimeError("Browser process remained connected after close().")
                        except Exception as error:
                            browser_close_failure = f"{type(error).__name__}"
                        # A leaked context may only finish its video when the
                        # whole browser closes. Copy those raw files once more.
                        raw_copy_errors: list[str] = []
                        for failed_runtime, failed_directory in cleanup_failure_raws:
                            try:
                                await failed_runtime.preserve_failure(
                                    failed_directory,
                                    screenshots=False,
                                    copy_raw=True,
                                )
                            except Exception as error:
                                raw_copy_errors.append(f"{type(error).__name__}")
                        if browser_close_failure or raw_copy_errors:
                            reasons = [item for item in [browser_close_failure, *raw_copy_errors] if item]
                            raise RuntimeError("Browser finalization failed: " + " | ".join(reasons))
        except Exception as error:
            results.append({
                "scenario": "__suite__",
                "repetition": 0,
                "status": "failed",
                "durationSeconds": round(time.time() - started, 3),
                "error": f"{type(error).__name__}",
                "traceback": [f"{Path(frame.filename).name}:{frame.lineno}" for frame in traceback.extract_tb(sys.exception().__traceback__)[-40:]],
            })
        finally:
            processes_for_artifacts = list(services.processes if services else _STARTUP_PROCESSES)
            if services:
                stop_errors.extend(await services.stop())
            else:
                for process in reversed(_STARTUP_PROCESSES):
                    try:
                        await process.stop()
                    except Exception as error:
                        stop_errors.append(f"{process.name}: {type(error).__name__}")
            _STARTUP_PROCESSES.clear()
            if stop_errors:
                results.append({
                    "scenario": "__services__",
                    "repetition": 0,
                    "status": "failed",
                    "durationSeconds": round(time.time() - started, 3),
                    "error": "Service cleanup failed: " + " | ".join(stop_errors),
                    "traceback": [],
                })

        failed = [result for result in results if result["status"] != "passed"]
        artifact_errors: list[str] = []
        if failed:
            artifact_errors.extend(copy_service_logs(processes_for_artifacts, failure_root / "services"))

        try:
            # Complete the managed-workspace cleanup before publishing a green
            # final summary. The context manager becomes a fallback retry only.
            remove_disposable_workspace(temporary)
        except Exception as error:
            results.append({
                "scenario": "__workspace__",
                "repetition": 0,
                "status": "failed",
                "durationSeconds": round(time.time() - started, 3),
                "error": f"Temporary workspace cleanup failed: {type(error).__name__}",
                "traceback": [f"{Path(frame.filename).name}:{frame.lineno}" for frame in traceback.extract_tb(sys.exception().__traceback__)[-20:]],
            })
            if not failed:
                artifact_errors.extend(copy_service_logs(processes_for_artifacts, failure_root / "services"))

        if artifact_errors:
            results.append({
                "scenario": "__artifacts__",
                "repetition": 0,
                "status": "failed",
                "durationSeconds": round(time.time() - started, 3),
                "error": "Failure artifact capture failed: " + " | ".join(artifact_errors),
                "traceback": [],
            })
        failed = [result for result in results if result["status"] != "passed"]

        summary = {
            "schemaVersion": 1,
            "status": "failed" if failed else "passed",
            "runId": run_id,
            "startedAtUnix": started,
            "durationSeconds": round(time.time() - started, 3),
            "repeat": args.repeat,
            "browser": browser_identity,
            "browserVersion": browser_version,
            "turnMode": services.turn_mode if services else "not-started",
            "turnTlsVerified": False,
            "rawArtifactsPolicy": "disabled",
            "failureArtifacts": str(failure_root.relative_to(artifacts)) if failed else None,
            "videoCaptureEnabled": False,
            "privacyMode": "aggregate-only; no media, SDP, candidates, IPs, tickets or raw traces",
            "passed": len(results) - len(failed),
            "failed": len(failed),
            "results": results,
        }
        write_json_atomic(summary_path, summary)
        return 1 if failed else 0


def parser() -> argparse.ArgumentParser:
    value = argparse.ArgumentParser(description=__doc__)
    value.add_argument("--repeat", type=int, default=3)
    value.add_argument("--scenario", action="append", choices=sorted(SCENARIOS))
    value.add_argument("--artifacts-dir", default="output/team-call-quality/browser")
    value.add_argument("--api-port", type=int, default=0)
    value.add_argument("--frontend-port", type=int, default=0)
    value.add_argument("--turn-port", type=int, default=0)
    value.add_argument("--external-turn", action="store_true")
    value.add_argument("--browser-channel", default="")
    value.add_argument("--browser-executable", default="")
    value.add_argument("--node", default="node")
    return value


if __name__ == "__main__":
    arguments = parser().parse_args()
    if arguments.repeat < 1:
        parser().error("--repeat must be at least 1")
    raise SystemExit(asyncio.run(run(arguments)))
