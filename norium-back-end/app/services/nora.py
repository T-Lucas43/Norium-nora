from __future__ import annotations

import os
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

    async def perguntar_nora(self, mensagens: list[dict[str, str]]) -> str:
        if not self.api_key:
            return "A Nora está temporariamente sem acesso ao provedor de IA. Configure a GROQ_API_KEY no backend."

        payload_messages: list[dict[str, str]] = [{"role": "system", "content": self.system_prompt}]
        for message in mensagens:
            role = message.get("role", "user")
            payload_messages.append(
                {
                    "role": role if role in {"user", "assistant", "system"} else "user",
                    "content": str(message.get("content", "")),
                }
            )

        payload: dict[str, Any] = {
            "model": self.model,
            "messages": payload_messages,
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
