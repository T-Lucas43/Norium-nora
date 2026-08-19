from __future__ import annotations

import base64
import hashlib
import json
import re
import secrets
import unicodedata
import uuid
from datetime import date, datetime, timedelta, timezone
from typing import Any, Iterable

from cryptography.fernet import Fernet

from app.core.security import auth_secret
from app.core.tenant import read_user_db
from app.modules.platform.repository import load_store, mutate_store, now_iso
from app.services.finance_store import create_lancamento, list_finance
from app.services.task_store import list_tasks


def entity_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex}"


def normalize_text(value: Any) -> str:
    text = unicodedata.normalize("NFKD", str(value or ""))
    return "".join(char for char in text if not unicodedata.combining(char)).lower().strip()


def account_id(user: dict[str, Any]) -> str:
    return str(user.get("teamOwnerId") or user.get("id") or "lucas123")


def tenant_id(user: dict[str, Any]) -> str:
    return str(user.get("id") or "lucas123")


def _workspace_seed(user: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": "primary",
        "name": str(user.get("name") or "Empresa principal"),
        "legalName": "",
        "document": "",
        "domain": "",
        "logoUrl": "",
        "primaryColor": "#1677ff",
        "accentColor": "#22d3ee",
        "emailSignature": "",
        "reportFooter": "",
        "ownerId": account_id(user),
        "active": True,
        "createdAt": now_iso(),
        "updatedAt": now_iso(),
    }


async def ensure_primary_workspace(user: dict[str, Any]) -> list[dict[str, Any]]:
    owner_id = account_id(user)

    def mutation(store: dict[str, Any]) -> list[dict[str, Any]]:
        workspaces = store["workspaces"]
        if not any(item.get("id") == "primary" for item in workspaces):
            workspaces.insert(0, _workspace_seed(user))
        return list(workspaces)

    return await mutate_store(owner_id, mutation, account_level=True)


async def create_workspace(user: dict[str, Any], payload: dict[str, Any]) -> dict[str, Any]:
    owner_id = account_id(user)

    def mutation(store: dict[str, Any]) -> dict[str, Any]:
        item = {
            **payload,
            "id": entity_id("workspace"),
            "ownerId": owner_id,
            "active": True,
            "createdAt": now_iso(),
            "updatedAt": now_iso(),
        }
        store["workspaces"].append(item)
        return item

    return await mutate_store(owner_id, mutation, account_level=True)


async def update_workspace(user: dict[str, Any], workspace_id: str, updates: dict[str, Any]) -> dict[str, Any] | None:
    owner_id = account_id(user)

    def mutation(store: dict[str, Any]) -> dict[str, Any] | None:
        for item in store["workspaces"]:
            if str(item.get("id")) == workspace_id:
                item.update({key: value for key, value in updates.items() if value is not None})
                item["updatedAt"] = now_iso()
                return item
        return None

    return await mutate_store(owner_id, mutation, account_level=True)


async def delete_workspace(user: dict[str, Any], workspace_id: str) -> bool:
    if workspace_id == "primary":
        return False
    owner_id = account_id(user)

    def mutation(store: dict[str, Any]) -> bool:
        before = len(store["workspaces"])
        store["workspaces"] = [item for item in store["workspaces"] if str(item.get("id")) != workspace_id]
        return len(store["workspaces"]) != before

    return await mutate_store(owner_id, mutation, account_level=True)


async def list_collection(user: dict[str, Any], collection: str, *, account_level: bool = False) -> list[dict[str, Any]]:
    owner = account_id(user) if account_level else tenant_id(user)
    store = await load_store(owner, account_level=account_level)
    return list(store.get(collection, []))


async def create_collection_item(
    user: dict[str, Any],
    collection: str,
    prefix: str,
    payload: dict[str, Any],
    *,
    account_level: bool = False,
    item_id: str | None = None,
) -> dict[str, Any]:
    owner = account_id(user) if account_level else tenant_id(user)

    def mutation(store: dict[str, Any]) -> dict[str, Any]:
        item = {
            **payload,
            "id": item_id or entity_id(prefix),
            "createdBy": tenant_id(user),
            "createdAt": now_iso(),
            "updatedAt": now_iso(),
        }
        store[collection].insert(0, item)
        return item

    return await mutate_store(owner, mutation, account_level=account_level)


