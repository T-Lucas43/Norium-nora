"""Apply reviewed imports, keeping a receipt in the same record as each change."""
from __future__ import annotations

import asyncio
import hashlib
import json
import re
import uuid

from app.core.identity import require_user_id
from app.core.tenant import write_user_db
from . import jobs
from .router import now
from .store import mutate, require_room

RECEIPTS = "_businessImportReceipts"


def source_key(source: str, row: dict) -> str:
    return hashlib.sha256(json.dumps([source, row["index"], row["data"]], sort_keys=True, ensure_ascii=True).encode()).hexdigest()


def identities(row: dict):
    result = []
    for field in ("document", "phone", "email"):
        value = str(row.get(field) or "").strip()
        if not value:
            continue
        value = value.casefold() if field == "email" else re.sub(r"\D", "", value)
        if field == "phone" and len(value) in {10, 11}:
            value = "55" + value
        result.append((field, value))
    return result


def report(current, payload):
    result = json.loads(current["result"])
    return {"cursor": 0, "created": 0, "merged": 0, "duplicates": 0,
            "attention": 0, "attentionExamples": [], "skippedInvalid": payload.get("skipped", 0), **result}


def apply_clients(user, job, current):
    from app.modules.clients.repository import list_clients
    from app.modules.clients.router import ClientCreate
    actor = require_user_id(user)
    items = list_clients(actor)
    receipt_index = {key: entry for item in items for key, entry in item.get(RECEIPTS, {}).items()}
    identity_index = {}
    for index, item in enumerate(items):
        for identity in identities(item):
            identity_index.setdefault(identity, set()).add(index)
    result = report(current, job["payload"])
    rows = job["payload"]["rows"]
    batch = rows[result["cursor"]:result["cursor"]+250]
    changed = False
    for row in batch:
        value = ClientCreate.model_validate(row["data"]).model_dump()
        key = source_key(job["payload"]["sourceDigest"], row)
        previous = receipt_index.get(key)
        if previous:
            result[previous["action"]] += 1
            continue
        matching = set().union(*(identity_index.get(identity, set()) for identity in identities(value)))
        if len(matching) > 1:
            result["attention"] += 1
            if len(result["attentionExamples"]) < 100:
                result["attentionExamples"].append({"line": row["line"], "reason": "Documento, telefone ou e-mail apontam para clientes diferentes. Revise manualmente."})
            continue
        if matching:
            index = next(iter(matching))
            item = items[index]
            filled = False
            # Import fills missing fields; it never replaces a price/contact or
            # sharing rule that was already reviewed in the system.
            for field in ("name", "company", "document", "phone", "email", "city", "state", "notes", "segment"):
                if not item.get(field) and value.get(field):
                    item[field] = value[field]; filled = True
            action = "merged" if filled else "duplicates"
            if filled:
                item["updatedAt"] = now()
        else:
            require_room(items, 50_000)
            item = {**value, "id": "client_" + uuid.uuid4().hex,
                    "createdBy": actor, "createdByName": str(user.get("nome") or ""),
                    "access": {"teamPermission": "none", "people": []}, "createdAt": now(), "updatedAt": now()}
            items.append(item); index = len(items)-1; action = "created"
        receipt = {"action": action}
        item.setdefault(RECEIPTS, {})[key] = receipt
        receipt_index[key] = receipt
        for identity in identities(item):
            identity_index.setdefault(identity, set()).add(index)
        result[action] += 1
        changed = True
    if changed:
        write_user_db(actor, "clientes", items)
    result["cursor"] += len(batch)
    result["total"] = len(rows)
    return min(100, result["cursor"]*100//len(rows)), result, result["cursor"] >= len(rows)


def apply_catalog(user, job, current):
    from .router import CatalogItem
    result = report(current, job["payload"])
    rows = job["payload"]["rows"]
    batch = rows[result["cursor"]:result["cursor"]+250]
    def update(data):
        items = data["items"]
        receipt_index = {key: entry for item in items for key, entry in item.get(RECEIPTS, {}).items()}
        skus = {item.get("sku", "").casefold(): item for item in items if item.get("sku") and not item.get("archivedAt")}
        for row in batch:
            value = CatalogItem.model_validate(row["data"]).model_dump()
            key = source_key(job["payload"]["sourceDigest"], row)
            if key in receipt_index:
                result[receipt_index[key]["action"]] += 1
                continue
            existing = skus.get(value["sku"].casefold()) if value["sku"] else None
            if existing:
                item, action = existing, "duplicates"
            else:
                require_room(items)
                item = {**value, "id": "catalog_" + uuid.uuid4().hex,
                        "version": 1, "createdAt": now(), "updatedAt": now(),
                        "createdBy": require_user_id(user), "updatedBy": require_user_id(user), "priceHistory": []}
                items.append(item)
                if value["sku"]:
                    skus[value["sku"].casefold()] = item
                action = "created"
            receipt = {"action": action}
            item.setdefault(RECEIPTS, {})[key] = receipt
            receipt_index[key] = receipt
            result[action] += 1
    mutate(user, "catalog", update)
    result["cursor"] += len(batch)
    result["total"] = len(rows)
    return min(100, result["cursor"]*100//len(rows)), result, result["cursor"] >= len(rows)


async def apply_import(job):
    from app.modules.clients.router import _lock as client_writer_lock
    completed = False
    while not completed:
        user = await jobs.live_user(job)
        operation = apply_clients if job["kind"] == "import.clients" else apply_catalog
        if job["kind"] == "import.clients":
            # Same lock as manual CRUD; the job row is additionally locked during
            # the write and progress commit. A crash replays row receipts only.
            async with client_writer_lock:
                completed = await asyncio.to_thread(jobs.apply_chunk, job, lambda current: operation(user, job, current))
        else:
            completed = await asyncio.to_thread(jobs.apply_chunk, job, lambda current: operation(user, job, current))
        await jobs.notify(job)
        await asyncio.sleep(0)
