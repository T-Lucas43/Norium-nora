"""Prova relay-only real para duas CallSessions independentes.

Executar com o venv do backend e um serviço TURN/TLS acessível. Ausência de
infraestrutura encerra com código 2 (bloqueado), nunca como skip/sucesso.
"""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

from playwright.async_api import async_playwright, expect


FRONTEND = Path(__file__).resolve().parents[2]
ROOT = FRONTEND.parent
BACKEND = ROOT / "norium-back-end"
OUTPUT = ROOT / "output" / "call-validation"
BACKEND_URL = "http://127.0.0.1:8000"
FRONTEND_URL = "http://127.0.0.1:5173"


def blocked(reason: str, detail: str) -> int:
    print(json.dumps({"status": "blocked", "reason": reason, "detail": detail}, ensure_ascii=False))
    return 2


def wait_for_http(url: str, timeout_seconds: float = 30.0) -> None:
    deadline = time.monotonic() + timeout_seconds
    last_error: Exception | None = None
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=1.0) as response:
                if response.status < 500:
                    return
        except Exception as exc:  # noqa: BLE001 - preservado apenas para timeout local
            last_error = exc
        time.sleep(0.2)
    raise RuntimeError(f"Serviço local não iniciou em {url}: {last_error}")


def stop_process(process: subprocess.Popen[bytes]) -> None:
    if process.poll() is not None:
        return
    if os.name == "nt":
        subprocess.run(
            ["taskkill", "/PID", str(process.pid), "/T", "/F"],
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        return
    process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()


async def selected_paths(page):
    return await page.evaluate("""async () => {
      const paths = [];
      for (const peer of (window.__pcs || [])) {
        if (!['connected', 'completed'].includes(peer.iceConnectionState)) continue;
        const stats = await peer.getStats();
        const entries = [...stats.values()];
        const transport = entries.find(item => item.type === 'transport' && item.selectedCandidatePairId);
        const pair = transport
          ? stats.get(transport.selectedCandidatePairId)
          : entries.find(item => item.type === 'candidate-pair' && item.state === 'succeeded' && (item.nominated || item.selected));
        if (!pair) continue;
        const local = stats.get(pair.localCandidateId);
        const remote = stats.get(pair.remoteCandidateId);
        if (!local || !remote) continue;
        paths.push({
          iceConnectionState: peer.iceConnectionState,
          localType: local.candidateType || 'unknown',
          remoteType: remote.candidateType || 'unknown',
          protocol: local.relayProtocol || local.protocol || 'unknown',
        });
      }
      return paths;
    }""")


async def verify() -> dict[str, object]:
    browser_errors: list[str] = []
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(args=["--autoplay-policy=no-user-gesture-required"])
        contexts = [await browser.new_context() for _ in range(2)]
        pages = [await context.new_page() for context in contexts]
        for page, user in zip(pages, ("owner", "member"), strict=True):
            page.on("pageerror", lambda error: browser_errors.append(str(error)))
            await page.add_init_script("""
              window.__pcs = [];
              const NativePeer = window.RTCPeerConnection;
              window.RTCPeerConnection = class extends NativePeer {
                constructor(configuration) {
                  super(configuration);
                  window.__pcs.push(this);
                }
              };
            """)
            await page.goto(f"{FRONTEND_URL}/tests/browser/calls.html?user={user}&relay=1")
            await expect(page.get_by_text("Conectado", exact=True)).to_be_visible()
            await expect(page.get_by_test_id("ice-service")).to_have_text("ICE: ready")

        owner, member = pages
        await owner.get_by_role("button", name="Iniciar reunião", exact=True).click()
        await owner.get_by_role("button", name="Entrar agora", exact=True).click()
        await member.get_by_role("button", name="Entrar na reunião", exact=True).click()
        await member.get_by_role("button", name="Entrar agora", exact=True).click()
        await expect(owner.get_by_role("slider", name="Volume de Member")).to_be_visible(timeout=30_000)
        await expect(member.get_by_role("slider", name="Volume de Owner")).to_be_visible(timeout=30_000)

        async def relay_selected(page) -> bool:
            paths = await selected_paths(page)
            return bool(paths) and all(path["localType"] == "relay" for path in paths)

        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            if await relay_selected(owner) and await relay_selected(member):
                break
            await asyncio.sleep(0.25)
        owner_paths = await selected_paths(owner)
        member_paths = await selected_paths(member)
        assert owner_paths and member_paths, "Nenhum par ICE selecionado nas duas sessões."
        assert all(path["localType"] == "relay" for path in [*owner_paths, *member_paths]), (owner_paths, member_paths)
        await expect(owner.get_by_test_id("relay-observed")).to_have_text("Relay observado: sim")
        await expect(member.get_by_test_id("relay-observed")).to_have_text("Relay observado: sim")
        assert not browser_errors, browser_errors
        await browser.close()
        return {
            "status": "passed",
            "sessions": 2,
            "iceTransportPolicy": "relay",
            "ownerPaths": owner_paths,
            "memberPaths": member_paths,
            "sensitiveCandidateDataStored": False,
        }


def main() -> int:
    turn_urls = os.getenv("TEAM_CALL_TURN_URLS", "").strip()
    shared_secret = os.getenv("TEAM_CALL_TURN_SHARED_SECRET", "")
    if not turn_urls or not shared_secret:
        return blocked(
            "external_turn_not_configured",
            "Defina TEAM_CALL_TURN_URLS e TEAM_CALL_TURN_SHARED_SECRET para um servidor TURN real acessível.",
        )
    if not any(url.strip().startswith("turns:") for url in turn_urls.split(",")):
        return blocked("external_turn_tls_missing", "TEAM_CALL_TURN_URLS precisa incluir uma URL turns: acessível.")

    OUTPUT.mkdir(parents=True, exist_ok=True)
    backend_log = (OUTPUT / "relay-backend.log").open("wb")
    frontend_log = (OUTPUT / "relay-frontend.log").open("wb")
    creation_flags = subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0
    processes: list[subprocess.Popen[bytes]] = []
    try:
        processes.append(subprocess.Popen(
            [sys.executable, "-m", "uvicorn", "tests.team_call_browser_app:app", "--host", "127.0.0.1", "--port", "8000"],
            cwd=BACKEND,
            env=os.environ.copy(),
            stdout=backend_log,
            stderr=subprocess.STDOUT,
            creationflags=creation_flags,
        ))
        npm = "npm.cmd" if os.name == "nt" else "npm"
        processes.append(subprocess.Popen(
            [npm, "run", "dev", "--", "--host", "127.0.0.1", "--port", "5173"],
            cwd=FRONTEND,
            env=os.environ.copy(),
            stdout=frontend_log,
            stderr=subprocess.STDOUT,
            creationflags=creation_flags,
        ))
        wait_for_http(f"{BACKEND_URL}/openapi.json")
        wait_for_http(f"{FRONTEND_URL}/tests/browser/calls.html")
        result = asyncio.run(verify())
        (OUTPUT / "relay-result.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
        print(json.dumps(result, ensure_ascii=False))
        return 0
    finally:
        for process in reversed(processes):
            stop_process(process)
        backend_log.close()
        frontend_log.close()


if __name__ == "__main__":
    raise SystemExit(main())
