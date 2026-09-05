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
import sqlite3
import ssl
import time
from contextlib import contextmanager
from concurrent.futures import ThreadPoolExecutor
from email.message import EmailMessage
from email.utils import formataddr
from urllib.parse import urlsplit

from cryptography.fernet import Fernet

from app.core.security import auth_secret
from app.core.tenant import get_data_root, get_system_db_path, read_json_file, write_json_file

SENDER = "suporte@norium-ai.com"
SOURCES = {"calendar", "kanban", "financeiro", "equipe", "automacoes", "brainstorm", "relatorios", "sistema", "clientes"}
SOURCE_NAMES = {"calendar": "Agenda", "kanban": "Tarefas", "financeiro": "Financeiro", "equipe": "Equipe", "automacoes": "Automações", "brainstorm": "Estúdio", "relatorios": "Relatórios", "sistema": "Sistema", "clientes": "Clientes"}
SOURCE_PATHS = {"calendar": "agenda", "kanban": "tarefas", "financeiro": "financeiro", "equipe": "chat-equipe", "automacoes": "automacoes", "brainstorm": "estudio", "relatorios": "relatorios", "clientes": "clientes"}
logger = logging.getLogger(__name__)
smtp_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="system-smtp")
WELCOME_CAMPAIGN = "nora-welcome-v1"
WELCOME_TITLE = "Boas-vindas ao Norium! Aqui quem fala é a Nora"
WELCOME_DESCRIPTION = "Aqui quem fala é a Nora. Boas-vindas ao Norium! Estou aqui para ajudar você a organizar tarefas, acompanhar reuniões e consultar as informações da sua operação. No meu chat, você pode fazer perguntas e pedir ajuda para aproveitar os recursos do sistema. Acesse sua conta e vamos começar!"


def cipher() -> Fernet:
    return Fernet(base64.urlsafe_b64encode(hashlib.sha256(auth_secret() + b":system-email:v1").digest()))


def configuration() -> dict:
    raw = read_json_file(get_system_db_path("system_email_config"), {})
    return raw if isinstance(raw, dict) else {}


def ready() -> bool:
    config = configuration()
    return bool(config.get("enabled") and (config.get("passwordEncrypted") or os.getenv("NORIUM_SMTP_PASSWORD")) and config.get("publicUrl"))


def save_configuration(password: str, enabled: bool, public_url: str) -> dict:
    parsed = urlsplit(public_url)
    if parsed.scheme != "https" or not parsed.netloc or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("Informe o endereço HTTPS público do Norium, sem parâmetros.")
    config = configuration()
    if password:
        config["passwordEncrypted"] = cipher().encrypt(password.encode()).decode()
    config.update(enabled=enabled, publicUrl=public_url.rstrip("/"))
    if enabled and not (config.get("passwordEncrypted") or os.getenv("NORIUM_SMTP_PASSWORD")):
        raise ValueError("Informe a senha da caixa de suporte para ativar os envios.")
    write_json_file(get_system_db_path("system_email_config"), config)
    if enabled and password:
        with database() as connection:
            connection.execute("UPDATE email_outbox SET state='pending',attempts=0,next_attempt=0,error=NULL WHERE state='failed' AND expires>?", (time.time(),))
    return configuration_status()


def configuration_status() -> dict:
    config = configuration()
    return {"sender": SENDER, "host": "smtp.hostinger.com", "port": 465, "enabled": bool(config.get("enabled")),
            "passwordConfigured": bool(config.get("passwordEncrypted") or os.getenv("NORIUM_SMTP_PASSWORD")),
            "publicUrl": config.get("publicUrl", ""), "ready": ready()}


