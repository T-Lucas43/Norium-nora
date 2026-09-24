"""Transactional email: encrypted durable queue, one recipient, no model calls."""
from __future__ import annotations

import asyncio
import base64
import hashlib
import html
import json
import logging
import os
import secrets
import smtplib
import ssl
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from email.message import EmailMessage
from email.utils import formataddr, formatdate
from functools import lru_cache
from pathlib import Path
from urllib.parse import urlsplit

from cryptography.fernet import Fernet, InvalidToken

from app.core.security import auth_secret
from app.core.tenant import get_system_db_path, read_json_file, write_json_file

SENDER = "suporte@norium-ai.com"
SOURCES = {"calendar", "kanban", "financeiro", "equipe", "automacoes", "brainstorm", "relatorios", "sistema", "clientes"}
SOURCE_NAMES = {"calendar": "Agenda", "kanban": "Tarefas", "financeiro": "Financeiro", "equipe": "Equipe", "automacoes": "Automações", "brainstorm": "Estúdio", "relatorios": "Relatórios", "sistema": "Sistema", "clientes": "Clientes"}
SOURCE_PATHS = {"calendar": "agenda", "kanban": "tarefas", "financeiro": "financeiro", "equipe": "chat-equipe", "automacoes": "automacoes", "brainstorm": "estudio", "relatorios": "relatorios", "clientes": "clientes"}
EVENT_TYPES = {
    "meeting_scheduled",
    "meeting_reminder",
    "task_due",
    "chat_mention",
    "finance_due",
    "client_follow_up",
    "client_shared",
}
EVENT_NAMES = {
    "meeting_scheduled": "Reuniões agendadas",
    "meeting_reminder": "Lembretes de reunião",
    "task_due": "Tarefas prestes a vencer",
    "chat_mention": "Menções no chat",
    "finance_due": "Contas a pagar",
    "client_follow_up": "Acompanhamentos de clientes",
    "client_shared": "Clientes compartilhados comigo",
}
logger = logging.getLogger(__name__)
smtp_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="system-smtp")
store_lock = threading.RLock()
WELCOME_CAMPAIGN = "nora-welcome-v1"
WELCOME_TITLE = "Boas-vindas ao Norium! Aqui quem fala é a Nora"
WELCOME_DESCRIPTION = "Aqui quem fala é a Nora. Boas-vindas ao Norium! Estou aqui para ajudar você a organizar tarefas, acompanhar reuniões e consultar as informações da sua operação. No meu chat, você pode fazer perguntas e pedir ajuda para aproveitar os recursos do sistema. Acesse sua conta e vamos começar!"
NORA_SIGNATURE_PATH = Path(__file__).resolve().parents[1] / "assets" / "nora_email_signature.html"


class SmtpCredentialUnavailable(RuntimeError):
    """A credencial SMTP esta ausente ou pertence a outra chave de criptografia."""


def cipher() -> Fernet:
    return Fernet(base64.urlsafe_b64encode(hashlib.sha256(auth_secret() + b":system-email:v1").digest()))


def configuration() -> dict:
    raw = read_json_file(get_system_db_path("system_email_config"), {})
    return raw if isinstance(raw, dict) else {}


def smtp_password(config: dict | None = None) -> str:
    environment_password = os.getenv("NORIUM_SMTP_PASSWORD", "")
    if environment_password:
        return environment_password
    encrypted = (config or configuration()).get("passwordEncrypted")
    if not encrypted:
        raise SmtpCredentialUnavailable("missing")
    try:
        password = cipher().decrypt(str(encrypted).encode()).decode()
    except (InvalidToken, ValueError, TypeError, UnicodeError) as error:
        raise SmtpCredentialUnavailable("invalid") from error
    if not password:
        raise SmtpCredentialUnavailable("missing")
    return password


def credential_status(config: dict | None = None) -> str:
    try:
        smtp_password(config)
    except SmtpCredentialUnavailable as error:
        return str(error)
    return "ok"


