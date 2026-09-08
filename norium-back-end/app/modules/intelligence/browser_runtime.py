"""Executor real e supervisionado do Agente Navegador.

O modulo mantem o Chromium fora das rotas HTTP, aplica isolamento por contexto,
limites de duracao/etapas, aprovacoes por acao e persiste somente evidencias
sanitizadas. Nenhum seletor executa JavaScript fornecido pelo usuario ou modelo.
"""

from __future__ import annotations

import asyncio
import base64
import json
import mimetypes
import re
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from fastapi import HTTPException
from playwright.async_api import BrowserContext, Download, Locator, Page, Playwright, Route, async_playwright

from app.core.tenant import get_user_db_path
from app.modules.intelligence.browser_live import live_key, start_live
from app.modules.intelligence.repository import mutate_store, now_iso, read_store
from app.modules.platform.service import decrypt_secret, encrypt_secret, list_collection, update_collection_item


MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024
MAX_SCREENSHOTS = 30
ACTIVE_BROWSER_LIMIT = max(1, min(4, int(__import__("os").getenv("BROWSER_AGENT_CONCURRENCY", "1"))))
_SEMAPHORE = asyncio.Semaphore(ACTIVE_BROWSER_LIMIT)
_ACTIVE: dict[str, asyncio.Task[dict[str, Any]]] = {}
_CONTROLS: dict[str, "BrowserControl"] = {}


def _key(user_id: str, run_id: str) -> str:
    return live_key(user_id, run_id)


@dataclass
class BrowserControl:
    pause: asyncio.Event = field(default_factory=asyncio.Event)
    approval: asyncio.Event = field(default_factory=asyncio.Event)
    cancelled: bool = False

    def __post_init__(self) -> None:
        self.pause.set()


def sanitize_profile(profile: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in profile.items() if key != "encryptedStorageState"}


def sanitize_run(run: dict[str, Any]) -> dict[str, Any]:
    safe = {key: value for key, value in run.items() if key not in {"sessionSecret"}}
    if isinstance(run.get("report"), dict):
        safe["report"] = {key: run["report"].get(key) for key in ("title", "revision", "generator")}
    safe["artifacts"] = [
        {key: value for key, value in item.items() if key != "path"}
        for item in run.get("artifacts", [])
        if isinstance(item, dict)
    ]
    return safe


def _run_dir(user_id: str, run_id: str) -> Path:
    root = Path(get_user_db_path(user_id, "intelligence")).parent / "browser_runs" / run_id
    root.mkdir(parents=True, exist_ok=True)
    return root.resolve()


def artifact_path(user_id: str, run_id: str, artifact_id: str) -> tuple[Path, dict[str, Any]]:
    run = next((item for item in read_store(user_id)["browserRuns"] if item.get("id") == run_id), None)
    if not run:
        raise HTTPException(status_code=404, detail="Execucao do navegador nao encontrada.")
    artifact = next((item for item in run.get("artifacts", []) if item.get("id") == artifact_id), None)
    if not artifact:
        raise HTTPException(status_code=404, detail="Evidencia ou arquivo nao encontrado.")
    path = Path(str(artifact.get("path") or "")).resolve()
    try:
        path.relative_to(_run_dir(user_id, run_id))
    except ValueError as exc:
        raise HTTPException(status_code=404, detail="Arquivo fora da execucao autorizada.") from exc
    if not path.is_file():
        raise HTTPException(status_code=404, detail="O arquivo da execucao nao esta mais disponivel.")
    return path, artifact


