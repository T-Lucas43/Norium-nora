"""Dominio financeiro extraido para isolar lancamentos, anexos e relatorios."""

from __future__ import annotations

import os
import logging
import re
from calendar import monthrange
from datetime import date, datetime, timedelta, timezone
from typing import Any, Literal

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response
from pydantic import Field

from app.shared.schemas import StrictModel

from app.routers.auth_router import current_user
from app.routers.inbox_router import record_event
from app.modules.operations.schemas import ReceiptCreate
from app.modules.operations.service import record_receipt
from app.services.finance_store import (
    add_attachment,
    attachment_path,
    create_lancamento,
    create_programado,
    delete_lancamento,
    delete_programado,
    list_finance,
    remove_attachment,
    save_boletos,
    update_lancamento,
    update_programado,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/financeiro", tags=["Financeiro"])


class LancamentoPayload(StrictModel):
    user_id: str = "lucas123"
    title: str = Field(min_length=1, max_length=160)
    description: str = ""
    type: Literal["entrada", "saida"] = "saida"
    amount: float = Field(ge=0)
    category: str = "geral"
    method: str = ""
    status: Literal["pendente", "pago", "cancelado"] = "pendente"
    dueDate: str | None = None
    paidAt: str | None = None
    source: str = "manual"


class AtualizarLancamentoPayload(StrictModel):
    user_id: str = "lucas123"
    title: str | None = None
    description: str | None = None
    type: Literal["entrada", "saida"] | None = None
    amount: float | None = Field(default=None, ge=0)
    category: str | None = None
    method: str | None = None
    status: Literal["pendente", "pago", "cancelado"] | None = None
    dueDate: str | None = None
    paidAt: str | None = None


class ProgramadoPayload(StrictModel):
    user_id: str = "lucas123"
    title: str = Field(min_length=1, max_length=160)
    description: str = ""
    type: Literal["entrada", "saida"] = "saida"
    amount: float = Field(ge=0)
    category: str = "fixo"
    frequency: Literal["unico", "semanal", "mensal", "anual"] = "mensal"
    nextDueDate: str | None = None
    remindDaysBefore: int = Field(default=3, ge=0, le=60)
    active: bool = True


class AtualizarProgramadoPayload(StrictModel):
    user_id: str = "lucas123"
    title: str | None = None
    description: str | None = None
    type: Literal["entrada", "saida"] | None = None
    amount: float | None = Field(default=None, ge=0)
    category: str | None = None
    frequency: Literal["unico", "semanal", "mensal", "anual"] | None = None
    nextDueDate: str | None = None
    remindDaysBefore: int | None = Field(default=None, ge=0, le=60)
    active: bool | None = None


class AnexoPayload(StrictModel):
    user_id: str = "lucas123"
    file_name: str = Field(min_length=1, max_length=180)
    mime_type: str = "application/octet-stream"
    data_url: str = Field(min_length=16)


# Mantém o identificador histórico no OpenAPI quando há schemas homônimos.
AnexoPayload.__module__ = "app.routers.financeiro_router"
AnexoPayload.model_rebuild(force=True)


class ConsultaBoletosPayload(StrictModel):
    user_id: str = "lucas123"
    cpf: str = Field(min_length=11, max_length=18)
    senha: str | None = Field(default=None, max_length=80)


class FinanceAgentPayload(StrictModel):
    user_id: str = "lucas123"
    message: str = Field(min_length=1, max_length=1200)


def tenant_id(user: dict[str, Any]) -> str:
    return str(user.get("id") or "lucas123")


def finance_money(value: Any) -> str:
    number = float(value or 0)
    return f"R$ {number:,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")


