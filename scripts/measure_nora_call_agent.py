"""Real elapsed-time soak of the audio pipeline with two synthetic sources.

No RTC/provider integration or production capacity is claimed by this harness.
Only aggregate process memory, queue and source hashes are written.
"""
from __future__ import annotations

import argparse
import asyncio
import ctypes
import hashlib
import json
import os
from pathlib import Path
import struct
import sys
import time
import tracemalloc

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "norium-back-end"))
os.environ["PYTHON_DOTENV_DISABLED"] = "1"

from app.modules.team.nora_call_agent import NoraAudioPipeline
from app.modules.team.nora_call_state import NoraCallConfig, NoraConsentState
from app.modules.team.nora_call_stt import SpeechSegment


def process_memory() -> dict[str, float]:
    class Counters(ctypes.Structure):
        _fields_ = [("cb", ctypes.c_ulong), ("PageFaultCount", ctypes.c_ulong),
                    *[(name, ctypes.c_size_t) for name in ("PeakWorkingSetSize", "WorkingSetSize", "QuotaPeakPagedPoolUsage", "QuotaPagedPoolUsage", "QuotaPeakNonPagedPoolUsage", "QuotaNonPagedPoolUsage", "PagefileUsage", "PeakPagefileUsage", "PrivateUsage")]]
    if os.name != "nt":
        raise RuntimeError("This harness currently measures Windows working set")
    counters = Counters()
    counters.cb = ctypes.sizeof(counters)
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.GetCurrentProcess.restype = ctypes.c_void_p
    psapi = ctypes.WinDLL("psapi", use_last_error=True)
    psapi.GetProcessMemoryInfo.argtypes = [ctypes.c_void_p, ctypes.POINTER(Counters), ctypes.c_ulong]
    if not psapi.GetProcessMemoryInfo(kernel.GetCurrentProcess(), ctypes.byref(counters), counters.cb):
        raise ctypes.WinError(ctypes.get_last_error())
    return {"rssMiB": counters.WorkingSetSize / 1048576,
            "privateCommitMiB": counters.PrivateUsage / 1048576,
            "peakPrivateCommitMiB": counters.PeakPagefileUsage / 1048576}


def rss_mib() -> float:
    return process_memory()["rssMiB"]


def hashes() -> dict[str, str]:
    return {str(path.relative_to(ROOT)): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in (ROOT / "norium-back-end/app/modules/team").glob("nora_call_*.py")}


async def measure(seconds: int, destination: Path) -> None:
    original_hashes = hashes()
    state = NoraConsentState("call_synthetic_soak", "a", NoraCallConfig(enabled=True), True, "sfu")
    state.sync_members({"a": "a1", "b": "b1"})
    state.request("a", True)
    def agree():
        for user, session in state.sessions.items():
            state.consent(user, session, state.revision, True)
    agree()
    counters = {"requests": 0, "reservations": 0, "settlements": 0, "segments": 0, "maxQueue": 0}
    class Stt:
        async def transcribe(self, pcm):
            counters["requests"] += 1
            await asyncio.sleep(0.01)
            return (SpeechSegment(0, 10, "Fala sintética para ensaio de memória."),)
    class Meter:
        async def reserve(self, event_id, duration):
            counters["reservations"] += 1
        async def settle(self, event_id, **status):
            counters["settlements"] += 1
    async def publish(values):
        counters["segments"] += len(values)
    tracemalloc.start()
    pipe = NoraAudioPipeline(state, Stt(), Meter(), publish)
    pipe.start()
    voiced = struct.pack("<h", 1000) * 16000
    silent = bytes(32000)
    samples = []
    started = time.monotonic()
    try:
        for second in range(seconds):
            # Periodic withdrawal/reconsent exercises cleanup without retaining
            # audio/transcripts in the test observer.
            if second and second % 120 == 0:
                state.consent("b", "b1", state.revision, False)
                pipe.invalidate()
                agree()
            for user in ("a", "b"):
                pipe.feed(user, user + "1", silent if second % 40 >= 30 else voiced, second)
            counters["maxQueue"] = max(counters["maxQueue"], pipe.queue.qsize())
            if second % 60 == 0:
                current, peak = tracemalloc.get_traced_memory()
                sample = {"elapsedSeconds": round(time.monotonic() - started, 3), **process_memory(),
                          "pythonBytes": current, "pythonPeakBytes": peak,
                          "bufferBytes": sum(len(chunk.buffer) for chunk in pipe.chunkers.values()),
                          "queue": pipe.queue.qsize()}
                samples.append(sample)
                print(json.dumps({"elapsed": second, "rssMiB": round(sample["rssMiB"], 2), "requests": counters["requests"]}), flush=True)
            await asyncio.sleep(max(0, started + second + 1 - time.monotonic()))
        await asyncio.wait_for(pipe.queue.join(), 30)
    finally:
        await pipe.close()
    elapsed = time.monotonic() - started
    stable = [sample for sample in samples if sample["elapsedSeconds"] >= min(120, seconds / 3)]
    rss_delta = max(item["rssMiB"] for item in stable) - min(item["rssMiB"] for item in stable) if stable else 0
    python_delta = max(item["pythonBytes"] for item in stable) - min(item["pythonBytes"] for item in stable) if stable else 0
    private_growth = max(0, max(item["privateCommitMiB"] for item in stable) - stable[0]["privateCommitMiB"]) if stable else 0
    result = {"durationSeconds": elapsed, "syntheticSources": 2, **counters, "samples": samples,
              "stableRssRangeMiB": rss_delta, "stablePythonRangeBytes": python_delta,
              "privateCommitGrowthMiB": private_growth,
              "memoryCriterion": "private commit growth after warmup <16 MiB; Python allocation range <2 MiB; RSS range descriptive only",
              "sourceHashes": original_hashes, "sourceUnchanged": original_hashes == hashes(),
              "passed": elapsed >= seconds and private_growth < 16 and python_delta < 2 * 1024 * 1024
                        and not pipe.queue.qsize() and not pipe.chunkers and not pipe.last_error,
              "scope": "audio pipeline only; fake STT/meter; no LiveKit or live providers"}
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(json.dumps({key: value for key, value in result.items() if key not in {"samples", "sourceHashes"}}), flush=True)
    if not result["passed"]:
        raise SystemExit(1)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--seconds", type=int, default=1800)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if not 10 <= args.seconds <= 1800:
        parser.error("duration must be between 10 and 1800 real seconds")
    asyncio.run(measure(args.seconds, args.output))