async def store_uploaded_artifact(user_id: str, run_id: str, file_name: str, mime_type: str, data_url: str) -> dict[str, Any]:
    run = _fresh_run(user_id, run_id)
    if run.get("status") not in {"planned", "paused", "failed"}:
        raise HTTPException(status_code=409, detail="Pause a execucao antes de anexar arquivos ao plano.")
    if len([item for item in run.get("artifacts", []) if item.get("kind") == "upload"]) >= 10:
        raise HTTPException(status_code=409, detail="Cada execucao aceita no maximo dez arquivos enviados.")
    match = re.match(r"^data:([^;,]+);base64,(.*)$", data_url, flags=re.DOTALL)
    if not match:
        raise HTTPException(status_code=422, detail="Envie o arquivo em data URL valida.")
    encoded = match.group(2)
    try:
        content = base64.b64decode(encoded, validate=True)
    except (ValueError, TypeError) as exc:
        raise HTTPException(status_code=422, detail="O arquivo enviado nao possui base64 valido.") from exc
    if len(content) > 10 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Uploads do navegador aceitam no maximo 10 MB.")
    safe_name = re.sub(r"[^a-zA-Z0-9._-]+", "_", Path(file_name).name).strip("._") or "arquivo"
    artifact_id = f"artifact_{uuid.uuid4().hex[:16]}"
    path = _run_dir(user_id, run_id) / f"{artifact_id}_{safe_name}"
    await asyncio.to_thread(path.write_bytes, content)
    artifact = {
        "id": artifact_id, "kind": "upload", "name": safe_name,
        "mimeType": mime_type or match.group(1) or "application/octet-stream",
        "size": len(content), "path": str(path), "createdAt": now_iso(),
        "url": f"/api/navegador/runs/{run_id}/artifacts/{artifact_id}",
    }

    def mutation(store: dict[str, Any]) -> dict[str, Any]:
        run = next((item for item in store["browserRuns"] if item.get("id") == run_id), None)
        if not run:
            raise HTTPException(status_code=404, detail="Execucao do navegador nao encontrada.")
        run.setdefault("artifacts", []).append(artifact)
        run["updatedAt"] = now_iso()
        return artifact

    await mutate_store(user_id, mutation)
    return {key: value for key, value in artifact.items() if key != "path"}


async def _update_run(
    user_id: str,
    run_id: str,
    updates: dict[str, Any] | None = None,
    *,
    event: tuple[str, str] | None = None,
    action_id: str | None = None,
    action_updates: dict[str, Any] | None = None,
) -> dict[str, Any]:
    def mutation(store: dict[str, Any]) -> dict[str, Any]:
        run = next((item for item in store["browserRuns"] if item.get("id") == run_id), None)
        if not run:
            raise HTTPException(status_code=404, detail="Execucao do navegador nao encontrada.")
        if updates:
            run.update(updates)
        if action_id and action_updates:
            action = next((item for item in run.get("plan", []) if item.get("id") == action_id), None)
            if action:
                action.update(action_updates)
        if event:
            run.setdefault("timeline", []).append({"at": now_iso(), "event": event[0], "message": event[1]})
        run["updatedAt"] = now_iso()
        return sanitize_run(run)

    return await mutate_store(user_id, mutation)


def _fresh_run(user_id: str, run_id: str) -> dict[str, Any]:
    run = next((item for item in read_store(user_id)["browserRuns"] if item.get("id") == run_id), None)
    if not run:
        raise HTTPException(status_code=404, detail="Execucao do navegador nao encontrada.")
    return run


async def _save_screenshot(user_id: str, run_id: str, page: Page, label: str) -> dict[str, Any] | None:
    run = _fresh_run(user_id, run_id)
    screenshots = [item for item in run.get("artifacts", []) if item.get("kind") == "screenshot"]
    if len(screenshots) >= MAX_SCREENSHOTS:
        return None
    artifact_id = f"artifact_{uuid.uuid4().hex[:16]}"
    safe_label = re.sub(r"[^a-zA-Z0-9_-]+", "-", label).strip("-")[:50] or "captura"
    path = _run_dir(user_id, run_id) / f"{artifact_id}_{safe_label}.webp"
    await page.screenshot(path=str(path), type="webp", quality=58, full_page=False, animations="disabled")
    artifact = {
        "id": artifact_id, "kind": "screenshot", "name": f"{safe_label}.webp",
        "mimeType": "image/webp", "size": path.stat().st_size, "path": str(path),
        "createdAt": now_iso(), "url": f"/api/navegador/runs/{run_id}/artifacts/{artifact_id}",
    }

    def mutation(store: dict[str, Any]) -> None:
        stored = next((item for item in store["browserRuns"] if item.get("id") == run_id), None)
        if stored:
            stored.setdefault("artifacts", []).append(artifact)
            stored["latestScreenshotId"] = artifact_id
            stored["updatedAt"] = now_iso()

    await mutate_store(user_id, mutation)
    return {key: value for key, value in artifact.items() if key != "path"}


