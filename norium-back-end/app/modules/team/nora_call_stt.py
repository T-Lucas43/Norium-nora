"""Bounded in-memory Groq STT adapter. No automatic retry of billable audio."""
from __future__ import annotations

import io
import json
import math
import wave
from dataclasses import dataclass
from typing import Protocol

import httpx

from app.core.ai_guardrails import minimize_for_ai

SAMPLE_RATE = 16_000
MAX_PCM_BYTES = SAMPLE_RATE * 2 * 10
MAX_RESPONSE_BYTES = 128 * 1024


class TranscriptionUnavailable(RuntimeError):
    pass


@dataclass(frozen=True)
class SpeechSegment:
    start: float
    end: float
    text: str


class SpeechToText(Protocol):
    async def transcribe(self, pcm: bytes) -> tuple[SpeechSegment, ...]: ...


def wav_bytes(pcm: bytes) -> bytes:
    if not pcm or len(pcm) % 2 or len(pcm) > MAX_PCM_BYTES:
        raise ValueError("Trecho de áudio inválido.")
    target = io.BytesIO()
    with wave.open(target, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(SAMPLE_RATE)
        wav.writeframes(pcm)
    return target.getvalue()


def parse_segments(payload: object, duration: float) -> tuple[SpeechSegment, ...]:
    if not isinstance(payload, dict):
        raise TranscriptionUnavailable("Transcrição temporariamente indisponível.")
    items = payload.get("segments")
    if items is None and isinstance(payload.get("text"), str):
        items = [{"start": 0, "end": duration, "text": payload["text"]}]
    if not isinstance(items, list) or len(items) > 100:
        raise TranscriptionUnavailable("Transcrição temporariamente indisponível.")
    result = []
    for item in items:
        if not isinstance(item, dict) or not isinstance(item.get("text"), str):
            raise TranscriptionUnavailable("Transcrição temporariamente indisponível.")
        start, end = item.get("start"), item.get("end")
        if any(isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value)
               for value in (start, end)) or not 0 <= start < end <= duration + 0.25:
            raise TranscriptionUnavailable("Transcrição temporariamente indisponível.")
        text = minimize_for_ai(item["text"], max_chars=2000).strip()
        if text:
            result.append(SpeechSegment(float(start), min(float(end), duration), text))
    return tuple(result)


class GroqWhisper:
    model = "whisper-large-v3-turbo"
    endpoint = "https://api.groq.com/openai/v1/audio/transcriptions"

    def __init__(self, api_key: str, client: httpx.AsyncClient) -> None:
        if not api_key.strip():
            raise TranscriptionUnavailable("Transcrição não configurada no servidor.")
        self._api_key = api_key.strip()
        self._client = client

    async def transcribe(self, pcm: bytes) -> tuple[SpeechSegment, ...]:
        wav = wav_bytes(pcm)
        try:
            async with self._client.stream(
                "POST", self.endpoint,
                headers={"Authorization": f"Bearer {self._api_key}"},
                files={"file": ("meeting.wav", wav, "audio/wav")},
                data={"model": self.model, "language": "pt", "temperature": "0",
                      "response_format": "verbose_json", "timestamp_granularities[]": "segment"},
                timeout=httpx.Timeout(25, connect=5), follow_redirects=False,
            ) as response:
                if response.status_code != 200:
                    raise TranscriptionUnavailable("Transcrição temporariamente indisponível.")
                body = bytearray()
                async for data in response.aiter_bytes():
                    if len(body) + len(data) > MAX_RESPONSE_BYTES:
                        raise TranscriptionUnavailable("Transcrição temporariamente indisponível.")
                    body.extend(data)
                payload = json.loads(body)
            return parse_segments(payload, len(pcm) / (SAMPLE_RATE * 2))
        except (httpx.HTTPError, ValueError, TypeError) as exc:
            raise TranscriptionUnavailable("Transcrição temporariamente indisponível.") from None
