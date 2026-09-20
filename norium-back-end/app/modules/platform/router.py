from __future__ import annotations

import base64
import binascii
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path
import re
from typing import Any
import uuid

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse

try:
    from pypdf import PdfReader
except ImportError:  # Mantem o backend inicializavel ate a dependencia ser instalada.
    PdfReader = None

from app.core.tenant import get_data_root, get_user_db_path, read_json_file, write_json_file
from app.modules.auth.router import (
    can_manage_system,
    can_manage_team,
    current_user,
    find_user,
    read_user_store,
    sanitize_user,
)
from app.modules.inbox.router import record_event
from app.modules.platform.repository import load_store, now_iso
from app.modules.platform.schemas import (
    AbsencePayload,
    ApprovalEvaluationPayload,
    ApprovalRulePayload,
    FormSubmissionPayload,
    HandoffPayload,
    KnowledgePdfPayload,
    KnowledgePayload,
    KnowledgeQueryPayload,
    MeetingPayload,
    OcrPayload,
    PortalInvitePayload,
    PortalRequestPayload,
    PublicFormPayload,
    QuickCapturePayload,
    SignaturePayload,
    SignatureStatusPayload,
    SlaCasePayload,
    SlaPolicyPayload,
    VaultPayload,
    WorkspacePayload,
)
from app.modules.platform.service import (
    account_id,
    calculate_sla_deadline,
    conflict_scan,
    create_collection_item,
    create_workspace,
    delete_collection_item,
    delete_workspace,
    ensure_primary_workspace,
    evaluate_rules,
    generate_handoff,
    list_collection,
    new_portal_token,
    process_capture,
    process_meeting,
    process_ocr,
    quality_scan,
    query_knowledge,
    sanitize_vault_item,
    save_vault_secret,
    tenant_id,
    update_collection_item,
    update_workspace,
)


router = APIRouter(prefix="/api/plataforma", tags=["Plataforma Norium"])


def require_team_manager(user: dict[str, Any]) -> None:
    if not can_manage_team(user):
        raise HTTPException(status_code=403, detail="Somente o lider da equipe pode executar esta acao.")


def require_system_manager(user: dict[str, Any]) -> None:
    if not can_manage_system(user):
        raise HTTPException(status_code=403, detail="Acesso exclusivo do administrador do sistema.")


async def activity(user: dict[str, Any], title: str, description: str, action: str, resource_id: str | None = None) -> None:
    await record_event(
        source="sistema",
        title=title,
        description=description,
        metadata={
            "userId": tenant_id(user),
            "action": action,
            "resourceId": resource_id,
            "workspaceOwnerId": account_id(user),
        },
    )