@contextmanager
def database():
    connection = sqlite3.connect(get_data_root() / "system_email.sqlite3", timeout=3)
    connection.row_factory = sqlite3.Row
    try:
        connection.execute("CREATE TABLE IF NOT EXISTS email_tokens (digest TEXT PRIMARY KEY, user_id TEXT, email TEXT, purpose TEXT, version INTEGER, created REAL, expires REAL, used INTEGER DEFAULT 0)")
        connection.execute("CREATE INDEX IF NOT EXISTS email_tokens_user ON email_tokens(user_id, purpose, created)")
        connection.execute("CREATE TABLE IF NOT EXISTS email_outbox (id TEXT PRIMARY KEY, user_id TEXT, recipient TEXT, kind TEXT, payload TEXT, created REAL, expires REAL, state TEXT DEFAULT 'pending', attempts INTEGER DEFAULT 0, next_attempt REAL DEFAULT 0, lease TEXT, lease_until REAL DEFAULT 0, error TEXT)")
        connection.execute("CREATE INDEX IF NOT EXISTS email_outbox_due ON email_outbox(state,next_attempt,expires)")
        connection.execute("CREATE TABLE IF NOT EXISTS email_campaign_recipients (campaign TEXT, recipient_digest TEXT, PRIMARY KEY(campaign,recipient_digest))")
        connection.commit()
        yield connection
        connection.commit()
    finally:
        connection.close()


def render_message(name: str, title: str, description: str, link: str, button: str) -> dict:
    text = f"Olá, {name}.\n\n{title}\n\n{description}\n\n{button}: {link}\n\nNorium • {SENDER}\nGerencie notificações na sua conta do Norium."
    esc = html.escape
    body = f'<html lang="pt-BR"><body style="margin:0;background:#080c12;color:#eaf2ff;font-family:Arial,sans-serif"><table role="presentation" width="100%"><tr><td style="padding:32px 16px"><table role="presentation" style="max-width:600px;width:100%;margin:auto;background:#101822;border:1px solid #26364b;border-radius:16px"><tr><td style="padding:32px"><div style="color:#22d3ee;font-size:20px;font-weight:bold">NORIUM</div><p style="color:#aabbd0">Olá, {esc(name)}.</p><h1 style="font-size:24px;line-height:1.3">{esc(title)}</h1><p style="line-height:1.7;color:#c2d0e2">{esc(description)}</p><p style="margin:30px 0"><a href="{esc(link, quote=True)}" style="display:inline-block;background:#1765ee;color:white;padding:14px 22px;border-radius:9px;text-decoration:none;font-weight:bold">{esc(button)}</a></p><p style="font-size:12px;color:#9aacc2">Se o botão não abrir, copie este endereço:<br>{esc(link)}</p><hr style="border:0;border-top:1px solid #26364b"><p style="font-size:12px;color:#9aacc2">Norium · {SENDER}<br>Gerencie notificações na sua conta do Norium.</p></td></tr></table></td></tr></table></body></html>'
    return {"subject": f"Norium — {title}"[:180], "text": text, "html": body}


def _enqueue(connection, user: dict, kind: str, payload: dict, key: str, expires: float) -> bool:
    encrypted = cipher().encrypt(json.dumps(payload, ensure_ascii=False).encode()).decode()
    return connection.execute("INSERT OR IGNORE INTO email_outbox(id,user_id,recipient,kind,payload,created,expires) VALUES(?,?,?,?,?,?,?)",
                              (key, user["id"], user["email"], kind, encrypted, time.time(), expires)).rowcount == 1


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
    with database() as connection:
        connection.execute("BEGIN IMMEDIATE")
        recent = connection.execute("SELECT count(*), max(created) FROM email_tokens WHERE user_id=? AND purpose=? AND created>?", (user["id"], purpose, now - 3600)).fetchone()
        if recent[0] >= 3 or (recent[1] and now - recent[1] < 60):
            return False
        connection.execute("UPDATE email_tokens SET used=1 WHERE user_id=? AND purpose=?", (user["id"], purpose))
        connection.execute("UPDATE email_outbox SET state='skipped',payload='' WHERE user_id=? AND kind=? AND state='pending'", (user["id"], purpose))
        connection.execute("INSERT INTO email_tokens(digest,user_id,email,purpose,version,created,expires) VALUES(?,?,?,?,?,?,?)", (digest, user["id"], user["email"], purpose, int(user.get("sessionVersion") or 0), now, expires))
        _enqueue(connection, user, purpose, payload, digest, expires)
    return True


