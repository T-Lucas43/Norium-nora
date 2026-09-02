from __future__ import annotations

import asyncio
import hashlib
import html
import ipaddress
import os
import re
import socket
import uuid
from collections import Counter
from datetime import datetime, timezone
from html.parser import HTMLParser
from typing import Any
from urllib.parse import urljoin, urlparse

import httpx
from fastapi import HTTPException

from app.core.tenant import read_user_db, write_user_db
from app.modules.intelligence.repository import mutate_store, now_iso, read_store, write_store
from app.modules.platform.service import decrypt_secret, encrypt_secret


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


def host_matches(host: str, rule: str) -> bool:
    normalized = rule.strip().lower().lstrip(".")
    return bool(normalized and (host == normalized or host.endswith(f".{normalized}")))


def validate_public_url(url: str, allowed_domains: list[str] | None = None, blocked_domains: list[str] | None = None) -> tuple[str, str]:
    parsed = urlparse(url.strip())
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
        raise HTTPException(status_code=400, detail="Use uma URL HTTP(S) publica, sem credenciais embutidas.")
    host = parsed.hostname.rstrip(".").lower()
    if host in {"localhost", "localhost.localdomain"} or host.endswith(".local"):
        raise HTTPException(status_code=400, detail="Enderecos locais ou privados nao podem ser acessados.")
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        address = None
    if address and not address.is_global:
        raise HTTPException(status_code=400, detail="Enderecos locais ou privados nao podem ser acessados.")
    if any(host_matches(host, rule) for rule in blocked_domains or []):
        raise HTTPException(status_code=403, detail="O dominio esta bloqueado neste perfil.")
    if allowed_domains and not any(host_matches(host, rule) for rule in allowed_domains):
        raise HTTPException(status_code=403, detail="O dominio nao esta na lista permitida deste perfil.")
    port = parsed.port
    if port and port not in {80, 443}:
        raise HTTPException(status_code=400, detail="Somente portas web padrao sao permitidas.")
    return parsed.geturl(), host


async def assert_public_dns(host: str) -> None:
    try:
        records = await asyncio.to_thread(socket.getaddrinfo, host, None, type=socket.SOCK_STREAM)
    except OSError as exc:
        raise HTTPException(status_code=400, detail="O dominio informado nao pode ser resolvido.") from exc
    for record in records:
        try:
            address = ipaddress.ip_address(record[4][0])
        except ValueError:
            continue
        if not address.is_global:
            raise HTTPException(status_code=400, detail="O dominio resolve para uma rede local ou privada.")


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
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=False, headers=headers) as client:
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


def find_item(items: list[dict[str, Any]], item_id: str) -> dict[str, Any] | None:
    return next((item for item in items if str(item.get("id")) == item_id), None)


async def create_browser_profile(user: dict[str, Any], payload: dict[str, Any]) -> dict[str, Any]:
    item = {**payload, "id": entity_id("profile"), "createdAt": now_iso(), "updatedAt": now_iso()}
    await mutate_store(tenant_id(user), lambda store: store["browserProfiles"].insert(0, item))
    return item


