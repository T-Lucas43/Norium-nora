from __future__ import annotations

import asyncio
import hashlib
import html
import json
import os
import re
import uuid
import unicodedata
from collections import Counter
from datetime import datetime, timezone
from html.parser import HTMLParser
from typing import Any
from urllib.parse import urljoin, urlparse

import httpx
from fastapi import HTTPException

from app.core.ai_guardrails import minimize_for_ai
from app.core.tenant import read_user_db, write_user_db
from app.infrastructure.public_http import PublicHTTPTransport, assert_public_dns, host_matches, validate_public_url
from app.services.ai_costs import Meter, apply_provider_prices
from app.modules.intelligence.repository import mutate_store, now_iso, read_store, write_store
from app.modules.platform.service import decrypt_secret, encrypt_secret, save_vault_secret


MAX_FETCH_BYTES = 1_000_000
SENSITIVE_TERMS = (
    "comprar", "pagar", "enviar", "publicar", "excluir", "apagar", "assinar",
    "confirmar pedido", "transferir", "alterar senha", "login", "entrar na conta",
)
TOKEN_PATTERN = re.compile(r"[a-zA-ZÀ-ÿ0-9_]{2,}")


def entity_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:16]}"


def tenant_id(user: dict[str, Any]) -> str:
    return str(user.get("id") or "anonymous")


def normalize_text(value: Any) -> str:
    return " ".join(str(value or "").lower().split())


class _TextExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.title = ""
        self._in_title = False
        self._skip = 0
        self.parts: list[str] = []
        self.links: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in {"script", "style", "noscript", "svg"}:
            self._skip += 1
        if tag == "title":
            self._in_title = True
        if tag == "a":
            href = next((value for key, value in attrs if key.lower() == "href" and value), None)
            if href:
                self.links.append(href)

    def handle_endtag(self, tag: str) -> None:
        if tag in {"script", "style", "noscript", "svg"} and self._skip:
            self._skip -= 1
        if tag == "title":
            self._in_title = False

    def handle_data(self, data: str) -> None:
        clean = " ".join(data.split())
        if not clean or self._skip:
            return
        if self._in_title:
            self.title = f"{self.title} {clean}".strip()
        self.parts.append(clean)


def extract_page(content: bytes, content_type: str) -> tuple[str, str, list[str]]:
    charset = "utf-8"
    match = re.search(r"charset=([\w-]+)", content_type, flags=re.I)
    if match:
        charset = match.group(1)
    text = content.decode(charset, errors="replace")
    if "html" not in content_type.lower():
        return "Documento de texto", " ".join(text.split())[:200_000], []
    parser = _TextExtractor()
    parser.feed(text)
    return parser.title[:300] or "Pagina sem titulo", "\n".join(parser.parts)[:200_000], parser.links


async def safe_fetch(url: str, allowed_domains: list[str] | None = None, blocked_domains: list[str] | None = None) -> dict[str, Any]:
    normalized, host = validate_public_url(url, allowed_domains, blocked_domains)
    await assert_public_dns(host)
    timeout = httpx.Timeout(20, connect=8)
    headers = {"User-Agent": "NoriumBrowserAgent/1.0 (+safe-read-only)"}
    try:
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=False, headers=headers, trust_env=False,
                                     transport=PublicHTTPTransport(allowed_domains or [host], blocked_domains)) as client:
            async with client.stream("GET", normalized) as response:
                if 300 <= response.status_code < 400:
                    raise HTTPException(status_code=409, detail="A pagina redirecionou. Revise e autorize a URL final antes de continuar.")
                response.raise_for_status()
                content_type = response.headers.get("content-type", "")
                if not any(kind in content_type.lower() for kind in ("text/", "html", "json", "xml")):
                    raise HTTPException(status_code=415, detail="O agente aceita apenas conteudo textual nesta versao.")
                chunks: list[bytes] = []
                size = 0
                async for chunk in response.aiter_bytes():
                    size += len(chunk)
                    if size > MAX_FETCH_BYTES:
                        raise HTTPException(status_code=413, detail="A pagina excede o limite seguro de 1 MB.")
                    chunks.append(chunk)
    except HTTPException:
        raise
    except (httpx.HTTPError, OSError) as exc:
        raise HTTPException(status_code=502, detail="Nao foi possivel ler a pagina publica solicitada.") from exc
    title, text, raw_links = extract_page(b"".join(chunks), content_type)
    links = []
    for raw_link in raw_links:
        resolved = urljoin(normalized, raw_link)
        if urlparse(resolved).scheme in {"http", "https"}:
            links.append(resolved)
    return {"url": normalized, "host": host, "title": title, "text": text, "links": list(dict.fromkeys(links))[:100], "bytes": size, "contentType": content_type}


def browser_risk(objective: str) -> tuple[str, bool, str]:
    normalized = normalize_text(objective)
    matched = next((term for term in SENSITIVE_TERMS if term in normalized), None)
    if matched:
        return "alto", True, f'A tarefa inclui uma acao sensivel ("{matched}") e exige aprovacao humana.'
    if any(term in normalized for term in ("preencher", "formulario", "baixar", "download", "clicar")):
        return "medio", True, "A tarefa pode alterar estado ou transferir arquivo e exige aprovacao humana."
    return "baixo", False, "Leitura publica sem alteracao externa."


READ_ACTIONS = {"navigate", "search", "extract", "screenshot", "wait"}
EXTERNAL_ACTIONS = {"click", "fill", "select", "press", "download", "upload"}
SENSITIVE_ACTION_TERMS = {
    "enviar", "submit", "comprar", "pagar", "pagamento", "assinar", "aceitar",
    "excluir", "apagar", "publicar", "contratar", "transferir", "senha", "login",
}


def classify_browser_action(action: dict[str, Any]) -> tuple[str, bool, str]:
    kind = str(action.get("type") or "")
    context = normalize_text(f'{action.get("target", "")} {action.get("description", "")}')
    sensitive = kind == "credential_fill" or any(term in context for term in SENSITIVE_ACTION_TERMS)
    if sensitive:
        return "sensitive", True, "Acao sensivel: exige confirmacao imediatamente antes da execucao."
    if kind in EXTERNAL_ACTIONS:
        return "external", True, "Acao externa: exige aprovacao antes de alterar ou transferir dados."
    if kind in {"click", "press"} and any(term in context for term in SENSITIVE_ACTION_TERMS):
        return "sensitive", True, "O controle pode confirmar uma operacao sensivel."
    return "read", False, "Acao de navegacao ou consulta sem alteracao externa identificada."


def _action(kind: str, description: str, target: str = "", value: str = "", **extra: Any) -> dict[str, Any]:
    item = {
        "id": entity_id("action"), "type": kind, "description": description,
        "target": target, "value": value, "status": "pending", "approved": False,
        **extra,
    }
    risk_class, requires_approval, reason = classify_browser_action(item)
    item.update({"riskClass": risk_class, "requiresApproval": requires_approval, "riskReason": reason})
    return item


def heuristic_browser_actions(objective: str, start_url: str) -> list[dict[str, Any]]:
    actions = [_action("navigate", "Abrir a URL inicial autorizada", value=start_url)]
    quoted = re.findall(r'["“]([^"”]{1,300})["”]', objective)
    normalized = normalize_text(objective)
    fill_match = re.search(r'(?:preencha|preencher)\s+(?:o\s+campo\s+)?["“]([^"”]+)["”]\s+com\s+["“]([^"”]+)["”]', objective, flags=re.I)
    select_match = re.search(r'(?:selecione|selecionar)\s+["“]([^"”]+)["”]\s+(?:em|no\s+campo)\s+["“]([^"”]+)["”]', objective, flags=re.I)
    if fill_match:
        actions.append(_action("fill", f'Preencher o campo {fill_match.group(1)}', target=fill_match.group(1), value=fill_match.group(2)))
    if select_match:
        actions.append(_action("select", f'Selecionar {select_match.group(1)} em {select_match.group(2)}', target=select_match.group(2), value=select_match.group(1)))
    if any(term in normalized for term in ("pesquise", "pesquisar", "busque", "buscar", "procure", "procurar")):
        query = quoted[0] if quoted else re.sub(r'^.*?(?:por|sobre)\s+', "", objective, flags=re.I).strip(" .")
        if query and query != objective:
            actions.append(_action("search", f'Pesquisar por {query[:120]}', value=query[:1000]))
    click_match = re.search(r'(?:clique|clicar)\s+(?:em|no|na)?\s*["“]([^"”]+)["”]', objective, flags=re.I)
    if click_match:
        actions.append(_action("click", f'Clicar em {click_match.group(1)}', target=click_match.group(1)))
    if any(term in normalized for term in ("baixe", "baixar", "download")) and quoted:
        actions.append(_action("download", f'Baixar {quoted[-1]}', target=quoted[-1]))
    actions.extend([
        _action("extract", "Extrair texto, links e tabelas da pagina final"),
        _action("screenshot", "Registrar captura final como evidencia"),
    ])
    return actions