def consume_action(token: str, purpose: str) -> dict | None:
    digest = hashlib.sha256(token.encode()).hexdigest()
    with database() as connection:
        connection.execute("BEGIN IMMEDIATE")
        row = connection.execute("SELECT * FROM email_tokens WHERE digest=? AND purpose=? AND used=0 AND expires>?", (digest, purpose, time.time())).fetchone()
        if row is None:
            return None
        connection.execute("UPDATE email_tokens SET used=1 WHERE digest=?", (digest,))
        return dict(row)


def queue_security_notice(user: dict) -> None:
    if not ready():
        return
    payload = render_message(user.get("nome", ""), "Sua senha foi alterada", "A senha da sua conta foi redefinida e as sessões anteriores foram encerradas. Se você não reconhece essa alteração, entre em contato com o suporte.", configuration()["publicUrl"] + "/app", "Acessar minha conta")
    with database() as connection:
        _enqueue(connection, user, "security", payload, secrets.token_hex(24), time.time() + 86400)


def queue_welcome(users: list[dict]) -> dict:
    """One explicit administrative campaign, deduplicated even across restarts."""
    if not ready():
        raise ValueError("Configure e ative o envio primeiro.")
    queued = existing = skipped = 0
    public_url = configuration()["publicUrl"]
    with database() as connection:
        connection.execute("BEGIN IMMEDIATE")
        for user in users:
            recipient = str(user.get("email") or "").strip().lower()
            if user.get("status") != "ativo" or not user.get("id") or "@" not in recipient or any(character.isspace() for character in recipient) or not preferences(user)["enabled"]:
                skipped += 1
                continue
            digest = hashlib.sha256(recipient.encode()).hexdigest()
            inserted = connection.execute("INSERT OR IGNORE INTO email_campaign_recipients VALUES(?,?)", (WELCOME_CAMPAIGN, digest)).rowcount
            if not inserted:
                existing += 1
                continue
            payload = render_message(user.get("nome", ""), WELCOME_TITLE, WELCOME_DESCRIPTION, public_url + "/app/nora", "Conversar com a Nora")
            _enqueue(connection, {**user, "email": recipient}, "welcome", payload, WELCOME_CAMPAIGN + "_" + digest, time.time() + 7 * 86400)
            queued += 1
    return {"queued": queued, "alreadyQueued": existing, "skipped": skipped}


def delivery_status() -> dict:
    with database() as connection:
        counts = {row["state"]: row["total"] for row in connection.execute("SELECT CASE WHEN state IN ('pending','sending') AND expires<=? THEN 'expired' ELSE state END AS state,count(*) total FROM email_outbox GROUP BY 1", (time.time(),))}
        recent = [dict(row) for row in connection.execute("SELECT kind,state,attempts,error,created FROM email_outbox ORDER BY created DESC LIMIT 10")]
    return {"counts": counts, "recent": recent, "welcome": {"title": WELCOME_TITLE, "description": WELCOME_DESCRIPTION}}


def preferences(user: dict) -> dict:
    raw = user.get("emailNotifications") or {}
    return {"enabled": raw.get("enabled", True), "sources": {key: (raw.get("sources") or {}).get(key, True) for key in sorted(SOURCES)}}


