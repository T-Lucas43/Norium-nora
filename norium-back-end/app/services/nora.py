from __future__ import annotations

import json
import os
from collections.abc import AsyncGenerator
from typing import Any

import httpx
from dotenv import load_dotenv

from app.services.nora_system_prompt import NORA_SYSTEM_PROMPT


load_dotenv()


class NoraIAService:
    def __init__(self) -> None:
        self.api_key = os.getenv("GROQ_API_KEY", "").strip()
        self.base_url = "https://api.groq.com/openai/v1/chat/completions"
        self.headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        self.model = os.getenv("NORA_MODEL", "llama-3.1-8b-instant").strip() or "llama-3.1-8b-instant"
        self.system_prompt = NORA_SYSTEM_PROMPT

    def _build_payload_messages(self, mensagens: list[dict[str, str]], screen_context: str | None) -> list[dict[str, str]]:
        system_content = self.system_prompt
        if screen_context:
            system_content = f"{system_content}\n\nContexto atual do usuario na interface: {screen_context}"

        payload_messages: list[dict[str, str]] = [{"role": "system", "content": system_content}]
        for message in mensagens:
            role = message.get("role", "user")
            payload_messages.append(
                {
                    "role": role if role in {"user", "assistant", "system"} else "user",
                    "content": str(message.get("content", "")),
                }
            )
        return payload_messages

    async def perguntar_nora(self, mensagens: list[dict[str, str]], screen_context: str | None = None) -> str:
        if not self.api_key:
            return "A Nora está temporariamente sem acesso ao provedor de IA. Configure a GROQ_API_KEY no backend."

        payload: dict[str, Any] = {
            "model": self.model,
            "messages": self._build_payload_messages(mensagens, screen_context),
            "temperature": 0.45,
            "max_tokens": 1400,
        }

        async with httpx.AsyncClient() as client:
            try:
                response = await client.post(self.base_url, json=payload, headers=self.headers, timeout=30.0)
                if response.status_code == 200:
                    data = response.json()
                    return str(data["choices"][0]["message"]["content"])
                return f"A Nora não conseguiu acessar o provedor de IA ({response.status_code}). Nenhuma ação foi executada."
            except Exception as exc:
                return f"A Nora não conseguiu acessar o servidor de IA: {str(exc)}. Nenhuma ação foi executada."

    async def perguntar_nora_stream(
        self, mensagens: list[dict[str, str]], screen_context: str | None = None
    ) -> AsyncGenerator[str, None]:
        if not self.api_key:
            yield "A Nora está temporariamente sem acesso ao provedor de IA. Configure a GROQ_API_KEY no backend."
            return

        payload: dict[str, Any] = {
            "model": self.model,
            "messages": self._build_payload_messages(mensagens, screen_context),
            "temperature": 0.45,
            "max_tokens": 1400,
            "stream": True,
        }

        try:
            async with httpx.AsyncClient() as client:
                async with client.stream("POST", self.base_url, json=payload, headers=self.headers, timeout=30.0) as response:
                    if response.status_code != 200:
                        yield f"A Nora não conseguiu acessar o provedor de IA ({response.status_code}). Nenhuma ação foi executada."
                        return
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
        except Exception as exc:
            yield f"A Nora não conseguiu acessar o servidor de IA: {str(exc)}. Nenhuma ação foi executada."
