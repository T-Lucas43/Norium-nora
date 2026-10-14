"""Explicit audio upload to approved Groq; one token reservation per attempt.

Whisper reports decoder tokens via verbose segments, not audio input tokens.
Missing counts remain estimates. Hourly provider costs remain unpriced here.
"""
from __future__ import annotations
import asyncio
import base64
import binascii
import os
import httpx
from fastapi import HTTPException
from app.core.ai_guardrails import minimize_for_ai
from app.core.ai_provider_policy import approved_provider, ProviderPolicyError
from app.services.ai_costs import Meter


def usage_for(data: dict) -> dict:
    segments = data.get("segments")
    measured = bool(isinstance(segments, list) and segments and all(
        isinstance(item, dict) and isinstance(item.get("tokens"), list)
        and all(type(token) is int and token >= 0 for token in item["tokens"]) for item in segments))
    if not measured:
        return {}
    return {"prompt_tokens": 0, "completion_tokens": sum(len(item["tokens"]) for item in segments)}


async def transcribe(audio_data_url: str, mime_type: str, user: dict) -> dict:
    if not str(user.get("id") or ""):
        raise HTTPException(401, "Login necessário.")
    try:
        approved_provider(user, {"provider": "groq"})
    except ProviderPolicyError:
        raise HTTPException(403, "Groq não foi aprovado para esta conta.") from None
    api_key = os.getenv("GROQ_API_KEY", "").strip()
    if not api_key:
        raise HTTPException(503, "Transcrição de voz não configurada no servidor.")
    try:
        audio = base64.b64decode(audio_data_url.split(",", 1)[-1].strip(), validate=True)
    except (ValueError, binascii.Error):
        raise HTTPException(400, "Áudio inválido para transcrição.") from None
    if not audio or len(audio) > 15_000_000:
        raise HTTPException(413, "O áudio deve ter no máximo 15 MB.")
    mime = mime_type.split(";", 1)[0].strip().lower()
    extensions = {"audio/webm": "webm", "audio/ogg": "ogg", "audio/mp4": "mp4", "audio/mpeg": "mp3", "audio/wav": "wav", "audio/x-wav": "wav", "audio/flac": "flac", "audio/x-m4a": "m4a"}
    if mime not in extensions:
        raise HTTPException(415, "Selecione um áudio em formato compatível.")
    model = os.getenv("NORA_STT_MODEL", "whisper-large-v3-turbo").strip()
    if model not in {"whisper-large-v3-turbo", "whisper-large-v3"}:
        raise HTTPException(503, "Modelo de transcrição não aprovado.")
    provider = {"provider": "groq", "model": model, "id": f"groq/{model}"}
    async with httpx.AsyncClient(timeout=httpx.Timeout(25, connect=8)) as client:
        for attempt in range(2):
            try:
                async with Meter(provider, {"kind": "explicit_audio_transcription"}, 12000,
                                 user_id=user["id"], source="nora-transcription") as meter:
                    if meter.max_output < 12000:
                        raise HTTPException(402, "A transcrição requer uma reserva de 12.000 tokens. Ajuste sua franquia antes de transcrever este áudio.")
                    meter.sent()
                    response = await client.post("https://api.groq.com/openai/v1/audio/transcriptions",
                        headers={"Authorization": f"Bearer {api_key}"},
                        files={"file": (f"nora-voice.{extensions[mime]}", audio, mime)},
                        data={"model": model, "language": "pt", "response_format": "verbose_json", "temperature": "0"})
                    if response.status_code == 200:
                        data = response.json()
                        text = str(data.get("text") or "").strip()
                        usage = usage_for(data)
                        receipt = await meter.record({"model": model, "usage": usage}, text)
                        if not text:
                            raise HTTPException(422, "Não foi possível identificar fala no áudio.")
                        return {"text": minimize_for_ai(text)[:12000], "language": "pt-BR", "provider": "groq",
                                "usage": {"outputTokens": receipt["outputTokens"], "estimated": receipt["estimated"],
                                          "ledgerId": receipt["ledgerId"]}}
                    # Status-only rejection consumed no successful transcription; unknown
                    # timeout/response parsing retains the conservative reservation.
                    meter.rejected()
                    if response.status_code not in {429, 500, 502, 503, 504}:
                        raise HTTPException(502, "O serviço não aceitou este áudio. Confira a conexão e o formato.")
            except HTTPException:
                raise
            except (httpx.HTTPError, ValueError):
                pass
            if attempt == 0:
                await asyncio.sleep(.5)
    raise HTTPException(502, "A transcrição está indisponível. Tente novamente em instantes.")