async def create_browser_plan(user: dict[str, Any], payload: dict[str, Any], *, source: str = "screen") -> dict[str, Any]:
    user_id = tenant_id(user)
    store = read_store(user_id)
    profile = find_item(store["browserProfiles"], str(payload.get("profileId") or ""))
    allowed = list(profile.get("allowedDomains", [])) if profile else []
    blocked = list(profile.get("blockedDomains", [])) if profile else []
    normalized, host = validate_public_url(str(payload["startUrl"]), allowed, blocked)
    risk, approval, reason = browser_risk(str(payload["objective"]))
    created = now_iso()
    run = {
        "id": entity_id("browser_run"), "objective": payload["objective"], "startUrl": normalized,
        "host": host, "profileId": profile.get("id") if profile else None, "source": source,
        "policySnapshot": {"allowedDomains": allowed, "blockedDomains": blocked, "allowDownloads": bool(profile and profile.get("allowDownloads"))},
        "risk": risk, "riskReason": reason, "requiresApproval": approval, "approved": False,
        "status": "planned", "progress": 0, "maxPages": payload.get("maxPages", 1),
        "plan": [
            {"id": "validate", "title": "Validar dominio e politica", "status": "ready"},
            {"id": "read", "title": "Ler a pagina publica", "status": "pending"},
            {"id": "extract", "title": "Extrair fatos e links", "status": "pending"},
        ],
        "timeline": [{"at": created, "event": "plan_created", "message": reason}],
        "result": None, "error": None, "cancelRequested": False, "pauseRequested": False,
        "createdAt": created, "updatedAt": created,
    }
    await mutate_store(user_id, lambda current: current["browserRuns"].insert(0, run))
    return run


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
    user_id = tenant_id(user)
    store = read_store(user_id)
    run = find_item(store["browserRuns"], run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Execucao do navegador nao encontrada.")
    if run.get("requiresApproval") and not run.get("approved"):
        return _set_run(user_id, run_id, {"status": "awaiting_approval"}, ("approval_required", "Aguardando aprovacao humana."))
    if run.get("cancelRequested"):
        return _set_run(user_id, run_id, {"status": "cancelled"}, ("cancelled", "Execucao cancelada antes do acesso externo."))
    if run.get("pauseRequested"):
        return _set_run(user_id, run_id, {"status": "paused"}, ("paused", "Execucao pausada antes do acesso externo."))
    _set_run(user_id, run_id, {"status": "running", "progress": 25}, ("started", "Leitura segura iniciada."))
    try:
        current_store = read_store(user_id)
        current = find_item(current_store["browserRuns"], run_id) or run
        profile = find_item(current_store["browserProfiles"], str(current.get("profileId") or ""))
        policy = current.get("policySnapshot") if isinstance(current.get("policySnapshot"), dict) else {}
        page = await safe_fetch(
            str(current["startUrl"]),
            list(policy.get("allowedDomains", profile.get("allowedDomains", []) if profile else [])),
            list(policy.get("blockedDomains", profile.get("blockedDomains", []) if profile else [])),
        )
        latest = find_item(read_store(user_id)["browserRuns"], run_id) or current
        if latest.get("cancelRequested"):
            return _set_run(user_id, run_id, {"status": "cancelled", "progress": 50}, ("cancelled", "Resultado descartado apos cancelamento."))
        result = {
            "title": page["title"], "url": page["url"], "summary": page["text"][:1200],
            "textLength": len(page["text"]), "links": list(page.get("links", []))[:30], "readOnly": True,
        }
        return _set_run(user_id, run_id, {"status": "completed", "progress": 100, "result": result, "error": None}, ("completed", "Pagina lida e evidencias registradas."))
    except HTTPException as exc:
        return _set_run(user_id, run_id, {"status": "failed", "error": str(exc.detail), "progress": 100}, ("failed", str(exc.detail)))
    except Exception:
        return _set_run(user_id, run_id, {"status": "failed", "error": "Falha inesperada na execucao segura.", "progress": 100}, ("failed", "Falha inesperada na execucao segura."))


async def update_browser_control(user: dict[str, Any], run_id: str, action: str) -> dict[str, Any]:
    user_id = tenant_id(user)
    updates: dict[str, Any]
    if action == "cancel":
        updates = {"cancelRequested": True, "status": "cancelled"}
    elif action == "pause":
        updates = {"pauseRequested": True, "status": "paused"}
    elif action == "resume":
        updates = {"pauseRequested": False, "status": "planned"}
    else:
        raise HTTPException(status_code=400, detail="Controle de execucao invalido.")
    return _set_run(user_id, run_id, updates, (action, f"Execucao {action}."))


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
    return [match.group(0).lower() for match in TOKEN_PATTERN.finditer(value)]


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
    bases = {item["id"]: item for item in store["knowledgeBases"] if not wanted or item["id"] in wanted}
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


MARKETPLACE_CATALOG = [
    {
        "id": "browser-research-agent", "type": "agent", "name": "Pesquisa web segura", "description": "Cria um perfil restrito para pesquisas publicas e rastreaveis.",
        "version": "1.0.0", "author": "Norium", "verified": True, "permissions": ["Leitura de paginas publicas"], "dependencies": ["Agente Navegador"], "category": "Pesquisa",
    },
    {
        "id": "competitor-watch-automation", "type": "automation", "name": "Monitor de pagina", "description": "Instala uma automacao desativada para leitura controlada de uma URL.",
        "version": "1.0.0", "author": "Norium", "verified": True, "permissions": ["Criar automacao", "Leitura de URL autorizada"], "dependencies": ["Agente Navegador", "Automacoes"], "category": "Automacao",
    },
    {
        "id": "sales-knowledge-template", "type": "template", "name": "Base comercial", "description": "Estrutura uma base privada para politicas, propostas e materiais comerciais.",
        "version": "1.1.0", "author": "Norium", "verified": True, "permissions": ["Criar base de conhecimento"], "dependencies": ["Conhecimento"], "category": "Conhecimento",
    },
    {
        "id": "cost-aware-model-policy", "type": "package", "name": "Roteamento custo consciente", "description": "Instala uma politica desativada que prioriza modelos configurados de menor custo.",
        "version": "1.0.0", "author": "Norium", "verified": True, "permissions": ["Criar politica de modelos"], "dependencies": ["IA e Modelos"], "category": "IA",
    },
    {
        "id": "nora-runtime-model", "type": "model", "name": "Modelo padrão da Nora", "description": "Cria uma política desativada apontando para o modelo gerenciado pelo runtime da Nora.",
        "version": "1.0.0", "author": "Norium", "verified": True, "permissions": ["Criar política de modelo"], "dependencies": ["NORA_MODEL e GROQ_API_KEY no ambiente"], "category": "Modelos",
    },
    {
        "id": "web-source-connector", "type": "integration", "name": "Conector de fontes web", "description": "Cria uma base desativada para receber páginas públicas pelo conector seguro de URL.",
        "version": "1.0.0", "author": "Norium", "verified": True, "permissions": ["Criar base", "Ler páginas públicas autorizadas"], "dependencies": ["Conhecimento", "Saída HTTPS"], "category": "Integrações",
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
        resource = {"id": entity_id("kb"), "name": "Fontes web" if is_connector else "Base comercial", "description": "Paginas publicas autorizadas." if is_connector else "Politicas, propostas e materiais comerciais.", "visibility": "private", "tags": ["web"] if is_connector else ["comercial"], "sourceCount": 0, "chunkCount": 0, "status": "ready", "active": False if is_connector else True, "marketplaceInstallationId": installation_id, "createdAt": now_iso(), "updatedAt": now_iso()}
        store["knowledgeBases"].insert(0, resource)
        write_store(user_id, store)
        return {"type": "knowledgeBase", "id": resource["id"]}
    if item["id"] in {"cost-aware-model-policy", "nora-runtime-model"}:
        store = read_store(user_id)
        runtime_model = item["id"] == "nora-runtime-model"
        resource = {"id": entity_id("policy"), "name": "Modelo padrão da Nora" if runtime_model else "Custo consciente", "mode": "manual" if runtime_model else "automatic", "preferredProviderId": "nora-runtime" if runtime_model else None, "fallbackProviderIds": [], "requireCapabilities": ["text"], "maxInputCostPerMillion": None if runtime_model else 2, "privacy": "any", "monthlyBudget": None, "enabled": False, "marketplaceInstallationId": installation_id, "createdAt": now_iso(), "updatedAt": now_iso()}
        store["modelPolicies"].insert(0, resource)
        write_store(user_id, store)
        return {"type": "modelPolicy", "id": resource["id"]}
    auto_store = read_user_db(user_id, "automacoes", {"automations": [], "history": []})
    if not isinstance(auto_store, dict):
        auto_store = {"automations": [], "history": []}
    created = now_iso()
    resource = {
        "id": entity_id("auto"), "name": "Monitor de pagina", "description": "Le uma pagina autorizada e registra evidencias.",
        "icon": "globe", "category": "Navegador", "trigger": "Manual", "actions": ["Executar tarefa no navegador"],
        "status": "desativada", "active": False, "aiEnabled": False, "favorite": False, "savedMinutesPerRun": 10,
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
    installation = {"id": installation_id, "catalogId": item_id, "name": item["name"], "version": version or item["version"], "status": "installed", "enabled": False, "resource": resource, "installedAt": now_iso(), "updatedAt": now_iso()}
    await mutate_store(user_id, lambda current: current["installations"].insert(0, installation))
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
        "capabilities": ["text", "tools", "json"], "contextWindow": 131072, "inputCostPerMillion": 0,
        "outputCostPerMillion": 0, "dataPolicy": "external", "managed": True,
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
    return [builtin_provider(), *read_store(user_id)["modelProviders"]]


def route_model(user: dict[str, Any], payload: dict[str, Any]) -> dict[str, Any]:
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
        if not provider.get("enabled") or not (provider.get("encryptedSecret") or provider.get("configured")):
            reason = "desativado ou sem credencial"
        elif not requirements.issubset(set(provider.get("capabilities", []))):
            reason = "capacidade obrigatoria ausente"
        elif privacy == "local" and provider.get("dataPolicy") != "local":
            reason = "politica exige processamento local"
        elif privacy == "private" and provider.get("dataPolicy") not in {"private", "local"}:
            reason = "politica exige provedor privado"
        elif max_cost is not None and float(provider.get("inputCostPerMillion") or 0) > float(max_cost):
            reason = "custo excede a politica"
        if reason:
            rejected.append({"providerId": str(provider["id"]), "reason": reason})
        else:
            eligible.append(provider)
    eligible.sort(key=lambda item: (0 if item["id"] == preferred else 1, float(item.get("inputCostPerMillion") or 0), -int(item.get("contextWindow") or 0)))
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
    provider = next((item for item in all_providers(user_id) if item["id"] == provider_id), None)
    if not provider:
        raise HTTPException(status_code=404, detail="Provedor nao encontrado.")
    if provider_id == "nora-runtime":
        secret = os.getenv("GROQ_API_KEY", "").strip()
    else:
        encrypted = str(provider.get("encryptedSecret") or "")
        secret = decrypt_secret(encrypted) if encrypted else ""
    if not secret:
        return {"ok": False, "providerId": provider_id, "detail": "Salve uma credencial antes de testar."}
    base_url = str(provider.get("baseUrl") or "").rstrip("/")
    if not base_url:
        base_url = "https://api.groq.com/openai/v1" if provider.get("provider") == "groq" else "https://api.anthropic.com/v1" if provider.get("provider") == "anthropic" else "https://api.openai.com/v1"
    _, host = validate_public_url(base_url)
    await assert_public_dns(host)
    headers = {"x-api-key": secret, "anthropic-version": "2023-06-01"} if provider.get("provider") == "anthropic" else {"Authorization": f"Bearer {secret}"}
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(timeout_seconds, connect=min(8, timeout_seconds)), follow_redirects=False) as client:
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
    provider = next((item for item in all_providers(user_id) if item["id"] == provider_id), None)
    if not provider:
        raise HTTPException(status_code=404, detail="Modelo selecionado nao foi encontrado.")
    if provider_id == "nora-runtime":
        secret = os.getenv("GROQ_API_KEY", "").strip()
    else:
        encrypted = str(provider.get("encryptedSecret") or "")
        secret = decrypt_secret(encrypted) if encrypted else ""
    if not secret:
        raise HTTPException(status_code=409, detail="O modelo selecionado ainda nao possui credencial configurada.")
    provider_kind = str(provider.get("provider") or "")
    base_url = str(provider.get("baseUrl") or "").rstrip("/")
    if provider_kind == "groq":
        base_url = base_url or "https://api.groq.com/openai/v1"
    elif provider_kind == "openai":
        base_url = base_url or "https://api.openai.com/v1"
    elif provider_kind == "anthropic":
        base_url = base_url or "https://api.anthropic.com/v1"
    if not base_url:
        raise HTTPException(status_code=409, detail="Configure a URL base do provedor.")
    _, host = validate_public_url(base_url)
    await assert_public_dns(host)
    safe_messages = [
        {"role": item.get("role") if item.get("role") in {"user", "assistant"} else "user", "content": str(item.get("content") or "")[:20_000]}
        for item in messages[-12:]
    ]
    timeout = httpx.Timeout(45, connect=8)
    try:
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=False) as client:
            if provider_kind == "anthropic":
                response = await client.post(
                    f"{base_url}/messages",
                    headers={"x-api-key": secret, "anthropic-version": "2023-06-01", "content-type": "application/json"},
                    json={"model": provider["model"], "system": system_prompt, "messages": safe_messages, "max_tokens": 1400},
                )
            else:
                response = await client.post(
                    f"{base_url}/chat/completions",
                    headers={"Authorization": f"Bearer {secret}", "Content-Type": "application/json"},
                    json={"model": provider["model"], "messages": [{"role": "system", "content": system_prompt}, *safe_messages], "temperature": 0.45, "max_tokens": 1400},
                )
            response.raise_for_status()
            data = response.json()
    except (httpx.HTTPError, ValueError) as exc:
        raise HTTPException(status_code=502, detail="O provedor selecionado nao concluiu a resposta. Nenhuma acao externa foi executada.") from exc
    if provider_kind == "anthropic":
        blocks = data.get("content") if isinstance(data, dict) else []
        answer = "".join(str(block.get("text") or "") for block in blocks if isinstance(block, dict))
        input_tokens = int((data.get("usage") or {}).get("input_tokens") or 0)
        output_tokens = int((data.get("usage") or {}).get("output_tokens") or 0)
    else:
        choices = data.get("choices") if isinstance(data, dict) else []
        answer = str(((choices or [{}])[0].get("message") or {}).get("content") or "")
        input_tokens = int((data.get("usage") or {}).get("prompt_tokens") or 0)
        output_tokens = int((data.get("usage") or {}).get("completion_tokens") or 0)
    if not answer.strip():
        raise HTTPException(status_code=502, detail="O provedor retornou uma resposta vazia.")
    estimated = (
        input_tokens * float(provider.get("inputCostPerMillion") or 0)
        + output_tokens * float(provider.get("outputCostPerMillion") or 0)
    ) / 1_000_000
    usage = {"id": entity_id("usage"), "providerId": provider_id, "model": provider["model"], "inputTokens": input_tokens, "outputTokens": output_tokens, "estimatedCost": round(estimated, 6), "createdAt": now_iso()}
    await mutate_store(user_id, lambda store: store["modelUsage"].insert(0, usage))
    return answer.strip(), {"provider": sanitize_provider(provider), "usage": usage}
