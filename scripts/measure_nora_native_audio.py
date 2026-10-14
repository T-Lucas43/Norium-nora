"""Thirty-minute offline native RTC/audio pipeline soak, no room or credentials.

Run using the isolated environment containing requirements-nora-call.lock.txt.
Both sources are synthetic PCM; STT and meter are explicit local substitutes.
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
from importlib.metadata import version
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

from livekit import rtc
from app.modules.team.nora_call_agent import NoraAudioPipeline
from app.modules.team.nora_call_state import NoraCallConfig, NoraConsentState
from app.modules.team.nora_call_stt import SpeechSegment
from measure_nora_call_agent import process_memory


def hashes():
    paths = list((ROOT / "norium-back-end/app/modules/team").glob("nora_call_*.py")) + [Path(__file__), ROOT / "scripts/measure_nora_call_agent.py"]
    return {str(path.relative_to(ROOT)): hashlib.sha256(path.read_bytes()).hexdigest() for path in paths}


async def measure(seconds: int, output: Path):
    original = hashes()
    state = NoraConsentState("call_synthetic_native", "a", NoraCallConfig(enabled=True), True, "sfu")
    state.sync_members({"a": "a1", "b": "b1"})
    state.request("a", True)
    for user, session in state.sessions.items():
        state.consent(user, session, state.revision, True)
    counters = {"requests": 0, "settlements": 0, "segments": 0, "nativeFrames": 0, "maxQueue": 0}
    class Stt:
        async def transcribe(self, pcm):
            counters["requests"] += 1
            await asyncio.sleep(.001)
            return (SpeechSegment(0, 10, "Fala sintética para medição nativa."),)
    class Meter:
        async def reserve(self, event_id, duration):
            pass
        async def settle(self, event_id, **status):
            counters["settlements"] += 1
    async def publish(values):
        counters["segments"] += len(values)
    pipeline = NoraAudioPipeline(state, Stt(), Meter(), publish)
    pipeline.start()
    sources, streams, consumers = [], [], []
    started = time.monotonic()
    async def consume(user, stream):
        samples = 0
        async for item in stream:
            frame = item.frame
            if frame.sample_rate != 16000 or frame.num_channels != 1:
                raise RuntimeError("Unexpected native format")
            pipeline.feed(user, user + "1", bytes(frame.data), samples / 16000)
            samples += frame.samples_per_channel
            counters["nativeFrames"] += 1
            counters["maxQueue"] = max(counters["maxQueue"], pipeline.queue.qsize())
    for user in ("a", "b"):
        source = rtc.AudioSource(16000, 1, queue_size_ms=200)
        track = rtc.LocalAudioTrack.create_audio_track("synthetic-" + user, source)
        stream = rtc.AudioStream.from_track(track=track, sample_rate=16000, num_channels=1,
                                           frame_size_ms=20, capacity=8)
        sources.append(source)
        streams.append(stream)
        consumers.append(asyncio.create_task(consume(user, stream)))
    voiced = struct.pack("<h", 900) * 320
    silence = bytes(640)
    samples = []
    tracemalloc.start()
    try:
        for tick in range(seconds * 50):
            data = silence if tick // 50 % 40 >= 30 else voiced
            frame = rtc.AudioFrame(data=data, sample_rate=16000, num_channels=1, samples_per_channel=320)
            await asyncio.gather(*(source.capture_frame(frame) for source in sources))
            if tick % 3000 == 0:
                current, peak = tracemalloc.get_traced_memory()
                sample = {"elapsedSeconds": time.monotonic() - started, **process_memory(),
                          "pythonBytes": current, "pythonPeakBytes": peak,
                          "bufferBytes": sum(len(chunk.buffer) for chunk in pipeline.chunkers.values())}
                samples.append(sample)
                print(json.dumps({"elapsed": tick // 50, "rssMiB": round(sample["rssMiB"], 2), "nativeFrames": counters["nativeFrames"]}), flush=True)
            await asyncio.sleep(max(0, started + (tick + 1) * .02 - time.monotonic()))
        await asyncio.gather(*(source.wait_for_playout() for source in sources))
        await asyncio.sleep(.1)
        await asyncio.wait_for(pipeline.queue.join(), 10)
    finally:
        for stream in streams:
            await stream.aclose()
        for task in consumers:
            await task
        for source in sources:
            source.clear_queue()
            await source.aclose()
        await pipeline.close()
    elapsed = time.monotonic() - started
    stable = [sample for sample in samples if sample["elapsedSeconds"] >= min(120, seconds / 3)]
    rss_range = max(sample["rssMiB"] for sample in stable) - min(sample["rssMiB"] for sample in stable) if stable else 0
    python_range = max(sample["pythonBytes"] for sample in stable) - min(sample["pythonBytes"] for sample in stable) if stable else 0
    private_growth = max(0, max(sample["privateCommitMiB"] for sample in stable) - stable[0]["privateCommitMiB"]) if stable else 0
    result = {"durationSeconds": elapsed, "sdkVersion": version("livekit"), "sources": 2, **counters,
              "samples": samples, "stableRssRangeMiB": rss_range, "stablePythonRangeBytes": python_range,
              "privateCommitGrowthMiB": private_growth,
              "memoryCriterion": "private commit growth after warmup <16 MiB; Python allocation range <2 MiB; RSS range descriptive only",
              "sourceHashes": original, "sourceUnchanged": original == hashes(),
              "roomConnected": False, "liveProviders": False,
              "passed": elapsed >= seconds and private_growth < 16 and python_range < 2 * 1024 * 1024
                        and counters["nativeFrames"] > seconds * 80 and not pipeline.last_error,
              "scope": "native local AudioSource/AudioStream + pipeline; synthetic audio; fake STT/meter; no SFU room"}
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, indent=2), encoding="utf-8")
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