def ready() -> bool:
    config = configuration()
    return bool(config.get("enabled") and config.get("publicUrl") and credential_status(config) == "ok")


def save_configuration(password: str, enabled: bool, public_url: str) -> dict:
    parsed = urlsplit(public_url)
    if parsed.scheme != "https" or not parsed.netloc or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("Informe o endereço HTTPS público do Norium, sem parâmetros.")
    config = configuration()
    if password:
        config["passwordEncrypted"] = cipher().encrypt(password.encode()).decode()
    config.update(enabled=enabled, publicUrl=public_url.rstrip("/"))
    status = credential_status(config)
    if enabled and status == "missing":
        raise ValueError("Informe a senha da caixa de suporte para ativar os envios.")
    if enabled and status == "invalid":
        raise ValueError("A senha SMTP salva pertence a outra chave. Informe-a novamente para reativar os envios.")
    write_json_file(get_system_db_path("system_email_config"), config)
    if enabled and password:
        with store_lock:
            store = read_store()
            for job in store["outbox"]:
                if job.get("state") in {"pending", "failed", "sending"} and job.get("expires", 0) > time.time():
                    job.update(state="pending", attempts=0, next_attempt=0, error=None)
            write_store(store)
    return configuration_status()


def configuration_status() -> dict:
    config = configuration()
    status = credential_status(config)
    return {"sender": SENDER, "host": "smtp.hostinger.com", "port": 465, "enabled": bool(config.get("enabled")),
            "passwordConfigured": bool(config.get("passwordEncrypted") or os.getenv("NORIUM_SMTP_PASSWORD")),
            "credentialStatus": status, "publicUrl": config.get("publicUrl", ""),
            "ready": bool(config.get("enabled") and config.get("publicUrl") and status == "ok")}


def read_store() -> dict:
    raw = read_json_file(get_system_db_path("system_email"), {})
    if not isinstance(raw, dict):
        raw = {}
    return {
        "version": 1,
        "tokens": raw.get("tokens", []) if isinstance(raw.get("tokens"), list) else [],
        "outbox": raw.get("outbox", []) if isinstance(raw.get("outbox"), list) else [],
        "campaigns": raw.get("campaigns", {}) if isinstance(raw.get("campaigns"), dict) else {},
    }


def write_store(store: dict) -> None:
    write_json_file(get_system_db_path("system_email"), store)


@lru_cache(maxsize=1)
def nora_signature_html() -> str:
    return NORA_SIGNATURE_PATH.read_text(encoding="utf-8").strip()


def render_message(name: str, title: str, description: str, link: str, button: str) -> dict:
    text = (
        f"Olá, {name}.\n\n{title}\n\n{description}\n\n{button}: {link}\n\n"
        f"Nora\nAssistente virtual do Norium\n{SENDER}\nhttps://norium-ai.com\n\n"
        "Gerencie suas notificações na sua conta do Norium."
    )
    esc = html.escape
    body = f'''<!doctype html><html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;background:#080c12;color:#eaf2ff;font-family:Arial,sans-serif">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td style="padding:32px 16px">
<table role="presentation" cellspacing="0" cellpadding="0" style="max-width:600px;width:100%;margin:auto;background:#101822;border:1px solid #26364b;border-radius:16px">
<tr><td style="padding:32px">
<div style="color:#22d3ee;font-size:20px;font-weight:bold;letter-spacing:1px">NORIUM</div>
<p style="color:#aabbd0">Olá, {esc(name)}.</p>
<h1 style="font-size:24px;line-height:1.3">{esc(title)}</h1>
<p style="white-space:pre-wrap;line-height:1.7;color:#c2d0e2">{esc(description)}</p>
<p style="margin:30px 0"><a href="{esc(link, quote=True)}" style="display:inline-block;background:#1765ee;color:white;padding:14px 22px;border-radius:9px;text-decoration:none;font-weight:bold">{esc(button)}</a></p>
<p style="font-size:12px;overflow-wrap:anywhere;word-break:break-word;color:#9aacc2">Se o botão não abrir, copie este endereço:<br>{esc(link)}</p>
<hr style="margin:28px 0 22px;border:0;border-top:1px solid #26364b">
{nora_signature_html()}
<p style="margin:20px 0 0;font-size:11px;line-height:1.5;color:#7f93ab">Esta mensagem foi enviada pelo Norium para a sua conta. Gerencie suas notificações no perfil.</p>
</td></tr></table></td></tr></table></body></html>'''
    return {"subject": f"Norium — {title}"[:180], "text": text, "html": body}


