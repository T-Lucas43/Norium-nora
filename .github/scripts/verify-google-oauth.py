"""Valida os Client IDs sincronizados pelo deploy e os callbacks OAuth.

O script não usa nem imprime client secrets. Ele confirma no endpoint público
do Google que cada cliente web aceita ambos os callbacks de produção, evitando
que uma troca de referência entre Gmail e Agenda volte a causar erro 400.
"""

from __future__ import annotations

import os
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urlencode, urlsplit


PUBLIC_URL = os.environ.get("OAUTH_PUBLIC_URL", "").strip().rstrip("/")
CLIENTS = {
    "gmail-client": os.environ.get("GMAIL_CLIENT_ID", "").strip(),
    "agenda-client": os.environ.get("GOOGLE_CLIENT_ID", "").strip(),
}
CALLBACKS = {
    "gmail": f"{PUBLIC_URL}/api/auth/callback/gmail",
    "agenda": f"{PUBLIC_URL}/api/integracoes/google/callback",
}


def validate_inputs() -> None:
    if not PUBLIC_URL.startswith("https://"):
        raise RuntimeError("OAUTH_PUBLIC_URL deve ser uma URL HTTPS pública.")
    missing = [name for name, value in CLIENTS.items() if not value]
    if missing:
        raise RuntimeError(f"Client IDs ausentes: {', '.join(missing)}")


def authorization_url(client_id: str, callback: str) -> str:
    return "https://accounts.google.com/o/oauth2/v2/auth?" + urlencode(
        {
            "client_id": client_id,
            "redirect_uri": callback,
            "response_type": "code",
            "scope": "openid email",
            "state": "norium-deploy-validation",
            "access_type": "offline",
            "prompt": "consent",
        }
    )


def fetch_authorization_page(url: str) -> tuple[int, str, str]:
    completed = subprocess.run(
        [
            "curl",
            "--silent",
            "--show-error",
            "--location",
            "--compressed",
            "--max-time",
            "20",
            "--retry",
            "2",
            "--retry-delay",
            "2",
            "--retry-all-errors",
            "--user-agent",
            "Norium-OAuth-Validator/1.0",
            "--write-out",
            "\\n%{http_code}\\n%{url_effective}",
            url,
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=75,
    )
    if completed.returncode != 0:
        raise RuntimeError(f"Google OAuth indisponível: curl {completed.returncode}")
    body, raw_status, final_url = completed.stdout.rsplit("\n", 2)
    return int(raw_status), final_url, body


def validate_pair(client_name: str, client_id: str, callback_name: str, callback: str) -> None:
    status, final_url, body = fetch_authorization_page(authorization_url(client_id, callback))
    normalized_body = body.casefold()
    parsed_final_url = urlsplit(final_url)
    final_path = parsed_final_url.path.casefold()
    rejected = (
        parsed_final_url.hostname != "accounts.google.com"
        or "redirect_uri_mismatch" in normalized_body
        or "invalid_client" in normalized_body
        or "oauth client was not found" in normalized_body
        or "/oauth/error" in final_path
    )
    if status >= 400 or rejected:
        raise RuntimeError(f"Google rejeitou {client_name} com callback {callback_name} (HTTP {status}).")
    print(f"{client_name} -> {callback_name}: aceito")


def main() -> int:
    validate_inputs()
    pairs = [
        (client_name, client_id, callback_name, callback)
        for client_name, client_id in CLIENTS.items()
        for callback_name, callback in CALLBACKS.items()
    ]
    with ThreadPoolExecutor(max_workers=len(pairs)) as executor:
        list(executor.map(lambda pair: validate_pair(*pair), pairs))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except RuntimeError as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(1)