async def _credential_value(user: dict[str, Any], profile: dict[str, Any], action: dict[str, Any], current_url: str) -> str:
    credential_id = str(action.get("credentialId") or "")
    if credential_id not in profile.get("credentialIds", []):
        raise HTTPException(status_code=403, detail="A credencial nao esta autorizada neste perfil de navegacao.")
    items = await list_collection(user, "vault", account_level=True)
    item = next((value for value in items if value.get("id") == credential_id), None)
    if not item or not item.get("encryptedSecret"):
        raise HTTPException(status_code=404, detail="Credencial autorizada nao encontrada ou revogada.")
    credential_domain = str(item.get("integration") or "").removeprefix("browser:").lower().lstrip(".")
    current_host = str(urlparse(current_url).hostname or "").lower()
    if not credential_domain or not (current_host == credential_domain or current_host.endswith(f".{credential_domain}")):
        raise HTTPException(status_code=403, detail="A credencial nao pode ser preenchida fora do dominio ao qual pertence.")
    secret = decrypt_secret(str(item["encryptedSecret"]))
    field_name = str(action.get("credentialField") or "secret")
    try:
        parsed = json.loads(secret)
    except json.JSONDecodeError:
        parsed = {"secret": secret}
    value = str(parsed.get(field_name) or "") if isinstance(parsed, dict) else ""
    if not value:
        raise HTTPException(status_code=422, detail=f'A credencial nao possui o campo protegido "{field_name}".')
    await update_collection_item(user, "vault", credential_id, {"lastUsedAt": now_iso()}, account_level=True)
    return value


async def _first_visible(candidates: list[Locator]) -> Locator:
    for candidate in candidates:
        try:
            if await candidate.count() and await candidate.first.is_visible(timeout=700):
                return candidate.first
        except Exception:
            continue
    raise HTTPException(status_code=422, detail="O elemento solicitado nao foi encontrado ou nao esta visivel.")


async def _target(page: Page, target: str, *, input_only: bool = False) -> Locator:
    value = target.strip()
    if not value:
        if input_only:
            return await _first_visible([
                page.locator('input[type="search"]'), page.get_by_role("searchbox"),
                page.locator('input:not([type="hidden"]):not([type="submit"])'), page.locator("textarea"),
            ])
        raise HTTPException(status_code=422, detail="A acao exige um alvo visivel.")
    if value.startswith("css="):
        return await _first_visible([page.locator(value[4:])])
    if value.startswith("label="):
        return await _first_visible([page.get_by_label(value[6:], exact=False)])
    if value.startswith("placeholder="):
        return await _first_visible([page.get_by_placeholder(value[12:], exact=False)])
    if value.startswith("text="):
        return await _first_visible([page.get_by_text(value[5:], exact=False)])
    candidates = [page.get_by_label(value, exact=False), page.get_by_placeholder(value, exact=False)]
    if not input_only:
        candidates.extend([
            page.get_by_role("button", name=value, exact=False), page.get_by_role("link", name=value, exact=False),
            page.get_by_text(value, exact=False), page.get_by_title(value, exact=False),
        ])
    return await _first_visible(candidates)


async def _extract(page: Page) -> dict[str, Any]:
    title = await page.title()
    text = await page.locator("body").inner_text(timeout=10_000)
    links = await page.locator("a[href]").evaluate_all(
        "els => els.slice(0, 100).map(a => ({text: (a.innerText || '').trim().slice(0, 240), url: a.href}))"
    )
    tables = await page.locator("table").evaluate_all(
        "tables => tables.slice(0, 10).map(t => [...t.rows].slice(0, 100).map(r => [...r.cells].map(c => (c.innerText || '').trim().slice(0, 500))))"
    )
    return {"title": title[:300], "url": page.url, "text": text[:200_000], "links": links, "tables": tables}