def _enqueue(store: dict, user: dict, kind: str, payload: dict, key: str, expires: float) -> bool:
    if any(job.get("id") == key for job in store["outbox"]):
        return False
    encrypted = cipher().encrypt(json.dumps(payload, ensure_ascii=False).encode()).decode()
    store["outbox"].append({"id": key, "user_id": user["id"], "recipient": user["email"], "kind": kind,
                            "payload": encrypted, "created": time.time(), "expires": expires, "state": "pending",
                            "attempts": 0, "next_attempt": 0, "lease": "", "lease_until": 0, "error": None})
    return True


def enqueue_direct(user: dict, kind: str, payload: dict, key: str, expires: float) -> bool:
    with store_lock:
        store = read_store()
        inserted = _enqueue(store, user, kind, payload, key, expires)
        if inserted:
            write_store(store)
        return inserted


def issue_action(user: dict, purpose: str) -> bool:
    if not ready():
        return False
    now = time.time()
    expires = now + (1800 if purpose == "reset" else 86400)
    token = secrets.token_urlsafe(32)
    digest = hashlib.sha256(token.encode()).hexdigest()
    link = f'{configuration()["publicUrl"]}/app#/{"redefinir-senha" if purpose == "reset" else "confirmar-email"}/{token}'
    title = "Redefina sua senha" if purpose == "reset" else "Confirme seu e-mail"
    description = "Recebemos uma solicitação de redefinição de senha. O link é válido por 30 minutos e pode ser usado uma única vez. Se não foi você, ignore esta mensagem." if purpose == "reset" else "Confirme que este endereço pertence a você para receber as notificações da sua conta. O link é válido por 24 horas e pode ser usado uma única vez."
    payload = render_message(user.get("nome", ""), title, description, link, title)
    with store_lock:
        store = read_store()
        recent = [item for item in store["tokens"] if item.get("user_id") == user["id"] and item.get("purpose") == purpose and item.get("created", 0) > now - 3600]
        latest = max((item.get("created", 0) for item in recent), default=0)
        if len(recent) >= 3 or (latest and now - latest < 60):
            return False
        for item in store["tokens"]:
            if item.get("user_id") == user["id"] and item.get("purpose") == purpose:
                item["used"] = True
        for job in store["outbox"]:
            if job.get("user_id") == user["id"] and job.get("kind") == purpose and job.get("state") == "pending":
                job.update(state="skipped", payload="")
        store["tokens"].append({"digest": digest, "user_id": user["id"], "email": user["email"], "purpose": purpose,
                                "version": int(user.get("sessionVersion") or 0), "created": now, "expires": expires, "used": False})
        _enqueue(store, user, purpose, payload, digest, expires)
        write_store(store)
    return True


def consume_action(token: str, purpose: str) -> dict | None:
    digest = hashlib.sha256(token.encode()).hexdigest()
    with store_lock:
        store = read_store()
        row = next((item for item in store["tokens"] if item.get("digest") == digest and item.get("purpose") == purpose and not item.get("used") and item.get("expires", 0) > time.time()), None)
        if row is None:
            return None
        row["used"] = True
        write_store(store)
        return dict(row)


