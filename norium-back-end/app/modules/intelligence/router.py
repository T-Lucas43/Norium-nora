from __future__ import annotations

import asyncio
from contextlib import suppress
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import Response

from app.modules.auth.router import assert_route_permissions, assert_workspace_access, can_manage_team, current_user, user_from_websocket_ticket
from app.core.request_context import reset_request_context, set_request_context
from app.modules.intelligence.browser_live import FEEDS, live_key
from app.modules.intelligence.browser_reports import get_report, report_pdf, rewrite_report, update_report
from app.modules.intelligence.browser_runtime import (
    ACTIVE_BROWSER_LIMIT, artifact_path, control_browser_run, decide_browser_action, queue_browser_run,
    sanitize_profile, sanitize_run, store_uploaded_artifact,
)
from app.modules.intelligence.repository import mutate_store, now_iso, read_store
from app.modules.intelligence.schemas import (
    BrowserApprovalPayload, BrowserCredentialPayload, BrowserPlanActionsPayload, BrowserPlanPayload, BrowserProfilePayload, BrowserUploadPayload, BrowserReportPayload, BrowserReportRewritePayload, KnowledgeBasePayload,
    KnowledgeSearchPayload, KnowledgeSourcePayload, MarketplaceInstallPayload, MarketplaceStatePayload, MarketplaceUpdatePayload,
    ModelPolicyPayload, ModelProviderPayload, ModelRoutePayload, ModelTestPayload,
)
from app.modules.intelligence.service import (
    MARKETPLACE_CATALOG, all_providers, catalog_item, create_browser_credential, create_browser_plan, create_browser_profile,
    create_knowledge_base, find_item, install_marketplace, replace_browser_plan_actions, route_model,
    sanitize_provider, save_model_policy, save_provider, search_knowledge, set_marketplace_enabled, tenant_id, test_provider,
    uninstall_marketplace, usage_summary, add_knowledge_source, reindex_knowledge_source,
)
from app.modules.platform.service import delete_collection_item, list_collection, sanitize_vault_item


browser_router = APIRouter(prefix="/api/navegador", tags=["Agente Navegador"])
knowledge_router = APIRouter(prefix="/api/conhecimento", tags=["Conhecimento Empresarial"])
marketplace_router = APIRouter(prefix="/api/marketplace", tags=["Marketplace"])
models_router = APIRouter(prefix="/api/modelos-ia", tags=["IA e Modelos"])


