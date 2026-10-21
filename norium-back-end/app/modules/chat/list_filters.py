"""Validated filters are applied before pagination, never just to loaded rows."""
from datetime import datetime, time, timedelta
from zoneinfo import ZoneInfo
from fastapi import HTTPException
from pydantic import ValidationError
from app.modules.business.whatsapp_views import Filters


async def options(user, encoded, *, team=False):
    if not isinstance(encoded, str) or not encoded:
        return {}, None
    try:
        filters = Filters.model_validate_json(encoded)
    except ValidationError:
        raise HTTPException(422, "Filtros de conversa inválidos.") from None
    if filters.fromDate and filters.toDate and filters.fromDate > filters.toDate:
        raise HTTPException(422, "O início do período deve ser anterior ao fim.")
    if not team and (filters.responsavel != "all" or filters.estado):
        raise HTTPException(422, "Responsável e estado pertencem à caixa de equipe.")
    values = filters.model_dump()
    zone = ZoneInfo("America/Sao_Paulo")
    if filters.fromDate:
        values["fromTs"] = datetime.combine(datetime.fromisoformat(filters.fromDate).date(), time.min, zone).timestamp()
    if filters.toDate:
        values["toTs"] = (datetime.combine(datetime.fromisoformat(filters.toDate).date(), time.min, zone) + timedelta(days=1)).timestamp()
    matching = None
    if filters.tagIds:
        from app.modules.business.router import tagged_conversations
        result = await tagged_conversations(tagIds=",".join(filters.tagIds), offset=0, limit=50000, user=user)
        matching = set(result["ids"])
    return values, matching


def matches(identifier, row, filters, allowed_ids):
    if allowed_ids is not None and identifier not in allowed_ids:
        return False
    if filters.get("unread") and not int(row.get("naoLidasCount") or 0):
        return False
    kind = filters.get("kind", "all")
    if kind != "all" and bool(row.get("esGrupo")) != (kind == "group"):
        return False
    timestamp = int(row.get("timestampUltimaMsg") or 0)
    return not (("fromTs" in filters and timestamp < filters["fromTs"]) or ("toTs" in filters and timestamp >= filters["toTs"]))
