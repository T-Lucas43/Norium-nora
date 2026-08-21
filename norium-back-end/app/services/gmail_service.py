from __future__ import annotations

import base64
import hashlib
import html
import json
import logging
import mimetypes
import os
import re
import uuid
from datetime import datetime, timedelta, timezone
from email.header import decode_header, make_header
from email.message import EmailMessage
from email.utils import formatdate, make_msgid, parseaddr
from pathlib import Path
from typing import Any
from urllib.parse import quote

from dotenv import load_dotenv
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import Flow
from googleapiclient.discovery import build

from app.core.tenant import (
    public_api_url,
    read_account_db,
    read_profile_db,
    write_account_db,
)
from app.services.oauth_state import active_oauth_attempts, find_oauth_attempt, oauth_attempts_payload

BASE_DIR = Path(__file__).resolve().parents[2]
load_dotenv(BASE_DIR / ".env")
logger = logging.getLogger(__name__)

SCOPES = [
    "openid",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/gmail.compose",
    "https://www.googleapis.com/auth/gmail.labels",
]
TOKEN_PATH = BASE_DIR / "gmail_token.json"
OAUTH_STATE_PATH = BASE_DIR / "gmail_oauth_state.json"
SYNC_STATE_PATH = BASE_DIR / "gmail_sync_state.json"
PROFILE_CACHE_PATH = BASE_DIR / "gmail_profile_cache.json"
DEFAULT_REDIRECT_URI = "http://localhost:8000/api/auth/callback/gmail"
LOCAL_TZ = timezone(timedelta(hours=-3))
MAX_ATTACHMENT_BYTES = 24 * 1024 * 1024
PROFILE_CACHE_TTL_SECONDS = 600
OAUTH_STATE_TTL_SECONDS = 20 * 60
MAX_OAUTH_ATTEMPTS = 5
MAILBOX_CACHE_TTL_SECONDS = 30
MAILBOX_CACHE_MAX_ENTRIES = 24
INTEGRATION_DB_NAME = "gmail_integration"

FOLDER_LABELS = {
    "inbox": ["INBOX"],
    "sent": ["SENT"],
    "spam": ["SPAM"],
    "trash": ["TRASH"],
    "starred": ["STARRED"],
    "important": ["IMPORTANT"],
}

FOLDER_QUERIES = {
    "all": ["in:anywhere", "-in:spam", "-in:trash"],
    "unread": ["is:unread"],
    "scheduled": ["in:scheduled"],
}


class GmailConfigError(RuntimeError):
    pass