@browser_router.get("")
async def browser_overview(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    store = read_store(tenant_id(user))
    credentials = []
    if can_manage_team(user):
        credentials = [
            sanitize_vault_item(item) for item in await list_collection(user, "vault", account_level=True)
            if str(item.get("integration") or "").startswith("browser:")
        ]
    return {
        "profiles": [sanitize_profile(item) for item in store["browserProfiles"]],
        "runs": [sanitize_run(item) for item in store["browserRuns"][:100]],
        "credentials": credentials,
        "runtime": {"engine": "playwright-chromium", "realBrowser": True, "maxConcurrency": ACTIVE_BROWSER_LIMIT},
    }


@browser_router.post("/profiles")
async def post_browser_profile(payload: BrowserProfilePayload, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    if payload.credentialIds and not can_manage_team(user):
        raise HTTPException(status_code=403, detail="Somente o responsavel da equipe pode vincular credenciais.")
    if payload.credentialIds:
        browser_credentials = {
            str(item.get("id")) for item in await list_collection(user, "vault", account_level=True)
            if str(item.get("integration") or "").startswith("browser:")
        }
        if any(credential_id not in browser_credentials for credential_id in payload.credentialIds):
            raise HTTPException(status_code=422, detail="Um dos IDs nao pertence a uma credencial do Agente Navegador.")
    return {"item": sanitize_profile(await create_browser_profile(user, payload.model_dump()))}


@browser_router.post("/credentials")
async def post_browser_credential(payload: BrowserCredentialPayload, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    if not can_manage_team(user):
        raise HTTPException(status_code=403, detail="Somente o responsavel da equipe pode cadastrar credenciais.")
    return {"item": await create_browser_credential(user, payload.model_dump())}


@browser_router.delete("/credentials/{credential_id}")
async def delete_browser_credential(credential_id: str, user: dict[str, Any] = Depends(current_user)) -> dict[str, bool]:
    if not can_manage_team(user):
        raise HTTPException(status_code=403, detail="Somente o responsavel da equipe pode revogar credenciais.")
    credentials = await list_collection(user, "vault", account_level=True)
    item = find_item(credentials, credential_id)
    if not item or not str(item.get("integration") or "").startswith("browser:"):
        raise HTTPException(status_code=404, detail="Credencial de navegador nao encontrada.")
    deleted = await delete_collection_item(user, "vault", credential_id, account_level=True)
    return {"deleted": deleted}


@browser_router.delete("/profiles/{profile_id}")
async def delete_browser_profile(profile_id: str, user: dict[str, Any] = Depends(current_user)) -> dict[str, bool]:
    def mutation(store: dict[str, Any]) -> bool:
        before = len(store["browserProfiles"])
        store["browserProfiles"] = [item for item in store["browserProfiles"] if item.get("id") != profile_id]
        return len(store["browserProfiles"]) != before
    return {"deleted": await mutate_store(tenant_id(user), mutation)}


@browser_router.post("/runs/plan")
async def plan_browser_run(payload: BrowserPlanPayload, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    return {"item": await create_browser_plan(user, payload.model_dump())}


@browser_router.put("/runs/{run_id}/plan")
async def put_browser_run_plan(run_id: str, payload: BrowserPlanActionsPayload, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    return {"item": sanitize_run(await replace_browser_plan_actions(user, run_id, [item.model_dump() for item in payload.actions]))}


@browser_router.put("/runs/{run_id}/research-plan")
async def edit_research_plan(run_id: str, payload: BrowserPlanPayload, user: dict[str, Any] = Depends(current_user)) -> dict:
    return {"item": sanitize_run(await create_browser_plan(user, payload.model_dump(), replace_id=run_id))}


@browser_router.get("/runs/{run_id}/report")
async def read_browser_report(run_id: str, user: dict[str, Any] = Depends(current_user)) -> dict:
    return {"item": get_report(tenant_id(user), run_id)}


@browser_router.put("/runs/{run_id}/report")
async def edit_browser_report(run_id: str, payload: BrowserReportPayload, user: dict[str, Any] = Depends(current_user)) -> dict:
    return {"item": await update_report(tenant_id(user), run_id, payload.model_dump())}


@browser_router.get("/runs/{run_id}/report/pdf")
async def browser_report_pdf(run_id: str, user: dict[str, Any] = Depends(current_user)) -> Response:
    content = await asyncio.to_thread(report_pdf, get_report(tenant_id(user), run_id))
    return Response(content, media_type="application/pdf", headers={"Content-Disposition": 'inline; filename="pesquisa-norium.pdf"', "Cache-Control": "no-store"})


@browser_router.post("/runs/{run_id}/report/rewrite")
async def rewrite_browser_report(run_id: str, payload: BrowserReportRewritePayload, user: dict[str, Any] = Depends(current_user)) -> dict:
    return {"item": await rewrite_report(tenant_id(user), run_id, payload.revision, payload.instruction)}


@browser_router.websocket("/runs/{run_id}/live")
async def browser_live(websocket: WebSocket, run_id: str, ticket: str = "", workspace: str = "primary") -> None:
    tokens = set_request_context("browser-live", workspace)
    feed = None
    receiver = None
    queue: asyncio.Queue[bytes | None] = asyncio.Queue(maxsize=1)
    try:
        try:
            user = await user_from_websocket_ticket(ticket)
            assert_route_permissions(user, "/api/navegador")
            await assert_workspace_access(user, Request({"type": "http", "headers": [(b"x-norium-workspace", workspace.encode("utf-8"))]}))
            if not find_item(read_store(tenant_id(user))["browserRuns"], run_id):
                raise HTTPException(404, "Pesquisa não encontrada.")
        except HTTPException:
            await websocket.close(code=4401)
            return
        await websocket.accept()
        key = live_key(tenant_id(user), run_id)
        # The browser may still be queued when the viewer connects.
        for _ in range(120):
            feed = FEEDS.get(key)
            if feed:
                break
            run = find_item(read_store(tenant_id(user))["browserRuns"], run_id)
            if not run or run.get("status") not in {"queued", "running", "paused", "awaiting_approval", "awaiting_login"}:
                await websocket.send_json({"type": "ended"})
                return
            await websocket.send_json({"type": "waiting"})
            await asyncio.sleep(1)
        if not feed:
            return
        if len(feed.viewers) >= 4:
            await websocket.close(code=4429)
            return
        feed.viewers.add(queue)
        if feed.frame:
            queue.put_nowait(feed.frame)
        async def receive_input():
            import json
            from app.modules.intelligence.browser_runtime import browser_login_input

            while True:
                value = await websocket.receive_text()
                if len(value) > 12_000:
                    await websocket.close(code=4400)
                    return
                try:
                    payload = json.loads(value)
                    if not isinstance(payload, dict):
                        raise ValueError
                    await browser_login_input(tenant_id(user), run_id, payload)
                except (ValueError, HTTPException):
                    await websocket.send_json({"type": "input_error", "message": "A interação está disponível somente durante o login solicitado pelo agente."})
                except Exception:
                    await websocket.send_json({"type": "input_error", "message": "Não foi possível interagir com a página. Aguarde o carregamento e tente novamente."})
        receiver = asyncio.create_task(receive_input())
        while True:
            if receiver.done():
                break
            try:
                frame = await asyncio.wait_for(queue.get(), timeout=10)
            except asyncio.TimeoutError:
                await websocket.send_json({"type": "heartbeat"})
                continue
            if frame is None:
                await websocket.send_json({"type": "ended"})
                break
            await asyncio.wait_for(websocket.send_bytes(frame), timeout=5)
    except (WebSocketDisconnect, RuntimeError, asyncio.TimeoutError):
        pass
    finally:
        if receiver:
            receiver.cancel()
            with suppress(asyncio.CancelledError, WebSocketDisconnect, RuntimeError):
                await receiver
        if feed:
            feed.viewers.discard(queue)
        with suppress(RuntimeError, WebSocketDisconnect):
            await websocket.close()
        reset_request_context(tokens)


@browser_router.post("/runs/{run_id}/execute")
async def start_browser_run(run_id: str, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    store = read_store(tenant_id(user))
    run = find_item(store["browserRuns"], run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Execucao do navegador nao encontrada.")
    return {"item": await queue_browser_run(user, run_id)}


@browser_router.post("/runs/{run_id}/approval")
async def approve_browser_run(run_id: str, payload: BrowserApprovalPayload, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    item = await decide_browser_action(user, run_id, payload.actionId, payload.decision == "approve", payload.note)
    return {"item": item}


@browser_router.post("/runs/{run_id}/uploads")
async def upload_browser_file(run_id: str, payload: BrowserUploadPayload, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    return {"item": await store_uploaded_artifact(tenant_id(user), run_id, payload.fileName, payload.mimeType, payload.dataUrl)}


@browser_router.get("/runs/{run_id}/artifacts/{artifact_id}")
async def get_browser_artifact(run_id: str, artifact_id: str, user: dict[str, Any] = Depends(current_user)) -> Response:
    path, artifact = artifact_path(tenant_id(user), run_id, artifact_id)
    from app.infrastructure.persistence import files as persistent_files
    filename = str(artifact.get("name") or path.name).replace('"', "")
    return Response(persistent_files.read(path), media_type=str(artifact.get("mimeType") or "application/octet-stream"),
                    headers={"Content-Disposition": f'attachment; filename="{filename}"', "Cache-Control": "private, no-store"})


@browser_router.post("/runs/{run_id}/pause")
async def pause_browser_run(run_id: str, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    return {"item": await control_browser_run(user, run_id, "pause")}


@browser_router.post("/runs/{run_id}/resume")
async def resume_browser_run(run_id: str, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    return {"item": await control_browser_run(user, run_id, "resume")}


@browser_router.post("/runs/{run_id}/cancel")
async def cancel_browser_run(run_id: str, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    return {"item": await control_browser_run(user, run_id, "cancel")}


@knowledge_router.get("")
async def knowledge_overview(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    store = read_store(tenant_id(user))
    sources = [{key: value for key, value in item.items() if key not in {"content", "chunks"}} | {"chunkCount": len(item.get("chunks", []))} for item in store["knowledgeSources"]]
    return {"bases": store["knowledgeBases"], "sources": sources}


@knowledge_router.post("/bases")
async def post_knowledge_base(payload: KnowledgeBasePayload, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    return {"item": await create_knowledge_base(user, payload.model_dump())}


@knowledge_router.put("/bases/{base_id}")
async def put_knowledge_base(base_id: str, payload: KnowledgeBasePayload, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    def mutation(store: dict[str, Any]) -> dict[str, Any]:
        item = find_item(store["knowledgeBases"], base_id)
        if not item:
            raise HTTPException(status_code=404, detail="Base de conhecimento nao encontrada.")
        item.update({**payload.model_dump(), "updatedAt": now_iso()})
        return item
    return {"item": await mutate_store(tenant_id(user), mutation)}


@knowledge_router.delete("/bases/{base_id}")
async def delete_knowledge_base(base_id: str, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    def mutation(store: dict[str, Any]) -> dict[str, Any]:
        item = find_item(store["knowledgeBases"], base_id)
        if not item:
            raise HTTPException(status_code=404, detail="Base de conhecimento nao encontrada.")
        removed_sources = len([source for source in store["knowledgeSources"] if source.get("baseId") == base_id])
        store["knowledgeBases"] = [base for base in store["knowledgeBases"] if base.get("id") != base_id]
        store["knowledgeSources"] = [source for source in store["knowledgeSources"] if source.get("baseId") != base_id]
        return {"deleted": True, "removedSources": removed_sources}
    return await mutate_store(tenant_id(user), mutation)


@knowledge_router.post("/bases/{base_id}/sources")
async def post_knowledge_source(base_id: str, payload: KnowledgeSourcePayload, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    return {"item": await add_knowledge_source(user, base_id, payload.model_dump())}


@knowledge_router.delete("/sources/{source_id}")
async def delete_knowledge_source(source_id: str, user: dict[str, Any] = Depends(current_user)) -> dict[str, bool]:
    def mutation(store: dict[str, Any]) -> bool:
        source = find_item(store["knowledgeSources"], source_id)
        if not source:
            return False
        store["knowledgeSources"] = [item for item in store["knowledgeSources"] if item.get("id") != source_id]
        base = find_item(store["knowledgeBases"], str(source.get("baseId") or ""))
        if base:
            base["sourceCount"] = max(0, int(base.get("sourceCount") or 0) - 1)
            base["chunkCount"] = max(0, int(base.get("chunkCount") or 0) - len(source.get("chunks", [])))
        return True
    return {"deleted": await mutate_store(tenant_id(user), mutation)}


@knowledge_router.post("/sources/{source_id}/reindex")
async def post_knowledge_reindex(source_id: str, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    return {"item": await reindex_knowledge_source(user, source_id)}


@knowledge_router.post("/sources/{source_id}/stale")
async def post_knowledge_stale(source_id: str, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    def mutation(store: dict[str, Any]) -> dict[str, Any]:
        item = find_item(store["knowledgeSources"], source_id)
        if not item:
            raise HTTPException(status_code=404, detail="Fonte nao encontrada.")
        item["stale"] = True
        item["updatedAt"] = now_iso()
        return {key: value for key, value in item.items() if key not in {"content", "chunks"}} | {"chunkCount": len(item.get("chunks", []))}
    return {"item": await mutate_store(tenant_id(user), mutation)}


@knowledge_router.post("/search")
async def post_knowledge_search(payload: KnowledgeSearchPayload, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    from app.modules.intelligence.service import search_knowledge_semantic
    return await search_knowledge_semantic(user, payload.query, payload.baseIds, payload.limit)


@marketplace_router.get("")
async def marketplace_overview(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    return {"catalog": MARKETPLACE_CATALOG, "installations": read_store(tenant_id(user))["installations"]}


@marketplace_router.get("/{item_id}")
async def marketplace_detail(item_id: str, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    item = catalog_item(item_id)
    if not item:
        raise HTTPException(status_code=404, detail="Item do marketplace nao encontrado.")
    return {"item": item, "installation": next((entry for entry in read_store(tenant_id(user))["installations"] if entry.get("catalogId") == item_id and entry.get("status") == "installed"), None)}


@marketplace_router.post("/{item_id}/install")
async def post_marketplace_install(item_id: str, payload: MarketplaceInstallPayload, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    return {"item": await install_marketplace(user, item_id, payload.confirm, payload.version)}


@marketplace_router.post("/installations/{installation_id}/update")
async def update_marketplace_installation(installation_id: str, payload: MarketplaceUpdatePayload, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    if not payload.confirm:
        raise HTTPException(status_code=409, detail="Confirme a atualizacao depois de revisar permissoes.")
    def mutation(store: dict[str, Any]) -> dict[str, Any]:
        item = find_item(store["installations"], installation_id)
        if not item:
            raise HTTPException(status_code=404, detail="Instalacao nao encontrada.")
        catalog = catalog_item(str(item.get("catalogId") or ""))
        if catalog:
            item["version"] = catalog["version"]
        item["updatedAt"] = now_iso()
        return item
    return {"item": await mutate_store(tenant_id(user), mutation)}


@marketplace_router.patch("/installations/{installation_id}")
async def patch_marketplace_installation(
    installation_id: str,
    payload: MarketplaceStatePayload,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    return {"item": await set_marketplace_enabled(user, installation_id, payload.enabled)}


@marketplace_router.delete("/installations/{installation_id}")
async def delete_marketplace_installation(installation_id: str, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    return {"item": await uninstall_marketplace(user, installation_id)}


@models_router.get("")
async def models_overview(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    def snapshot():
        store = read_store(tenant_id(user))
        return {"providers": [sanitize_provider(item) for item in all_providers(tenant_id(user))], "policies": store["modelPolicies"], "usage": usage_summary(user)}
    return await asyncio.to_thread(snapshot)


@models_router.post("/providers")
async def post_model_provider(payload: ModelProviderPayload, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    return {"item": await save_provider(user, payload.model_dump())}


@models_router.put("/providers/{provider_id}")
async def put_model_provider(provider_id: str, payload: ModelProviderPayload, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    return {"item": await save_provider(user, payload.model_dump(), provider_id)}


@models_router.post("/providers/{provider_id}/test")
async def post_model_test(provider_id: str, payload: ModelTestPayload, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    return await test_provider(user, provider_id, payload.timeoutSeconds)


@models_router.post("/policies")
async def post_model_policy(payload: ModelPolicyPayload, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    return {"item": await save_model_policy(user, payload.model_dump())}


@models_router.put("/policies/{policy_id}")
async def put_model_policy(policy_id: str, payload: ModelPolicyPayload, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    return {"item": await save_model_policy(user, payload.model_dump(), policy_id)}


@models_router.post("/route")
async def post_model_route(payload: ModelRoutePayload, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    return await asyncio.to_thread(route_model, user, payload.model_dump())
