from __future__ import annotations

import json
import hashlib
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

from app.services.nora_system_prompt import NORA_SYSTEM_PROMPT, NORA_EMAIL_DRAFT_PROMPT
from app.core.ai_guardrails import minimize_for_ai
from app.services.ai_costs import Meter
from app.core.request_context import current_ai_user_id, current_workspace_id


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
        requested_provider = os.getenv("NORA_PROVIDER", "auto").strip().lower() or "auto"
        openai_key = os.getenv("OPENAI_API_KEY", "").strip()
        groq_key = os.getenv("GROQ_API_KEY", "").strip()
        self.provider = "openai" if requested_provider == "openai" or (requested_provider == "auto" and openai_key) else "groq"
        self.api_key = openai_key if self.provider == "openai" else groq_key
        self.base_url = (
            "https://api.openai.com/v1/responses"
            if self.provider == "openai"
            else "https://api.groq.com/openai/v1/chat/completions"
        )
        self.headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        if self.provider == "openai":
            self.model = os.getenv("NORA_OPENAI_MODEL", "gpt-5.6-luna").strip() or "gpt-5.6-luna"
            fallback_setting = os.getenv("NORA_OPENAI_FALLBACK_MODELS", "gpt-5.6-luna")
        else:
            self.model = os.getenv("NORA_MODEL", "openai/gpt-oss-20b").strip() or "openai/gpt-oss-20b"
            fallback_setting = os.getenv(
                "NORA_FALLBACK_MODELS",
                "openai/gpt-oss-20b,qwen/qwen3.6-27b,groq/compound-mini",
            )
        configured_fallbacks = [
            model.strip()
            for model in fallback_setting.split(",")
            if model.strip()
        ]
        self.fallback_models = list(dict.fromkeys([self.model, *configured_fallbacks]))
        self.system_prompt = NORA_SYSTEM_PROMPT
        self._client: httpx.AsyncClient | None = None

    async def _authorize_provider(self, user_id):
        from app.core.ai_provider_policy import approved_provider, ProviderPolicyError
        from app.core.tenant import get_system_db_path, read_json_file
        actor = str(user_id or "system")
        store = await asyncio.to_thread(read_json_file, get_system_db_path("usuarios"), {})
        identity = next((u for u in store.get("users", []) if u.get("id") == actor), {"id": actor}) if isinstance(store, dict) else {"id": actor}
        try:
            approved_provider(identity, {"provider": self.provider})
        except ProviderPolicyError:
            raise HTTPException(403, "Este provedor de IA não foi aprovado para sua conta.") from None

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

    @property
    def _uses_responses_api(self) -> bool:
        return self.provider == "openai"

    def _request_payload(self, messages: list[dict[str, str]], max_tokens: int, *, stream: bool = False) -> dict[str, Any]:
        if self._uses_responses_api:
            system_parts = [item["content"] for item in messages if item.get("role") == "system"]
            system = "\n\n".join(system_parts) or self.system_prompt
            conversation = [item for item in messages if item.get("role") != "system"]
            return {
                "instructions": system,
                "input": conversation,
                "max_output_tokens": max_tokens,
                "store": False,
                "stream": stream,
            }
        return {
            "messages": messages,
            "temperature": 0.45,
            "max_tokens": max_tokens,
            **({"stream": True, "stream_options": {"include_usage": True}} if stream else {}),
        }

    def _response_text(self, data: dict[str, Any]) -> str:
        if not self._uses_responses_api:
            content = (data.get("choices") or [{}])[0].get("message", {}).get("content")
            return content.strip() if isinstance(content, str) else ""
        direct = data.get("output_text")
        if isinstance(direct, str) and direct.strip():
            return direct.strip()
        return "".join(
            str(part.get("text") or "")
            for item in data.get("output") or []
            if isinstance(item, dict) and item.get("type") == "message"
            for part in item.get("content") or []
            if isinstance(part, dict) and part.get("type") == "output_text"
        ).strip()

    @staticmethod
    def _provider_error(status_code: int) -> str:
        if status_code in {400, 404}:
            return "A Nora esta atualizando o modelo de IA. Tente novamente em alguns segundos. Nenhuma acao foi executada."
        if status_code == 429:
            return "A Nora atingiu o limite temporario do provedor de IA. Tente novamente em instantes. Nenhuma acao foi executada."
        return f"A Nora nao conseguiu acessar o provedor de IA ({status_code}). Nenhuma acao foi executada."

    def _build_payload_messages(self, mensagens: list[dict[str, str]], screen_context: str | None, *, purpose: str = "routine") -> list[dict[str, str]]:
        now = datetime.now(ZoneInfo("America/Sao_Paulo"))
        system_content = (
            f"{NORA_EMAIL_DRAFT_PROMPT if purpose == 'email-draft' else self.system_prompt}\n\n"
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

    async def perguntar_nora(self, mensagens: list[dict[str, str]], screen_context: str | None = None, *, max_tokens: int = 1400, require_complete: bool = False, research: bool = False, user_id: str | None = None, purpose: str = "routine", usage_source: str | None = None, strict_errors: bool = False) -> str:
        if not self.api_key:
            if strict_errors:
                raise HTTPException(503, "A Nora está sem provedor de IA configurado.")
            if research:
                raise NoraResearchUnavailable("configuration")
            return "A Nora está temporariamente sem acesso ao provedor de IA. Configure OPENAI_API_KEY ou GROQ_API_KEY no backend."

        user_id = user_id or current_ai_user_id()
        await self._authorize_provider(user_id)
        built_messages = self._build_payload_messages(mensagens, screen_context, purpose=purpose)
        cache_key = (str(user_id or "system"), current_workspace_id(), self.provider, purpose,
                     hashlib.sha256(json.dumps({"messages": built_messages, "tokens": max_tokens,
                        "complete": require_complete, "research": research, "model": self.model}, sort_keys=True).encode()).hexdigest())
        cached = _response_cache.get(cache_key)
        if not research and cached and cached[0] > time.monotonic():
            return cached[1]
        output_budget = max(256, min(6000, max_tokens))
        payload = self._request_payload(built_messages, output_budget)

        try:
            client = self._http_client()
            last_status = 503
            retry_until = time.monotonic() + 55
            chosen = ([os.getenv("NORA_OPENAI_DOCUMENT_MODEL", "gpt-5.6-sol")] if self.provider == "openai" and purpose == "document" else self._models())
            attempts = [(model, 0, 0.0) for model in chosen]
            limited = False
            while attempts:
                model, retry, not_before = attempts.pop(0)
                if not_before > time.monotonic():
                    if not_before >= retry_until:
                        continue
                    await asyncio.sleep(not_before - time.monotonic())
                settings = {**payload, "model": model}
                if not self._uses_responses_api and research and model.startswith("openai/gpt-oss"):
                    settings["reasoning_effort"] = "low"
                elif research and model in {"qwen/qwen3.6-27b", "qwen/qwen3.8-27b"}:
                    settings["reasoning_effort"] = "none"
                elif research and model.startswith("groq/compound"):
                    settings["compound_custom"] = {"tools": {"enabled_tools": []}}
                try:
                    async with Meter(self._billing_provider(model), built_messages, output_budget, user_id=user_id, source=usage_source or ("nora-research" if research else "nora")) as meter:
                        settings["max_output_tokens" if self._uses_responses_api else "max_tokens"] = meter.max_output
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
                    incomplete = (
                        data.get("status") != "completed"
                        if self._uses_responses_api
                        else (data.get("choices") or [{}])[0].get("finish_reason") == "length"
                    )
                    if require_complete and incomplete:
                        raise NoraIncompleteResponse
                    answer = self._response_text(data)
                    if answer:
                        if purpose != "document":
                            self.model = model
                        if not research:
                            for expired in [key for key, value in _response_cache.items() if value[0] <= time.monotonic()]:
                                _response_cache.pop(expired, None)
                            if len(_response_cache) >= 128:
                                _response_cache.pop(next(iter(_response_cache)))
                            _response_cache[cache_key] = (time.monotonic() + 30, answer)
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
            if strict_errors:
                raise HTTPException(503, "O provedor não conseguiu concluir esta solicitação.")
            return self._provider_error(last_status) if last_status != 200 else "Não consegui gerar uma resposta completa agora. Tente novamente em instantes."
        except (NoraIncompleteResponse, NoraResearchUnavailable, HTTPException):
            raise
        except Exception:
            if strict_errors:
                raise HTTPException(502, "A Nora não conseguiu concluir esta solicitação.") from None
            if research:
                raise NoraResearchUnavailable("provider") from None
            return "A Nora não conseguiu acessar o servidor de IA. Nenhuma ação foi executada."

    async def perguntar_nora_stream(
        self, mensagens: list[dict[str, str]], screen_context: str | None = None, *, user_id: str | None = None
    ) -> AsyncGenerator[str, None]:
        if not self.api_key:
            yield "A Nora está temporariamente sem acesso ao provedor de IA. Configure OPENAI_API_KEY ou GROQ_API_KEY no backend."
            return

        user_id = user_id or current_ai_user_id()
        await self._authorize_provider(user_id)
        built_messages = self._build_payload_messages(mensagens, screen_context)
        payload = self._request_payload(built_messages, 1400, stream=True)

        try:
            client = self._http_client()
            last_status = 503
            for model in self._models():
                received_text = False
                async with Meter(self._billing_provider(model), built_messages, 1400, user_id=user_id, source="nora-stream") as meter, client.stream(
                    "POST",
                    self.base_url,
                    json={**payload, "model": model, ("max_output_tokens" if self._uses_responses_api else "max_tokens"): meter.max_output},
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
                        if self._uses_responses_api:
                            if chunk.get("type") == "response.completed":
                                usage_data = chunk.get("response") or chunk
                            delta = chunk.get("delta") if chunk.get("type") == "response.output_text.delta" else None
                        else:
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

    def _billing_provider(self, model: str) -> dict:
        return {
            "id": "nora-runtime",
            "provider": self.provider,
            "model": model,
            "name": "Nora Runtime",
            "baseUrl": "https://api.openai.com/v1" if self._uses_responses_api else "https://api.groq.com/openai/v1",
            "managed": True,
        }


_response_cache: dict[tuple, tuple[float, str]] = {}


def clear_response_cache(user_id: str) -> None:
    for key in [key for key in _response_cache if key[0] == user_id]:
        _response_cache.pop(key, None)