def queue_security_notice(user: dict) -> None:
    if not ready():
        return
    payload = render_message(user.get("nome", ""), "Sua senha foi alterada", "A senha da sua conta foi redefinida e as sessões anteriores foram encerradas. Se você não reconhece essa alteração, entre em contato com o suporte.", configuration()["publicUrl"] + "/app", "Acessar minha conta")
    enqueue_direct(user, "security", payload, secrets.token_hex(24), time.time() + 86400)


def queue_welcome(users: list[dict]) -> dict:
    return queue_campaign(users, WELCOME_CAMPAIGN, "welcome", WELCOME_TITLE, WELCOME_DESCRIPTION, "/app/nora", "Conversar com a Nora")


def queue_campaign(users: list[dict], campaign: str, kind: str, title: str, description: str, path: str = "/app", button: str = "Abrir Norium") -> dict:
    """One explicit administrative campaign, deduplicated even across restarts."""
    if not ready():
        raise ValueError("Configure e ative o envio primeiro.")
    queued = existing = skipped = 0
    public_url = configuration()["publicUrl"]
    with store_lock:
        store = read_store()
        recipients = store["campaigns"].setdefault(campaign, [])
        for user in users:
            recipient = str(user.get("email") or "").strip().lower()
            if user.get("status") != "ativo" or not user.get("id") or "@" not in recipient or any(character.isspace() for character in recipient) or not preferences(user)["enabled"]:
                skipped += 1
                continue
            digest = hashlib.sha256(recipient.encode()).hexdigest()
            if digest in recipients:
                existing += 1
                continue
            recipients.append(digest)
            payload = render_message(user.get("nome", ""), title, description, public_url + path, button)
            _enqueue(store, {**user, "email": recipient}, kind, payload, campaign + "_" + digest, time.time() + 7 * 86400)
            queued += 1
        write_store(store)
    return {"queued": queued, "alreadyQueued": existing, "skipped": skipped}


def delivery_status() -> dict:
    try:
        with store_lock:
            store = read_store()
        counts: dict[str, int] = {}
        now = time.time()
        for job in store["outbox"]:
            state = "expired" if job.get("state") in {"pending", "sending"} and job.get("expires", 0) <= now else job.get("state", "pending")
            counts[state] = counts.get(state, 0) + 1
        recent = [{key: job.get(key) for key in ("kind", "state", "attempts", "error", "created")} for job in sorted(store["outbox"], key=lambda item: item.get("created", 0), reverse=True)[:10]]
        return {"available": True, "counts": counts, "recent": recent, "welcome": {"title": WELCOME_TITLE, "description": WELCOME_DESCRIPTION}}
    except OSError as error:
        code = type(error).__name__
        logger.error("system_email_storage_unavailable code=%s", code)
        return {"available": False, "error": f"O armazenamento da fila está indisponível ({code}). Os envios permanecem bloqueados até a correção.", "counts": {}, "recent": [], "welcome": {"title": WELCOME_TITLE, "description": WELCOME_DESCRIPTION}}


def preferences(user: dict) -> dict:
    raw = user.get("emailNotifications") or {}
    return {
        "enabled": raw.get("enabled", True),
        "sources": {
            key: (raw.get("sources") or {}).get(key, True)
            for key in sorted(SOURCES)
        },
        "events": {
            key: (raw.get("events") or {}).get(key, True)
            for key in sorted(EVENT_TYPES)
        },
    }


def notification_event_type(event: dict) -> str | None:
    metadata = event.get("metadata") if isinstance(event.get("metadata"), dict) else {}
    requested = str(metadata.get("emailCategory") or "")
    if requested in EVENT_TYPES:
        return requested
    return {
        "team_meeting_scheduled": "meeting_scheduled",
        "team_meeting_reminder": "meeting_reminder",
        "team_member_mentioned": "chat_mention",
    }.get(str(metadata.get("action") or ""))