class GmailService:
    def __init__(self, user_id: str = "lucas123") -> None:
        self.user_id = user_id

    @staticmethod
    def user_id_from_state(state: str | None) -> str | None:
        if not state:
            return None
        parts = state.split(":", 1)
        if len(parts) != 2 or not re.fullmatch(r"[0-9a-f]{32}", parts[1]):
            return None
        user_id = parts[0].strip()
        return user_id or None

    def status(self) -> dict[str, Any]:
        configured = bool(self._client_config())
        connected = False
        detail = ""
        profile: dict[str, Any] = {}
        if configured:
            try:
                creds = self._credentials(refresh=True)
                connected = bool(creds and creds.valid)
                if connected:
                    profile = self._cached_profile() or self._profile()
                    if profile:
                        self._save_profile_cache(profile)
            except Exception:
                logger.exception("Falha ao validar a conexao do Gmail.")
                detail = "Falha ao validar a conexao."

        sync_state = self._read_profile_section("gmailSync", {})
        return {
            "configured": configured,
            "connected": connected,
            "source": "gmail" if connected else "disconnected",
            "email": profile.get("emailAddress"),
            "name": profile.get("name"),
            "picture": profile.get("picture"),
            "messagesTotal": profile.get("messagesTotal"),
            "threadsTotal": profile.get("threadsTotal"),
            "lastSync": sync_state.get("lastSync"),
            "detail": detail,
        }

    def authorization_url(self) -> dict[str, str]:
        state_value = f"{self._safe_user_id()}:{uuid.uuid4().hex}"
        flow = self._flow(state=state_value)
        auth_url, state = flow.authorization_url(
            access_type="offline",
            prompt="consent",
        )
        attempts = active_oauth_attempts(
            self._read_profile_section("gmailOauthState", {}),
            ttl_seconds=OAUTH_STATE_TTL_SECONDS,
        )
        attempts.append({
            "state": state,
            "codeVerifier": flow.code_verifier,
            "createdAt": self._now_iso(),
        })
        self._write_profile_section(
            "gmailOauthState",
            oauth_attempts_payload(attempts[-MAX_OAUTH_ATTEMPTS:]),
        )
        return {"auth_url": auth_url, "state": state}

    def finish_oauth(self, *, code: str, state: str | None) -> dict[str, Any]:
        oauth_state = self._read_profile_section("gmailOauthState", {})
        attempt, remaining_attempts = find_oauth_attempt(oauth_state, state)
        if attempt is None:
            raise GmailConfigError("Estado OAuth invalido. Gere um novo link de conexao.")

        try:
            created_at = datetime.fromisoformat(str(attempt.get("createdAt") or ""))
            if created_at.tzinfo is None:
                created_at = created_at.replace(tzinfo=timezone.utc)
        except ValueError as exc:
            self._write_profile_section("gmailOauthState", oauth_attempts_payload(remaining_attempts))
            raise GmailConfigError("Sessao OAuth expirada. Gere um novo link de conexao do Gmail.") from exc
        if datetime.now(timezone.utc) - created_at > timedelta(seconds=OAUTH_STATE_TTL_SECONDS):
            self._write_profile_section("gmailOauthState", oauth_attempts_payload(remaining_attempts))
            raise GmailConfigError("Sessao OAuth expirada. Gere um novo link de conexao do Gmail.")

        code_verifier = attempt.get("codeVerifier")
        if not code_verifier:
            self._write_profile_section("gmailOauthState", oauth_attempts_payload(remaining_attempts))
            raise GmailConfigError("Sessao OAuth expirada. Gere um novo link de conexao do Gmail.")

        # Consome antes da troca do codigo: a mesma autorizacao nunca pode ser reutilizada.
        self._write_profile_section("gmailOauthState", oauth_attempts_payload(remaining_attempts))
        flow = self._flow(state=state, code_verifier=code_verifier)
        self._fetch_token(flow, code)
        payload = json.loads(flow.credentials.to_json())
        self._assert_required_scopes(payload.get("scopes") or SCOPES)
        previous = self._read_profile_section("gmailToken", {})
        if previous.get("refresh_token") and not payload.get("refresh_token"):
            payload["refresh_token"] = previous["refresh_token"]
        self._write_profile_section("gmailToken", payload)
        self._mark_sync()
        return {"connected": True, "scopes": payload.get("scopes", SCOPES)}

    def cancel_oauth(self, state: str | None) -> None:
        """Consome uma tentativa recusada pelo Google sem afetar outras abas."""
        oauth_state = self._read_profile_section("gmailOauthState", {})
        _, remaining_attempts = find_oauth_attempt(oauth_state, state)
        self._write_profile_section("gmailOauthState", oauth_attempts_payload(remaining_attempts))

    def list_labels(self) -> dict[str, Any]:
        labels = self._service().users().labels().list(userId="me").execute().get("labels", [])
        self._mark_sync()
        return {
            "labels": [self._normalize_label(label) for label in labels],
            **self.status(),
        }

    def create_label(self, name: str) -> dict[str, Any]:
        label = self._service().users().labels().create(
            userId="me",
            body={
                "name": name.strip(),
                "labelListVisibility": "labelShow",
                "messageListVisibility": "show",
            },
        ).execute()
        return {"label": self._normalize_label(label)}

    def list_messages(
        self,
        *,
        folder: str = "inbox",
        query: str | None = None,
        page_token: str | None = None,
        max_results: int = 25,
    ) -> dict[str, Any]:
        folder_key = (folder or "inbox").strip()
        cached_page = self._cached_mailbox_page(
            folder=folder_key,
            query=query,
            page_token=page_token,
            max_results=max_results,
        )
        if cached_page is not None:
            return {**cached_page, **self.status(), "cacheSource": "user_profile"}

        service = self._service()
        if folder_key == "drafts":
            drafts = self._list_drafts(query=query, page_token=page_token, max_results=max_results)
            self._save_mailbox_page(
                folder=folder_key,
                query=query,
                page_token=page_token,
                max_results=max_results,
                payload=drafts,
            )
            return {**drafts, "cacheSource": "gmail"}

        label_ids, query_parts = self._folder_filters(folder_key)
        if query:
            query_parts.append(query.strip())

        params: dict[str, Any] = {
            "userId": "me",
            "maxResults": max(1, min(max_results, 50)),
        }
        if label_ids:
            params["labelIds"] = label_ids
        if query_parts:
            params["q"] = " ".join(query_parts)
        if page_token:
            params["pageToken"] = page_token

        result = service.users().messages().list(**params).execute()
        items = result.get("messages", [])
        message_details = self._execute_batch(
            service,
            items,
            lambda item: service.users().messages().get(
                userId="me",
                id=item["id"],
                format="metadata",
                metadataHeaders=["From", "To", "Cc", "Subject", "Date", "Message-ID"],
            ),
        )
        messages = [self._normalize_message(message) for message in message_details]

        self._mark_sync()
        payload = {
            "messages": messages,
            "nextPageToken": result.get("nextPageToken"),
            "resultSizeEstimate": result.get("resultSizeEstimate", 0),
            "folder": folder_key,
        }
        self._save_mailbox_page(
            folder=folder_key,
            query=query,
            page_token=page_token,
            max_results=max_results,
            payload=payload,
        )
        return {**payload, **self.status(), "cacheSource": "gmail"}

    def get_message(self, message_id: str) -> dict[str, Any]:
        message = self._service().users().messages().get(userId="me", id=message_id, format="full").execute()
        return {"message": self._normalize_message(message, detail=True)}

    def send_message(
        self,
        *,
        to: list[str],
        subject: str,
        body: str,
        cc: list[str] | None = None,
        bcc: list[str] | None = None,
        attachments: list[dict[str, Any]] | None = None,
        thread_id: str | None = None,
        extra_headers: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        raw = self._build_raw_message(
            to=to,
            subject=subject,
            body=body,
            cc=cc or [],
            bcc=bcc or [],
            attachments=attachments or [],
            extra_headers=extra_headers or {},
        )
        payload: dict[str, Any] = {"raw": raw}
        if thread_id:
            payload["threadId"] = thread_id
        sent = self._service().users().messages().send(userId="me", body=payload).execute()
        self._clear_mailbox_cache()
        self._mark_sync()
        return {"sent": True, "message": sent}

    def reply_message(
        self,
        *,
        message_id: str,
        body: str,
        attachments: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        original = self.get_message(message_id)["message"]
        subject = original.get("subject") or "Sem assunto"
        if not subject.lower().startswith("re:"):
            subject = f"Re: {subject}"

        headers = {}
        if original.get("messageIdHeader"):
            headers["In-Reply-To"] = original["messageIdHeader"]
            headers["References"] = original["messageIdHeader"]

        to_email = original.get("replyToEmail") or original.get("fromEmail")
        if not to_email:
            raise GmailConfigError("Nao encontrei um remetente valido para responder.")

        return self.send_message(
            to=[to_email],
            subject=subject,
            body=body,
            attachments=attachments or [],
            thread_id=original.get("threadId"),
            extra_headers=headers,
        )

    def create_draft(
        self,
        *,
        to: list[str],
        subject: str,
        body: str,
        cc: list[str] | None = None,
        bcc: list[str] | None = None,
        attachments: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        raw = self._build_raw_message(
            to=to,
            subject=subject,
            body=body,
            cc=cc or [],
            bcc=bcc or [],
            attachments=attachments or [],
            extra_headers={},
        )
        draft = self._service().users().drafts().create(
            userId="me",
            body={"message": {"raw": raw}},
        ).execute()
        self._clear_mailbox_cache()
        self._mark_sync()
        return {"draft": draft}

    def send_draft(self, draft_id: str) -> dict[str, Any]:
        sent = self._service().users().drafts().send(userId="me", body={"id": draft_id}).execute()
        self._clear_mailbox_cache()
        self._mark_sync()
        return {"sent": True, "message": sent}

    def disconnect(self) -> dict[str, Any]:
        self._write_integration_store({})
        return {"connected": False, "status": "desconectado"}

    def modify_message(
        self,
        message_id: str,
        *,
        action: str,
        add_label_ids: list[str] | None = None,
        remove_label_ids: list[str] | None = None,
    ) -> dict[str, Any]:
        service = self._service()
        action_key = action.strip().lower()

        if action_key == "trash":
            result = service.users().messages().trash(userId="me", id=message_id).execute()
        elif action_key == "untrash":
            result = service.users().messages().untrash(userId="me", id=message_id).execute()
        else:
            add: list[str] = []
            remove: list[str] = []
            if action_key == "read":
                remove = ["UNREAD"]
            elif action_key == "unread":
                add = ["UNREAD"]
            elif action_key == "archive":
                remove = ["INBOX"]
            elif action_key == "move_inbox":
                add = ["INBOX"]
            elif action_key == "star":
                add = ["STARRED"]
            elif action_key == "unstar":
                remove = ["STARRED"]
            elif action_key == "spam":
                add = ["SPAM"]
                remove = ["INBOX"]
            elif action_key == "important":
                add = ["IMPORTANT"]
            elif action_key == "unimportant":
                remove = ["IMPORTANT"]
            elif action_key == "labels":
                add = add_label_ids or []
                remove = remove_label_ids or []
            else:
                raise GmailConfigError(f"Acao de e-mail desconhecida: {action}")

            result = service.users().messages().modify(
                userId="me",
                id=message_id,
                body={"addLabelIds": add, "removeLabelIds": remove},
            ).execute()

        self._clear_mailbox_cache()
        self._mark_sync()
        return {"status": "sucesso", "message": self._normalize_message(result)}

    def download_attachment(self, *, message_id: str, attachment_id: str) -> bytes:
        payload = self._service().users().messages().attachments().get(
            userId="me",
            messageId=message_id,
            id=attachment_id,
        ).execute()
        return self._decode_base64_url(payload.get("data", ""))

    def _list_drafts(self, *, query: str | None, page_token: str | None, max_results: int) -> dict[str, Any]:
        service = self._service()
        params: dict[str, Any] = {"userId": "me", "maxResults": max(1, min(max_results, 50))}
        if page_token:
            params["pageToken"] = page_token
        result = service.users().drafts().list(**params).execute()
        drafts = []
        query_lower = (query or "").lower().strip()
        items = result.get("drafts", [])
        draft_details = self._execute_batch(
            service,
            items,
            lambda item: service.users().drafts().get(userId="me", id=item["id"], format="metadata"),
        )
        for draft in draft_details:
            message = self._normalize_message(draft.get("message", {}))
            message["draftId"] = draft.get("id")
            if query_lower and query_lower not in f"{message.get('subject', '')} {message.get('snippet', '')}".lower():
                continue
            drafts.append(message)

        self._mark_sync()
        return {
            "messages": drafts,
            "nextPageToken": result.get("nextPageToken"),
            "resultSizeEstimate": result.get("resultSizeEstimate", 0),
            "folder": "drafts",
            **self.status(),
        }

    def _execute_batch(self, service: Any, items: list[dict[str, Any]], request_factory: Any) -> list[dict[str, Any]]:
        """Executa leituras do Gmail em lote e preserva a ordem exibida na interface."""
        if not items:
            return []

        responses: dict[int, dict[str, Any]] = {}

        def callback(request_id: str, response: dict[str, Any] | None, exception: Exception | None) -> None:
            if exception is None and response:
                responses[int(request_id)] = response

        try:
            batch = service.new_batch_http_request(callback=callback)
            for index, item in enumerate(items):
                batch.add(request_factory(item), request_id=str(index))
            batch.execute()
        except Exception:
            responses.clear()

        # Uma falha pontual no lote nao deve esvaziar a caixa inteira.
        for index, item in enumerate(items):
            if index in responses:
                continue
            try:
                responses[index] = request_factory(item).execute()
            except Exception:
                continue

        return [responses[index] for index in range(len(items)) if index in responses]

    def _service(self):
        creds = self._credentials(refresh=True)
        if not creds or not creds.valid:
            raise GmailConfigError("Gmail ainda nao esta conectado.")
        return build("gmail", "v1", credentials=creds, cache_discovery=False)

    def _credentials(self, *, refresh: bool) -> Credentials | None:
        info = self._read_profile_section("gmailToken", {})
        if not info.get("client_id") or not info.get("client_secret"):
            return None
        creds = Credentials.from_authorized_user_info(info, info.get("scopes") or SCOPES)
        if refresh and creds.expired and creds.refresh_token:
            creds.refresh(Request())
            self._save_credentials(creds)
        return creds

    def _save_credentials(self, creds: Credentials) -> None:
        payload = json.loads(creds.to_json())
        previous = self._read_profile_section("gmailToken", {})
        if previous.get("refresh_token") and not payload.get("refresh_token"):
            payload["refresh_token"] = previous["refresh_token"]
        self._write_profile_section("gmailToken", payload)

    def _flow(self, state: str | None = None, code_verifier: str | None = None) -> Flow:
        config = self._client_config()
        if not config:
            raise GmailConfigError("Configure GMAIL_CLIENT_ID e GMAIL_CLIENT_SECRET no backend.")
        return Flow.from_client_config(
            config,
            scopes=SCOPES,
            state=state,
            redirect_uri=self._redirect_uri(),
            code_verifier=code_verifier,
            autogenerate_code_verifier=code_verifier is None,
        )

    def _fetch_token(self, flow: Flow, code: str) -> None:
        previous_relax_scope = os.environ.get("OAUTHLIB_RELAX_TOKEN_SCOPE")
        os.environ["OAUTHLIB_RELAX_TOKEN_SCOPE"] = "1"
        try:
            flow.fetch_token(code=code)
        finally:
            if previous_relax_scope is None:
                os.environ.pop("OAUTHLIB_RELAX_TOKEN_SCOPE", None)
            else:
                os.environ["OAUTHLIB_RELAX_TOKEN_SCOPE"] = previous_relax_scope

    def _assert_required_scopes(self, scopes: Any) -> None:
        granted = set(scopes.split() if isinstance(scopes, str) else scopes or [])
        missing = [scope for scope in SCOPES if scope not in granted]
        if missing:
            raise GmailConfigError("Permissoes do Gmail incompletas. Gere um novo link de conexao.")

    def _client_config(self) -> dict[str, Any] | None:
        client_id = os.getenv("GMAIL_CLIENT_ID")
        client_secret = os.getenv("GMAIL_CLIENT_SECRET")
        if not client_id or not client_secret:
            return None
        return {
            "web": {
                "client_id": client_id,
                "client_secret": client_secret,
                "auth_uri": "https://accounts.google.com/o/oauth2/auth",
                "token_uri": "https://oauth2.googleapis.com/token",
                "redirect_uris": [self._redirect_uri()],
            }
        }

    def _redirect_uri(self) -> str:
        return os.getenv("GMAIL_REDIRECT_URI") or DEFAULT_REDIRECT_URI

    def _profile(self) -> dict[str, Any]:
        gmail_profile: dict[str, Any] = {}
        try:
            gmail_profile = self._service().users().getProfile(userId="me").execute()
        except Exception:
            gmail_profile = {}

        account_profile: dict[str, Any] = {}
        try:
            account_profile = build("oauth2", "v2", credentials=self._credentials(refresh=True), cache_discovery=False).userinfo().get().execute()
        except Exception:
            account_profile = {}

        return {
            **gmail_profile,
            "emailAddress": account_profile.get("email") or gmail_profile.get("emailAddress"),
            "name": account_profile.get("name"),
            "picture": account_profile.get("picture"),
        }

    def _cached_profile(self) -> dict[str, Any] | None:
        cached = self._read_profile_section("gmailProfileCache", {})
        if not isinstance(cached, dict):
            return None
        cached_at = cached.get("cachedAt")
        profile = cached.get("profile")
        if not isinstance(cached_at, str) or not isinstance(profile, dict):
            return None
        try:
            age = datetime.now(timezone.utc) - datetime.fromisoformat(cached_at)
        except ValueError:
            return None
        if age.total_seconds() > PROFILE_CACHE_TTL_SECONDS:
            return None
        return profile

    def _save_profile_cache(self, profile: dict[str, Any]) -> None:
        self._write_profile_section("gmailProfileCache", {"cachedAt": self._now_iso(), "profile": profile})

    def _folder_filters(self, folder: str) -> tuple[list[str] | None, list[str]]:
        if folder.startswith("label:"):
            label_id = folder.split(":", 1)[1].strip()
            return ([label_id] if label_id else None), []
        return FOLDER_LABELS.get(folder), list(FOLDER_QUERIES.get(folder, []))

    def _normalize_label(self, label: dict[str, Any]) -> dict[str, Any]:
        return {
            "id": label.get("id"),
            "name": label.get("name"),
            "type": label.get("type"),
            "messagesTotal": label.get("messagesTotal", 0),
            "messagesUnread": label.get("messagesUnread", 0),
            "threadsTotal": label.get("threadsTotal", 0),
            "threadsUnread": label.get("threadsUnread", 0),
        }

    def _normalize_message(self, message: dict[str, Any], *, detail: bool = False) -> dict[str, Any]:
        headers = self._headers_to_dict((message.get("payload") or {}).get("headers") or [])
        from_name, from_email = parseaddr(headers.get("from", ""))
        reply_name, reply_email = parseaddr(headers.get("reply-to", ""))
        label_ids = list(message.get("labelIds") or [])
        internal_date = self._format_internal_date(message.get("internalDate"))
        normalized = {
            "id": message.get("id"),
            "threadId": message.get("threadId"),
            "from": self._decode_header(headers.get("from", "")),
            "fromName": self._decode_header(from_name) or from_email or "Remetente",
            "fromEmail": from_email,
            "replyToEmail": reply_email,
            "replyToName": self._decode_header(reply_name),
            "to": self._decode_header(headers.get("to", "")),
            "cc": self._decode_header(headers.get("cc", "")),
            "subject": self._decode_header(headers.get("subject", "")) or "(sem assunto)",
            "snippet": html.unescape(message.get("snippet", "") or ""),
            "dateHeader": self._decode_header(headers.get("date", "")),
            "messageIdHeader": headers.get("message-id", ""),
            "dateLabel": internal_date["label"],
            "dateFull": internal_date["full"],
            "timestamp": internal_date["timestamp"],
            "labels": label_ids,
            "unread": "UNREAD" in label_ids,
            "starred": "STARRED" in label_ids,
            "important": "IMPORTANT" in label_ids,
            "hasAttachment": False,
        }

        if detail:
            content = self._extract_content(message.get("payload") or {}, message.get("id") or "")
            normalized.update(content)
            normalized["hasAttachment"] = bool(content.get("attachments"))
        return normalized

    def _headers_to_dict(self, headers: list[dict[str, str]]) -> dict[str, str]:
        parsed: dict[str, str] = {}
        for header in headers:
            name = str(header.get("name", "")).lower()
            if name:
                parsed[name] = str(header.get("value", ""))
        return parsed

    def _extract_content(self, payload: dict[str, Any], message_id: str) -> dict[str, Any]:
        plain_parts: list[str] = []
        html_parts: list[str] = []
        attachments: list[dict[str, Any]] = []
        inline_images: dict[str, str] = {}
        inline_image_bytes = 0
        max_inline_image_bytes = 8 * 1024 * 1024

        def walk(part: dict[str, Any]) -> None:
            nonlocal inline_image_bytes
            mime_type = str(part.get("mimeType") or "")
            body = part.get("body") or {}
            filename = str(part.get("filename") or "").strip()
            part_headers = self._headers_to_dict(part.get("headers") or [])
            content_id = str(part_headers.get("content-id") or "").strip().strip("<>")
            attachment_id = str(body.get("attachmentId") or "")

            if filename and attachment_id:
                attachments.append(
                    {
                        "attachmentId": attachment_id,
                        "fileName": filename,
                        "mimeType": mime_type or "application/octet-stream",
                        "size": body.get("size", 0),
                        "downloadUrl": public_api_url(
                            "/api/emails/gmail/attachments"
                            f"?message_id={quote(message_id)}&attachment_id={quote(attachment_id)}"
                            f"&filename={quote(filename)}&mime_type={quote(mime_type or 'application/octet-stream')}"
                        ),
                    }
                )

            data = body.get("data")
            if content_id and mime_type.lower().startswith("image/"):
                try:
                    image_content = (
                        self._decode_base64_url(str(data))
                        if data
                        else self.download_attachment(message_id=message_id, attachment_id=attachment_id)
                        if attachment_id
                        else b""
                    )
                    if image_content and inline_image_bytes + len(image_content) <= max_inline_image_bytes:
                        inline_image_bytes += len(image_content)
                        encoded = base64.b64encode(image_content).decode("ascii")
                        inline_images[content_id] = f"data:{mime_type};base64,{encoded}"
                except Exception as exc:
                    logger.info("gmail_inline_image_unavailable content_id=%s reason=%s", content_id[:80], type(exc).__name__)

            if data and mime_type in {"text/plain", "text/html"}:
                decoded = self._decode_base64_url(str(data)).decode(self._part_charset(part), errors="replace")
                if mime_type == "text/plain":
                    plain_parts.append(decoded)
                else:
                    html_parts.append(decoded)

            for child in part.get("parts") or []:
                walk(child)

        walk(payload)
        body_text = "\n\n".join(part.strip() for part in plain_parts if part.strip())
        body_html = "\n".join(part.strip() for part in html_parts if part.strip())
        for content_id, data_url in inline_images.items():
            body_html = re.sub(rf"cid:{re.escape(content_id)}", data_url, body_html, flags=re.I)
        return {
            "bodyText": body_text,
            "bodyHtml": body_html,
            "attachments": attachments,
        }

    def _part_charset(self, part: dict[str, Any]) -> str:
        for header in part.get("headers") or []:
            if str(header.get("name", "")).lower() == "content-type":
                match = re.search(r"charset=[\"']?([^;\"']+)", str(header.get("value", "")), re.I)
                if match:
                    return match.group(1)
        return "utf-8"

    def _build_raw_message(
        self,
        *,
        to: list[str],
        subject: str,
        body: str,
        cc: list[str],
        bcc: list[str],
        attachments: list[dict[str, Any]],
        extra_headers: dict[str, str],
    ) -> str:
        recipients = self._clean_recipients(to)
        if not recipients:
            raise GmailConfigError("Informe ao menos um destinatario valido.")

        message = EmailMessage()
        message["To"] = ", ".join(recipients)
        if cc:
            message["Cc"] = ", ".join(self._clean_recipients(cc))
        if bcc:
            message["Bcc"] = ", ".join(self._clean_recipients(bcc))
        message["Subject"] = subject.strip() or "(sem assunto)"
        message["Date"] = formatdate(localtime=True)
        message["Message-ID"] = make_msgid(domain="norium.local")
        for key, value in extra_headers.items():
            if key and value:
                message[key] = value
        message.set_content(body or "")

        total_size = 0
        for attachment in attachments:
            file_bytes, mime_type = self._decode_data_url(
                str(attachment.get("dataUrl") or attachment.get("data_url") or ""),
                str(attachment.get("mimeType") or attachment.get("mime_type") or "application/octet-stream"),
            )
            total_size += len(file_bytes)
            if total_size > MAX_ATTACHMENT_BYTES:
                raise GmailConfigError("Anexos acima do limite de 24 MB para envio pelo Norium.")
            file_name = Path(str(attachment.get("fileName") or attachment.get("name") or "anexo")).name
            maintype, subtype = (mime_type.split("/", 1) + ["octet-stream"])[:2]
            message.add_attachment(file_bytes, maintype=maintype, subtype=subtype, filename=file_name)

        return base64.urlsafe_b64encode(message.as_bytes()).decode()

    def _clean_recipients(self, values: list[str]) -> list[str]:
        recipients: list[str] = []
        for value in values:
            for item in re.split(r"[,;]", str(value)):
                item = item.strip()
                if item and "@" in parseaddr(item)[1]:
                    recipients.append(item)
        return recipients

    def _decode_data_url(self, data_url: str, fallback_mime: str) -> tuple[bytes, str]:
        match = re.match(r"^data:([^,]*),(.*)$", data_url, flags=re.DOTALL)
        if not match or "base64" not in match.group(1).lower():
            raise GmailConfigError("Anexo invalido. Envie um data URL base64.")
        metadata = [part.strip() for part in match.group(1).split(";") if part.strip()]
        mime_type = next((part for part in metadata if "/" in part), fallback_mime or "application/octet-stream")
        file_bytes = base64.b64decode(match.group(2), validate=True)
        if not file_bytes:
            raise GmailConfigError("Anexo vazio.")
        return file_bytes, mime_type

    def _decode_base64_url(self, value: str) -> bytes:
        if not value:
            return b""
        padded = value + "=" * (-len(value) % 4)
        return base64.urlsafe_b64decode(padded.encode("utf-8"))

    def _decode_header(self, value: str) -> str:
        if not value:
            return ""
        try:
            return str(make_header(decode_header(value))).strip()
        except Exception:
            return value.strip()

    def _format_internal_date(self, value: Any) -> dict[str, Any]:
        try:
            dt = datetime.fromtimestamp(int(value) / 1000, tz=timezone.utc).astimezone(LOCAL_TZ)
        except Exception:
            dt = datetime.now(LOCAL_TZ)
        now = datetime.now(LOCAL_TZ)
        label = dt.strftime("%H:%M") if dt.date() == now.date() else dt.strftime("%d/%m")
        return {
            "label": label,
            "full": dt.strftime("%d/%m/%Y %H:%M"),
            "timestamp": int(dt.timestamp()),
        }

    def _mark_sync(self) -> None:
        self._write_profile_section("gmailSync", {"lastSync": self._now_iso()})

    def _mailbox_cache_key(
        self,
        *,
        folder: str,
        query: str | None,
        page_token: str | None,
        max_results: int,
    ) -> str:
        raw_key = "|".join((folder, (query or "").strip(), page_token or "first", str(max_results)))
        return hashlib.sha256(raw_key.encode("utf-8")).hexdigest()

    def _cached_mailbox_page(
        self,
        *,
        folder: str,
        query: str | None,
        page_token: str | None,
        max_results: int,
    ) -> dict[str, Any] | None:
        cache = self._read_profile_section("gmailMailboxCache", {})
        if not isinstance(cache, dict):
            return None
        cache_key = self._mailbox_cache_key(
            folder=folder,
            query=query,
            page_token=page_token,
            max_results=max_results,
        )
        entry = cache.get(cache_key)
        if not isinstance(entry, dict) or not isinstance(entry.get("payload"), dict):
            return None
        try:
            cached_at = datetime.fromisoformat(str(entry.get("cachedAt") or ""))
            if cached_at.tzinfo is None:
                cached_at = cached_at.replace(tzinfo=timezone.utc)
            if datetime.now(timezone.utc) - cached_at > timedelta(seconds=MAILBOX_CACHE_TTL_SECONDS):
                return None
        except ValueError:
            return None
        return dict(entry["payload"])

    def _save_mailbox_page(
        self,
        *,
        folder: str,
        query: str | None,
        page_token: str | None,
        max_results: int,
        payload: dict[str, Any],
    ) -> None:
        cache = self._read_profile_section("gmailMailboxCache", {})
        if not isinstance(cache, dict):
            cache = {}
        cache_key = self._mailbox_cache_key(
            folder=folder,
            query=query,
            page_token=page_token,
            max_results=max_results,
        )
        cache[cache_key] = {
            "cachedAt": self._now_iso(),
            "folder": folder,
            "payload": {
                "messages": list(payload.get("messages") or []),
                "nextPageToken": payload.get("nextPageToken"),
                "resultSizeEstimate": payload.get("resultSizeEstimate", 0),
                "folder": folder,
            },
        }
        if len(cache) > MAILBOX_CACHE_MAX_ENTRIES:
            ordered_keys = sorted(cache, key=lambda key: str(cache[key].get("cachedAt") or ""), reverse=True)
            cache = {key: cache[key] for key in ordered_keys[:MAILBOX_CACHE_MAX_ENTRIES]}
        self._write_profile_section("gmailMailboxCache", cache)

    def _clear_mailbox_cache(self) -> None:
        self._write_profile_section("gmailMailboxCache", {})

    def _now_iso(self) -> str:
        return datetime.now(timezone.utc).isoformat()

    def _read_json(self, path: Path, fallback: Any) -> Any:
        try:
            return json.loads(path.read_text(encoding="utf-8")) if path.exists() else fallback
        except Exception:
            return fallback

    def _write_json(self, path: Path, payload: Any) -> None:
        path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    def _read_profile(self) -> dict[str, Any]:
        profile = read_profile_db(self.user_id, {})
        if profile:
            return profile
        if self.user_id == "lucas123":
            legacy_profile_path = BASE_DIR / "perfil_db.json"
            legacy_profile = self._read_json(legacy_profile_path, {})
            if isinstance(legacy_profile, dict):
                if "nome" in legacy_profile:
                    return legacy_profile
                if isinstance(legacy_profile.get(self.user_id), dict):
                    return legacy_profile[self.user_id]
        return {}

    def _read_integration_store(self) -> dict[str, Any]:
        payload = read_account_db(self.user_id, INTEGRATION_DB_NAME, {})
        return payload if isinstance(payload, dict) else {}

    def _write_integration_store(self, payload: dict[str, Any]) -> None:
        write_account_db(self.user_id, INTEGRATION_DB_NAME, payload)

    def _read_profile_section(self, section: str, fallback: Any) -> Any:
        # A autorizacao pertence a conta, nao ao workspace ativo. O callback do
        # Google nao carrega X-Norium-Workspace; guardar o state no perfil do
        # workspace fazia contas secundarias falharem ao retornar do consentimento.
        integration = self._read_integration_store()
        if section in integration:
            return integration[section]

        # Migra de forma transparente os dados gravados antes da separacao.
        profile = self._read_profile()
        value = profile.get(section)
        if value is not None:
            integration[section] = value
            self._write_integration_store(integration)
            return value
        if self.user_id != "lucas123":
            return fallback
        legacy_map = {
            "gmailToken": TOKEN_PATH,
            "gmailOauthState": OAUTH_STATE_PATH,
            "gmailSync": SYNC_STATE_PATH,
            "gmailProfileCache": PROFILE_CACHE_PATH,
        }
        legacy_path = legacy_map.get(section)
        return self._read_json(legacy_path, fallback) if legacy_path else fallback

    def _write_profile_section(self, section: str, value: Any) -> None:
        integration = self._read_integration_store()
        integration[section] = value
        self._write_integration_store(integration)

    def _safe_user_id(self) -> str:
        return re.sub(r"[^a-zA-Z0-9_.-]+", "_", self.user_id or "lucas123").strip("._") or "lucas123"