async def update_collection_item(
    user: dict[str, Any],
    collection: str,
    item_id: str,
    updates: dict[str, Any],
    *,
    account_level: bool = False,
) -> dict[str, Any] | None:
    owner = account_id(user) if account_level else tenant_id(user)

    def mutation(store: dict[str, Any]) -> dict[str, Any] | None:
        for item in store[collection]:
            if str(item.get("id")) == item_id:
                item.update({key: value for key, value in updates.items() if value is not None})
                item["updatedAt"] = now_iso()
                return item
        return None

    return await mutate_store(owner, mutation, account_level=account_level)


async def delete_collection_item(
    user: dict[str, Any],
    collection: str,
    item_id: str,
    *,
    account_level: bool = False,
) -> bool:
    owner = account_id(user) if account_level else tenant_id(user)

    def mutation(store: dict[str, Any]) -> bool:
        before = len(store[collection])
        store[collection] = [item for item in store[collection] if str(item.get("id")) != item_id]
        return len(store[collection]) != before

    return await mutate_store(owner, mutation, account_level=account_level)


def _fernet() -> Fernet:
    digest = hashlib.sha256(auth_secret().encode("utf-8")).digest()
    return Fernet(base64.urlsafe_b64encode(digest))


def encrypt_secret(value: str) -> str:
    return _fernet().encrypt(value.encode("utf-8")).decode("ascii")


def masked_secret(value: str) -> str:
    if len(value) <= 4:
        return "****"
    return f"{value[:2]}{'*' * min(12, len(value) - 4)}{value[-2:]}"


async def save_vault_secret(user: dict[str, Any], payload: dict[str, Any]) -> dict[str, Any]:
    public = {key: value for key, value in payload.items() if key != "secret"}
    public.update(
        {
            "maskedSecret": masked_secret(payload["secret"]),
            "encryptedSecret": encrypt_secret(payload["secret"]),
            "lastTestStatus": "pending",
            "rotatedAt": now_iso(),
        }
    )
    item = await create_collection_item(user, "vault", "credential", public, account_level=True)
    return sanitize_vault_item(item)


def sanitize_vault_item(item: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in item.items() if key != "encryptedSecret"}


def parse_money(text: str) -> float | None:
    candidates = re.findall(r"(?:r\$\s*)?(\d{1,3}(?:\.\d{3})*(?:,\d{2})|\d+(?:[.,]\d{2}))", text.lower())
    if not candidates:
        return None
    raw = candidates[-1]
    if "," in raw:
        raw = raw.replace(".", "").replace(",", ".")
    try:
        return round(float(raw), 2)
    except ValueError:
        return None


def parse_date(text: str) -> str | None:
    match = re.search(r"\b([0-3]?\d)[/\-.]([01]?\d)[/\-.](\d{2,4})\b", text)
    if not match:
        return None
    day, month, year = (int(part) for part in match.groups())
    year = year + 2000 if year < 100 else year
    try:
        return date(year, month, day).isoformat()
    except ValueError:
        return None


def infer_finance_category(text: str) -> str:
    normalized = normalize_text(text)
    categories = {
        "alimentacao": ("mercado", "restaurante", "comida", "refeicao"),
        "transporte": ("uber", "99", "combustivel", "gasolina", "passagem"),
        "moradia": ("aluguel", "condominio", "energia", "agua"),
        "saude": ("farmacia", "medico", "hospital", "consulta"),
        "tecnologia": ("software", "assinatura", "internet", "hosting"),
        "impostos": ("tributo", "imposto", "darf", "das "),
    }
    for category, keywords in categories.items():
        if any(keyword in normalized for keyword in keywords):
            return category
    return "geral"


def ocr_extract(text: str) -> dict[str, Any]:
    amount = parse_money(text)
    due_date = parse_date(text)
    cnpj_match = re.search(r"\b\d{2}\.?\d{3}\.?\d{3}/?\d{4}-?\d{2}\b", text)
    cpf_match = re.search(r"\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b", text)
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    title = lines[0][:120] if lines else "Documento financeiro"
    confidence_parts = [amount is not None, due_date is not None, bool(cnpj_match or cpf_match), bool(lines)]
    confidence = round(sum(1 for part in confidence_parts if part) / len(confidence_parts), 2)
    return {
        "title": title,
        "amount": amount,
        "dueDate": due_date,
        "document": (cnpj_match or cpf_match).group(0) if (cnpj_match or cpf_match) else None,
        "category": infer_finance_category(text),
        "type": "saida",
        "status": "pendente",
        "confidence": confidence,
        "rawText": text,
        "needsReview": confidence < 0.75,
    }


