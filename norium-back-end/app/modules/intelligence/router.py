from __future__ import annotations

from typing import Any

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException

from app.modules.auth.router import current_user
from app.modules.intelligence.repository import mutate_store, now_iso, read_store
from app.modules.intelligence.schemas import (
    BrowserApprovalPayload, BrowserPlanPayload, BrowserProfilePayload, KnowledgeBasePayload,
    KnowledgeSearchPayload, KnowledgeSourcePayload, MarketplaceInstallPayload, MarketplaceUpdatePayload,
    ModelPolicyPayload, ModelProviderPayload, ModelRoutePayload, ModelTestPayload,
)
from app.modules.intelligence.service import (
    MARKETPLACE_CATALOG, all_providers, catalog_item, create_browser_plan, create_browser_profile,
    create_knowledge_base, execute_browser_run, find_item, install_marketplace, route_model,
    sanitize_provider, save_model_policy, save_provider, search_knowledge, tenant_id, test_provider,
    uninstall_marketplace, update_browser_control, usage_summary, add_knowledge_source, reindex_knowledge_source,
)


browser_router = APIRouter(prefix="/api/navegador", tags=["Agente Navegador"])
knowledge_router = APIRouter(prefix="/api/conhecimento", tags=["Conhecimento Empresarial"])
marketplace_router = APIRouter(prefix="/api/marketplace", tags=["Marketplace"])
models_router = APIRouter(prefix="/api/modelos-ia", tags=["IA e Modelos"])


@browser_router.get("")
async def browser_overview(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    store = read_store(tenant_id(user))
    return {"profiles": store["browserProfiles"], "runs": store["browserRuns"][:100]}


@browser_router.post("/profiles")
async def post_browser_profile(payload: BrowserProfilePayload, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    return {"item": await create_browser_profile(user, payload.model_dump())}


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


@browser_router.post("/runs/{run_id}/execute")
async def start_browser_run(run_id: str, background: BackgroundTasks, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    store = read_store(tenant_id(user))
    run = find_item(store["browserRuns"], run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Execucao do navegador nao encontrada.")
    if run.get("requiresApproval") and not run.get("approved"):
        item = await execute_browser_run(user, run_id)
        return {"item": item}
    background.add_task(execute_browser_run, user, run_id)
    return {"item": {**run, "status": "queued"}}


@browser_router.post("/runs/{run_id}/approval")
async def approve_browser_run(run_id: str, payload: BrowserApprovalPayload, background: BackgroundTasks, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    def mutation(store: dict[str, Any]) -> dict[str, Any]:
        run = find_item(store["browserRuns"], run_id)
        if not run:
            raise HTTPException(status_code=404, detail="Execucao do navegador nao encontrada.")
        approved = payload.decision == "approve"
        run.update({"approved": approved, "status": "planned" if approved else "rejected", "approvalNote": payload.note, "approvedAt": now_iso(), "updatedAt": now_iso()})
        run.setdefault("timeline", []).append({"at": now_iso(), "event": "approved" if approved else "rejected", "message": payload.note or ("Aprovado pelo operador." if approved else "Rejeitado pelo operador.")})
        return run
    item = await mutate_store(tenant_id(user), mutation)
    if payload.decision == "approve":
        background.add_task(execute_browser_run, user, run_id)
    return {"item": item}


@browser_router.post("/runs/{run_id}/{action}")
async def control_browser_run(run_id: str, action: str, background: BackgroundTasks, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    item = await update_browser_control(user, run_id, action)
    if action == "resume":
        background.add_task(execute_browser_run, user, run_id)
    return {"item": item}


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
    return search_knowledge(user, payload.query, payload.baseIds, payload.limit)


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


@marketplace_router.delete("/installations/{installation_id}")
async def delete_marketplace_installation(installation_id: str, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    return {"item": await uninstall_marketplace(user, installation_id)}


@models_router.get("")
async def models_overview(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    store = read_store(tenant_id(user))
    return {"providers": [sanitize_provider(item) for item in all_providers(tenant_id(user))], "policies": store["modelPolicies"], "usage": usage_summary(user)}


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
    return route_model(user, payload.model_dump())
