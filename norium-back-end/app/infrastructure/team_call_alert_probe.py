"""Explicit, single-recipient SMTP probe, run by an authorized deployment operator."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re

from app.core.tenant import get_system_db_path
from app.services import system_email as mail


def send_probe(recipient: str, probe_id: str) -> dict:
    if not re.fullmatch(r"[A-Za-z0-9_.+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}", recipient):
        raise ValueError("invalid_recipient")
    if not re.fullmatch(r"[A-Za-z0-9_-]{8,96}", probe_id):
        raise ValueError("invalid_probe_id")
    if not mail.ready():
        raise RuntimeError("email_not_configured")
    directory = Path(get_system_db_path("system_email_config")).parent / ".operations"
    directory.mkdir(exist_ok=True)
    marker = directory / f"call-alert-{probe_id}.json"
    fingerprint = hashlib.sha256(recipient.lower().encode()).hexdigest()
    try:
        with marker.open("x", encoding="utf-8") as handle:
            json.dump({"recipientFingerprint": fingerprint, "smtpAccepted": False}, handle)
    except FileExistsError:
        previous = json.loads(marker.read_text(encoding="utf-8"))
        if previous.get("recipientFingerprint") != fingerprint:
            raise ValueError("probe_recipient_changed")
        return {"smtpAccepted": previous.get("smtpAccepted") is True, "alreadyAttempted": True,
                "inboxDeliveryConfirmed": False, "externalMonitoringConfigured": False}

    payload = {
        "subject": "Norium — Teste do canal de alertas das chamadas",
        "text": "Este é o teste de e-mail das chamadas de equipe solicitado pelo responsável pelo Norium. "
                "Não há incidente associado a esta mensagem. O monitoramento externo ainda está pendente. "
                "Este envio verifica somente o canal de e-mail já existente.",
        "html": "<p>Teste do canal de e-mail das chamadas de equipe do Norium.</p>"
                "<p>Não há incidente associado a esta mensagem. O monitoramento externo ainda está pendente.</p>",
    }
    mail.send_smtp({"id": "call-alert-" + probe_id, "recipient": recipient, "kind": "test",
                    "payload": mail.cipher().encrypt(json.dumps(payload).encode()).decode()})
    marker.write_text(json.dumps({"recipientFingerprint": fingerprint, "smtpAccepted": True}), encoding="utf-8")
    return {"smtpAccepted": True, "alreadyAttempted": False, "inboxDeliveryConfirmed": False,
            "externalMonitoringConfigured": False}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--recipient", required=True)
    parser.add_argument("--probe-id", required=True)
    args = parser.parse_args()
    try:
        result = send_probe(args.recipient, args.probe_id)
    except Exception as error:
        result = {"smtpAccepted": False, "errorType": type(error).__name__}
    print("TEAM_CALL_EMAIL_PROBE=" + json.dumps(result), flush=True)
    return 0 if result["smtpAccepted"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