def reconcile_finance(user_id: str, extracted: dict[str, Any]) -> list[dict[str, Any]]:
    finance = list_finance(user_id)
    amount = extracted.get("amount")
    due_date = extracted.get("dueDate")
    matches: list[dict[str, Any]] = []
    for item in [*finance.get("lancamentos", []), *finance.get("boletos", [])]:
        score = 0
        if amount is not None and abs(float(item.get("amount") or 0) - amount) < 0.01:
            score += 70
        if due_date and due_date in {item.get("dueDate"), item.get("paidAt")}:
            score += 25
        if normalize_text(extracted.get("title")) in normalize_text(item.get("title")):
            score += 5
        if score:
            matches.append(
                {
                    "id": item.get("id"),
                    "title": item.get("title"),
                    "amount": item.get("amount"),
                    "dueDate": item.get("dueDate"),
                    "score": score,
                }
            )
    return sorted(matches, key=lambda item: item["score"], reverse=True)[:5]


async def process_ocr(user: dict[str, Any], payload: dict[str, Any]) -> dict[str, Any]:
    text = str(payload.get("recognizedText") or "").strip()
    if not text:
        return {
            "extracted": {
                "title": payload.get("fileName") or "Documento financeiro",
                "amount": None,
                "dueDate": None,
                "category": "geral",
                "confidence": 0,
                "needsReview": True,
            },
            "matches": [],
            "createdTransaction": None,
            "provider": "manual_review",
            "message": "Nenhum texto foi reconhecido. Informe o texto do documento ou configure um provedor OCR.",
        }
    extracted = ocr_extract(text)
    matches = reconcile_finance(tenant_id(user), extracted)
    created = None
    if payload.get("createTransaction") and extracted.get("amount") is not None:
        created = create_lancamento(
            tenant_id(user),
            {
                "title": extracted["title"],
                "description": f"Importado por OCR. Documento: {extracted.get('document') or 'nao identificado'}",
                "type": "saida",
                "amount": extracted["amount"],
                "category": extracted["category"],
                "status": "pendente",
                "dueDate": extracted.get("dueDate"),
                "source": "ocr",
            },
        )
    return {
        "extracted": extracted,
        "matches": matches,
        "createdTransaction": created,
        "provider": "norium_local",
        "message": "Documento analisado. Revise os campos antes de confirmar." if extracted["needsReview"] else "Documento reconhecido com boa confianca.",
    }


def capture_destination(payload: dict[str, Any]) -> str:
    requested = str(payload.get("destination") or "auto")
    if requested != "auto":
        return requested
    normalized = normalize_text(payload.get("content"))
    if any(word in normalized for word in ("gastei", "paguei", "pix", "nota fiscal", "boleto")):
        return "finance"
    if any(word in normalized for word in ("reuniao", "agenda", "agende", "compromisso")):
        return "calendar"
    if any(word in normalized for word in ("tarefa", "fazer", "lembrar", "pendencia")):
        return "task"
    return "note"


async def process_capture(user: dict[str, Any], payload: dict[str, Any]) -> dict[str, Any]:
    destination = capture_destination(payload)
    suggestion: dict[str, Any] = {
        "destination": destination,
        "content": payload.get("content"),
        "fileName": payload.get("fileName"),
        "kind": payload.get("kind"),
    }
    if destination == "finance":
        suggestion["fields"] = {
            "title": (str(payload.get("content") or "Lancamento capturado")[:100]),
            "amount": parse_money(str(payload.get("content") or "")),
            "category": infer_finance_category(str(payload.get("content") or "")),
            "type": "saida",
            "status": "pago" if "paguei" in normalize_text(payload.get("content")) else "pendente",
            "dueDate": parse_date(str(payload.get("content") or "")),
        }
    elif destination == "task":
        suggestion["fields"] = {"title": str(payload.get("content") or "Nova tarefa")[:140], "priority": "media"}
    elif destination == "calendar":
        suggestion["fields"] = {"title": str(payload.get("content") or "Novo compromisso")[:140]}

    created = None
    if payload.get("confirm") and destination == "finance" and suggestion["fields"].get("amount") is not None:
        created = create_lancamento(tenant_id(user), {**suggestion["fields"], "source": "quick_capture"})

    item = await create_collection_item(
        user,
        "captures",
        "capture",
        {**payload, "destination": destination, "suggestion": suggestion, "result": created},
    )
    return {"capture": item, "suggestion": suggestion, "result": created, "requiresConfirmation": created is None}


def split_sentences(value: str) -> list[str]:
    return [item.strip(" \t-*") for item in re.split(r"[\r\n]+|(?<=[.!?])\s+", value) if item.strip()]


