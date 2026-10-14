"""Revoga a autorização no provedor antes de apagar o único token recuperável."""
from __future__ import annotations

import httpx

from app.core.tenant import get_data_root, read_account_db, write_account_db, safe_tenant_id, read_json_file, write_json_file
from app.infrastructure.persistence import postgres_store
from app.services.oauth_credentials import recover


def revoke_google_for_account(user_id: str) -> int:
    documents = []
    for store, section in (("gmail_integration", "gmailToken"), ("calendar_integration", "calendarToken")):
        payload = read_account_db(user_id, store, {})
        if isinstance(payload, dict) and payload.get(section):
            documents.append((get_data_root() / f"user_{safe_tenant_id(user_id)}" / f"{store}_db.json", payload, section))
    prefix = f"user_{safe_tenant_id(user_id)}/"
    if postgres_store.configured() or postgres_store.required():
        profiles = [get_data_root() / key for key in postgres_store.list_document_keys(prefix) if key.endswith("/perfil_db.json")]
    else:
        profiles = list((get_data_root() / prefix).rglob("perfil_db.json"))
    for path in profiles:
        payload = read_json_file(path, {})
        if isinstance(payload, dict):
            for section in ("gmailToken", "calendarToken"):
                if payload.get(section):
                    documents.append((path, payload, section))
    revoked: set[str] = set()
    for path, payload, section in documents:
        credentials, _ = recover(user_id, section, payload[section])
        token = str(credentials.get("refresh_token") or credentials.get("token") or credentials.get("access_token") or "")
        if token and token not in revoked:
            try:
                response = httpx.post("https://oauth2.googleapis.com/revoke", data={"token": token},
                                      timeout=10, follow_redirects=False)
            except httpx.HTTPError:
                raise RuntimeError("google_revocation_pending") from None
            # Invalid/already revoked tokens are terminal; 5xx/429 must be retried.
            if response.status_code != 200:
                try:
                    invalid = response.status_code == 400 and response.json().get("error") == "invalid_token"
                except ValueError:
                    invalid = False
                if not invalid:
                    raise RuntimeError("google_revocation_pending")
            revoked.add(token)
        payload.pop(section, None)
        write_json_file(path, payload)
    return len(revoked)