async def _save_download(user_id: str, run_id: str, download: Download) -> dict[str, Any]:
    artifact_id = f"artifact_{uuid.uuid4().hex[:16]}"
    safe_name = re.sub(r"[^a-zA-Z0-9._-]+", "_", Path(download.suggested_filename).name).strip("._") or "download"
    path = _run_dir(user_id, run_id) / f"{artifact_id}_{safe_name}"
    await download.save_as(str(path))
    size = path.stat().st_size
    if size > MAX_DOWNLOAD_BYTES:
        path.unlink(missing_ok=True)
        raise HTTPException(status_code=413, detail="O download excedeu o limite seguro de 25 MB.")
    artifact = {
        "id": artifact_id, "kind": "download", "name": safe_name,
        "mimeType": mimetypes.guess_type(safe_name)[0] or "application/octet-stream",
        "size": size, "path": str(path), "createdAt": now_iso(),
        "url": f"/api/navegador/runs/{run_id}/artifacts/{artifact_id}",
    }

    def mutation(store: dict[str, Any]) -> None:
        run = next((item for item in store["browserRuns"] if item.get("id") == run_id), None)
        if run:
            run.setdefault("artifacts", []).append(artifact)

    await mutate_store(user_id, mutation)
    return {key: value for key, value in artifact.items() if key != "path"}


async def _execute_action(
    user: dict[str, Any], user_id: str, run_id: str, page: Page,
    profile: dict[str, Any], action: dict[str, Any],
) -> dict[str, Any] | None:
    kind = str(action.get("type") or "")
    target = str(action.get("target") or "")
    value = str(action.get("value") or "")
    timeout = min(30_000, int(profile.get("actionTimeoutMs") or 15_000))
    if kind == "navigate":
        from app.modules.intelligence.service import assert_public_dns, validate_public_url

        normalized, host = validate_public_url(
            value or target,
            list(profile.get("allowedDomains", [])),
            list(profile.get("blockedDomains", [])),
        )
        await assert_public_dns(host)
        await page.goto(normalized, wait_until="domcontentloaded", timeout=timeout)
    elif kind == "search":
        locator = await _target(page, target, input_only=True)
        await locator.fill(value, timeout=timeout)
        await locator.press("Enter", timeout=timeout)
        await page.wait_for_load_state("domcontentloaded", timeout=timeout)
    elif kind == "click":
        await (await _target(page, target)).click(timeout=timeout)
    elif kind in {"fill", "credential_fill"}:
        if not profile.get("allowForms"):
            raise HTTPException(status_code=403, detail="Preenchimento de formularios nao esta autorizado neste perfil.")
        locator = await _target(page, target, input_only=True)
        content = await _credential_value(user, profile, action, page.url) if kind == "credential_fill" else value
        await locator.fill(content, timeout=timeout)
    elif kind == "select":
        if not profile.get("allowForms"):
            raise HTTPException(status_code=403, detail="Alteracao de formularios nao esta autorizada neste perfil.")
        locator = await _target(page, target, input_only=True)
        try:
            await locator.select_option(label=value, timeout=timeout)
        except Exception:
            await locator.select_option(value=value, timeout=timeout)
    elif kind == "press":
        if action.get("riskClass") != "read" and not profile.get("allowForms"):
            raise HTTPException(status_code=403, detail="Confirmacao de formulario nao esta autorizada neste perfil.")
        if target:
            await (await _target(page, target)).press(value or "Enter", timeout=timeout)
        else:
            await page.keyboard.press(value or "Enter")
    elif kind == "wait":
        await page.wait_for_timeout(min(10_000, max(100, int(float(value or "1") * 1000))))
    elif kind == "extract":
        return await _extract(page)
    elif kind == "screenshot":
        return await _save_screenshot(user_id, run_id, page, str(action.get("description") or "captura"))
    elif kind == "download":
        if not profile.get("allowDownloads"):
            raise HTTPException(status_code=403, detail="Downloads nao estao autorizados neste perfil.")
        async with page.expect_download(timeout=timeout) as pending:
            await (await _target(page, target)).click(timeout=timeout)
        return await _save_download(user_id, run_id, await pending.value)
    elif kind == "upload":
        if not profile.get("allowUploads"):
            raise HTTPException(status_code=403, detail="Uploads nao estao autorizados neste perfil.")
        path, artifact = artifact_path(user_id, run_id, str(action.get("artifactId") or ""))
        if artifact.get("kind") != "upload":
            raise HTTPException(status_code=422, detail="Selecione um arquivo enviado para esta execucao.")
        await (await _target(page, target, input_only=True)).set_input_files(str(path), timeout=timeout)
    else:
        raise HTTPException(status_code=422, detail=f'Acao de navegador nao suportada: "{kind}".')
    return None