def next_scheduled_due(current_due: str | None, frequency: str) -> str | None:
    base = date.today()
    if current_due:
        try:
            base = date.fromisoformat(current_due)
        except ValueError:
            pass

    if frequency == "unico":
        return None
    if frequency == "semanal":
        return (base + timedelta(days=7)).isoformat()
    if frequency == "anual":
        year = base.year + 1
        day = min(base.day, monthrange(year, base.month)[1])
        return date(year, base.month, day).isoformat()

    month_index = base.month
    year = base.year + (month_index // 12)
    month = (month_index % 12) + 1
    day = min(base.day, monthrange(year, month)[1])
    return date(year, month, day).isoformat()


async def record_finance_event(user_id: str, title: str, description: str, action: str, metadata: dict[str, Any] | None = None) -> None:
    await record_event(
        source="financeiro",
        title=title,
        description=description,
        metadata={"action": action, "userId": user_id, **(metadata or {})},
    )


@router.get("")
async def obter_financeiro(user_id: str = "lucas123", user: dict[str, Any] = Depends(current_user)):
    return list_finance(tenant_id(user))


@router.post("/agente/mensagem")
async def conversar_agente_financeiro(payload: FinanceAgentPayload, user: dict[str, Any] = Depends(current_user)):
    return await handle_finance_agent(tenant_id(user), payload.message)


@router.post("/lancamentos")
async def criar_lancamento(payload: LancamentoPayload, user: dict[str, Any] = Depends(current_user)):
    user_id = tenant_id(user)
    lancamento = create_lancamento(user_id, payload.model_dump(exclude={"user_id"}))
    await record_finance_event(
        user_id,
        f"Lancamento financeiro criado: {lancamento.get('title')}",
        (
            f"{lancamento.get('type')} de {finance_money(lancamento.get('amount'))}; "
            f"status {lancamento.get('status')}; categoria {lancamento.get('category')}; "
            f"vencimento {lancamento.get('dueDate') or 'sem data'}."
        ),
        "finance_entry_created",
        {"entryId": lancamento.get("id"), "entryType": lancamento.get("type"), "status": lancamento.get("status")},
    )
    await record_receipt(
        user,
        ReceiptCreate(
            action="finance_entry_created",
            title="Lancamento financeiro criado",
            description=f'{lancamento.get("title")}: {finance_money(lancamento.get("amount"))} ({lancamento.get("type")}).',
            entityType="finance_entry",
            entityId=str(lancamento.get("id") or ""),
            undoAction="delete_finance_entry",
            metadata={
                "current": lancamento,
                "entryType": lancamento.get("type"),
                "status": lancamento.get("status"),
                "category": lancamento.get("category"),
                "amount": lancamento.get("amount"),
            },
        ),
    )
    return {"lancamento": lancamento}


@router.patch("/lancamentos/{lancamento_id}")
async def atualizar_lancamento(lancamento_id: str, payload: AtualizarLancamentoPayload, user: dict[str, Any] = Depends(current_user)):
    updates = {key: getattr(payload, key) for key in payload.model_fields_set if key != "user_id"}
    user_id = tenant_id(user)
    previous = next((item for item in list_finance(user_id).get("lancamentos", []) if item.get("id") == lancamento_id), None)
    lancamento = update_lancamento(user_id, lancamento_id, updates)
    if not lancamento:
        raise HTTPException(status_code=404, detail="Lancamento nao encontrado.")
    await record_finance_event(
        user_id,
        f"Lancamento financeiro atualizado: {lancamento.get('title')}",
        (
            f"Campos alterados: {', '.join(updates.keys()) or 'nenhum'}. "
            f"Valor atual {finance_money(lancamento.get('amount'))}; status {lancamento.get('status')}; "
            f"vencimento {lancamento.get('dueDate') or 'sem data'}."
        ),
        "finance_entry_updated",
        {"entryId": lancamento.get("id"), "updates": updates, "status": lancamento.get("status")},
    )
    await record_receipt(
        user,
        ReceiptCreate(
            action="finance_entry_updated",
            title="Lancamento financeiro atualizado",
            description=f'{lancamento.get("title")}: {len(updates)} campo(s) alterado(s).',
            entityType="finance_entry",
            entityId=str(lancamento.get("id") or lancamento_id),
            undoAction="restore_finance_snapshot",
            metadata={
                "changedFields": sorted(updates.keys()),
                "previous": previous or {},
                "current": lancamento,
            },
        ),
    )
    return {"lancamento": lancamento}


@router.delete("/lancamentos/{lancamento_id}")
async def apagar_lancamento(lancamento_id: str, user_id: str = "lucas123", user: dict[str, Any] = Depends(current_user)):
    resolved_user_id = tenant_id(user)
    previous = next((item for item in list_finance(resolved_user_id).get("lancamentos", []) if item.get("id") == lancamento_id), None)
    if delete_lancamento(resolved_user_id, lancamento_id):
        await record_finance_event(
            resolved_user_id,
            f"Lancamento financeiro excluido: {(previous or {}).get('title') or lancamento_id}",
            (
                f"O lancamento {(previous or {}).get('title') or lancamento_id} foi removido. "
                f"Valor anterior {finance_money((previous or {}).get('amount'))}; status anterior {(previous or {}).get('status') or 'desconhecido'}."
            ),
            "finance_entry_deleted",
            {"entryId": lancamento_id, "previous": previous or {}},
        )
        await record_receipt(
            user,
            ReceiptCreate(
                action="finance_entry_deleted",
                title="Lancamento financeiro excluido",
                description=f'{(previous or {}).get("title") or lancamento_id} foi removido do financeiro.',
                entityType="finance_entry",
                entityId=lancamento_id,
                undoAction="restore_finance_snapshot",
                metadata={"previous": previous or {}},
            ),
        )
        return {"status": "sucesso"}
    raise HTTPException(status_code=404, detail="Lancamento nao encontrado.")


@router.post("/lancamentos/{lancamento_id}/anexos")
async def anexar_comprovante(lancamento_id: str, payload: AnexoPayload, user: dict[str, Any] = Depends(current_user)):
    user_id = tenant_id(user)
    try:
        attachment = add_attachment(
            user_id,
            lancamento_id,
            file_name=payload.file_name,
            mime_type=payload.mime_type,
            data_url=payload.data_url,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not attachment:
        raise HTTPException(status_code=404, detail="Lancamento nao encontrado.")
    await record_finance_event(
        user_id,
        "Comprovante anexado ao financeiro",
        f'O arquivo "{attachment.get("name")}" foi anexado ao lancamento {lancamento_id}. Tipo: {attachment.get("mimeType")}.',
        "finance_attachment_added",
        {"entryId": lancamento_id, "attachmentId": attachment.get("id"), "mimeType": attachment.get("mimeType")},
    )
    return {"attachment": attachment}


@router.get("/anexos/{file_name}")
async def baixar_anexo(file_name: str, user: dict[str, Any] = Depends(current_user)):
    path = attachment_path(tenant_id(user), file_name)
    if not path:
        raise HTTPException(status_code=404, detail="Anexo nao encontrado.")
    from app.infrastructure.persistence import files as persistent_files
    return Response(
        persistent_files.read(path), media_type="application/octet-stream",
        headers={"Content-Disposition": f'attachment; filename="{path.name}"', "Cache-Control": "private, no-store"},
    )


@router.delete("/lancamentos/{lancamento_id}/anexos/{attachment_id}")
async def remover_anexo_lancamento(lancamento_id: str, attachment_id: str, user_id: str = "lucas123", user: dict[str, Any] = Depends(current_user)):
    removed = remove_attachment(tenant_id(user), lancamento_id, attachment_id)
    if not removed:
        raise HTTPException(status_code=404, detail="Anexo nao encontrado.")
    return {"status": "sucesso", "attachment": removed}


@router.post("/programados")
async def criar_programado(payload: ProgramadoPayload, user: dict[str, Any] = Depends(current_user)):
    user_id = tenant_id(user)
    programado = create_programado(user_id, payload.model_dump(exclude={"user_id"}))
    await record_finance_event(
        user_id,
        f"Gasto programado criado: {programado.get('title')}",
        (
            f"{programado.get('frequency')} de {finance_money(programado.get('amount'))}; "
            f"proximo vencimento {programado.get('nextDueDate') or 'sem data'}; "
            f"lembrete {programado.get('remindDaysBefore')} dia(s) antes."
        ),
        "finance_scheduled_created",
        {"scheduledId": programado.get("id"), "frequency": programado.get("frequency")},
    )
    return {"programado": programado}


@router.patch("/programados/{programado_id}")
async def atualizar_programado(programado_id: str, payload: AtualizarProgramadoPayload, user: dict[str, Any] = Depends(current_user)):
    updates = {key: getattr(payload, key) for key in payload.model_fields_set if key != "user_id"}
    user_id = tenant_id(user)
    programado = update_programado(user_id, programado_id, updates)
    if not programado:
        raise HTTPException(status_code=404, detail="Programacao nao encontrada.")
    await record_finance_event(
        user_id,
        f"Gasto programado atualizado: {programado.get('title')}",
        (
            f"Campos alterados: {', '.join(updates.keys()) or 'nenhum'}. "
            f"Valor {finance_money(programado.get('amount'))}; frequencia {programado.get('frequency')}; "
            f"proximo vencimento {programado.get('nextDueDate') or 'sem data'}."
        ),
        "finance_scheduled_updated",
        {"scheduledId": programado.get("id"), "updates": updates},
    )
    return {"programado": programado}


@router.post("/programados/{programado_id}/pagar")
async def pagar_programado(programado_id: str, user: dict[str, Any] = Depends(current_user)):
    user_id = tenant_id(user)
    programado = next(
        (item for item in list_finance(user_id).get("programados", []) if item.get("id") == programado_id),
        None,
    )
    if not programado:
        raise HTTPException(status_code=404, detail="Programacao nao encontrada.")
    if not programado.get("active", True):
        raise HTTPException(status_code=409, detail="Esta programacao esta inativa.")

    paid_on = date.today().isoformat()
    due_date = programado.get("nextDueDate") or paid_on
    lancamento = create_lancamento(
        user_id,
        {
            "title": programado.get("title") or "Gasto programado",
            "description": programado.get("description") or "Quitacao gerada a partir de um gasto programado.",
            "type": programado.get("type") or "saida",
            "amount": programado.get("amount") or 0,
            "category": programado.get("category") or "fixo",
            "method": "programado",
            "status": "pago",
            "dueDate": due_date,
            "paidAt": paid_on,
            "source": "scheduled",
        },
    )
    frequency = str(programado.get("frequency") or "mensal")
    next_due = next_scheduled_due(due_date, frequency)
    updated_programado = update_programado(
        user_id,
        programado_id,
        {
            "nextDueDate": next_due,
            "active": frequency != "unico",
        },
    )

    await record_finance_event(
        user_id,
        f"Gasto programado pago: {programado.get('title')}",
        (
            f"Pagamento de {finance_money(programado.get('amount'))} registrado em {paid_on}. "
            f"Proximo vencimento: {next_due or 'programacao concluida'}."
        ),
        "finance_scheduled_paid",
        {
            "scheduledId": programado_id,
            "entryId": lancamento.get("id"),
            "paidAt": paid_on,
            "nextDueDate": next_due,
        },
    )
    await record_receipt(
        user,
        ReceiptCreate(
            action="finance_scheduled_paid",
            title="Gasto programado marcado como pago",
            description=f'{programado.get("title")}: {finance_money(programado.get("amount"))}.',
            entityType="finance_entry",
            entityId=str(lancamento.get("id") or ""),
            undoAction="delete_finance_entry",
            metadata={
                "scheduledId": programado_id,
                "entry": lancamento,
                "previousSchedule": programado,
                "currentSchedule": updated_programado or {},
            },
        ),
    )
    return {"lancamento": lancamento, "programado": updated_programado}


@router.delete("/programados/{programado_id}")
async def apagar_programado(programado_id: str, user_id: str = "lucas123", user: dict[str, Any] = Depends(current_user)):
    resolved_user_id = tenant_id(user)
    previous = next((item for item in list_finance(resolved_user_id).get("programados", []) if item.get("id") == programado_id), None)
    if delete_programado(resolved_user_id, programado_id):
        await record_finance_event(
            resolved_user_id,
            f"Gasto programado excluido: {(previous or {}).get('title') or programado_id}",
            (
                f"A programacao {(previous or {}).get('title') or programado_id} foi removida. "
                f"Valor anterior {finance_money((previous or {}).get('amount'))}; frequencia anterior {(previous or {}).get('frequency') or 'desconhecida'}."
            ),
            "finance_scheduled_deleted",
            {"scheduledId": programado_id, "previous": previous or {}},
        )
        return {"status": "sucesso"}
    raise HTTPException(status_code=404, detail="Programacao nao encontrada.")


@router.post("/boletos/consultar")
async def consultar_boletos(payload: ConsultaBoletosPayload, user: dict[str, Any] = Depends(current_user)):
    user_id = tenant_id(user)
    result = await consultar_boletos_para_usuario(payload, user_id)
    await record_finance_event(
        user_id,
        "Boletos consultados no CPF",
        result.get("message") or f"{len(result.get('boletos', []))} boleto(s) retornado(s) pelo provedor configurado.",
        "finance_boletos_consulted",
        {"count": len(result.get("boletos", [])), "configured": result.get("configured")},
    )
    return result


async def consultar_boletos_para_usuario(payload: ConsultaBoletosPayload, user_id: str) -> dict[str, Any]:
    cpf_cnpj = re.sub(r"\D+", "", payload.cpf)
    if len(cpf_cnpj) not in {11, 14}:
        raise HTTPException(status_code=400, detail="CPF/CNPJ invalido. Informe 11 ou 14 digitos.")

    config = _samierp_config()
    if not config["configured"]:
        return {
            "configured": False,
            "boletos": [],
            "message": "API Meu Boleto nao configurada. Defina SAMIERP_ID_PARCEIRO e SAMIERP_SIGLA no .env.",
        }

    senha = (payload.senha or config["senha"]).strip()
    if config["validar_senha"] and not senha:
        raise HTTPException(status_code=400, detail="Senha do boleto obrigatoria para a configuracao atual da Sami.")

    request_body: dict[str, Any] = {
        "sigla": config["sigla"],
        "cpf_cnpj": cpf_cnpj,
        "validar_senha": config["validar_senha"],
    }
    if senha:
        request_body["senha"] = senha

    try:
        async with httpx.AsyncClient(timeout=25.0) as client:
            response = await client.post(
                config["url"],
                json=request_body,
                headers={"Accept": "application/json", "Content-Type": "application/json"},
            )
        if response.status_code >= 400:
            logger.warning("Provedor de boletos recusou a consulta com status %s.", response.status_code)
            raise HTTPException(status_code=502, detail="O provedor de boletos recusou a consulta.")
        try:
            provider_payload = response.json()
        except ValueError:
            provider_payload = {"raw": response.text}
        boletos = _extract_boletos(provider_payload)
        saved = save_boletos(user_id, boletos)
        return {
            "configured": True,
            "provider": "samierp-api-meu-boleto",
            "boletos": saved,
            "message": f"{len(saved)} boleto(s) encontrado(s) pela Sami.",
        }
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Falha ao consultar boletos.")
        raise HTTPException(status_code=502, detail="Falha temporaria ao consultar boletos.") from exc


def _samierp_config() -> dict[str, Any]:
    id_parceiro = os.getenv("SAMIERP_ID_PARCEIRO", "").strip() or os.getenv("MEU_BOLETO_ID_PARCEIRO", "").strip()
    sigla = os.getenv("SAMIERP_SIGLA", "").strip() or os.getenv("MEU_BOLETO_SIGLA", "").strip()
    url_override = os.getenv("SAMIERP_BOLETO_URL", "").strip()
    validar_senha = _env_bool("SAMIERP_VALIDAR_SENHA", default=True)
    senha = os.getenv("SAMIERP_SENHA", "").strip() or os.getenv("MEU_BOLETO_SENHA", "").strip()
    url = url_override or (f"https://wapi.samierp.com.br/{id_parceiro}/financeiro/boleto" if id_parceiro else "")
    return {
        "configured": bool(url and sigla),
        "url": url,
        "sigla": sigla,
        "validar_senha": validar_senha,
        "senha": senha,
    }


def _env_bool(name: str, *, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "sim", "yes", "y", "on"}


def _extract_boletos(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, list):
        return [_normalize_provider_boleto(item) for item in payload if isinstance(item, dict)]
    if isinstance(payload, dict):
        for key in ("boletos", "data", "items", "results", "retorno", "dados"):
            value = payload.get(key)
            if isinstance(value, list):
                return [_normalize_provider_boleto(item) for item in value if isinstance(item, dict)]
            if isinstance(value, dict):
                nested = _extract_boletos(value)
                if nested:
                    return nested
        if any(key in payload for key in ("link", "url", "url_boleto", "boleto", "linhaDigitavel", "linha_digitavel", "valor")):
            return [_normalize_provider_boleto(payload)]
    return []


def _normalize_provider_boleto(item: dict[str, Any]) -> dict[str, Any]:
    url = _first_value(item, "url", "link", "url_boleto", "boleto", "segunda_via", "segundaVia")
    linha = _first_value(item, "linhaDigitavel", "linha_digitavel", "linha", "codigo_linha_digitavel")
    barcode = _first_value(item, "barcode", "codigoBarras", "codigo_barras", "codBarras", "cod_barras") or linha
    title = _first_value(item, "title", "titulo", "descricao", "documento", "numeroDocumento", "nossoNumero") or "Boleto Sami"
    return {
        "id": _first_value(item, "id", "codigo", "nossoNumero", "numeroDocumento") or linha or barcode or url,
        "title": title,
        "beneficiary": _first_value(item, "beneficiary", "beneficiario", "cedente", "favorecido", "empresa", "nome"),
        "amount": _money_value(_first_value(item, "amount", "valor", "valor_boleto", "total")),
        "dueDate": _first_value(item, "dueDate", "vencimento", "data_vencimento", "dataVencimento"),
        "status": _first_value(item, "status", "situacao") or "pendente",
        "barcode": barcode,
        "linhaDigitavel": linha,
        "url": url,
        "source": "samierp",
        "raw": item,
    }


def _first_value(item: dict[str, Any], *keys: str) -> str:
    for key in keys:
        value = item.get(key)
        if value is not None and str(value).strip():
            return str(value).strip()
    return ""


def _money_value(value: Any) -> float:
    if value is None or value == "":
        return 0.0
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip().replace("R$", "").replace(" ", "")
    if "," in text:
        text = text.replace(".", "").replace(",", ".")
    try:
        return float(text)
    except ValueError:
        return 0.0


async def handle_finance_agent(user_id: str, message: str) -> dict[str, Any]:
    normalized = _normalize_text(message)

    if _is_boleto_intent(normalized):
        cpf = _extract_cpf(message)
        if not cpf:
            return {
                "status": "precisa_cpf",
                "response": "Para consultar boletos eu preciso do CPF com 11 digitos. Envie algo como: consultar boletos do CPF 00000000000.",
            }
        result = await consultar_boletos_para_usuario(ConsultaBoletosPayload(user_id=user_id, cpf=cpf), user_id)
        await record_finance_event(
            user_id,
            "Nora consultou boletos no CPF",
            result.get("message") or f"{len(result.get('boletos', []))} boleto(s) retornado(s).",
            "nora_finance_boletos",
            {"count": len(result.get("boletos", []))},
        )
        return {
            "status": "boletos",
            "response": result.get("message") or f"Consulta concluida: {len(result.get('boletos', []))} boleto(s).",
            "boletos": result.get("boletos", []),
        }

    if _is_delete_programado_intent(normalized):
        data = list_finance(user_id)
        item = _find_item(data.get("programados", []), message)
        if not item:
            return {"status": "nao_encontrado", "response": "Nao achei esse gasto programado. Me diga um trecho do nome."}
        delete_programado(user_id, item["id"])
        await record_finance_event(
            user_id,
            f"Nora excluiu gasto programado: {item.get('title')}",
            f"Gasto programado removido pela Nora. Valor anterior {finance_money(item.get('amount'))}; frequencia {item.get('frequency')}.",
            "nora_finance_scheduled_deleted",
            {"scheduledId": item.get("id")},
        )
        return {"status": "programado_excluido", "response": f"Exclui o gasto programado: {item['title']}."}

    if _is_programado_create_intent(normalized):
        amount = _extract_amount(message)
        if amount <= 0:
            return {"status": "precisa_valor", "response": "Para programar um gasto eu preciso do valor. Exemplo: programar internet R$ 120 mensal dia 10."}
        payload = {
            "title": _extract_finance_title(message, fallback="Gasto programado pela Nora"),
            "description": "Criado pela Nora via agente financeiro.",
            "type": _entry_type_from_text(normalized),
            "amount": amount,
            "category": _category_from_text(normalized, default="fixo"),
            "frequency": _frequency_from_text(normalized),
            "nextDueDate": _extract_due_date(normalized),
            "remindDaysBefore": _extract_reminder_days(normalized),
            "active": True,
        }
        programado = create_programado(user_id, payload)
        await record_finance_event(
            user_id,
            f"Nora programou gasto: {programado.get('title')}",
            (
                f"{programado.get('frequency')} de {finance_money(programado.get('amount'))}; "
                f"proximo vencimento {programado.get('nextDueDate') or 'sem data'}; "
                f"lembrete {programado.get('remindDaysBefore')} dia(s) antes."
            ),
            "nora_finance_scheduled_created",
            {"scheduledId": programado.get("id")},
        )
        return {
            "status": "programado_criado",
            "response": (
                f"Programei {programado['title']} ({_money_br(programado['amount'])}) "
                f"com frequencia {programado['frequency']} e lembrete {programado['remindDaysBefore']} dia(s) antes."
            ),
            "programado": programado,
        }

    if _is_delete_lancamento_intent(normalized):
        data = list_finance(user_id)
        item = _find_item(data.get("lancamentos", []), message)
        if not item:
            return {"status": "nao_encontrado", "response": "Nao achei esse lancamento. Me diga um trecho do titulo."}
        delete_lancamento(user_id, item["id"])
        await record_finance_event(
            user_id,
            f"Nora excluiu lancamento: {item.get('title')}",
            f"Lancamento removido pela Nora. Valor anterior {finance_money(item.get('amount'))}; status anterior {item.get('status')}.",
            "nora_finance_entry_deleted",
            {"entryId": item.get("id")},
        )
        return {"status": "lancamento_excluido", "response": f"Exclui o lancamento: {item['title']}."}

    if _is_update_lancamento_intent(normalized):
        data = list_finance(user_id)
        item = _find_item(data.get("lancamentos", []), message)
        if not item:
            return {"status": "nao_encontrado", "response": "Nao achei esse lancamento para atualizar. Me diga um trecho do titulo."}
        updates: dict[str, Any] = {}
        amount = _extract_amount(message)
        if amount > 0:
            updates["amount"] = amount
        status = _status_from_text(normalized)
        if status:
            updates["status"] = status
            updates["paidAt"] = datetime.now(timezone(timedelta(hours=-3))).date().isoformat() if status == "pago" else None
        due = _extract_due_date(normalized)
        if due:
            updates["dueDate"] = due
        category = _category_from_text(normalized, default="")
        if category:
            updates["category"] = category
        if not updates:
            return {"status": "sem_alteracao", "response": "Diga o que quer alterar: valor, status, vencimento ou categoria."}
        updated = update_lancamento(user_id, item["id"], updates)
        await record_finance_event(
            user_id,
            f"Nora atualizou lancamento: {updated.get('title')}",
            f"Campos alterados: {', '.join(updates.keys())}. Novo estado: {format_lancamento_line(updated)}",
            "nora_finance_entry_updated",
            {"entryId": updated.get("id"), "updates": updates},
        )
        return {
            "status": "lancamento_atualizado",
            "response": f"Atualizei {updated['title']}: {format_lancamento_line(updated)}",
            "lancamento": updated,
        }

    if _is_lancamento_create_intent(normalized):
        amount = _extract_amount(message)
        if amount <= 0:
            return {"status": "precisa_valor", "response": "Para criar um lancamento eu preciso do valor. Exemplo: lancar saida mercado R$ 83,90."}
        status = _status_from_text(normalized) or ("pago" if _is_paid_expense_phrase(normalized) else "pendente")
        payload = {
            "title": _extract_finance_title(message, fallback="Lancamento pela Nora"),
            "description": "Criado pela Nora via agente financeiro.",
            "type": _entry_type_from_text(normalized),
            "amount": amount,
            "category": _category_from_text(normalized, default="geral"),
            "method": _method_from_text(normalized),
            "status": status,
            "dueDate": _extract_due_date(normalized),
            "paidAt": datetime.now(timezone(timedelta(hours=-3))).date().isoformat() if status == "pago" else None,
            "source": "nora",
        }
        lancamento = create_lancamento(user_id, payload)
        await record_finance_event(
            user_id,
            f"Nora criou lancamento: {lancamento.get('title')}",
            (
                f"{lancamento.get('type')} de {finance_money(lancamento.get('amount'))}; "
                f"status {lancamento.get('status')}; categoria {lancamento.get('category')}; "
                f"vencimento {lancamento.get('dueDate') or 'sem data'}."
            ),
            "nora_finance_entry_created",
            {"entryId": lancamento.get("id"), "entryType": lancamento.get("type")},
        )
        return {
            "status": "lancamento_criado",
            "response": f"Criei o lancamento financeiro: {format_lancamento_line(lancamento)}",
            "lancamento": lancamento,
        }

    data = list_finance(user_id)
    return {
        "status": "consulta",
        "response": format_finance_overview(data),
        "financeiro": data,
    }


def format_finance_overview(data: dict[str, Any]) -> str:
    resumo = data.get("resumo", {})
    lines = [
        "Resumo financeiro do Norium:",
        f"- Entradas pagas: {_money_br(resumo.get('entradas', 0))}",
        f"- Saidas pagas: {_money_br(resumo.get('saidas', 0))}",
        f"- Saldo: {_money_br(resumo.get('saldo', 0))}",
        f"- Pendente a pagar: {_money_br(resumo.get('pendente', 0))}",
        f"- Vencidos: {resumo.get('vencidos', 0)}",
        "",
        "Ultimos lancamentos:",
    ]
    lancamentos = data.get("lancamentos", [])[:6]
    if lancamentos:
        lines.extend(f"- {format_lancamento_line(item)}" for item in lancamentos)
    else:
        lines.append("- Nenhum lancamento cadastrado.")

    programados = data.get("programados", [])[:4]
    lines.append("")
    lines.append("Gastos programados:")
    if programados:
        lines.extend(
            f"- {item.get('title')} | {_money_br(item.get('amount', 0))} | {item.get('frequency')} | proximo: {item.get('nextDueDate') or 'sem data'}"
            for item in programados
        )
    else:
        lines.append("- Nenhum gasto programado ativo.")

    boletos = data.get("boletos", [])[:4]
    lines.append("")
    lines.append("Boletos importados:")
    if boletos:
        lines.extend(
            f"- {item.get('title')} | {_money_br(item.get('amount', 0))} | vencimento: {item.get('dueDate') or 'sem data'} | {item.get('status')}"
            for item in boletos
        )
    else:
        lines.append("- Nenhum boleto importado.")
    return "\n".join(lines)


def format_lancamento_line(item: dict[str, Any]) -> str:
    return (
        f"{item.get('title')} | {item.get('type')} | {_money_br(item.get('amount', 0))} | "
        f"{item.get('status')} | vencimento: {item.get('dueDate') or 'sem data'} | "
        f"categoria: {item.get('category') or 'geral'} | anexos: {len(item.get('attachments') or [])}"
    )


def _normalize_text(value: str) -> str:
    import unicodedata

    lowered = value.lower().strip()
    return "".join(char for char in unicodedata.normalize("NFKD", lowered) if not unicodedata.combining(char))


def _money_br(value: Any) -> str:
    number = float(value or 0)
    return f"R$ {number:,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")


def _extract_amount(message: str) -> float:
    matches = re.findall(r"(?:r\$\s*)?(\d{1,3}(?:\.\d{3})*(?:,\d{1,2})?|\d+(?:[.,]\d{1,2})?)", message, flags=re.I)
    for raw in matches:
        value = _money_value(raw)
        if value > 0 and value < 1_000_000_000:
            return value
    return 0.0


def _extract_cpf(message: str) -> str:
    digits = re.sub(r"\D+", "", message)
    return digits[:11] if len(digits) >= 11 else ""


def _extract_due_date(normalized: str) -> str | None:
    today = datetime.now(timezone(timedelta(hours=-3))).date()
    if "hoje" in normalized:
        return today.isoformat()
    if "amanha" in normalized:
        return (today + timedelta(days=1)).isoformat()
    match = re.search(r"\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b", normalized)
    if match:
        day = int(match.group(1))
        month = int(match.group(2))
        year = int(match.group(3) or today.year)
        year = 2000 + year if year < 100 else year
        try:
            parsed = date(year, month, day)
            if parsed < today and not match.group(3):
                parsed = date(today.year + 1, month, day)
            return parsed.isoformat()
        except ValueError:
            return None
    day_match = re.search(r"\bdia\s+(\d{1,2})\b", normalized)
    if day_match:
        day = int(day_match.group(1))
        try:
            parsed = date(today.year, today.month, day)
            if parsed < today:
                next_month = today.month + 1
                year = today.year + (1 if next_month > 12 else 0)
                month = 1 if next_month > 12 else next_month
                parsed = date(year, month, day)
            return parsed.isoformat()
        except ValueError:
            return None
    return None


def _extract_reminder_days(normalized: str) -> int:
    match = re.search(r"(\d{1,2})\s+dias?\s+antes", normalized)
    if not match:
        return 3
    return max(0, min(60, int(match.group(1))))


def _entry_type_from_text(normalized: str) -> str:
    if any(word in normalized for word in ["entrada", "receita", "recebi", "recebimento", "ganhei"]):
        return "entrada"
    return "saida"


def _is_paid_expense_phrase(normalized: str) -> bool:
    return any(word in normalized for word in ["gastei", "paguei", "comprei", "comprando", "quitei"])


def _status_from_text(normalized: str) -> str | None:
    if any(word in normalized for word in ["cancelar", "cancelado", "cancelada"]):
        return "cancelado"
    if any(word in normalized for word in ["pago", "paga", "paguei", "quitado", "quitada"]):
        return "pago"
    if "pendente" in normalized:
        return "pendente"
    return None


def _frequency_from_text(normalized: str) -> str:
    if "semanal" in normalized or "semana" in normalized:
        return "semanal"
    if "anual" in normalized or "ano" in normalized:
        return "anual"
    if "unico" in normalized or "uma vez" in normalized:
        return "unico"
    return "mensal"


def _category_from_text(normalized: str, *, default: str) -> str:
    categories = ["moradia", "mercado", "transporte", "saude", "educacao", "lazer", "imposto", "boleto", "fixo", "geral"]
    for category in categories:
        if category in normalized:
            return category
    if any(word in normalized for word in ["comida", "alimentacao", "almoco", "jantar", "lanche", "restaurante"]):
        return "alimentacao"
    if "cartao" in normalized:
        return "cartao"
    if "cliente" in normalized:
        return "cliente"
    return default


def _method_from_text(normalized: str) -> str:
    for method in ["pix", "cartao", "boleto", "dinheiro", "debito", "credito"]:
        if method in normalized:
            return method
    return ""


def _extract_finance_title(message: str, *, fallback: str) -> str:
    title = re.sub(r"(?:r\$\s*)?\d{1,3}(?:\.\d{3})*(?:,\d{1,2})?|\d+(?:[.,]\d{1,2})?", " ", message, flags=re.I)
    title = re.sub(
        r"\b(criar|crie|lancar|lançar|registrar|adicionar|nova|novo|um|uma|de|do|da|o|a|entrada|saida|despesa|gasto|receita|pago|pendente|cancelado|programar|fixo|recorrente|mensal|semanal|anual|dia|vencimento|valor|no|na|com|por|para|paguei|recebi)\b",
        " ",
        title,
        flags=re.I,
    )
    title = re.sub(r"\b(gastei|comprei|comprando|hoje|ontem|pix|cartao|dinheiro|real|reais)\b", " ", title, flags=re.I)
    title = re.sub(r"\s+", " ", title).strip(" :-.,")
    return title[:160] or fallback


def _find_item(items: list[dict[str, Any]], message: str) -> dict[str, Any] | None:
    normalized = _normalize_text(message)
    for item in items:
        if str(item.get("id") or "").lower() in normalized:
            return item
    for item in items:
        title = _normalize_text(str(item.get("title") or ""))
        if title and title in normalized:
            return item
    tokens = [token for token in re.findall(r"[a-z0-9]{3,}", normalized) if token not in {"lancamento", "gasto", "programado", "pago", "pagar"}]
    for item in items:
        title = _normalize_text(str(item.get("title") or ""))
        if any(token in title for token in tokens):
            return item
    return items[0] if len(items) == 1 else None


def _is_boleto_intent(normalized: str) -> bool:
    return any(word in normalized for word in ["boleto", "boletos", "cpf", "segunda via"])


def _is_lancamento_create_intent(normalized: str) -> bool:
    return any(
        word in normalized
        for word in [
            "lancar",
            "registrar",
            "adicionar",
            "criar lancamento",
            "nova despesa",
            "nova receita",
            "gastei",
            "paguei",
            "recebi",
            "comprei",
            "comprando",
            "compra no",
            "compra de",
        ]
    )


def _is_update_lancamento_intent(normalized: str) -> bool:
    return any(word in normalized for word in ["marcar", "alterar", "editar", "atualizar", "corrigir", "mudar"]) and any(
        word in normalized for word in ["pago", "pendente", "cancelado", "valor", "vencimento", "categoria"]
    )


def _is_delete_lancamento_intent(normalized: str) -> bool:
    return any(word in normalized for word in ["excluir", "apagar", "deletar", "remover"]) and "programado" not in normalized


def _is_programado_create_intent(normalized: str) -> bool:
    return any(word in normalized for word in ["programar", "recorrente", "gasto fixo", "fixo mensal", "despesa fixa"])


def _is_delete_programado_intent(normalized: str) -> bool:
    return any(word in normalized for word in ["excluir", "apagar", "deletar", "remover"]) and "programado" in normalized
