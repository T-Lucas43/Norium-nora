from __future__ import annotations

import json
import os
from collections.abc import AsyncGenerator
from typing import Any

import httpx
from dotenv import load_dotenv

from app.services.nora_system_prompt import NORA_SYSTEM_PROMPT
from app.core.ai_guardrails import minimize_for_ai


load_dotenv()


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
        system_content = self.system_prompt
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

    async def perguntar_nora(self, mensagens: list[dict[str, str]], screen_context: str | None = None) -> str:
        if not self.api_key:
            return "A Nora está temporariamente sem acesso ao provedor de IA. Configure a GROQ_API_KEY no backend."

        payload: dict[str, Any] = {
            "messages": self._build_payload_messages(mensagens, screen_context),
            "temperature": 0.45,
            "max_tokens": 1400,
        }

        async with httpx.AsyncClient() as client:
            try:
                last_status = 503
                for model in self._models():
                    response = await client.post(
                        self.base_url,
                        json={**payload, "model": model},
                        headers=self.headers,
                        timeout=30.0,
                    )
                    last_status = response.status_code
                    if response.status_code == 200:
                        self.model = model
                        data = response.json()
                        return str(data["choices"][0]["message"]["content"])
                    if response.status_code not in {400, 404}:
                        break
                return self._provider_error(last_status)
            except Exception:
                return "A Nora não conseguiu acessar o servidor de IA. Nenhuma ação foi executada."

    async def perguntar_nora_stream(
        self, mensagens: list[dict[str, str]], screen_context: str | None = None
    ) -> AsyncGenerator[str, None]:
        if not self.api_key:
            yield "A Nora está temporariamente sem acesso ao provedor de IA. Configure a GROQ_API_KEY no backend."
            return

        payload: dict[str, Any] = {
            "messages": self._build_payload_messages(mensagens, screen_context),
            "temperature": 0.45,
            "max_tokens": 1400,
            "stream": True,
        }

        try:
            async with httpx.AsyncClient() as client:
                last_status = 503
                for model in self._models():
                    async with client.stream(
                        "POST",
                        self.base_url,
                        json={**payload, "model": model},
                        headers=self.headers,
                        timeout=30.0,
                    ) as response:
                        last_status = response.status_code
                        if response.status_code in {400, 404}:
                            continue
                        if response.status_code != 200:
                            yield self._provider_error(response.status_code)
                            return
                        self.model = model
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
                            choices = chunk.get("choices") or []
                            delta = choices[0].get("delta", {}).get("content") if choices else None
                            if delta:
                                yield delta
                        return
                yield self._provider_error(last_status)
        except Exception:
            yield "A Nora não conseguiu acessar o servidor de IA. Nenhuma ação foi executada."