def queue_notification(user: dict, event: dict, workspace: str = "primary", lifetime: float = 86400) -> bool:
    source = event.get("source")
    pref = preferences(user)
    if source not in SOURCES or not ready() or not user.get("emailVerifiedAt") or not pref["enabled"] or not pref["sources"].get(source):
        return False
    if str((event.get("metadata") or {}).get("userId") or "") != str(user["id"]):
        return False
    title = str(event.get("title") or SOURCE_NAMES[source])[:180]
    # Avoid copying private email/WhatsApp content or arbitrary event metadata.
    description = f"Há uma atualização em {SOURCE_NAMES[source]} na sua conta. Abra o Norium para consultar os detalhes com segurança."
    link = configuration()["publicUrl"] + "/app/" + SOURCE_PATHS.get(source, "central")
    payload = render_message(user.get("nome", ""), title, description, link, "Abrir no Norium")
    key = hashlib.sha256(f'{user["id"]}:{workspace}:{event["id"]}'.encode()).hexdigest()
    with database() as connection:
        return _enqueue(connection, user, source, payload, key, time.time() + lifetime)


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
    with database() as connection:
        connection.execute("BEGIN IMMEDIATE")
        connection.execute("DELETE FROM email_outbox WHERE expires<?", (now - 7 * 86400,))
        connection.execute("DELETE FROM email_tokens WHERE expires<?", (now - 7 * 86400,))
        connection.execute("UPDATE email_outbox SET state='failed',error='delivery' WHERE state='sending' AND lease_until<? AND attempts>=5", (now,))
        row = connection.execute("SELECT * FROM email_outbox WHERE attempts<5 AND expires>? AND next_attempt<=? AND (state='pending' OR (state='sending' AND lease_until<?)) ORDER BY CASE WHEN kind IN ('reset','verify','test','security') THEN 0 ELSE 1 END, created LIMIT 1", (now, now, now)).fetchone()
        if row is None:
            return None
        lease = secrets.token_hex(16)
        connection.execute("UPDATE email_outbox SET state='sending',lease=?,lease_until=?,attempts=attempts+1 WHERE id=?", (lease, now + 300, row["id"]))
        return {**dict(row), "lease": lease, "attempts": row["attempts"] + 1}


def finish_delivery(job: dict, state: str, error: str = "") -> None:
    with database() as connection:
        connection.execute("UPDATE email_outbox SET state=?,error=?,next_attempt=?,payload=CASE WHEN ? IN ('sent','skipped') THEN '' ELSE payload END WHERE id=? AND lease=?",
                           (state, error, time.time() + min(3600, 60 * 2 ** job["attempts"]), state, job["id"], job["lease"]))


def send_smtp(job: dict) -> None:
    config = configuration()
    password = os.getenv("NORIUM_SMTP_PASSWORD") or cipher().decrypt(config["passwordEncrypted"].encode()).decode()
    payload = json.loads(cipher().decrypt(job["payload"].encode()))
    message = EmailMessage()
    message["From"] = formataddr(("Norium", SENDER))
    message["To"] = job["recipient"]
    message["Reply-To"] = SENDER
    message["Subject"] = payload["subject"]
    message["Message-ID"] = f'<{job["id"]}@norium-ai.com>'
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
    if job["kind"] == "welcome":
        allowed = allowed and pref["enabled"]
    if job["kind"] in SOURCES:
        allowed = allowed and user.get("emailVerifiedAt") and pref["enabled"] and pref["sources"].get(job["kind"])
    if job["kind"] in {"reset", "verify"} and allowed:
        def action_is_current():
            with database() as connection:
                record = connection.execute("SELECT version FROM email_tokens WHERE digest=? AND used=0 AND expires>?", (job["id"], time.time())).fetchone()
                return record is not None and record["version"] == int(user.get("sessionVersion") or 0)
        allowed = await asyncio.to_thread(action_is_current)
    if not allowed:
        await asyncio.to_thread(finish_delivery, job, "skipped")
        return True
    try:
        await asyncio.get_running_loop().run_in_executor(smtp_executor, send_smtp, job)
    except Exception as error:
        code = "authentication" if isinstance(error, smtplib.SMTPAuthenticationError) else "delivery"
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