async def _network_guard(route: Route, allowed_domains: list[str], blocked_domains: list[str], dns_cache: set[str]) -> None:
    from app.modules.intelligence.service import assert_public_dns, validate_public_url

    url = route.request.url
    parsed = urlparse(url)
    if parsed.scheme in {"data", "blob", "about"}:
        await route.continue_()
        return
    if parsed.scheme not in {"http", "https"}:
        await route.abort("blockedbyclient")
        return
    try:
        _, host = validate_public_url(
            url,
            allowed_domains if route.request.resource_type == "document" else None,
            blocked_domains,
        )
        if host not in dns_cache:
            await assert_public_dns(host)
            dns_cache.add(host)
    except HTTPException:
        await route.abort("blockedbyclient")
        return
    await route.continue_()


async def _browser_context(playwright: Playwright, run: dict[str, Any], profile: dict[str, Any]) -> tuple[Any, BrowserContext]:
    browser = await playwright.chromium.launch(headless=True, args=["--disable-dev-shm-usage"])
    storage_state: dict[str, Any] | None = None
    encrypted_state = str(profile.get("encryptedStorageState") or "")
    if profile.get("retainSession") and encrypted_state:
        try:
            decoded = json.loads(decrypt_secret(encrypted_state))
            if isinstance(decoded, dict):
                storage_state = decoded
        except Exception:
            storage_state = None
    context = await browser.new_context(
        accept_downloads=bool(profile.get("allowDownloads")),
        viewport={"width": 1440, "height": 900},
        locale="pt-BR", timezone_id="America/Sao_Paulo", service_workers="block",
        storage_state=storage_state,
    )
    policy = run.get("policySnapshot") if isinstance(run.get("policySnapshot"), dict) else {}
    dns_cache: set[str] = set()
    await context.route(
        "**/*",
        lambda route: _network_guard(
            route, list(policy.get("allowedDomains", [])), list(policy.get("blockedDomains", [])), dns_cache,
        ),
    )
    return browser, context


async def _persist_session(user_id: str, profile_id: str, context: BrowserContext) -> None:
    if not profile_id:
        return
    state = await context.storage_state()

    def mutation(store: dict[str, Any]) -> None:
        profile = next((item for item in store["browserProfiles"] if item.get("id") == profile_id), None)
        if profile and profile.get("retainSession"):
            profile["encryptedStorageState"] = encrypt_secret(json.dumps(state, ensure_ascii=False))
            profile["sessionUpdatedAt"] = now_iso()

    await mutate_store(user_id, mutation)