def _parse_planner_json(answer: str) -> list[dict[str, Any]]:
    match = re.search(r"\{[\s\S]*\}", answer)
    if not match:
        return []
    try:
        payload = json.loads(match.group(0))
    except json.JSONDecodeError:
        return []
    actions = payload.get("actions") if isinstance(payload, dict) else []
    if not isinstance(actions, list):
        return []
    allowed = {"navigate", "search", "click", "fill", "select", "press", "wait", "extract", "screenshot", "download", "upload", "credential_fill"}
    normalized: list[dict[str, Any]] = []
    for raw in actions[:40]:
        if not isinstance(raw, dict) or raw.get("type") not in allowed:
            continue
        normalized.append(_action(
            str(raw["type"]), str(raw.get("description") or raw["type"])[:500],
            target=str(raw.get("target") or "")[:500], value=str(raw.get("value") or "")[:10_000],
        ))
    return normalized


async def plan_browser_actions(user: dict[str, Any], payload: dict[str, Any], normalized_url: str) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    if payload.get("taskType", "automation") != "automation":
        from app.modules.intelligence.browser_research import TASK_LABELS

        limit = 1 if payload.get("scope") == "page" else payload.get("maxPages", 10)
        return [
            _action("navigate", "Abrir a página inicial", value=normalized_url),
            _action("research", f"Ler até {limit} página(s), preparar {TASK_LABELS[payload['taskType']].lower()} com Nora e gerar PDF editável com fontes"),
        ], {"mode": "research", "detail": "Revise o objetivo, o escopo e o formato antes de iniciar a pesquisa."}
    explicit = payload.get("actions") if isinstance(payload.get("actions"), list) else []
    if explicit:
        actions = [
            _action(
                str(raw.get("type") or "extract"), str(raw.get("description") or raw.get("type") or "Etapa")[:500],
                target=str(raw.get("target") or "")[:500], value=str(raw.get("value") or "")[:10_000],
                credentialId=raw.get("credentialId"), credentialField=raw.get("credentialField"), artifactId=raw.get("artifactId"),
            )
            for raw in explicit[:40]
        ]
        if not actions or actions[0].get("type") != "navigate":
            actions.insert(0, _action("navigate", "Abrir a URL inicial autorizada", value=normalized_url))
        return actions, {"mode": "manual", "detail": "Plano editado pelo operador."}
    if payload.get("useAiPlanner"):
        routed = await asyncio.to_thread(route_model, user, {"requiredCapabilities": ["text", "json"], "estimatedInputTokens": 900, "estimatedOutputTokens": 700, "privacy": "any", "externalActionCommitted": False})
        selected = routed.get("selected")
        if selected:
            try:
                answer, model_meta = await complete_with_provider(
                    user, str(selected["id"]),
                    [{"role": "user", "content": f"URL inicial: {normalized_url}\nObjetivo: {payload['objective']}"}],
                    "Crie um plano de automacao web. Responda somente JSON {\"actions\":[{\"type\":\"navigate|search|click|fill|select|press|wait|extract|screenshot|download\",\"description\":\"...\",\"target\":\"texto, label=, placeholder= ou css=\",\"value\":\"...\"}]}. Nao inclua senhas, tokens, JavaScript nem acoes nao solicitadas. Comece navegando e termine extraindo e capturando evidencia.",
                )
                actions = _parse_planner_json(answer)
                if actions:
                    if actions[0].get("type") != "navigate":
                        actions.insert(0, _action("navigate", "Abrir a URL inicial autorizada", value=normalized_url))
                    return actions, {"mode": "ai", "provider": model_meta.get("provider"), "detail": "Plano criado pelo roteador de IA e reclassificado pelo servidor."}
            except HTTPException:
                pass
    return heuristic_browser_actions(str(payload["objective"]), normalized_url), {"mode": "deterministic", "detail": "Plano seguro criado localmente; pode ser editado antes da execucao."}


def find_item(items: list[dict[str, Any]], item_id: str) -> dict[str, Any] | None:
    return next((item for item in items if str(item.get("id")) == item_id), None)


async def create_browser_profile(user: dict[str, Any], payload: dict[str, Any]) -> dict[str, Any]:
    item = {**payload, "id": entity_id("profile"), "createdAt": now_iso(), "updatedAt": now_iso()}
    await mutate_store(tenant_id(user), lambda store: store["browserProfiles"].insert(0, item))
    return item


async def create_browser_credential(user: dict[str, Any], payload: dict[str, Any]) -> dict[str, Any]:
    secret = json.dumps({"username": payload["username"], "password": payload["password"]}, ensure_ascii=False)
    return await save_vault_secret(user, {
        "integration": f'browser:{payload["domain"]}', "label": payload["label"], "secret": secret,
        "expiresAt": None, "scopes": [f'domain:{payload["domain"]}', "browser:fill"],
    })


async def create_browser_plan(user: dict[str, Any], payload: dict[str, Any], *, source: str = "screen", replace_id: str | None = None) -> dict[str, Any]:
    user_id = tenant_id(user)
    store = read_store(user_id)
    profile = find_item(store["browserProfiles"], str(payload.get("profileId") or ""))
    allowed = list(profile.get("allowedDomains", [])) if profile else []
    blocked = list(profile.get("blockedDomains", [])) if profile else []
    normalized, host = validate_public_url(str(payload["startUrl"]), allowed, blocked)
    actions, planner = await plan_browser_actions(user, payload, normalized)
    max_steps = min(int(payload.get("maxSteps") or 20), int(profile.get("maxActions") or 20) if profile else 20)
    actions = actions[:max_steps]
    if payload.get("taskType", "automation") != "automation" and max_steps < 2:
        raise HTTPException(422, "A pesquisa precisa de pelo menos duas etapas autorizadas no perfil.")
    risk_order = {"read": 0, "external": 1, "sensitive": 2}
    highest = max((str(item.get("riskClass") or "read") for item in actions), key=lambda value: risk_order.get(value, 0), default="read")
    risk = "alto" if highest == "sensitive" else "medio" if highest == "external" else "baixo"
    approval = any(bool(item.get("requiresApproval")) for item in actions)
    reason = "O plano contem acoes que serao confirmadas individualmente." if approval else "Plano de consulta sem alteracao externa identificada."
    created = now_iso()
    run = {
        "id": entity_id("browser_run"), "objective": payload["objective"], "startUrl": normalized,
        "host": host, "profileId": profile.get("id") if profile else None, "source": source,
        "policySnapshot": {
            "allowedDomains": allowed, "blockedDomains": blocked,
            "credentialIds": list(profile.get("credentialIds", [])) if profile else [],
            "allowDownloads": bool(profile and profile.get("allowDownloads")),
            "allowUploads": bool(profile and profile.get("allowUploads")),
            "allowForms": bool(profile and profile.get("allowForms")),
            "retainSession": bool(profile and profile.get("retainSession")),
            "maxDurationSeconds": int(profile.get("maxDurationSeconds") or 300) if profile else 900,
            "maxActions": int(profile.get("maxActions") or 20) if profile else 20,
        },
        "risk": risk, "riskReason": reason, "requiresApproval": approval, "approved": False,
        "status": "planned", "progress": 0, "maxPages": payload.get("maxPages", 10),
        "maxSteps": max_steps, "timeoutSeconds": min(int(payload.get("timeoutSeconds") or 300), int(profile.get("maxDurationSeconds") or 300) if profile else 900),
        "executionMode": payload.get("executionMode", "assisted"), "expectedResult": payload.get("expectedResult", "summary"),
        "planner": planner, "plan": actions,
        "taskType": payload.get("taskType", "automation"), "scope": payload.get("scope", "site"), "reportTitle": payload.get("reportTitle", ""),
        "timeline": [{"at": created, "event": "plan_created", "message": reason}],
        "result": None, "error": None, "cancelRequested": False, "pauseRequested": False, "artifacts": [], "pendingApproval": None,
        "createdAt": created, "updatedAt": created,
    }
    def save_plan(current):
        if replace_id:
            previous = find_item(current["browserRuns"], replace_id)
            if not previous:
                raise HTTPException(404, "Pesquisa não encontrada.")
            if previous.get("status") not in {"planned", "failed"}:
                raise HTTPException(409, "Edite o pedido antes da execução ou depois de uma falha.")
            run["id"] = replace_id
            run["createdAt"] = previous["createdAt"]
            previous.clear()
            previous.update(run)
        else:
            current["browserRuns"].insert(0, run)
    await mutate_store(user_id, save_plan)
    return run