def queue_notification(user: dict, event: dict, workspace: str = "primary", lifetime: float = 86400) -> bool:
    source = event.get("source")
    pref = preferences(user)
    event_type = notification_event_type(event)
    if (
        source not in SOURCES
        or not ready()
        or not user.get("emailVerifiedAt")
        or not pref["enabled"]
        or (event_type and not pref["events"].get(event_type))
        or (not event_type and not pref["sources"].get(source))
    ):
        return False
    if str((event.get("metadata") or {}).get("userId") or "") != str(user["id"]):
        return False
    title = str(event.get("title") or (EVENT_NAMES.get(event_type) if event_type else SOURCE_NAMES[source]))[:180]
    # Avoid copying private email/WhatsApp content or arbitrary event metadata.
    description = f"Há uma atualização em {SOURCE_NAMES[source]} na sua conta. Abra o Norium para consultar os detalhes com segurança."
    link = configuration()["publicUrl"] + "/app/" + SOURCE_PATHS.get(source, "central")
    payload = render_message(user.get("nome", ""), title, description, link, "Abrir no Norium")
    key = hashlib.sha256(f'{user["id"]}:{workspace}:{event["id"]}'.encode()).hexdigest()
    return enqueue_direct(user, f"event:{event_type}" if event_type else source, payload, key, time.time() + lifetime)


async def notify_event(event: dict, workspace: str) -> None:
    if event.get("source") not in SOURCES:
        return
    # Chat messages are sent through their resolved participant list, not the
    # team's audit owner (who may not belong to a direct/subteam conversation).
    if (event.get("metadata") or {}).get("action") in {"team_message_created", "meeting_recording"}:
        return
    try:
        if not await asyncio.to_thread(ready):
            return
        from app.modules.auth.router import read_user_store, find_user
        user = find_user(await read_user_store(), str((event.get("metadata") or {}).get("userId") or ""))
        if user and user.get("status") == "ativo":
            await asyncio.to_thread(queue_notification, user, event, workspace)
    except Exception:
        logger.warning("system_email_enqueue_failed")


async def notify_team_participants(participant_ids: set[str], event_id: str, title: str) -> None:
    try:
        if not await asyncio.to_thread(ready):
            return
        from app.core.request_context import current_workspace_id
        from app.modules.auth.router import read_user_store, find_user
        store = await read_user_store()
        for participant_id in participant_ids:
            user = find_user(store, participant_id)
            if user and user.get("status") == "ativo":
                await asyncio.to_thread(queue_notification, user, {"id": event_id, "source": "equipe", "title": title, "metadata": {"userId": participant_id}}, current_workspace_id())
    except Exception:
        logger.warning("system_email_team_queue_failed")


def claim_delivery() -> dict | None:
    now = time.time()
    with store_lock:
        store = read_store()
        original_outbox_size = len(store["outbox"])
        original_token_size = len(store["tokens"])
        store["outbox"] = [job for job in store["outbox"] if job.get("expires", 0) >= now - 7 * 86400]
        store["tokens"] = [item for item in store["tokens"] if item.get("expires", 0) >= now - 7 * 86400]
        dirty = len(store["outbox"]) != original_outbox_size or len(store["tokens"]) != original_token_size
        for job in store["outbox"]:
            if job.get("state") == "sending" and job.get("lease_until", 0) < now and job.get("attempts", 0) >= 5:
                job.update(state="failed", error="delivery")
                dirty = True
        candidates = [job for job in store["outbox"] if job.get("attempts", 0) < 5 and job.get("expires", 0) > now and job.get("next_attempt", 0) <= now and (job.get("state") == "pending" or (job.get("state") == "sending" and job.get("lease_until", 0) < now))]
        candidates.sort(key=lambda job: (0 if job.get("kind") in {"reset", "verify", "test", "security"} else 1, job.get("created", 0)))
        if not candidates:
            if dirty:
                write_store(store)
            return None
        lease = secrets.token_hex(16)
        row = candidates[0]
        row.update(state="sending", lease=lease, lease_until=now + 300, attempts=row.get("attempts", 0) + 1)
        write_store(store)
        return dict(row)


