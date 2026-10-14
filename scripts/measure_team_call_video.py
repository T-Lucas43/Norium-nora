"""Measure three synthetic browser participants; preserve only aggregate counters.

Runs ten minutes by default, with the receiver minimized from minute 2 to 7.
CPU is process CPU seconds (100% means one logical core), not a Shard estimate.
The baseline frontend is a source copy restored from the accepted A snapshot.
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import ctypes
from ctypes import wintypes
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

from playwright.async_api import async_playwright

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "norium-front-end/tests/browser"))
import team_call_e2e as harness


def prepare_baseline(destination: Path) -> None:
    destination.resolve().relative_to(REPO / "output")
    if destination.exists():
        raise RuntimeError("Baseline destination already exists; preserve it and choose a new path.")
    files = subprocess.check_output(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], cwd=REPO).decode().split("\0")
    for name in files:
        source = REPO / name
        if not name.startswith("norium-front-end/") or not source.is_file() or any(part.startswith(".env") for part in Path(name).parts):
            continue
        target = destination / Path(name).relative_to("norium-front-end")
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
    snapshot = REPO / "output/nova-chamada-a-snapshot/norium-front-end"
    if not snapshot.is_dir():
        raise RuntimeError("Accepted Phase A snapshot missing.")
    for source in snapshot.rglob("*"):
        if source.is_file():
            target = destination / source.relative_to(snapshot)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)


def source_hashes(frontend: Path) -> dict[str, str]:
    files = [*sorted((frontend / "src/components/team-chat").rglob("*.ts*")), REPO / "norium-back-end/app/modules/team/call_coordinator.py"]
    return {str(path.relative_to(frontend)) if path.is_relative_to(frontend) else "backend/call_coordinator.py": hashlib.sha256(path.read_bytes()).hexdigest() for path in files}


class CpuLedger:
    def __init__(self):
        self.previous: dict[tuple[str, int], float] = {}
        self.total = 0.0

    async def sample(self, browser_cdp, services, initial: bool = False) -> float:
        rows = [("browser", int(row["id"]), row["cpuTime"]) for row in (await browser_cdp.send("SystemInfo.getProcessInfo"))["processInfo"]]
        rows += [("service", process.process.pid, process_cpu_seconds(process.process.pid)) for process in services.processes if process.process and process.process.poll() is None]
        for group, pid, value in rows:
            if value is None:
                continue
            key = group, pid
            previous = self.previous.get(key)
            if not initial:
                self.total += max(0, value - previous) if previous is not None else value
            self.previous[key] = value
        return self.total


def process_cpu_seconds(pid: int) -> float | None:
    if os.name != "nt":
        raise RuntimeError("Service CPU measurement currently supports Windows only.")
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.GetProcessTimes.argtypes = [wintypes.HANDLE, *([ctypes.POINTER(wintypes.FILETIME)] * 4)]
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    handle = kernel.OpenProcess(0x1000, False, pid)
    if not handle:
        return None
    try:
        created, exited, system, user = [wintypes.FILETIME() for _ in range(4)]
        if not kernel.GetProcessTimes(handle, ctypes.byref(created), ctypes.byref(exited), ctypes.byref(system), ctypes.byref(user)):
            return None
        return sum((value.dwHighDateTime << 32) + value.dwLowDateTime for value in (system, user)) / 10_000_000
    finally:
        kernel.CloseHandle(handle)


async def measure(args: argparse.Namespace) -> None:
    if args.frontend_directory:
        harness.FRONTEND_DIR = Path(args.frontend_directory).resolve()
    output = (REPO / args.output).resolve()
    output.relative_to(REPO / "output")
    output.mkdir(parents=True, exist_ok=True)
    hashes = source_hashes(harness.FRONTEND_DIR)
    service_args = harness.parser().parse_args(["--node", args.node])
    with harness.disposable_workspace(output) as temporary:
        media = temporary / "media"
        media.mkdir()
        harness.write_fake_audio(media / "microphone.wav")
        harness.write_fake_video(media / "camera.y4m")
        services = await harness.start_services(service_args, temporary)
        try:
            async with async_playwright() as playwright:
                browser, browser_name = await harness.launch_browser(playwright, service_args, media)
                runtime = harness.ScenarioRuntime(browser, services, temporary / "raw", record_video=False)
                try:
                    owner, member, other = await runtime.page("owner"), await runtime.page("member"), await runtime.page("other")
                    pages = [owner.page, member.page, other.page]
                    await harness.start_call(owner.page, "group", "on", camera=True)
                    await harness.join_call(member.page, "on", camera=True)
                    await harness.join_call(other.page, "on", camera=True)
                    for page in pages:
                        await page.get_by_label("Layout da chamada", exact=True).select_option("gallery")
                        await harness.wait_rtp(page, "inbound", "video")
                    # Let media, JIT and adaptive observers settle before measuring.
                    await asyncio.sleep(15)
                    browser_cdp = await browser.new_browser_cdp_session()
                    ledger = CpuLedger()
                    await ledger.sample(browser_cdp, services, initial=True)
                    started = time.monotonic()
                    samples = []
                    state = "gallery"
                    while True:
                        elapsed = time.monotonic() - started
                        next_state = "minimized" if args.seconds * .2 <= elapsed < args.seconds * .7 else "gallery"
                        if next_state != state:
                            label = "Minimizar chamada" if next_state == "minimized" else "Restaurar chamada"
                            await owner.page.get_by_role("button", name=label, exact=True).click()
                            state = next_state
                        totals = await asyncio.gather(*(harness.media_totals(page) for page in pages))
                        sample = {"seconds": round(elapsed, 3), "state": state, "cpuSeconds": round(await ledger.sample(browser_cdp, services), 6), "inbound": totals}
                        samples.append(sample)
                        if len(samples) == 1 or len(samples) % 4 == 0:
                            print(json.dumps({"variant": args.variant, "elapsedSeconds": round(elapsed), "state": state}), flush=True)
                        if elapsed >= args.seconds:
                            break
                        await asyncio.sleep(min(15, args.seconds - elapsed))
                    last, first = samples[-1], samples[0]
                    duration = last["seconds"] - first["seconds"]
                    totals = {kind: sum(last["inbound"][index][kind] - first["inbound"][index][kind] for index in range(3)) for kind in ("audio", "video")}
                    result = {"variant": args.variant, "browser": browser_name, "participants": 3, "durationSeconds": duration,
                              "cpuSeconds": last["cpuSeconds"] - first["cpuSeconds"], "cpuPercentOneLogicalCore": round((last["cpuSeconds"] - first["cpuSeconds"]) / duration * 100, 3),
                              "inboundBytes": totals, "samples": samples, "sourceHashes": hashes,
                              "sourceUnchanged": hashes == source_hashes(harness.FRONTEND_DIR),
                              "limitations": ["Local Windows CPU, no Shard estimate", "160x120 synthetic camera; not production-sized video", "One before/after run; no statistical significance", "CPU includes owned browser, fixture, Vite and TURN processes; short-lived process exits may be missed"]}
                    harness.write_json_atomic(output / "measurement.json", result)
                    await harness.end_host_call(owner.page)
                finally:
                    await runtime.close(temporary / "failures")
                    await browser.close()
        finally:
            errors = await services.stop()
            if errors:
                raise RuntimeError("Owned service cleanup failed.")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prepare-baseline")
    parser.add_argument("--frontend-directory")
    parser.add_argument("--variant", choices=["A", "B"])
    parser.add_argument("--seconds", type=int, default=600)
    parser.add_argument("--output", default="output/team-call-quality/video-measurement")
    parser.add_argument("--node", default="node")
    args = parser.parse_args()
    if args.prepare_baseline:
        prepare_baseline(Path(args.prepare_baseline))
    elif args.variant and args.seconds >= 30:
        asyncio.run(measure(args))
    else:
        parser.error("Provide --prepare-baseline or --variant with at least 30 seconds.")


if __name__ == "__main__":
    main()