@router.get("/resumo")
async def platform_summary(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    await ensure_primary_workspace(user)
    workspace_store = await load_store(tenant_id(user))
    account_store = await load_store(account_id(user), account_level=True)
    return {
        "workspaces": len(account_store["workspaces"]),
        "activeAbsences": len([item for item in account_store["absences"] if item.get("active", True)]),
        "portalClients": len(account_store["portalInvites"]),
        "forms": len(workspace_store["forms"]),
        "knowledgeDocuments": len(workspace_store["knowledge"]),
        "pendingSignatures": len(
            [item for item in workspace_store["signatures"] if item.get("status") not in {"signed", "cancelled", "expired"}]
        ),
        "approvalRules": len([item for item in workspace_store["approvalRules"] if item.get("active")]),
        "slaCases": len(workspace_store["slaCases"]),
        "captures": len(workspace_store["captures"]),
        "meetings": len(workspace_store["meetings"]),
        "updatedAt": workspace_store.get("updatedAt"),
    }


@router.get("/empresas")
async def workspaces(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    return {"items": await ensure_primary_workspace(user), "activeId": "primary"}


@router.post("/empresas")
async def post_workspace(payload: WorkspacePayload, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    require_team_manager(user)
    item = await create_workspace(user, payload.model_dump())
    await activity(user, "Empresa adicionada", f"{item['name']} agora possui ambiente isolado no Norium.", "workspace.created", item["id"])
    return {"item": item}


@router.put("/empresas/{workspace_id}")
async def put_workspace(
    workspace_id: str,
    payload: WorkspacePayload,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    require_team_manager(user)
    item = await update_workspace(user, workspace_id, payload.model_dump())
    if not item:
        raise HTTPException(status_code=404, detail="Empresa nao encontrada.")
    return {"item": item}


@router.delete("/empresas/{workspace_id}")
async def remove_workspace(workspace_id: str, user: dict[str, Any] = Depends(current_user)) -> dict[str, bool]:
    require_team_manager(user)
    deleted = await delete_workspace(user, workspace_id)
    if not deleted:
        raise HTTPException(status_code=409, detail="A empresa principal nao pode ser excluida.")
    return {"deleted": True}


@router.get("/ausencias")
async def absences(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    return {"items": await list_collection(user, "absences", account_level=True)}


@router.post("/ausencias")
async def post_absence(payload: AbsencePayload, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    require_team_manager(user)
    item = await create_collection_item(
        user,
        "absences",
        "absence",
        {**payload.model_dump(), "active": True},
        account_level=True,
    )
    await activity(user, "Substituicao programada", f"O membro {item['memberId']} sera substituido no periodo informado.", "absence.created", item["id"])
    return {"item": item}


@router.put("/ausencias/{absence_id}")
async def put_absence(
    absence_id: str,
    payload: AbsencePayload,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    require_team_manager(user)
    item = await update_collection_item(
        user,
        "absences",
        absence_id,
        payload.model_dump(),
        account_level=True,
    )
    if not item:
        raise HTTPException(status_code=404, detail="Ausencia nao encontrada.")
    return {"item": item}


@router.delete("/ausencias/{absence_id}")
async def remove_absence(absence_id: str, user: dict[str, Any] = Depends(current_user)) -> dict[str, bool]:
    require_team_manager(user)
    return {"deleted": await delete_collection_item(user, "absences", absence_id, account_level=True)}


@router.post("/permissoes/simular/{member_id}")
async def simulate_permissions(member_id: str, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    require_team_manager(user)
    store = await read_user_store()
    target = find_user(store, member_id)
    if not target:
        raise HTTPException(status_code=404, detail="Usuario nao encontrado.")
    if not can_manage_system(user) and target.get("teamOwnerId") != user.get("id"):
        raise HTTPException(status_code=403, detail="O usuario nao pertence a sua equipe.")
    return {
        "user": sanitize_user(target),
        "simulatedBy": sanitize_user(user),
    }


@router.get("/portal/convites")
async def portal_invites(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    return {"items": await list_collection(user, "portalInvites", account_level=True)}


@router.post("/portal/convites")
async def create_portal_invite(
    payload: PortalInvitePayload,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    require_team_manager(user)
    item = await create_collection_item(
        user,
        "portalInvites",
        "portal",
        {
            **payload.model_dump(),
            "token": new_portal_token(),
            "active": True,
            "status": "invited",
        },
        account_level=True,
    )
    return {"item": item, "publicPath": f"/portal/{item['token']}"}


def find_public_record(collection: str, field: str, value: str) -> tuple[str, dict[str, Any], dict[str, Any]] | None:
    for path in get_data_root().glob("user_*/plataforma_db.json"):
        payload = read_json_file(path, {})
        if not isinstance(payload, dict):
            continue
        for item in payload.get(collection, []):
            if isinstance(item, dict) and str(item.get(field)) == value:
                return path.parent.name.removeprefix("user_"), payload, item
    return None


def _workspace_path_is_active(path: Path) -> bool:
    workspace_directory = path.parent.name
    if not workspace_directory.startswith("workspace_"):
        return True
    workspace_id = workspace_directory.removeprefix("workspace_")
    for account_path in get_data_root().glob("user_*/plataforma_db.json"):
        account = read_json_file(account_path, {})
        if not isinstance(account, dict):
            continue
        workspace = next(
            (item for item in account.get("workspaces", []) if isinstance(item, dict) and str(item.get("id")) == workspace_id),
            None,
        )
        if workspace is not None:
            return bool(workspace.get("active", False))
    return False


def _find_public_form(token: str) -> tuple[Path, dict[str, Any], dict[str, Any]] | None:
    for path in get_data_root().glob("user_*/**/plataforma_db.json"):
        if not _workspace_path_is_active(path):
            continue
        store = read_json_file(path, {})
        if not isinstance(store, dict):
            continue
        form = next(
            (item for item in store.get("forms", []) if isinstance(item, dict) and item.get("publicToken") == token and item.get("active")),
            None,
        )
        if form:
            return path, store, form
    return None


@router.get("/portal/publico/{token}")
async def public_portal(token: str) -> dict[str, Any]:
    found = find_public_record("portalInvites", "token", token)
    if not found or not found[2].get("active"):
        raise HTTPException(status_code=404, detail="Portal indisponivel.")
    owner_id, store, invite = found
    requests = [item for item in store.get("portalRequests", []) if item.get("portalId") == invite.get("id")]
    safe_invite = {key: value for key, value in invite.items() if key != "token"}
    return {"portal": safe_invite, "requests": requests, "ownerId": owner_id}


@router.post("/portal/publico/{token}/solicitacoes")
async def public_portal_request(token: str, payload: PortalRequestPayload) -> dict[str, Any]:
    found = find_public_record("portalInvites", "token", token)
    if not found or not found[2].get("active"):
        raise HTTPException(status_code=404, detail="Portal indisponivel.")
    owner_id, _store, invite = found
    fake_user = {"id": owner_id}
    item = await create_collection_item(
        fake_user,
        "portalRequests",
        "request",
        {**payload.model_dump(), "portalId": invite["id"], "status": "open"},
        account_level=True,
    )
    return {"item": item}


@router.get("/formularios")
async def forms(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    return {
        "items": await list_collection(user, "forms"),
        "submissions": await list_collection(user, "submissions"),
    }


@router.post("/formularios")
async def post_form(payload: PublicFormPayload, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    item = await create_collection_item(
        user,
        "forms",
        "form",
        {**payload.model_dump(), "publicToken": new_portal_token()},
    )
    return {"item": item, "publicPath": f"/formulario/{item['publicToken']}"}


@router.put("/formularios/{form_id}")
async def put_form(
    form_id: str,
    payload: PublicFormPayload,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    item = await update_collection_item(user, "forms", form_id, payload.model_dump())
    if not item:
        raise HTTPException(status_code=404, detail="Formulario nao encontrado.")
    return {"item": item}


@router.delete("/formularios/{form_id}")
async def remove_form(form_id: str, user: dict[str, Any] = Depends(current_user)) -> dict[str, bool]:
    return {"deleted": await delete_collection_item(user, "forms", form_id)}


@router.get("/formularios/publico/{token}")
async def public_form(token: str) -> dict[str, Any]:
    found = _find_public_form(token)
    if found:
        return {"form": found[2]}
    raise HTTPException(status_code=404, detail="Formulario indisponivel.")


@router.post("/formularios/publico/{token}/respostas")
async def submit_public_form(token: str, payload: FormSubmissionPayload) -> dict[str, Any]:
    found = _find_public_form(token)
    if found:
        path, store, form = found
        timestamp = now_iso()
        item = {
            "id": f"submission_{uuid.uuid4().hex[:12]}",
            **payload.model_dump(),
            "formId": form["id"],
            "destination": form.get("destination"),
            "status": "received",
            "createdAt": timestamp,
            "updatedAt": timestamp,
        }
        submissions = store.setdefault("submissions", [])
        if not isinstance(submissions, list):
            submissions = []
            store["submissions"] = submissions
        submissions.insert(0, item)
        store["updatedAt"] = timestamp
        write_json_file(path, store)
        return {"item": item, "message": form.get("successMessage")}
    raise HTTPException(status_code=404, detail="Formulario indisponivel.")


@router.get("/conhecimento")
async def knowledge(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    items = await list_collection(user, "knowledge")
    return {"items": [{key: value for key, value in item.items() if key != "storedPath"} for item in items]}


@router.post("/conhecimento")
async def post_knowledge(payload: KnowledgePayload, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    return {"item": await create_collection_item(user, "knowledge", "knowledge", payload.model_dump())}


@router.post("/conhecimento/pdf")
async def upload_knowledge_pdf(
    payload: KnowledgePdfPayload,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    if PdfReader is None:
        raise HTTPException(status_code=503, detail="Leitor de PDF indisponivel. Instale a dependencia pypdf.")
    try:
        encoded = payload.dataUrl.split(",", 1)[1] if "," in payload.dataUrl else payload.dataUrl
        pdf_bytes = base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error) as exc:
        raise HTTPException(status_code=422, detail="O PDF enviado esta corrompido ou em formato invalido.") from exc
    if len(pdf_bytes) > 12 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="O PDF deve ter no maximo 12 MB.")
    if not pdf_bytes.startswith(b"%PDF"):
        raise HTTPException(status_code=422, detail="O arquivo enviado nao e um PDF valido.")

    try:
        reader = PdfReader(BytesIO(pdf_bytes))
        if len(reader.pages) > 200:
            raise HTTPException(status_code=413, detail="O PDF deve ter no maximo 200 paginas.")
        extracted = "\n\n".join((page.extract_text() or "").strip() for page in reader.pages).strip()
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=422, detail="Nao foi possivel ler o conteudo deste PDF.") from exc
    if len(extracted) < 2:
        raise HTTPException(
            status_code=422,
            detail="Este PDF nao possui texto pesquisavel. Envie uma versao com OCR para indexacao.",
        )

    safe_name = re.sub(r"[^a-zA-Z0-9._-]+", "_", Path(payload.fileName).name).strip("._") or "documento.pdf"
    file_id = f"knowledge_{uuid.uuid4().hex[:12]}"
    directory = Path(get_user_db_path(tenant_id(user), "platform")).parent / "knowledge_files"
    directory.mkdir(parents=True, exist_ok=True)
    stored_path = directory / f"{file_id}_{safe_name}"
    stored_path.write_bytes(pdf_bytes)

    item = await create_collection_item(
        user,
        "knowledge",
        "knowledge",
        {
            "title": payload.title.strip() or Path(safe_name).stem,
            "content": extracted[:100_000],
            "sourceUrl": f"/api/plataforma/conhecimento/{file_id}/arquivo",
            "tags": payload.tags,
            "visibility": payload.visibility,
            "sourceType": "pdf",
            "fileName": safe_name,
            "storedPath": str(stored_path),
            "pageCount": len(reader.pages),
            "characterCount": len(extracted),
        },
        item_id=file_id,
    )
    await activity(
        user,
        "PDF adicionado a base de conhecimento",
        f"{item['title']}: {len(reader.pages)} pagina(s) indexadas para consulta da Nora.",
        "knowledge.pdf_uploaded",
        item["id"],
    )
    return {"item": {key: value for key, value in item.items() if key != "storedPath"}}


@router.get("/conhecimento/{document_id}/arquivo")
async def download_knowledge_pdf(
    document_id: str,
    user: dict[str, Any] = Depends(current_user),
):
    item = next((entry for entry in await list_collection(user, "knowledge") if str(entry.get("id")) == document_id), None)
    if not item or item.get("sourceType") != "pdf":
        raise HTTPException(status_code=404, detail="PDF nao encontrado.")
    path = Path(str(item.get("storedPath") or "")).resolve()
    allowed_root = (Path(get_user_db_path(tenant_id(user), "platform")).parent / "knowledge_files").resolve()
    if not path.is_file() or allowed_root not in path.parents:
        raise HTTPException(status_code=404, detail="Arquivo do PDF nao encontrado.")
    return FileResponse(path, media_type="application/pdf", filename=str(item.get("fileName") or "documento.pdf"))


@router.put("/conhecimento/{document_id}")
async def put_knowledge(
    document_id: str,
    payload: KnowledgePayload,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    item = await update_collection_item(user, "knowledge", document_id, payload.model_dump())
    if not item:
        raise HTTPException(status_code=404, detail="Documento nao encontrado.")
    return {"item": item}


@router.delete("/conhecimento/{document_id}")
async def remove_knowledge(document_id: str, user: dict[str, Any] = Depends(current_user)) -> dict[str, bool]:
    item = next((entry for entry in await list_collection(user, "knowledge") if str(entry.get("id")) == document_id), None)
    if item and item.get("sourceType") == "pdf":
        path = Path(str(item.get("storedPath") or "")).resolve()
        allowed_root = (Path(get_user_db_path(tenant_id(user), "platform")).parent / "knowledge_files").resolve()
        if path.is_file() and allowed_root in path.parents:
            path.unlink()
    return {"deleted": await delete_collection_item(user, "knowledge", document_id)}


@router.post("/conhecimento/consultar")
async def consult_knowledge(
    payload: KnowledgeQueryPayload,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    return await query_knowledge(user, payload.query, payload.limit)


@router.get("/assinaturas")
async def signatures(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    return {"items": await list_collection(user, "signatures")}


@router.post("/assinaturas")
async def post_signature(payload: SignaturePayload, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    data = payload.model_dump()
    data["status"] = "sent" if data["provider"] == "manual" else "draft"
    data["providerConfigured"] = data["provider"] == "manual"
    item = await create_collection_item(user, "signatures", "signature", data)
    await activity(user, "Documento enviado para assinatura", item["title"], "signature.created", item["id"])
    return {"item": item}


@router.patch("/assinaturas/{signature_id}/status")
async def patch_signature_status(
    signature_id: str,
    payload: SignatureStatusPayload,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    item = await update_collection_item(
        user,
        "signatures",
        signature_id,
        {"status": payload.status, "completedAt": now_iso() if payload.status == "signed" else None},
    )
    if not item:
        raise HTTPException(status_code=404, detail="Assinatura nao encontrada.")
    return {"item": item}


@router.get("/regras-aprovacao")
async def approval_rules(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    return {"items": await list_collection(user, "approvalRules")}


@router.post("/regras-aprovacao")
async def post_approval_rule(
    payload: ApprovalRulePayload,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    require_team_manager(user)
    return {"item": await create_collection_item(user, "approvalRules", "rule", payload.model_dump())}


@router.put("/regras-aprovacao/{rule_id}")
async def put_approval_rule(
    rule_id: str,
    payload: ApprovalRulePayload,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    require_team_manager(user)
    item = await update_collection_item(user, "approvalRules", rule_id, payload.model_dump())
    if not item:
        raise HTTPException(status_code=404, detail="Regra nao encontrada.")
    return {"item": item}


@router.delete("/regras-aprovacao/{rule_id}")
async def remove_approval_rule(rule_id: str, user: dict[str, Any] = Depends(current_user)) -> dict[str, bool]:
    require_team_manager(user)
    return {"deleted": await delete_collection_item(user, "approvalRules", rule_id)}


@router.post("/regras-aprovacao/avaliar")
async def evaluate_approval_rules(
    payload: ApprovalEvaluationPayload,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    rules = await list_collection(user, "approvalRules")
    matched = evaluate_rules(rules, payload.resource, payload.data)
    return {
        "requiresApproval": bool(matched),
        "rules": matched,
        "approverIds": sorted({approver for rule in matched for approver in rule.get("approverIds", [])}),
    }


@router.get("/cofre")
async def vault(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    require_team_manager(user)
    return {"items": [sanitize_vault_item(item) for item in await list_collection(user, "vault", account_level=True)]}


@router.post("/cofre")
async def post_vault(payload: VaultPayload, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    require_team_manager(user)
    return {"item": await save_vault_secret(user, payload.model_dump())}


@router.post("/cofre/{credential_id}/testar")
async def test_vault(credential_id: str, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    require_team_manager(user)
    items = await list_collection(user, "vault", account_level=True)
    credential = next((item for item in items if item.get("id") == credential_id), None)
    if not credential:
        raise HTTPException(status_code=404, detail="Credencial nao encontrada.")
    expires_at = credential.get("expiresAt")
    expired = bool(expires_at and str(expires_at) < datetime.now(timezone.utc).date().isoformat())
    status = "expired" if expired else "stored"
    item = await update_collection_item(
        user,
        "vault",
        credential_id,
        {"lastTestStatus": status, "lastTestedAt": now_iso()},
        account_level=True,
    )
    return {"item": sanitize_vault_item(item or {}), "connected": not expired}


@router.delete("/cofre/{credential_id}")
async def remove_vault(credential_id: str, user: dict[str, Any] = Depends(current_user)) -> dict[str, bool]:
    require_team_manager(user)
    return {"deleted": await delete_collection_item(user, "vault", credential_id, account_level=True)}


@router.get("/sla")
async def sla(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    return {
        "policies": await list_collection(user, "slaPolicies"),
        "cases": await list_collection(user, "slaCases"),
    }


@router.post("/sla/politicas")
async def post_sla_policy(payload: SlaPolicyPayload, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    require_team_manager(user)
    return {"item": await create_collection_item(user, "slaPolicies", "sla_policy", payload.model_dump())}


@router.put("/sla/politicas/{policy_id}")
async def put_sla_policy(
    policy_id: str,
    payload: SlaPolicyPayload,
    user: dict[str, Any] = Depends(current_user),
) -> dict[str, Any]:
    require_team_manager(user)
    item = await update_collection_item(user, "slaPolicies", policy_id, payload.model_dump())
    if not item:
        raise HTTPException(status_code=404, detail="Politica nao encontrada.")
    return {"item": item}


@router.delete("/sla/politicas/{policy_id}")
async def remove_sla_policy(policy_id: str, user: dict[str, Any] = Depends(current_user)) -> dict[str, bool]:
    require_team_manager(user)
    return {"deleted": await delete_collection_item(user, "slaPolicies", policy_id)}


@router.post("/sla/casos")
async def post_sla_case(payload: SlaCasePayload, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    policies = await list_collection(user, "slaPolicies")
    policy = next((item for item in policies if item.get("id") == payload.policyId), None)
    if not policy:
        raise HTTPException(status_code=404, detail="Politica de SLA nao encontrada.")
    created_at = now_iso()
    item = await create_collection_item(
        user,
        "slaCases",
        "sla_case",
        {
            **payload.model_dump(),
            "status": "running",
            "startedAt": created_at,
            "deadlineAt": calculate_sla_deadline(created_at, int(policy["responseMinutes"])),
        },
    )
    return {"item": item}


@router.get("/qualidade")
async def data_quality(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    return await quality_scan(user)


@router.get("/conflitos")
async def conflicts(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    return await conflict_scan(user)


@router.post("/captura")
async def quick_capture(payload: QuickCapturePayload, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    result = await process_capture(user, payload.model_dump())
    await activity(user, "Captura processada", f"Destino sugerido: {result['suggestion']['destination']}.", "capture.processed", result["capture"]["id"])
    return result


@router.post("/ocr")
async def ocr(payload: OcrPayload, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    result = await process_ocr(user, payload.model_dump())
    await record_event(
        source="financeiro",
        title="Documento financeiro analisado",
        description=result["message"],
        metadata={"userId": tenant_id(user), "action": "finance.ocr", "confidence": result["extracted"].get("confidence")},
    )
    return result


@router.post("/reunioes/transcrever")
async def transcribe_meeting(payload: MeetingPayload, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    result = await process_meeting(user, payload.model_dump())
    await activity(user, "Reuniao analisada", payload.title, "meeting.transcribed", result["meeting"]["id"])
    return result


@router.get("/passagens-turno")
async def handoffs(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    return {"items": await list_collection(user, "handoffs")}


@router.post("/passagens-turno")
async def create_handoff(payload: HandoffPayload, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    item = await generate_handoff(user, payload.note, payload.nextOperatorId)
    await activity(user, "Passagem de turno preparada", f"{item['openTasks']} tarefa(s) aberta(s) e {item['slaRisks']} risco(s) de SLA.", "handoff.created", item["id"])
    return {"item": item}
