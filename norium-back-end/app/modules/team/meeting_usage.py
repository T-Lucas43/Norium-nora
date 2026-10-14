"""Opaque billing source identifiers; private questions are never room totals."""
from __future__ import annotations

import hashlib
import json


def meeting_usage_source(workspace: str, team_id: str, call_id: str, *, private_user_id: str | None = None) -> str:
    purpose = "private" if private_user_id else "shared"
    data = [workspace, team_id, call_id, purpose, private_user_id]
    digest = hashlib.sha256(json.dumps(data, separators=(",", ":")).encode()).hexdigest()[:32]
    return "nora-meeting:" + purpose + ":" + digest