async def replace_browser_plan_actions(user: dict[str, Any], run_id: str, raw_actions: list[dict[str, Any]]) -> dict[str, Any]:
    user_id = tenant_id(user)

    def mutation(store: dict[str, Any]) -> dict[str, Any]:
        run = find_item(store["browserRuns"], run_id)
        if not run:
            raise HTTPException(status_code=404, detail="Execucao do navegador nao encontrada.")
        if run.get("status") not in {"planned", "failed", "paused"}:
            raise HTTPException(status_code=409, detail="Pause a execucao antes de alterar o plano.")
        profile = find_item(store["browserProfiles"], str(run.get("profileId") or ""))
        limit = min(int(run.get("maxSteps") or 20), int((profile or run.get("policySnapshot") or {}).get("maxActions") or 20))
        actions = [
            _action(
                str(raw.get("type") or "extract"), str(raw.get("description") or raw.get("type") or "Etapa")[:500],
                target=str(raw.get("target") or "")[:500], value=str(raw.get("value") or "")[:10_000],
                credentialId=raw.get("credentialId"), credentialField=raw.get("credentialField"), artifactId=raw.get("artifactId"),
            )
            for raw in raw_actions[:limit]
        ]
        if not actions or actions[0].get("type") != "navigate":
            actions.insert(0, _action("navigate", "Abrir a URL inicial autorizada", value=str(run["startUrl"])))
        run.update({"plan": actions[:limit], "progress": 0, "currentStep": 0, "result": None, "error": None, "status": "planned", "updatedAt": now_iso()})
        run["requiresApproval"] = any(item.get("requiresApproval") for item in run["plan"])
        run.setdefault("timeline", []).append({"at": now_iso(), "event": "plan_updated", "message": "Plano revisado pelo operador antes da execucao."})
        return run

    return await mutate_store(user_id, mutation)