async def _run_real_browser(user: dict[str, Any], run_id: str, control: BrowserControl) -> dict[str, Any]:
    user_id = str(user.get("id") or "anonymous")
    run = _fresh_run(user_id, run_id)
    store = read_store(user_id)
    stored_profile = next((item for item in store["browserProfiles"] if item.get("id") == run.get("profileId")), None)
    snapshot = run.get("policySnapshot") if isinstance(run.get("policySnapshot"), dict) else {}
    profile = {**(stored_profile or {}), **snapshot}
    actions = list(run.get("plan", []))[: int(run.get("maxSteps") or profile.get("maxActions") or 20)]
    if any(action.get("status") == "completed" and action.get("riskClass") != "read" for action in actions):
        return await _update_run(
            user_id, run_id,
            {"status": "intervention_required", "error": "A sessao foi interrompida depois de uma acao externa. Revise o estado do site antes de continuar."},
            event=("intervention_required", "Retomada automatica bloqueada para evitar repetir uma acao externa."),
        )
    await _update_run(user_id, run_id, {"status": "running", "error": None}, event=("started", "Chromium isolado iniciado."))
    async with async_playwright() as playwright:
        browser, context = await _browser_context(playwright, run, profile)
        page = await context.new_page()
        extracted: list[dict[str, Any]] = []
        stop_live = None
        try:
            stop_live = await start_live(page, _key(user_id, run_id))
            for index, action in enumerate(actions):
                if control.cancelled or _fresh_run(user_id, run_id).get("cancelRequested"):
                    return await _update_run(user_id, run_id, {"status": "cancelled"}, event=("cancelled", "Execucao cancelada pelo operador."))
                await control.pause.wait()
                action_id = str(action.get("id"))
                if action.get("status") == "completed":
                    if action.get("riskClass") == "read" and action.get("type") not in {"extract", "research", "screenshot", "download"}:
                        await _execute_action(user, user_id, run_id, page, profile, action)
                    continue
                fresh_action = next((item for item in _fresh_run(user_id, run_id).get("plan", []) if item.get("id") == action_id), action)
                if fresh_action.get("requiresApproval") and not fresh_action.get("approved"):
                    if page.url != "about:blank":
                        await _save_screenshot(user_id, run_id, page, f"antes-{index + 1}")
                    pending = {
                        "actionId": action_id, "type": fresh_action.get("type"), "target": fresh_action.get("target"),
                        "description": fresh_action.get("description"), "riskClass": fresh_action.get("riskClass"),
                    }
                    control.approval.clear()
                    await _update_run(
                        user_id, run_id, {"status": "awaiting_approval", "pendingApproval": pending, "progress": round(index / max(1, len(actions)) * 100)},
                        event=("approval_required", f'A acao "{fresh_action.get("description")}" aguarda confirmacao imediata.'),
                        action_id=action_id, action_updates={"status": "awaiting_approval"},
                    )
                    await control.approval.wait()
                    approved_action = next((item for item in _fresh_run(user_id, run_id).get("plan", []) if item.get("id") == action_id), {})
                    if not approved_action.get("approved"):
                        return await _update_run(user_id, run_id, {"status": "cancelled"}, event=("rejected", "Acao rejeitada pelo operador."))
                    await _update_run(user_id, run_id, {"status": "running", "pendingApproval": None})
                    fresh_action = approved_action
                await _update_run(
                    user_id, run_id, {"status": "running", "currentStep": index},
                    event=("action_started", f'{index + 1}/{len(actions)} - {fresh_action.get("description")}'),
                    action_id=action_id, action_updates={"status": "running", "startedAt": now_iso()},
                )
                if fresh_action.get("type") == "research":
                    from app.modules.intelligence.browser_research import research_site

                    async def update_research(updates, event):
                        if updates.get("report", {}).get("researchMaterial"):
                            from app.modules.intelligence.browser_reports import save_research_material
                            # Keep full source text outside the overview store polled during navigation.
                            report = dict(updates["report"])
                            material = report.pop("researchMaterial")
                            await asyncio.to_thread(save_research_material, user_id, run_id, material)
                            updates = {**updates, "report": report}
                        return await _update_run(user_id, run_id, updates, event=event)

                    output = await research_site(page, run, profile, control, update_research)
                else:
                    output = await _execute_action(user, user_id, run_id, page, profile, fresh_action)
                if fresh_action.get("type") in {"extract", "research"} and isinstance(output, dict):
                    extracted.append(output)
                await _update_run(
                    user_id, run_id,
                    {"progress": round((index + 1) / max(1, len(actions)) * 100), "lastUrl": page.url},
                    event=("action_completed", f'{index + 1}/{len(actions)} concluida.'),
                    action_id=action_id, action_updates={"status": "completed", "completedAt": now_iso()},
                )
                if run.get("executionMode") == "assisted" and index < len(actions) - 1:
                    control.pause.clear()
                    await _update_run(user_id, run_id, {"status": "paused", "pauseRequested": True}, event=("assisted_pause", "Etapa concluída. Confira o navegador ao vivo antes de continuar."))
                    await control.pause.wait()
            if profile.get("retainSession"):
                await _persist_session(user_id, str(run.get("profileId") or ""), context)
            latest = _fresh_run(user_id, run_id)
            artifacts = [{key: value for key, value in item.items() if key != "path"} for item in latest.get("artifacts", [])]
            last_extract = extracted[-1] if extracted else await _extract(page)
            result = {
                "title": last_extract.get("title") or "Tarefa concluida", "url": page.url,
                "summary": str(last_extract.get("text") or "")[:5000],
                "structuredData": {"links": last_extract.get("links", []), "tables": last_extract.get("tables", [])},
                "actionsPerformed": len([item for item in actions if item.get("status") != "skipped"]),
                "artifacts": artifacts, "readOnly": not any(item.get("riskClass") != "read" for item in actions),
            }
            return await _update_run(
                user_id, run_id, {"status": "completed", "progress": 100, "result": result, "pendingApproval": None},
                event=("completed", "Tarefa executada em navegador real e evidencias registradas."),
            )
        finally:
            if stop_live:
                await stop_live()
            await context.close()
            await browser.close()