async def process_meeting(user: dict[str, Any], payload: dict[str, Any]) -> dict[str, Any]:
    transcript = str(payload.get("transcript") or "").strip()
    if not transcript:
        result = {
            "participants": payload.get("participants") or [],
            "summary": "O audio ainda precisa ser transcrito por um provedor configurado.",
            "decisions": [],
            "actionItems": [],
            "requiresConfirmation": True,
        }
    else:
        sentences = split_sentences(transcript)
        decision_words = ("decidimos", "ficou definido", "aprovado", "combinamos", "decisao")
        action_words = ("precisa", "deve", "responsavel", "ficou de", "acao", "prazo", "entregar")
        decisions = [item for item in sentences if any(word in normalize_text(item) for word in decision_words)]
        action_items = [item for item in sentences if any(word in normalize_text(item) for word in action_words)]
        result = {
            "participants": payload.get("participants") or [],
            "summary": " ".join(sentences[:4])[:1200],
            "decisions": decisions[:20],
            "actionItems": [{"description": item, "confirmed": False} for item in action_items[:30]],
            "requiresConfirmation": bool(action_items),
        }
    meeting = await create_collection_item(user, "meetings", "meeting", {**payload, "analysis": result})
    return {"meeting": meeting, **result}


def tokens(value: str) -> set[str]:
    return {part for part in re.findall(r"[a-z0-9]{3,}", normalize_text(value))}


async def query_knowledge(user: dict[str, Any], query: str, limit: int) -> dict[str, Any]:
    documents = await list_collection(user, "knowledge")
    query_tokens = tokens(query)
    ranked = []
    for document in documents:
        content = f"{document.get('title', '')} {document.get('content', '')} {' '.join(document.get('tags', []))}"
        common = query_tokens & tokens(content)
        if common:
            ranked.append((len(common), document))
    ranked.sort(key=lambda item: item[0], reverse=True)
    citations = [
        {
            "id": document.get("id"),
            "title": document.get("title"),
            "sourceUrl": document.get("sourceUrl"),
            "excerpt": str(document.get("content") or "")[:420],
            "matchedTerms": score,
        }
        for score, document in ranked[:limit]
    ]
    return {
        "answer": citations[0]["excerpt"] if citations else "Nao encontrei uma fonte autorizada para responder.",
        "citations": citations,
        "grounded": bool(citations),
    }


def duplicate_groups(items: Iterable[dict[str, Any]], fields: tuple[str, ...]) -> list[dict[str, Any]]:
    indexes: dict[str, list[dict[str, Any]]] = {}
    for item in items:
        for field in fields:
            value = normalize_text(item.get(field))
            if value:
                indexes.setdefault(f"{field}:{value}", []).append(item)
    groups = []
    for key, values in indexes.items():
        unique = {str(item.get("id")) for item in values}
        if len(unique) > 1:
            groups.append({"key": key, "ids": sorted(unique), "count": len(unique)})
    return groups


async def quality_scan(user: dict[str, Any]) -> dict[str, Any]:
    user_id = tenant_id(user)
    client_payload = read_user_db(user_id, "clientes", {})
    clients = client_payload.get("clients", []) if isinstance(client_payload, dict) else []
    task_payload = list_tasks(user_id)
    tasks = task_payload.get("tasks", [])
    finance = list_finance(user_id)
    platform = await load_store(user_id)
    missing_clients = [
        {"id": item.get("id"), "name": item.get("name"), "missing": field}
        for item in clients
        for field in ("name", "email")
        if not item.get(field)
    ]
    incomplete_tasks = [
        {"id": item.get("id"), "title": item.get("title"), "issue": "responsavel ausente"}
        for item in tasks
        if not (item.get("responsibleUserId") or item.get("responsible"))
    ]
    orphan_attachments = [
        {"resource": "finance", "id": item.get("id"), "attachment": attachment}
        for item in finance.get("lancamentos", [])
        for attachment in item.get("attachments", [])
        if not attachment.get("url")
    ]
    broken_references = [
        {"resource": "sla", "id": item.get("id"), "reference": item.get("resourceId")}
        for item in platform.get("slaCases", [])
        if not item.get("resourceId")
    ]
    issues = {
        "duplicateContacts": duplicate_groups(clients, ("email", "phone")),
        "incompleteContacts": missing_clients,
        "incompleteTasks": incomplete_tasks,
        "orphanAttachments": orphan_attachments,
        "brokenReferences": broken_references,
    }
    total = sum(len(value) for value in issues.values())
    return {"issues": issues, "totalIssues": total, "score": max(0, 100 - min(100, total * 4)), "scannedAt": now_iso()}


def parse_dt(value: Any) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None


