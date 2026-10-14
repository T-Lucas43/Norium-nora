from __future__ import annotations

import re
import uuid
from datetime import datetime, timezone
from threading import RLock
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import Field

from app.core.tenant import get_user_db_path, read_json_file, write_json_file
from app.modules.auth.router import current_user
from app.shared.schemas import StrictModel

router = APIRouter(prefix="/api/message-templates", tags=["Modelos de mensagens"])
_lock = RLock()

BUILTIN_TEMPLATES: list[dict[str, Any]] = [
    {"id": "builtin_email_first_contact", "name": "Primeiro contato comercial", "channel": "email", "category": "comercial", "subject": "Uma proposta para {{client_name}}", "body": "Olá, {{client_name}}!\n\nMeu nome é {{sender_name}} e falo em nome da {{company_name}}. Conhecemos o seu contexto e acreditamos que podemos ajudar com {{service_name}}.\n\nGostaria de marcar uma conversa breve para entender suas prioridades e apresentar uma proposta adequada, sem compromisso.\n\nQual é o melhor dia e horário para você?\n\nAtenciosamente,\n{{sender_name}}\n{{company_name}}"},
    {"id": "builtin_email_follow_up", "name": "Follow-up de proposta", "channel": "email", "category": "follow-up", "subject": "Podemos avançar, {{client_name}}?", "body": "Olá, {{client_name}}!\n\nEstou retomando nosso contato sobre a proposta de {{service_name}}. Ficou alguma dúvida sobre o escopo, os prazos ou o investimento?\n\nPosso ajustar a proposta ou agendar uma conversa rápida para alinharmos os próximos passos.\n\nFico à disposição.\n\nAtenciosamente,\n{{sender_name}}"},
    {"id": "builtin_email_onboarding", "name": "Boas-vindas e onboarding", "channel": "email", "category": "onboarding", "subject": "Bem-vindo à {{company_name}}, {{client_name}}", "body": "Olá, {{client_name}}!\n\nÉ um prazer iniciar esta parceria. A partir de agora, acompanharemos você durante todas as etapas de implantação de {{service_name}}.\n\nPróximo passo: {{next_step}}. Data prevista: {{date}} às {{time}}.\n\nSempre que precisar, responda a este e-mail.\n\nAtenciosamente,\nEquipe {{company_name}}"},
    {"id": "builtin_email_payment", "name": "Lembrete de pagamento", "channel": "email", "category": "financeiro", "subject": "Lembrete de vencimento — {{client_name}}", "body": "Olá, {{client_name}}!\n\nEste é um lembrete cordial sobre o pagamento de {{service_name}}, com vencimento em {{date}}. Caso o pagamento já tenha sido realizado, desconsidere esta mensagem.\n\nSe precisar de segunda via ou de apoio, responda a este e-mail.\n\nAtenciosamente,\n{{sender_name}}"},
    {"id": "builtin_whatsapp_first_contact", "name": "Primeiro contato comercial", "channel": "whatsapp", "category": "comercial", "subject": "", "body": "Olá, {{client_name}}! Sou {{sender_name}}, da {{company_name}}. Conheci sua necessidade e acredito que podemos ajudar com {{service_name}}. Posso te fazer algumas perguntas rápidas para preparar uma proposta adequada?"},
    {"id": "builtin_whatsapp_follow_up", "name": "Follow-up de proposta", "channel": "whatsapp", "category": "follow-up", "subject": "", "body": "Olá, {{client_name}}! Passando para saber se conseguiu analisar nossa proposta de {{service_name}}. Ficou alguma dúvida sobre escopo, prazo ou investimento? Estou à disposição para ajustar e avançarmos no melhor momento para você."},
    {"id": "builtin_whatsapp_appointment", "name": "Confirmação de atendimento", "channel": "whatsapp", "category": "agendamento", "subject": "", "body": "Olá, {{client_name}}! Confirmamos seu atendimento de {{service_name}} para {{date}}, às {{time}}, com {{professional_name}}. Se precisar alterar o horário, avise por aqui. Até lá!"},
    {"id": "builtin_whatsapp_support", "name": "Retorno de suporte", "channel": "whatsapp", "category": "suporte", "subject": "", "body": "Olá, {{client_name}}! Recebemos sua solicitação sobre {{service_name}} e ela já está em atendimento. O próximo passo é {{next_step}}. Manteremos você atualizado por aqui. Obrigado pela compreensão."},
]

ALLOWED_VARIABLES = {"client_name", "company_name", "sender_name", "service_name", "professional_name", "date", "time", "next_step"}


