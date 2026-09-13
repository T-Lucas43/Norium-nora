from __future__ import annotations

import json
import asyncio
import time
import os
from collections.abc import AsyncGenerator
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

import httpx
from fastapi import HTTPException
from dotenv import load_dotenv

from app.services.nora_system_prompt import NORA_SYSTEM_PROMPT
from app.core.ai_guardrails import minimize_for_ai
from app.services.ai_costs import Meter


load_dotenv()


class NoraIncompleteResponse(Exception):
    """The provider exhausted the output budget before completing its answer."""


class NoraResearchUnavailable(ValueError):
    """A safe, actionable failure without provider payloads or credentials."""

    def __init__(self, reason: str):
        self.reason = reason
        super().__init__({
            "configuration": "A conexão da Nora com o provedor de IA precisa ser configurada pelo administrador.",
            "rate_limit": "O provedor de IA atingiu seu limite temporário. As fontes e as notas foram preservadas; tente novamente em alguns instantes.",
            "provider": "O provedor de IA está indisponível no momento. O texto anterior e as fontes foram preservados.",
        }[reason])


class NoraIAService:
    def __init__(self) -> None:
        self.api_key = os.getenv("GROQ_API_KEY", "").strip()
        self.base_url = "https://api.groq.com/openai/v1/chat/completions"
        self.headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        self.model = os.getenv("NORA_MODEL", "openai/gpt-oss-20b").strip() or "openai/gpt-oss-20b"
        configured_fallbacks = [
            model.strip()
            for model in os.getenv(
                "NORA_FALLBACK_MODELS",
                "openai/gpt-oss-20b,qwen/qwen3.6-27b,groq/compound-mini",
            ).split(",")
            if model.strip()
        ]
        self.fallback_models = list(dict.fromkeys([self.model, *configured_fallbacks]))
        self.system_prompt = NORA_SYSTEM_PROMPT
        self._client: httpx.AsyncClient | None = None

    def _http_client(self) -> httpx.AsyncClient:
        if self._client is None or getattr(self._client, "is_closed", False):
            try:
                self._client = httpx.AsyncClient(
                    timeout=httpx.Timeout(30.0, connect=8.0),
                    limits=httpx.Limits(max_connections=20, max_keepalive_connections=10, keepalive_expiry=45.0),
                )
            except TypeError:
                # Mantem compatibilidade com clientes substitutos sem perder pooling no runtime real.
                self._client = httpx.AsyncClient()
        return self._client

    def _models(self) -> list[str]:
        """Mantem a Nora operante quando um modelo configurado e retirado pelo provedor."""
        return list(dict.fromkeys([self.model, *self.fallback_models]))

    @staticmethod
    def _provider_error(status_code: int) -> str:
        if status_code in {400, 404}:
            return "A Nora esta atualizando o modelo de IA. Tente novamente em alguns segundos. Nenhuma acao foi executada."
        if status_code == 429:
            return "A Nora atingiu o limite temporario do provedor de IA. Tente novamente em instantes. Nenhuma acao foi executada."
        return f"A Nora nao conseguiu acessar o provedor de IA ({status_code}). Nenhuma acao foi executada."

    def _build_payload_messages(self, mensagens: list[dict[str, str]], screen_context: str | None) -> list[dict[str, str]]:
        now = datetime.now(ZoneInfo("America/Sao_Paulo"))
        system_content = (
            f"{self.system_prompt}\n\n"
            f"DATA ATUAL DO SISTEMA: {now.strftime('%d/%m/%Y')} ({now.strftime('%Y')}), "
            "fuso America/Sao_Paulo. Use esta data para interpretar hoje, amanhã, prazos, "
            "documentos e exemplos. Nunca reutilize um ano antigo como se fosse o atual."
        )
        if screen_context:
            system_content = f"{system_content}\n\nContexto atual do usuario na interface: {minimize_for_ai(screen_context, max_chars=4_000)}"

        payload_messages: list[dict[str, str]] = [{"role": "system", "content": system_content}]
        for message in mensagens:
            role = message.get("role", "user")
            payload_messages.append(
                {
                    "role": role if role in {"user", "assistant", "system"} else "user",
                    "content": minimize_for_ai(str(message.get("content", ""))),
                }
            )
        return payload_messages

    async def perguntar_nora(self, mensagens: list[dict[str, str]], screen_context: str | None = None, *, max_tokens: int = 1400, require_complete: bool = False, research: bool = False, user_id: str | None = None) -> str:
        if not self.api_key:
            if research:
                raise NoraResearchUnavailable("configuration")
            return "A Nora está temporariamente sem acesso ao provedor de IA. Configure a GROQ_API_KEY no backend."

        payload: dict[str, Any] = {
            "messages": self._build_payload_messages(mensagens, screen_context),
            "temperature": 0.45,
            "max_tokens": max(256, min(6000, max_tokens)),
        }

        try:
            client = self._http_client()
            last_status = 503
            retry_until = time.monotonic() + 55
            attempts = [(model, 0, 0.0) for model in self._models()]
            limited = False
            while attempts:
                model, retry, not_before = attempts.pop(0)
                if not_before > time.monotonic():
                    if not_before >= retry_until:
                        continue
                    await asyncio.sleep(not_before - time.monotonic())
                settings = {**payload, "model": model}
                if research and model.startswith("openai/gpt-oss"):
                    settings["reasoning_effort"] = "low"
                elif research and model in {"qwen/qwen3.6-27b", "qwen/qwen3.8-27b"}:
                    settings["reasoning_effort"] = "none"
                elif research and model.startswith("groq/compound"):
                    settings["compound_custom"] = {"tools": {"enabled_tools": []}}
                try:
                    async with Meter(self._billing_provider(model), settings["messages"], settings["max_tokens"], user_id=user_id, source="nora-research" if research else "nora") as meter:
                        settings["max_tokens"] = meter.max_output
                        meter.sent()
                        response = await client.post(self.base_url, json=settings, headers=self.headers)
                        if response.status_code == 200:
                            await meter.record(response.json())
                        else:
                            meter.rejected()
                except httpx.TransportError:
                    if research:
                        continue
                    raise
                last_status = response.status_code
                if response.status_code == 200:
                    data = response.json()
                    if require_complete and (data.get("choices") or [{}])[0].get("finish_reason") == "length":
                        raise NoraIncompleteResponse
                    content = data.get("choices", [{}])[0].get("message", {}).get("content")
                    answer = content.strip() if isinstance(content, str) else ""
                    if answer:
                        self.model = model
                        return answer
                    continue
                if research and last_status == 429:
                    limited = True
                    if retry < 2:
                        try:
                            delay = max(1, float(response.headers.get("retry-after", "5")))
                        except (ValueError, TypeError):
                            delay = 5
                        attempts.append((model, retry + 1, time.monotonic() + delay))
                if response.status_code not in {400, 404, 429, 500, 502, 503, 504}:
                    break
            if research:
                raise NoraResearchUnavailable("configuration" if last_status in {401, 403} else "rate_limit" if limited else "provider")
            return self._provider_error(last_status) if last_status != 200 else "Não consegui gerar uma resposta completa agora. Tente novamente em instantes."
        except (NoraIncompleteResponse, NoraResearchUnavailable, HTTPException):
            raise
        except Exception:
            if research:
                raise NoraResearchUnavailable("provider") from None
            return "A Nora não conseguiu acessar o servidor de IA. Nenhuma ação foi executada."

    async def perguntar_nora_stream(
        self, mensagens: list[dict[str, str]], screen_context: str | None = None, *, user_id: str | None = None
    ) -> AsyncGenerator[str, None]:
        if not self.api_key:
            yield "A Nora está temporariamente sem acesso ao provedor de IA. Configure a GROQ_API_KEY no backend."
            return

        payload: dict[str, Any] = {
            "messages": self._build_payload_messages(mensagens, screen_context),
            "temperature": 0.45,
            "max_tokens": 1400,
            "stream": True,
            "stream_options": {"include_usage": True},
        }

        try:
            client = self._http_client()
            last_status = 503
            for model in self._models():
                received_text = False
                async with Meter(self._billing_provider(model), payload["messages"], payload["max_tokens"], user_id=user_id, source="nora-stream") as meter, client.stream(
                    "POST",
                    self.base_url,
                    json={**payload, "model": model, "max_tokens": meter.max_output},
                    headers=self.headers,
                ) as response:
                    last_status = response.status_code
                    if response.status_code in {400, 404, 429, 500, 502, 503, 504}:
                        continue
                    if response.status_code != 200:
                        yield self._provider_error(response.status_code)
                        return
                    meter.sent()
                    self.model = model
                    usage_data = {}
                    async for line in response.aiter_lines():
                        if not line or not line.startswith("data: "):
                            continue
                        data = line[len("data: "):].strip()
                        if data == "[DONE]":
                            break
                        try:
                            chunk = json.loads(data)
                        except json.JSONDecodeError:
                            continue
                        if chunk.get("usage") or (chunk.get("x_groq") or {}).get("usage"):
                            usage_data = chunk
                        choices = chunk.get("choices") or []
                        delta = choices[0].get("delta", {}).get("content") if choices else None
                        if delta:
                            received_text = True
                            yield delta
                    await meter.record(usage_data)
                    if received_text:
                        return
            if last_status == 200:
                yield "Não consegui gerar uma resposta completa agora. Tente novamente em instantes."
            else:
                yield self._provider_error(last_status)
        except HTTPException as exc:
            yield str(exc.detail)
        except Exception:
            yield "A Nora não conseguiu acessar o servidor de IA. Nenhuma ação foi executada."

    @staticmethod
    def _billing_provider(model: str) -> dict:
        return {"id": "nora-runtime", "provider": "groq", "model": model, "name": "Nora Runtime", "baseUrl": "https://api.groq.com/openai/v1", "managed": True}