async def conflict_scan(user: dict[str, Any]) -> dict[str, Any]:
    user_id = tenant_id(user)
    tasks = list_tasks(user_id).get("tasks", [])
    finance = list_finance(user_id)
    events_payload = read_user_db(user_id, "eventos", [])
    events = events_payload if isinstance(events_payload, list) else events_payload.get("events", [])
    calendar_events = [item for item in events if str(item.get("source")) == "calendar"]
    overlapping = []
    sorted_events = sorted(calendar_events, key=lambda item: str(item.get("timestamp") or ""))
    for first, second in zip(sorted_events, sorted_events[1:]):
        first_start = parse_dt(first.get("metadata", {}).get("start") or first.get("timestamp"))
        first_end = parse_dt(first.get("metadata", {}).get("end"))
        second_start = parse_dt(second.get("metadata", {}).get("start") or second.get("timestamp"))
        if first_start and first_end and second_start and first_start <= second_start < first_end:
            overlapping.append({"first": first.get("id"), "second": second.get("id")})

    duplicate_tasks = duplicate_groups(tasks, ("title",))
    duplicate_payments = []
    paid = [item for item in finance.get("lancamentos", []) if item.get("status") == "pago"]
    for index, item in enumerate(paid):
        for candidate in paid[index + 1 :]:
            if (
                abs(float(item.get("amount") or 0) - float(candidate.get("amount") or 0)) < 0.01
                and item.get("paidAt") == candidate.get("paidAt")
            ):
                duplicate_payments.append({"first": item.get("id"), "second": candidate.get("id")})

    workload: dict[str, int] = {}
    for task in tasks:
        if task.get("status") != "concluida":
            responsible = str(task.get("responsibleUserId") or task.get("responsible") or "sem-responsavel")
            workload[responsible] = workload.get(responsible, 0) + 1
    overloaded = [{"memberId": key, "openTasks": value} for key, value in workload.items() if value >= 10]
    conflicts = {
        "overlappingMeetings": overlapping,
        "duplicateTasks": duplicate_tasks,
        "duplicatePayments": duplicate_payments,
        "overloadedMembers": overloaded,
    }
    return {"conflicts": conflicts, "total": sum(len(value) for value in conflicts.values()), "scannedAt": now_iso()}


async def generate_handoff(user: dict[str, Any], note: str = "", next_operator_id: str | None = None) -> dict[str, Any]:
    user_id = tenant_id(user)
    tasks = list_tasks(user_id).get("tasks", [])
    finance = list_finance(user_id)
    platform = await load_store(user_id)
    pending_tasks = [item for item in tasks if item.get("status") != "concluida"]
    overdue = [
        item
        for item in pending_tasks
        if item.get("dueDate") and str(item.get("dueDate")) < date.today().isoformat()
    ]
    pending_payments = [item for item in finance.get("lancamentos", []) if item.get("status") == "pendente"]
    sla_risks = [item for item in platform.get("slaCases", []) if item.get("status") in {"at_risk", "breached"}]
    summary = {
        "fromOperator": user_id,
        "toOperator": next_operator_id,
        "note": note,
        "openTasks": len(pending_tasks),
        "overdueTasks": len(overdue),
        "pendingPayments": len(pending_payments),
        "slaRisks": len(sla_risks),
        "priorities": [
            *[{"type": "task", "id": item.get("id"), "title": item.get("title")} for item in overdue[:5]],
            *[{"type": "finance", "id": item.get("id"), "title": item.get("title")} for item in pending_payments[:5]],
        ],
        "generatedAt": now_iso(),
    }
    item = await create_collection_item(user, "handoffs", "handoff", summary)
    return item


def calculate_sla_deadline(created_at: str, response_minutes: int) -> str:
    try:
        start = datetime.fromisoformat(created_at)
    except ValueError:
        start = datetime.now(timezone.utc)
    return (start + timedelta(minutes=response_minutes)).isoformat()


def evaluate_rules(rules: list[dict[str, Any]], resource: str, data: dict[str, Any]) -> list[dict[str, Any]]:
    matched = []
    for rule in rules:
        if not rule.get("active") or rule.get("resource") != resource:
            continue
        condition = rule.get("condition") or {}
        minimum = condition.get("amountAbove")
        recipients = condition.get("recipientCountAbove")
        destructive = condition.get("destructive")
        if minimum is not None and float(data.get("amount") or 0) <= float(minimum):
            continue
        if recipients is not None and int(data.get("recipientCount") or 0) <= int(recipients):
            continue
        if destructive is not None and bool(data.get("destructive")) != bool(destructive):
            continue
        matched.append(rule)
    return matched


def new_portal_token() -> str:
    return secrets.token_urlsafe(32)
