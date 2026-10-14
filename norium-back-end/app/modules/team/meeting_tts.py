"""ElevenLabs PCM stream, backend-only key and explicitly configured voice.

The operator must verify the chosen voice is Alice in the account catalogue;
the historical global voice ID is not assumed to be Alice. No voice is guessed.
"""
from __future__ import annotations

import re
from typing import AsyncIterator

import httpx

from app.core.ai_guardrails import minimize_for_ai


class MeetingSpeechUnavailable(RuntimeError):
    pass


class ElevenLabsMeetingStream:
    def __init__(self, *, api_key: str, alice_voice_id: str, client: httpx.AsyncClient,
                 model: str = "eleven_multilingual_v2"):
        if not api_key.strip() or not re.fullmatch(r"[A-Za-z0-9]{10,80}", alice_voice_id):
            raise MeetingSpeechUnavailable("Voz Alice não configurada para reuniões.")
        if model not in {"eleven_multilingual_v2", "eleven_flash_v2_5", "eleven_turbo_v2_5"}:
            raise MeetingSpeechUnavailable("Modelo de voz não autorizado para reuniões.")
        self._api_key, self._voice_id = api_key.strip(), alice_voice_id
        self._client, self.model = client, model

    async def stream(self, text: str) -> AsyncIterator[bytes]:
        if not isinstance(text, str) or not text.strip() or len(text) > 1800:
            raise ValueError("Texto de voz inválido.")
        payload = {"text": minimize_for_ai(text).strip(), "model_id": self.model,
                   "voice_settings": {"stability": 0.45, "similarity_boost": 0.78,
                                      "style": 0.25, "use_speaker_boost": True}}
        if self.model != "eleven_multilingual_v2":
            payload["language_code"] = "pt"
        buffer = bytearray()
        total = 0
        try:
            async with self._client.stream(
                "POST", f"https://api.elevenlabs.io/v1/text-to-speech/{self._voice_id}/stream",
                headers={"xi-api-key": self._api_key, "Accept": "application/octet-stream"},
                params={"output_format": "pcm_16000"}, json=payload,
                timeout=httpx.Timeout(30, connect=5), follow_redirects=False,
            ) as response:
                if response.status_code != 200:
                    raise MeetingSpeechUnavailable("Voz temporariamente indisponível.")
                async for part in response.aiter_bytes(chunk_size=640):
                    total += len(part)
                    if total > 120 * 32000:
                        raise MeetingSpeechUnavailable("Limite de voz da reunião atingido.")
                    buffer.extend(part)
                    while len(buffer) >= 640:
                        yield bytes(buffer[:640])
                        del buffer[:640]
                if len(buffer) % 2:
                    raise MeetingSpeechUnavailable("Voz temporariamente indisponível.")
                if buffer:
                    yield bytes(buffer)
        except httpx.HTTPError:
            raise MeetingSpeechUnavailable("Voz temporariamente indisponível.") from None