class TemplatePayload(StrictModel):
    name: str = Field(min_length=2, max_length=120)
    channel: Literal["email", "whatsapp", "team"]
    category: str = Field(default="geral", min_length=2, max_length=60)
    subject: str = Field(default="", max_length=200)
    body: str = Field(min_length=2, max_length=12000)
    shortcut: str = Field(default="", max_length=30, pattern=r"^(?:[a-z][a-z0-9_-]{1,29})?$")


class RenderPayload(StrictModel):
    templateId: str = Field(min_length=2, max_length=120)
    variables: dict[str, str] = Field(default_factory=dict)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def store_path(user: dict[str, Any]):
    return get_user_db_path(str(user.get("id") or "primary"), "message_templates")


def load_custom(user: dict[str, Any]) -> list[dict[str, Any]]:
    payload = read_json_file(store_path(user), {"templates": []})
    templates = payload.get("templates", []) if isinstance(payload, dict) else []
    return [item for item in templates if isinstance(item, dict)]


def save_custom(user: dict[str, Any], templates: list[dict[str, Any]]) -> None:
    write_json_file(store_path(user), {"templates": templates, "updatedAt": now_iso()})


def sanitize(payload: TemplatePayload, *, template_id: str, created_at: str | None = None) -> dict[str, Any]:
    return {
        "id": template_id,
        "name": payload.name.strip(),
        "channel": payload.channel,
        "category": payload.category.strip().lower(),
        "subject": payload.subject.strip() if payload.channel == "email" else "",
        "body": payload.body.strip(),
        "shortcut": payload.shortcut,
        "builtIn": False,
        "createdAt": created_at or now_iso(),
        "updatedAt": now_iso(),
    }


def all_templates(user: dict[str, Any]) -> list[dict[str, Any]]:
    builtins = [{**item, "builtIn": True, "createdAt": None, "updatedAt": None} for item in BUILTIN_TEMPLATES]
    return builtins + load_custom(user)


@router.get("")
def list_templates(channel: Literal["email", "whatsapp", "team"] | None = None, user: dict[str, Any] = Depends(current_user)):
    templates = all_templates(user)
    if channel:
        templates = [item for item in templates if item.get("channel") == channel]
    return {"templates": templates}


@router.post("")
def create_template(payload: TemplatePayload, user: dict[str, Any] = Depends(current_user)):
    with _lock:
        templates = load_custom(user)
        if payload.shortcut and any(item.get("shortcut") == payload.shortcut for item in templates):
            raise HTTPException(409, "Este atalho já está em uso em outro modelo.")
        item = sanitize(payload, template_id=f"template_{uuid.uuid4().hex[:16]}")
        templates.insert(0, item)
        save_custom(user, templates)
    return {"template": item}


@router.put("/{template_id}")
def update_template(template_id: str, payload: TemplatePayload, user: dict[str, Any] = Depends(current_user)):
    if template_id.startswith("builtin_"):
        raise HTTPException(409, "Duplique o modelo padrao antes de edita-lo.")
    with _lock:
        templates = load_custom(user)
        if payload.shortcut and any(item.get("shortcut") == payload.shortcut and item.get("id") != template_id for item in templates):
            raise HTTPException(409, "Este atalho já está em uso em outro modelo.")
        for index, current in enumerate(templates):
            if str(current.get("id")) == template_id:
                item = sanitize(payload, template_id=template_id, created_at=str(current.get("createdAt") or now_iso()))
                templates[index] = item
                save_custom(user, templates)
                return {"template": item}
    raise HTTPException(404, "Modelo nao encontrado.")


@router.delete("/{template_id}")
def delete_template(template_id: str, user: dict[str, Any] = Depends(current_user)):
    if template_id.startswith("builtin_"):
        raise HTTPException(409, "Modelos padrao nao podem ser excluidos.")
    with _lock:
        templates = load_custom(user)
        filtered = [item for item in templates if str(item.get("id")) != template_id]
        if len(filtered) == len(templates):
            raise HTTPException(404, "Modelo nao encontrado.")
        save_custom(user, filtered)
    return {"deleted": True}


@router.post("/render")
def render_template(payload: RenderPayload, user: dict[str, Any] = Depends(current_user)):
    item = next((template for template in all_templates(user) if str(template.get("id")) == payload.templateId), None)
    if not item:
        raise HTTPException(404, "Modelo nao encontrado.")
    variables = {key: str(value) for key, value in payload.variables.items() if key in ALLOWED_VARIABLES}
    missing: set[str] = set()

    def replace(match: re.Match[str]) -> str:
        key = match.group(1)
        value = variables.get(key, "").strip()
        if not value:
            missing.add(key)
            return match.group(0)
        return value

    return {
        "subject": re.sub(r"\{\{([a-z_]+)\}\}", replace, str(item.get("subject") or "")),
        "body": re.sub(r"\{\{([a-z_]+)\}\}", replace, str(item.get("body") or "")),
        "missingVariables": sorted(missing),
    }