def _set_run(user_id: str, run_id: str, updates: dict[str, Any], event: tuple[str, str] | None = None) -> dict[str, Any]:
    store = read_store(user_id)
    run = find_item(store["browserRuns"], run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Execucao do navegador nao encontrada.")
    run.update(updates)
    run["updatedAt"] = now_iso()
    if event:
        run.setdefault("timeline", []).append({"at": now_iso(), "event": event[0], "message": event[1]})
    write_store(user_id, store)
    return run


async def execute_browser_run(user: dict[str, Any], run_id: str) -> dict[str, Any]:
    from app.modules.intelligence.browser_runtime import execute_browser_run as execute_real_browser

    return await execute_real_browser(user, run_id)


async def update_browser_control(user: dict[str, Any], run_id: str, action: str) -> dict[str, Any]:
    from app.modules.intelligence.browser_runtime import control_browser_run

    return await control_browser_run(user, run_id, action)


def chunk_text(text: str, size: int = 1200, overlap: int = 160) -> list[str]:
    clean = " ".join(text.split())
    if not clean:
        return []
    chunks: list[str] = []
    start = 0
    while start < len(clean):
        end = min(len(clean), start + size)
        chunks.append(clean[start:end])
        if end == len(clean):
            break
        start = max(start + 1, end - overlap)
    return chunks


async def create_knowledge_base(user: dict[str, Any], payload: dict[str, Any]) -> dict[str, Any]:
    item = {**payload, "id": entity_id("kb"), "sourceCount": 0, "chunkCount": 0, "status": "ready", "createdAt": now_iso(), "updatedAt": now_iso()}
    await mutate_store(tenant_id(user), lambda store: store["knowledgeBases"].insert(0, item))
    return item


async def add_knowledge_source(user: dict[str, Any], base_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    user_id = tenant_id(user)
    store = read_store(user_id)
    base = find_item(store["knowledgeBases"], base_id)
    if not base:
        raise HTTPException(status_code=404, detail="Base de conhecimento nao encontrada.")
    content = str(payload.get("content") or "")
    source_url = str(payload.get("url") or "")
    if payload.get("kind") == "url":
        if not source_url:
            raise HTTPException(status_code=422, detail="Informe a URL da fonte.")
        page = await safe_fetch(source_url)
        content = page["text"]
        source_url = page["url"]
    if len(content.strip()) < 2:
        raise HTTPException(status_code=422, detail="A fonte nao possui conteudo indexavel.")
    digest = hashlib.sha256(content.encode("utf-8")).hexdigest()
    duplicate = next((item for item in store["knowledgeSources"] if item.get("baseId") == base_id and item.get("digest") == digest), None)
    if duplicate:
        raise HTTPException(status_code=409, detail="Esta fonte ja esta indexada nesta base.")
    chunks = [
        {"id": entity_id("chunk"), "text": part, "position": index, "tokensApprox": max(1, len(part) // 4)}
        for index, part in enumerate(chunk_text(content))
    ]
    item = {
        **payload, "id": entity_id("source"), "baseId": base_id, "url": source_url,
        "content": content, "digest": digest, "status": "indexed", "stale": False,
        "chunks": chunks, "createdBy": user_id, "indexedAt": now_iso(), "createdAt": now_iso(), "updatedAt": now_iso(),
    }

    def mutation(current: dict[str, Any]) -> None:
        current["knowledgeSources"].insert(0, item)
        current_base = find_item(current["knowledgeBases"], base_id)
        if current_base:
            current_base["sourceCount"] = int(current_base.get("sourceCount") or 0) + 1
            current_base["chunkCount"] = int(current_base.get("chunkCount") or 0) + len(chunks)
            current_base["updatedAt"] = now_iso()

    await mutate_store(user_id, mutation)
    return {key: value for key, value in item.items() if key not in {"content", "chunks"}} | {"chunkCount": len(chunks)}


async def reindex_knowledge_source(user: dict[str, Any], source_id: str) -> dict[str, Any]:
    user_id = tenant_id(user)
    store = read_store(user_id)
    source = find_item(store["knowledgeSources"], source_id)
    if not source:
        raise HTTPException(status_code=404, detail="Fonte nao encontrada.")
    content = str(source.get("content") or "")
    if source.get("kind") == "url":
        page = await safe_fetch(str(source.get("url") or ""))
        content = page["text"]
    chunks = [
        {"id": entity_id("chunk"), "text": part, "position": index, "tokensApprox": max(1, len(part) // 4)}
        for index, part in enumerate(chunk_text(content))
    ]
    digest = hashlib.sha256(content.encode("utf-8")).hexdigest()

    def mutation(current: dict[str, Any]) -> dict[str, Any]:
        item = find_item(current["knowledgeSources"], source_id)
        if not item:
            raise HTTPException(status_code=404, detail="Fonte nao encontrada.")
        previous_count = len(item.get("chunks", []))
        item.update({"content": content, "chunks": chunks, "digest": digest, "status": "indexed", "stale": False, "indexedAt": now_iso(), "updatedAt": now_iso()})
        base = find_item(current["knowledgeBases"], str(item.get("baseId") or ""))
        if base:
            base["chunkCount"] = max(0, int(base.get("chunkCount") or 0) - previous_count + len(chunks))
            base["updatedAt"] = now_iso()
        return item

    updated = await mutate_store(user_id, mutation)
    return {key: value for key, value in updated.items() if key not in {"content", "chunks"}} | {"chunkCount": len(chunks)}


def tokens(value: str) -> list[str]:
    normalized = "".join(c for c in unicodedata.normalize("NFKD", value.casefold()) if not unicodedata.combining(c))
    return [match.group(0) for match in TOKEN_PATTERN.finditer(normalized)]


def quote_for(text: str, terms: list[str]) -> str:
    lowered = text.lower()
    positions = [lowered.find(term) for term in terms if lowered.find(term) >= 0]
    start = max(0, (min(positions) if positions else 0) - 90)
    return html.unescape(text[start:start + 420]).strip()


def search_knowledge(user: dict[str, Any], query: str, base_ids: list[str] | None = None, limit: int = 6) -> dict[str, Any]:
    user_id = tenant_id(user)
    store = read_store(user_id)
    wanted = set(base_ids or [])
    terms = list(dict.fromkeys(tokens(query)))
    scored: list[dict[str, Any]] = []
    bases = {
        item["id"]: item
        for item in store["knowledgeBases"]
        if item.get("active", True) is not False and (not wanted or item["id"] in wanted)
    }
    for source in store["knowledgeSources"]:
        base = bases.get(source.get("baseId"))
        if not base or source.get("status") != "indexed":
            continue
        if base.get("visibility") == "private" and source.get("createdBy") != user_id:
            continue
        title_terms = Counter(tokens(str(source.get("title") or "")))
        for chunk in source.get("chunks", []):
            counts = Counter(tokens(str(chunk.get("text") or "")))
            score = sum(min(counts[term], 4) for term in terms) + sum(2 for term in terms if title_terms[term])
            if score:
                scored.append({
                    "score": score, "baseId": base["id"], "baseName": base["name"],
                    "sourceId": source["id"], "sourceTitle": source["title"], "sourceUrl": source.get("url") or "",
                    "quote": quote_for(str(chunk.get("text") or ""), terms), "position": chunk.get("position", 0),
                    "stale": bool(source.get("stale")), "indexedAt": source.get("indexedAt"),
                })
    scored.sort(key=lambda item: (-item["score"], item["sourceTitle"], item["position"]))
    return {"query": query, "results": scored[:limit], "total": len(scored), "searchedBaseIds": list(bases)}


async def search_knowledge_semantic(user, query, base_ids=None, limit=6):
    lexical = search_knowledge(user, query, base_ids, limit)
    lexical["retrieval"] = "lexical"
    if os.getenv("NORA_KNOWLEDGE_EMBEDDINGS_ENABLED") != "1":
        return lexical
    from app.services.knowledge_embeddings import ensure_vectors, embed, cosine
    store = read_store(tenant_id(user))
    wanted = set(base_ids or [])
    bases = {b["id"]:b for b in store["knowledgeBases"] if b.get("active", True) and (not wanted or b["id"] in wanted)}
    candidates = [(source, chunk) for source in store["knowledgeSources"]
        if source.get("baseId") in bases and source.get("status") == "indexed"
        and (bases[source["baseId"]].get("visibility") != "private" or source.get("createdBy") == tenant_id(user))
        for chunk in source.get("chunks", [])][:128]
    if not candidates:
        return lexical
    try:
        vectors = await ensure_vectors(user, [chunk for _,chunk in candidates])
        query_vector = (await embed(user, [query]))[0]
    except Exception:
        # Fallback is explicit and never discloses provider details or keys.
        lexical["retrieval"] = "lexical_fallback"
        return lexical
    scored = []
    for source, chunk in candidates:
        score = cosine(query_vector, vectors.get(chunk["id"], []))
        if score <= 0.15:
            continue
        base = bases[source["baseId"]]
        scored.append({"score":score,"baseId":base["id"],"baseName":base["name"],
            "sourceId":source["id"],"sourceTitle":source["title"],"sourceUrl":source.get("url") or "",
            "quote":quote_for(chunk["text"],tokens(query)),"position":chunk.get("position",0),
            "stale":bool(source.get("stale")),"indexedAt":source.get("indexedAt")})
    scored.sort(key=lambda r:(-r["score"],r["sourceId"],r["position"]))
    return {**lexical,"results":scored[:limit] or lexical["results"],"total":len(scored),
            "retrieval":"semantic" if scored else "lexical_fallback", "coverage":{"chunksConsidered":len(candidates),"maxChunks":128}}


MARKETPLACE_CATALOG = [
    {
        "id": "document-models-pack", "type": "connector", "name": "Modelos de documentos", "description": "Libera a biblioteca ampliada de currículos, contratos, propostas, relatórios e documentos empresariais.",
        "details": "O pacote adiciona modelos preenchidos e editáveis somente enquanto a instalação estiver ativa. Ao desativar, documentos já criados permanecem intactos.",
        "features": ["139 modelos profissionais", "Currículos com layouts e paletas próprias", "Exemplos preenchidos e personalizáveis"],
        "dataAccess": ["Dados inseridos ao criar ou editar um documento", "Identidade visual escolhida pelo usuário"],
        "setupSteps": ["Instale o pacote", "Revise as permissões e ative", "Abra Documentos e escolha um modelo", "Personalize conteúdo, cores e identidade"],
        "limitations": ["Não altera documentos existentes", "Não envia nem assina documentos automaticamente"],
        "activationBehavior": "Exibe 139 modelos extras em Documentos; desativar oculta a biblioteca sem apagar os arquivos criados.",
        "version": "2.0.0", "author": "Norium Studio", "verified": True, "permissions": ["Exibir modelos na central de Documentos"], "dependencies": ["Documentos"], "category": "Documentos", "icon": "document-models", "destination": "Documentos",
    },
    {
        "id": "norium-mail-connector", "type": "extension", "name": "Triagem inteligente de e-mails", "description": "Acrescenta prioridade, resumo executivo e rascunhos assistidos à tela de E-mails que já existe no Norium.",
        "details": "Esta extensão não cria outra tela. Ela adiciona recursos da Nora à caixa existente e só lê mensagens depois da conexão OAuth feita pelo usuário.",
        "features": ["Resumo executivo sem repetir a caixa", "Prioridades justificadas", "Rascunhos com confirmação"],
        "dataAccess": ["Assunto, remetente e corpo dos e-mails da conta autorizada", "Contexto do rascunho solicitado pelo usuário"],
        "setupSteps": ["Conecte sua conta Google em Configurações", "Instale a extensão", "Revise o acesso solicitado", "Ative a triagem na tela de E-mails"],
        "limitations": ["Não cria outra caixa de entrada", "Não envia mensagens sem confirmação", "Sem OAuth ativo, nenhum e-mail é lido"],
        "activationBehavior": "Adiciona resumo, prioridade e rascunhos assistidos à tela de E-mails existente.",
        "version": "1.3.0", "author": "Norium", "verified": True, "permissions": ["Ler mensagens da conta já autorizada"], "dependencies": ["Tela E-mails", "Conta Google conectada pelo usuário"], "category": "Extensões", "icon": "norium-mail", "destination": "E-mails",
    },
    {
        "id": "whatsapp-connector", "type": "integration", "name": "WhatsApp", "description": "Disponibiliza ações de conversa e automação para uma instância vinculada pelo responsável.",
        "details": "Mensagens externas continuam exigindo destinatário real e confirmação explícita antes do envio.",
        "features": ["Atalhos de conversa", "Ações em automações", "Envio protegido por aprovação"],
        "dataAccess": ["Conversas da instância configurada", "Contexto da conversa selecionada para a ação solicitada"],
        "setupSteps": ["Configure a instância W-API", "Instale a integração", "Revise as permissões", "Ative e selecione uma conversa real"],
        "limitations": ["Não cria nem vincula uma instância automaticamente", "Envios exigem destino real e confirmação", "Credenciais da conta não são exibidas"],
        "activationBehavior": "Disponibiliza ações do WhatsApp no Chat e em fluxos de automação autorizados.",
        "version": "1.3.0", "author": "Norium", "verified": True, "permissions": ["Usar a instância vinculada pelo responsável"], "dependencies": ["Instância W-API configurada"], "category": "Comunicação", "icon": "whatsapp", "destination": "Chat",
    },
    {
        "id": "calendar-connector", "type": "extension", "name": "Briefing inteligente de agenda", "description": "Acrescenta preparação de compromissos, conflitos e gatilhos à tela de Agenda que já existe no Norium.",
        "details": "Esta extensão não instala outra agenda. Ela enriquece a tela existente e só acessa calendários externos depois da autorização OAuth.",
        "features": ["Briefing antes de compromissos", "Avisos de conflito", "Gatilhos para automações"],
        "dataAccess": ["Calendários autorizados pelo usuário", "Título, horário, participantes e descrição dos eventos permitidos"],
        "setupSteps": ["Conecte o Google Agenda", "Instale a extensão", "Revise os calendários autorizados", "Ative o briefing"],
        "limitations": ["Não cria outra tela de agenda", "Exige OAuth válido para eventos externos", "Alterações externas continuam exigindo confirmação"],
        "activationBehavior": "Acrescenta briefing, conflitos e gatilhos à tela de Agenda existente.",
        "version": "1.2.0", "author": "Norium", "verified": True, "permissions": ["Acessar calendários autorizados"], "dependencies": ["Tela Agenda", "Google Agenda conectado"], "category": "Extensões", "icon": "calendar", "destination": "Agenda",
    },
    {
        "id": "browser-research-agent", "type": "agent", "name": "Pesquisa web segura", "description": "Cria um perfil restrito para pesquisas públicas e rastreáveis.",
        "details": "O agente planeja, pede aprovação quando necessário e mantém evidências das páginas lidas.",
        "features": ["Domínios permitidos", "Relatório com fontes", "Sessão assistida"],
        "dataAccess": ["Páginas públicas dos domínios permitidos", "Evidências e resultados da sessão de pesquisa"],
        "setupSteps": ["Instale o agente", "Defina os domínios permitidos", "Revise as proteções", "Ative e abra o Agente Navegador"],
        "limitations": ["Bloqueia redes privadas e páginas com credenciais", "Downloads ficam desativados por padrão", "Ações sensíveis pedem aprovação"],
        "activationBehavior": "Cria um perfil de pesquisa segura no Agente Navegador, inicialmente sem domínios liberados.",
        "version": "1.1.0", "author": "Norium Labs", "verified": True, "permissions": ["Leitura de páginas públicas"], "dependencies": ["Agente Navegador"], "category": "Pesquisa", "icon": "browser", "destination": "Agente Navegador",
    },
    {
        "id": "web-source-connector", "type": "integration", "name": "Fontes web para Conhecimento", "description": "Cria uma base controlada para páginas públicas consultadas pela Nora.",
        "details": "URLs passam por bloqueio de redes privadas, indexação e rastreio de atualização.",
        "features": ["Indexação de URL", "Trechos citáveis", "Aviso de fonte desatualizada"],
        "dataAccess": ["Conteúdo das URLs públicas autorizadas", "Trechos indexados e datas de atualização"],
        "setupSteps": ["Instale o conector", "Abra Conhecimento", "Adicione somente URLs públicas autorizadas", "Indexe e ative a base"],
        "limitations": ["Aceita somente páginas públicas", "Bloqueia redes privadas", "Não acessa documentos internos automaticamente"],
        "activationBehavior": "Cria em Conhecimento uma base desativada para fontes web controladas.",
        "version": "1.2.0", "author": "Norium", "verified": True, "permissions": ["Criar base", "Ler páginas públicas autorizadas"], "dependencies": ["Conhecimento", "Saída HTTPS"], "category": "Conhecimento", "icon": "knowledge-web", "destination": "Conhecimento",
    },
    {
        "id": "sales-knowledge-template", "type": "template", "name": "Base comercial", "description": "Estrutura uma base privada para políticas, propostas e materiais comerciais.",
        "details": "A base nasce pronta para receber conteúdo e ser consultada pela Nora em perguntas sobre a empresa.",
        "features": ["Escopo privado", "Organização por tags", "Busca com origem"],
        "dataAccess": ["Textos e arquivos adicionados pelo usuário", "Metadados das fontes autorizadas na base"],
        "setupSteps": ["Instale o modelo", "Ative a base", "Abra Conhecimento", "Adicione políticas e materiais comerciais"],
        "limitations": ["A base começa vazia", "O conteúdo permanece privado", "A Nora não inventa informações não fornecidas"],
        "activationBehavior": "Cria uma base comercial privada e permite que a Nora a consulte com indicação da fonte.",
        "version": "1.2.0", "author": "Norium", "verified": True, "permissions": ["Criar base de conhecimento"], "dependencies": ["Conhecimento"], "category": "Conhecimento", "icon": "knowledge", "destination": "Conhecimento",
    },
    {
        "id": "competitor-watch-automation", "type": "automation", "name": "Monitor de página", "description": "Instala uma automação desativada para leitura controlada de uma URL.",
        "details": "Defina a URL e revise o fluxo antes de ativar. Execuções são registradas no histórico.",
        "features": ["Execução manual", "Evidências", "Política de tentativa"],
        "dataAccess": ["URL pública definida na automação", "Histórico e evidências das execuções"],
        "setupSteps": ["Instale a automação", "Informe a URL permitida", "Execute um teste manual", "Revise o resultado e ative"],
        "limitations": ["Começa desativada", "Não acessa páginas autenticadas", "Não executa ações externas sem aprovação"],
        "activationBehavior": "Cria um fluxo desativado em Automações e registra cada execução no histórico.",
        "version": "1.1.0", "author": "Norium Labs", "verified": True, "permissions": ["Criar automação", "Leitura de URL autorizada"], "dependencies": ["Agente Navegador", "Automações"], "category": "Automação", "icon": "automation", "destination": "Automações",
    },
    {
        "id": "client-nora-assistant", "type": "connector", "name": "Nora para Clientes", "description": "Adiciona atalhos contextuais da Nora à ficha de cada cliente.",
        "details": "A Nora recebe apenas o contexto visível da ficha selecionada para sugerir análise, próximos passos e documentos.",
        "features": ["Resumo 360°", "Próximos passos", "Criação contextual de documentos"],
        "dataAccess": ["Dados visíveis do cliente selecionado", "Linha do tempo e documentos que o usuário pode consultar"],
        "setupSteps": ["Instale o assistente", "Revise a permissão contextual", "Ative o recurso", "Abra um cliente e acione a Nora"],
        "limitations": ["Acessa apenas a ficha selecionada e visível", "Não envia mensagens nem altera o CRM sem confirmação"],
        "activationBehavior": "Exibe ações contextuais da Nora dentro da ficha de cada cliente.",
        "version": "1.0.0", "author": "Norium", "verified": True, "permissions": ["Usar dados visíveis da ficha selecionada"], "dependencies": ["Clientes", "Nora"], "category": "CRM", "icon": "clients", "destination": "Clientes",
    },
    {
        "id": "cost-aware-model-policy", "type": "package", "name": "Roteamento custo consciente", "description": "Instala uma política que prioriza modelos configurados de menor custo.",
        "details": "A política pode ser ligada ou desligada e nunca troca de provedor depois de uma ação externa confirmada.",
        "features": ["Limite de custo", "Fallback controlado", "Privacidade configurável"],
        "dataAccess": ["Metadados dos modelos configurados", "Custos, capacidades e limites definidos pelo administrador"],
        "setupSteps": ["Cadastre os provedores autorizados", "Instale a política", "Defina custo e privacidade", "Teste a rota e ative"],
        "limitations": ["Não cria provedores nem chaves", "Não troca o modelo depois de uma ação externa confirmada"],
        "activationBehavior": "Cria uma política desativada em IA e Modelos para selecionar rotas compatíveis com os limites.",
        "version": "1.1.0", "author": "Norium", "verified": True, "permissions": ["Criar política de modelos"], "dependencies": ["IA e Modelos"], "category": "IA", "icon": "models", "destination": "IA e Modelos",
    },
    {
        "id": "nora-runtime-model", "type": "model", "name": "Modelo padrão da Nora", "description": "Cria uma política apontando para o modelo gerenciado pelo runtime da Nora.",
        "details": "O modelo só fica disponível quando a chave do provedor está configurada no ambiente.",
        "features": ["Texto", "Ferramentas", "Saída estruturada"],
        "dataAccess": ["Prompt e contexto enviados ao provedor configurado", "Metadados de uso e custo da chamada"],
        "setupSteps": ["Configure a chave e o modelo no ambiente", "Instale o modelo", "Revise a política de dados", "Ative e faça um teste"],
        "limitations": ["Fica indisponível sem chave válida", "Não exibe nem fornece acesso à chave do provedor"],
        "activationBehavior": "Cria em IA e Modelos uma política desativada apontando para o runtime padrão da Nora.",
        "version": "1.1.0", "author": "Norium", "verified": True, "permissions": ["Criar política de modelo"], "dependencies": ["NORA_MODEL e GROQ_API_KEY no ambiente"], "category": "Modelos", "icon": "nora-model", "destination": "IA e Modelos",
    },
]


def catalog_item(item_id: str) -> dict[str, Any] | None:
    return next((item for item in MARKETPLACE_CATALOG if item["id"] == item_id), None)


def _install_resource(user_id: str, item: dict[str, Any], installation_id: str) -> dict[str, Any]:
    if item["id"] == "browser-research-agent":
        store = read_store(user_id)
        resource = {"id": entity_id("profile"), "name": "Pesquisa web segura", "allowedDomains": [], "blockedDomains": [], "allowDownloads": False, "retainSession": False, "marketplaceInstallationId": installation_id, "createdAt": now_iso(), "updatedAt": now_iso()}
        store["browserProfiles"].insert(0, resource)
        write_store(user_id, store)
        return {"type": "browserProfile", "id": resource["id"]}
    if item["id"] in {"sales-knowledge-template", "web-source-connector"}:
        store = read_store(user_id)
        is_connector = item["id"] == "web-source-connector"
        resource = {"id": entity_id("kb"), "name": "Fontes web" if is_connector else "Base comercial", "description": "Paginas publicas autorizadas." if is_connector else "Politicas, propostas e materiais comerciais.", "visibility": "private", "tags": ["web"] if is_connector else ["comercial"], "sourceCount": 0, "chunkCount": 0, "status": "ready", "active": True, "marketplaceInstallationId": installation_id, "createdAt": now_iso(), "updatedAt": now_iso()}
        store["knowledgeBases"].insert(0, resource)
        write_store(user_id, store)
        return {"type": "knowledgeBase", "id": resource["id"]}
    if item["id"] in {"cost-aware-model-policy", "nora-runtime-model"}:
        store = read_store(user_id)
        runtime_model = item["id"] == "nora-runtime-model"
        resource = {"id": entity_id("policy"), "name": "Modelo padrão da Nora" if runtime_model else "Custo consciente", "mode": "manual" if runtime_model else "automatic", "preferredProviderId": "nora-runtime" if runtime_model else None, "fallbackProviderIds": [], "requireCapabilities": ["text"], "maxInputCostPerMillion": None if runtime_model else 2, "privacy": "any", "monthlyBudget": None, "enabled": True, "marketplaceInstallationId": installation_id, "createdAt": now_iso(), "updatedAt": now_iso()}
        store["modelPolicies"].insert(0, resource)
        write_store(user_id, store)
        return {"type": "modelPolicy", "id": resource["id"]}
    if item["id"] in {
        "document-models-pack", "norium-mail-connector", "whatsapp-connector",
        "calendar-connector", "client-nora-assistant",
    }:
        return {"type": "feature", "id": item["id"]}
    auto_store = read_user_db(user_id, "automacoes", {"automations": [], "history": []})
    if not isinstance(auto_store, dict):
        auto_store = {"automations": [], "history": []}
    created = now_iso()
    resource = {
        "id": entity_id("auto"), "name": "Monitor de pagina", "description": "Le uma pagina autorizada e registra evidencias.",
        "icon": "globe", "category": "Navegador", "trigger": "Manual", "actions": ["Executar tarefa no navegador"],
        "status": "ativa", "active": True, "aiEnabled": False, "favorite": False, "savedMinutesPerRun": 10,
        "savedMinutes": 0, "executions": 0, "lastRunAt": None, "createdAt": created, "updatedAt": created,
        "version": 1, "environment": "rascunho", "versions": [], "variables": {"targetUrl": "", "browserObjective": "Ler e resumir a pagina"},
        "schedule": "", "retryPolicy": {"enabled": True, "maxAttempts": 1, "delaySeconds": 30}, "failureAction": "notificar_operador", "requiresApproval": False,
        "flow": {"nodes": [
            {"id": "manual", "kind": "trigger", "icon": "zap", "title": "Manual", "description": "Execucao manual", "x": 60, "y": 120},
            {"id": "browser", "kind": "action", "icon": "globe", "title": "Executar tarefa no navegador", "description": "Le uma URL autorizada", "x": 320, "y": 120},
        ], "connections": [{"source": "manual", "target": "browser"}]},
        "logs": [], "marketplaceInstallationId": installation_id,
    }
    auto_store.setdefault("automations", []).insert(0, resource)
    write_user_db(user_id, "automacoes", auto_store)
    return {"type": "automation", "id": resource["id"]}


async def install_marketplace(user: dict[str, Any], item_id: str, confirm: bool, version: str | None = None) -> dict[str, Any]:
    if not confirm:
        raise HTTPException(status_code=409, detail="Revise permissoes e dependencias antes de confirmar a instalacao.")
    item = catalog_item(item_id)
    if not item:
        raise HTTPException(status_code=404, detail="Item do marketplace nao encontrado.")
    user_id = tenant_id(user)
    store = read_store(user_id)
    existing = next((entry for entry in store["installations"] if entry.get("catalogId") == item_id and entry.get("status") == "installed"), None)
    if existing:
        raise HTTPException(status_code=409, detail="Este item ja esta instalado.")
    installation_id = entity_id("installation")
    resource = _install_resource(user_id, item, installation_id)
    installation = {"id": installation_id, "catalogId": item_id, "name": item["name"], "version": version or item["version"], "status": "installed", "enabled": True, "resource": resource, "installedAt": now_iso(), "updatedAt": now_iso()}
    await mutate_store(user_id, lambda current: current["installations"].insert(0, installation))
    return installation


def marketplace_item_enabled(user: dict[str, Any], catalog_id: str) -> bool:
    return any(
        item.get("catalogId") == catalog_id
        and item.get("status") == "installed"
        and item.get("enabled") is True
        for item in read_store(tenant_id(user))["installations"]
    )


async def set_marketplace_enabled(user: dict[str, Any], installation_id: str, enabled: bool) -> dict[str, Any]:
    user_id = tenant_id(user)

    def mutation(store: dict[str, Any]) -> dict[str, Any]:
        installation = find_item(store["installations"], installation_id)
        if not installation or installation.get("status") != "installed":
            raise HTTPException(status_code=404, detail="Instalacao nao encontrada.")
        installation.update({"enabled": enabled, "updatedAt": now_iso()})
        for collection in ("browserProfiles", "knowledgeBases", "modelPolicies"):
            for resource in store[collection]:
                if resource.get("marketplaceInstallationId") != installation_id:
                    continue
                resource["active"] = enabled
                if "enabled" in resource or collection == "modelPolicies":
                    resource["enabled"] = enabled
                resource["updatedAt"] = now_iso()
        return installation

    installation = await mutate_store(user_id, mutation)
    auto_store = read_user_db(user_id, "automacoes", {"automations": []})
    if isinstance(auto_store, dict):
        changed = False
        for automation in auto_store.get("automations", []):
            if automation.get("marketplaceInstallationId") == installation_id:
                automation["active"] = enabled
                automation["status"] = "ativa" if enabled else "desativada"
                automation["updatedAt"] = now_iso()
                changed = True
        if changed:
            write_user_db(user_id, "automacoes", auto_store)
    return installation


async def uninstall_marketplace(user: dict[str, Any], installation_id: str) -> dict[str, Any]:
    user_id = tenant_id(user)
    def mutation(store: dict[str, Any]) -> dict[str, Any]:
        installation = find_item(store["installations"], installation_id)
        if not installation:
            raise HTTPException(status_code=404, detail="Instalacao nao encontrada.")
        installation.update({"status": "removed", "enabled": False, "removedAt": now_iso(), "updatedAt": now_iso()})
        for collection in ("browserProfiles", "knowledgeBases", "modelPolicies"):
            for resource in store[collection]:
                if resource.get("marketplaceInstallationId") == installation_id:
                    resource["active"] = False
                    resource["enabled"] = False
        return installation
    installation = await mutate_store(user_id, mutation)
    auto_store = read_user_db(user_id, "automacoes", {"automations": []})
    if isinstance(auto_store, dict):
        for automation in auto_store.get("automations", []):
            if automation.get("marketplaceInstallationId") == installation_id:
                automation["active"] = False
                automation["status"] = "desativada"
        write_user_db(user_id, "automacoes", auto_store)
    return installation


def builtin_provider() -> dict[str, Any]:
    return {
        "id": "nora-runtime", "name": "Nora Runtime", "provider": "groq", "model": os.getenv("NORA_MODEL", "openai/gpt-oss-20b"),
        "baseUrl": "https://api.groq.com/openai/v1", "enabled": bool(os.getenv("GROQ_API_KEY", "").strip()), "configured": bool(os.getenv("GROQ_API_KEY", "").strip()),
        "capabilities": ["text", "tools", "json"], "contextWindow": 131072, "inputCostPerMillion": 0.075,
        "outputCostPerMillion": 0.30, "dataPolicy": "external", "managed": True,
    }


def builtin_gemini_provider() -> dict[str, Any]:
    configured = bool(os.getenv("GEMINI_API_KEY", "").strip())
    return {
        "id": "gemini-runtime", "name": "Google Gemini", "provider": "google",
        "model": os.getenv("GEMINI_MODEL", "gemini-3.7-flash").strip() or "gemini-3.7-flash",
        "baseUrl": "https://generativelanguage.googleapis.com/v1beta", "enabled": configured,
        "configured": configured, "capabilities": ["text", "tools", "json"],
        "contextWindow": 1_000_000, "inputCostPerMillion": 0.75,
        "outputCostPerMillion": 3.75, "dataPolicy": "external", "managed": True,
    }


def sanitize_provider(provider: dict[str, Any]) -> dict[str, Any]:
    safe = {key: value for key, value in provider.items() if key not in {"encryptedSecret", "secret"}}
    safe["configured"] = bool(provider.get("encryptedSecret")) or bool(provider.get("configured"))
    return safe


async def save_provider(user: dict[str, Any], payload: dict[str, Any], provider_id: str | None = None) -> dict[str, Any]:
    user_id = tenant_id(user)
    secret = str(payload.pop("secret", "") or "")
    base = {**payload, "updatedAt": now_iso()}
    if secret:
        base["encryptedSecret"] = encrypt_secret(secret)
    if provider_id:
        def update(store: dict[str, Any]) -> dict[str, Any]:
            item = find_item(store["modelProviders"], provider_id)
            if not item:
                raise HTTPException(status_code=404, detail="Provedor nao encontrado.")
            item.update(base)
            return item
        item = await mutate_store(user_id, update)
    else:
        item = {**base, "id": entity_id("provider"), "createdAt": now_iso()}
        await mutate_store(user_id, lambda store: store["modelProviders"].insert(0, item))
    return sanitize_provider(item)


def all_providers(user_id: str) -> list[dict[str, Any]]:
    return apply_provider_prices([builtin_provider(), builtin_gemini_provider(), *read_store(user_id)["modelProviders"]])


def route_model(user: dict[str, Any], payload: dict[str, Any]) -> dict[str, Any]:
    from app.core.ai_provider_policy import approved_provider, ProviderPolicyError
    user_id = tenant_id(user)
    store = read_store(user_id)
    policy = find_item(store["modelPolicies"], str(payload.get("policyId") or ""))
    requirements = set(payload.get("requiredCapabilities") or (policy or {}).get("requireCapabilities") or ["text"])
    privacy = str(payload.get("privacy") or (policy or {}).get("privacy") or "any")
    preferred = str(payload.get("preferredProviderId") or (policy or {}).get("preferredProviderId") or "")
    max_cost = (policy or {}).get("maxInputCostPerMillion")
    eligible: list[dict[str, Any]] = []
    rejected: list[dict[str, str]] = []
    for provider in all_providers(user_id):
        reason = ""
        try:
            approved_provider(user, provider)
        except ProviderPolicyError:
            reason = "provedor não aprovado para este ambiente"
        if reason:
            pass
        elif not provider.get("enabled") or not (provider.get("encryptedSecret") or provider.get("configured")):
            reason = "desativado ou sem credencial"
        elif not requirements.issubset(set(provider.get("capabilities", []))):
            reason = "capacidade obrigatoria ausente"
        elif privacy == "local" and provider.get("dataPolicy") != "local":
            reason = "politica exige processamento local"
        elif privacy == "private" and provider.get("dataPolicy") not in {"private", "local"}:
            reason = "politica exige provedor privado"
        elif max_cost is not None and (not provider.get("pricingConfigured", True) or float(provider.get("inputCostPerMillion") or 0) > float(max_cost)):
            reason = "custo excede a politica"
        if reason:
            rejected.append({"providerId": str(provider["id"]), "reason": reason})
        else:
            eligible.append(provider)
    eligible.sort(key=lambda item: (0 if item["id"] == preferred else 1, float(item.get("inputCostPerMillion") or 0) if item.get("pricingConfigured", True) else float("inf"), -int(item.get("contextWindow") or 0)))
    selected = eligible[0] if eligible else None
    fallback = [sanitize_provider(item) for item in eligible[1:]]
    estimated = 0.0
    if selected:
        estimated = (
            int(payload.get("estimatedInputTokens") or 0) * float(selected.get("inputCostPerMillion") or 0)
            + int(payload.get("estimatedOutputTokens") or 0) * float(selected.get("outputCostPerMillion") or 0)
        ) / 1_000_000
    return {
        "selected": sanitize_provider(selected) if selected else None, "fallback": fallback,
        "rejected": rejected, "estimatedCost": round(estimated, 6),
        "fallbackAllowed": not bool(payload.get("externalActionCommitted")),
        "reason": "Melhor correspondencia por capacidade, privacidade, custo e contexto." if selected else "Nenhum provedor configurado atende a politica.",
    }


async def test_provider(user: dict[str, Any], provider_id: str, timeout_seconds: int) -> dict[str, Any]:
    user_id = tenant_id(user)
    providers = await asyncio.to_thread(all_providers, user_id)
    provider = next((item for item in providers if item["id"] == provider_id), None)
    if not provider:
        raise HTTPException(status_code=404, detail="Provedor nao encontrado.")
    from app.core.ai_provider_policy import approved_provider, ProviderPolicyError

    try:
        _, base_url = approved_provider(user, provider)
    except ProviderPolicyError as exc:
        raise HTTPException(status_code=403, detail="Provedor não aprovado para este ambiente de trabalho.") from exc
    if provider_id == "nora-runtime":
        secret = os.getenv("GROQ_API_KEY", "").strip()
    elif provider_id == "gemini-runtime":
        secret = os.getenv("GEMINI_API_KEY", "").strip()
    else:
        encrypted = str(provider.get("encryptedSecret") or "")
        secret = decrypt_secret(encrypted) if encrypted else ""
    if not secret:
        return {"ok": False, "providerId": provider_id, "detail": "Salve uma credencial antes de testar."}
    _, host = validate_public_url(base_url)
    await assert_public_dns(host)
    headers = {"x-api-key": secret, "anthropic-version": "2023-06-01"} if provider.get("provider") == "anthropic" else {"x-goog-api-key": secret} if provider.get("provider") == "google" else {"Authorization": f"Bearer {secret}"}
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(timeout_seconds, connect=min(8, timeout_seconds)),
                                     follow_redirects=False, trust_env=False, transport=PublicHTTPTransport([host])) as client:
            response = await client.get(f"{base_url}/models", headers=headers)
    except (httpx.HTTPError, OSError):
        return {"ok": False, "providerId": provider_id, "detail": "O endpoint nao respondeu ao teste de conexao."}
    if response.status_code != 200:
        return {"ok": False, "providerId": provider_id, "detail": f"O provedor recusou o teste de conexao (HTTP {response.status_code})."}
    return {"ok": True, "providerId": provider_id, "detail": "Conexao autenticada com sucesso. Nenhum token de geracao foi consumido."}


async def save_model_policy(user: dict[str, Any], payload: dict[str, Any], policy_id: str | None = None) -> dict[str, Any]:
    user_id = tenant_id(user)
    if policy_id:
        def update(store: dict[str, Any]) -> dict[str, Any]:
            item = find_item(store["modelPolicies"], policy_id)
            if not item:
                raise HTTPException(status_code=404, detail="Politica nao encontrada.")
            item.update({**payload, "updatedAt": now_iso()})
            return item
        return await mutate_store(user_id, update)
    item = {**payload, "id": entity_id("policy"), "createdAt": now_iso(), "updatedAt": now_iso()}
    await mutate_store(user_id, lambda store: store["modelPolicies"].insert(0, item))
    return item


def usage_summary(user: dict[str, Any]) -> dict[str, Any]:
    usage = read_store(tenant_id(user))["modelUsage"]
    return {
        "items": usage[:200], "requests": len(usage),
        "inputTokens": sum(int(item.get("inputTokens") or 0) for item in usage),
        "outputTokens": sum(int(item.get("outputTokens") or 0) for item in usage),
        "estimatedCost": round(sum(float(item.get("estimatedCost") or 0) for item in usage), 6),
    }


async def complete_with_provider(
    user: dict[str, Any],
    provider_id: str,
    messages: list[dict[str, str]],
    system_prompt: str,
) -> tuple[str, dict[str, Any]]:
    """Executa chat no adapter selecionado e registra consumo aproximado."""
    user_id = tenant_id(user)
    if provider_id == "auto":
        route = await asyncio.to_thread(route_model,
            user,
            {
                "requiredCapabilities": ["text"],
                "privacy": "any",
                "estimatedInputTokens": 1000,
                "estimatedOutputTokens": 500,
                "externalActionCommitted": False,
            },
        )
        candidates = [route.get("selected"), *(route.get("fallback") or [])]
        attempted: list[str] = []
        for candidate in candidates:
            candidate_id = str((candidate or {}).get("id") or "")
            if not candidate_id or candidate_id in attempted:
                continue
            attempted.append(candidate_id)
            try:
                answer, metadata = await complete_with_provider(user, candidate_id, messages, system_prompt)
                return answer, {**metadata, "mode": "automatic", "attemptedProviderIds": attempted}
            except HTTPException as exc:
                if exc.status_code not in {429, 502, 503, 504}:
                    raise
        raise HTTPException(status_code=503, detail="Nenhum modelo configurado conseguiu concluir a resposta agora.")
    providers = await asyncio.to_thread(all_providers, user_id)
    provider = next((item for item in providers if item["id"] == provider_id), None)
    if not provider:
        raise HTTPException(status_code=404, detail="Modelo selecionado nao foi encontrado.")
    from app.core.ai_provider_policy import approved_provider, ProviderPolicyError

    try:
        provider_kind, base_url = approved_provider(user, provider)
    except ProviderPolicyError as exc:
        raise HTTPException(status_code=403, detail="Provedor não aprovado para este ambiente de trabalho.") from exc
    if provider_id == "nora-runtime":
        secret = os.getenv("GROQ_API_KEY", "").strip()
    elif provider_id == "gemini-runtime":
        secret = os.getenv("GEMINI_API_KEY", "").strip()
    else:
        encrypted = str(provider.get("encryptedSecret") or "")
        secret = decrypt_secret(encrypted) if encrypted else ""
    if not secret:
        raise HTTPException(status_code=409, detail="O modelo selecionado ainda nao possui credencial configurada.")
    if not base_url:
        raise HTTPException(status_code=409, detail="Configure a URL base do provedor.")
    _, host = validate_public_url(base_url)
    await assert_public_dns(host)
    # LGPD: segredos, CPF e cartao saem de toda chamada, inclusive pesquisa web e provedores extras.
    safe_messages = [
        {
            "role": item.get("role") if item.get("role") in {"user", "assistant"} else "user",
            "content": minimize_for_ai(str(item.get("content") or ""), max_chars=20_000),
        }
        for item in messages[-12:]
    ]
    system_prompt = minimize_for_ai(system_prompt)
    timeout = httpx.Timeout(45, connect=8)
    try:
        async with Meter(provider, [system_prompt, *safe_messages], 1400, user_id=user_id, source="model-gateway") as meter, httpx.AsyncClient(timeout=timeout, follow_redirects=False, trust_env=False, transport=PublicHTTPTransport([host])) as client:
            meter.sent()
            if provider_kind == "anthropic":
                response = await client.post(
                    f"{base_url}/messages",
                    headers={"x-api-key": secret, "anthropic-version": "2023-06-01", "content-type": "application/json"},
                    json={"model": provider["model"], "system": system_prompt, "messages": safe_messages, "max_tokens": meter.max_output},
                )
            elif provider_kind == "google":
                transcript = "\n\n".join(
                    f"{'Usuário' if item['role'] == 'user' else 'Nora'}: {item['content']}"
                    for item in safe_messages
                )
                response = await client.post(
                    f"{base_url}/interactions",
                    headers={"x-goog-api-key": secret, "Content-Type": "application/json"},
                    json={
                        "model": provider["model"],
                        "store": False,
                        "input": f"{system_prompt}\n\nConversa recente:\n{transcript}",
                        "generation_config": {"thinking_level": "low", "max_output_tokens": meter.max_output},
                    },
                )
            elif provider_kind == "openai":
                response = await client.post(
                    f"{base_url}/responses",
                    headers={"Authorization": f"Bearer {secret}", "Content-Type": "application/json"},
                    json={
                        "model": provider["model"],
                        "instructions": system_prompt,
                        "input": safe_messages,
                        "store": False,
                        "max_output_tokens": meter.max_output,
                    },
                )
            else:
                response = await client.post(
                    f"{base_url}/chat/completions",
                    headers={"Authorization": f"Bearer {secret}", "Content-Type": "application/json"},
                    json={"model": provider["model"], "messages": [{"role": "system", "content": system_prompt}, *safe_messages], "temperature": 0.45, "max_tokens": meter.max_output},
                )
            if response.status_code >= 400:
                meter.rejected()
            response.raise_for_status()
            data = response.json()
            usage = {**await meter.record(data), "providerId": provider_id}
    except (httpx.HTTPError, ValueError) as exc:
        raise HTTPException(status_code=502, detail="O provedor selecionado nao concluiu a resposta. Nenhuma acao externa foi executada.") from exc
    if provider_kind == "anthropic":
        blocks = data.get("content") if isinstance(data, dict) else []
        answer = "".join(str(block.get("text") or "") for block in blocks if isinstance(block, dict))
    elif provider_kind == "google":
        steps = data.get("steps") if isinstance(data, dict) else []
        answer = "".join(
            str(content.get("text") or "")
            for step in steps or [] if isinstance(step, dict) and step.get("type") == "model_output"
            for content in step.get("content") or [] if isinstance(content, dict) and content.get("type") == "text"
        )
    elif provider_kind == "openai":
        answer = str(data.get("output_text") or "")
        if not answer:
            answer = "".join(
                str(content.get("text") or "")
                for item in data.get("output") or [] if isinstance(item, dict) and item.get("type") == "message"
                for content in item.get("content") or [] if isinstance(content, dict) and content.get("type") == "output_text"
            )
    else:
        choices = data.get("choices") if isinstance(data, dict) else []
        answer = str(((choices or [{}])[0].get("message") or {}).get("content") or "")
    if not answer.strip():
        raise HTTPException(status_code=502, detail="O provedor retornou uma resposta vazia.")
    await mutate_store(user_id, lambda store: store["modelUsage"].insert(0, usage))
    return answer.strip(), {"provider": sanitize_provider(provider), "usage": usage}