async def execute_browser_run(user: dict[str, Any], run_id: str, control: BrowserControl | None = None) -> dict[str, Any]:
    user_id = str(user.get("id") or "anonymous")
    active_control = control or BrowserControl()
    run = _fresh_run(user_id, run_id)
    timeout = min(900, max(30, int(run.get("timeoutSeconds") or 300)))
    async with _SEMAPHORE:
        try:
            return await asyncio.wait_for(_run_real_browser(user, run_id, active_control), timeout=timeout)
        except asyncio.CancelledError:
            return await _update_run(user_id, run_id, {"status": "cancelled"}, event=("cancelled", "Pesquisa cancelada pelo usuário."))
        except asyncio.TimeoutError:
            return await _update_run(user_id, run_id, {"status": "failed", "progress": 100, "error": f"A execucao excedeu o limite de {timeout} segundos."}, event=("timeout", "Sessao encerrada pelo limite de duracao."))
        except HTTPException as exc:
            return await _update_run(user_id, run_id, {"status": "failed", "progress": 100, "error": str(exc.detail)}, event=("failed", str(exc.detail)))
        except Exception as exc:
            message = "O Chromium nao conseguiu concluir esta etapa. Revise o alvo e tente novamente."
            return await _update_run(user_id, run_id, {"status": "failed", "progress": 100, "error": message, "technicalError": type(exc).__name__}, event=("failed", message))


async def queue_browser_run(user: dict[str, Any], run_id: str) -> dict[str, Any]:
    user_id = str(user.get("id") or "anonymous")
    key = _key(user_id, run_id)
    task = _ACTIVE.get(key)
    if task and not task.done():
        return sanitize_run(_fresh_run(user_id, run_id))
    if _fresh_run(user_id, run_id).get("status") in {"completed", "cancelled"}:
        raise HTTPException(409, "Esta execução já terminou. Prepare uma nova pesquisa para executar novamente.")
    control = BrowserControl()
    _CONTROLS[key] = control
    await _update_run(user_id, run_id, {"status": "queued", "cancelRequested": False}, event=("queued", "Execucao adicionada a fila do Chromium."))
    task = asyncio.create_task(execute_browser_run(user, run_id, control), name=f"browser-agent-{run_id}")
    _ACTIVE[key] = task

    def cleanup(_: asyncio.Task[dict[str, Any]]) -> None:
        _ACTIVE.pop(key, None)
        _CONTROLS.pop(key, None)

    task.add_done_callback(cleanup)
    return sanitize_run(_fresh_run(user_id, run_id))