def finish_delivery(job: dict, state: str, error: str = "") -> None:
    with store_lock:
        store = read_store()
        row = next((item for item in store["outbox"] if item.get("id") == job["id"] and item.get("lease") == job["lease"]), None)
        if row:
            row.update(state=state, error=error or None, next_attempt=time.time() + min(3600, 60 * 2 ** job["attempts"]))
            if state in {"sent", "skipped"}:
                row["payload"] = ""
            write_store(store)


def send_smtp(job: dict) -> None:
    config = configuration()
    password = smtp_password(config)
    payload = json.loads(cipher().decrypt(job["payload"].encode()))
    message = EmailMessage()
    message["From"] = formataddr(("Norium", SENDER))
    message["To"] = job["recipient"]
    message["Reply-To"] = SENDER
    message["Subject"] = payload["subject"]
    message["Date"] = formatdate(localtime=False)
    message["Message-ID"] = f'<{job["id"]}@norium-ai.com>'
    if job["kind"] != "manual":
        message["Auto-Submitted"] = "auto-generated"
    message.set_content(payload["text"])
    message.add_alternative(payload["html"], subtype="html")
    with smtplib.SMTP_SSL("smtp.hostinger.com", 465, timeout=10, context=ssl.create_default_context()) as smtp:
        smtp.login(SENDER, password)
        smtp.send_message(message, from_addr=SENDER, to_addrs=[job["recipient"]])


async def deliver_one() -> bool:
    if not await asyncio.to_thread(ready):
        return False
    job = await asyncio.to_thread(claim_delivery)
    if not job:
        return False
    from app.modules.auth.router import read_user_store, find_user
    user = find_user(await read_user_store(), job["user_id"])
    pref = preferences(user or {})
    allowed = user and user.get("status") == "ativo" and str(user.get("email", "")).lower() == job["recipient"].lower()
    if job["kind"] in {"welcome", "manual"}:
        allowed = allowed and pref["enabled"]
    if job["kind"] in SOURCES:
        allowed = allowed and user.get("emailVerifiedAt") and pref["enabled"] and pref["sources"].get(job["kind"])
    if str(job["kind"]).startswith("event:"):
        event_type = str(job["kind"]).split(":", 1)[1]
        allowed = allowed and user.get("emailVerifiedAt") and pref["enabled"] and event_type in EVENT_TYPES and pref["events"].get(event_type)
    if job["kind"] in {"reset", "verify"} and allowed:
        def action_is_current():
            with store_lock:
                record = next((item for item in read_store()["tokens"] if item.get("digest") == job["id"] and not item.get("used") and item.get("expires", 0) > time.time()), None)
            return record is not None and record["version"] == int(user.get("sessionVersion") or 0)
        allowed = await asyncio.to_thread(action_is_current)
    if not allowed:
        await asyncio.to_thread(finish_delivery, job, "skipped")
        return True
    try:
        await asyncio.get_running_loop().run_in_executor(smtp_executor, send_smtp, job)
    except Exception as error:
        if isinstance(error, SmtpCredentialUnavailable):
            code = "credential"
        elif isinstance(error, smtplib.SMTPAuthenticationError):
            code = "authentication"
        else:
            code = "delivery"
        await asyncio.to_thread(finish_delivery, job, "pending" if job["attempts"] < 5 else "failed", code)
        logger.warning("system_email_delivery_failed kind=%s code=%s", job["kind"], code)
    else:
        await asyncio.to_thread(finish_delivery, job, "sent")
    return True


async def worker() -> None:
    while True:
        try:
            delivered = await deliver_one()
        except Exception:
            delivered = False
            logger.warning("system_email_worker_unavailable")
        await asyncio.sleep(1 if delivered else 15)