async def control_browser_run(user: dict[str, Any], run_id: str, action: str) -> dict[str, Any]:
    user_id = str(user.get("id") or "anonymous")
    key = _key(user_id, run_id)
    control = _CONTROLS.get(key)
    run = _fresh_run(user_id, run_id)
    if run.get("status") in {"completed", "cancelled", "failed"}:
        return sanitize_run(run)
    if action == "cancel":
        if control:
            control.cancelled = True
            control.pause.set()
            control.approval.set()
        return await _update_run(user_id, run_id, {"cancelRequested": True, "status": "cancelling" if control else "cancelled"}, event=("cancel_requested", "Cancelamento solicitado."))
    if action == "pause":
        if control:
            control.pause.clear()
        return await _update_run(user_id, run_id, {"pauseRequested": True, "status": "paused"}, event=("paused", "Execucao pausada pelo operador."))
    if action == "resume":
        if control:
            control.pause.set()
            return await _update_run(user_id, run_id, {"pauseRequested": False, "status": "running"}, event=("resumed", "Execucao retomada."))
        await _update_run(user_id, run_id, {"pauseRequested": False, "status": "planned"}, event=("resume_queued", "Sessao sera reconstruida com seguranca."))
        return await queue_browser_run(user, run_id)
    raise HTTPException(status_code=400, detail="Controle de execucao invalido.")


async def decide_browser_action(user: dict[str, Any], run_id: str, action_id: str | None, approve: bool, note: str) -> dict[str, Any]:
    user_id = str(user.get("id") or "anonymous")
    run = _fresh_run(user_id, run_id)
    pending = run.get("pendingApproval") if isinstance(run.get("pendingApproval"), dict) else {}
    selected_id = action_id or str(pending.get("actionId") or "")
    if not selected_id:
        raise HTTPException(status_code=409, detail="Nao existe uma acao aguardando aprovacao.")
    action = next((item for item in run.get("plan", []) if item.get("id") == selected_id), None)
    if not action or action.get("status") != "awaiting_approval":
        raise HTTPException(status_code=409, detail="A acao informada nao esta aguardando aprovacao.")
    event_name = "approved" if approve else "rejected"
    status = "running" if approve else "cancelled"
    updated = await _update_run(
        user_id, run_id, {"status": status, "pendingApproval": None, "approvedAt": now_iso(), "approvalNote": note},
        event=(event_name, note or ("Acao aprovada pelo operador." if approve else "Acao rejeitada pelo operador.")),
        action_id=selected_id,
        action_updates={"approved": approve, "status": "pending" if approve else "rejected", "approvalNote": note, "approvedAt": now_iso()},
    )
    control = _CONTROLS.get(_key(user_id, run_id))
    if control:
        if not approve:
            control.cancelled = True
        control.approval.set()
        control.pause.set()
    elif approve:
        updated = await queue_browser_run(user, run_id)
    return updated


async def browser_runtime_health() -> dict[str, Any]:
    """Comprova o Chromium real sem depender da rede externa do provedor."""
    health_document = """<!doctype html>
<html lang="pt-BR">
  <head><meta charset="utf-8"><title>Norium Browser Runtime</title></head>
  <body>
    <button id="proof" type="button" onclick="this.textContent='executed'">pending</button>
  </body>
</html>"""
    health_url = "data:text/html;base64," + base64.b64encode(health_document.encode("utf-8")).decode("ascii")
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(headless=True, args=["--disable-dev-shm-usage"])
        try:
            page = await browser.new_page(viewport={"width": 1024, "height": 768})
            await page.goto(health_url, wait_until="domcontentloaded", timeout=8_000)
            title = await page.title()
            button = page.locator("#proof")
            await button.click(timeout=5_000)
            result = await button.text_content(timeout=5_000)
            if result != "executed":
                raise RuntimeError("Chromium nao confirmou o clique de verificacao.")
            return {
                "ok": True,
                "engine": "chromium",
                "navigation": "isolated_data_document",
                "title": title,
                "interaction": "button_clicked",
                "result": result,
            }
        finally:
            await asyncio.wait_for(browser.close(), timeout=5)
