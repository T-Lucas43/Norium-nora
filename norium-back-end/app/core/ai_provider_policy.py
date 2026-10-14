"""Operator-controlled approval of AI providers per tenant and workspace.

Client model settings never grant permission to disclose data to a new host.
NORIUM_AI_PROVIDER_POLICY is a JSON object keyed by tenant, then workspace.
An entry contains providers (a list) and optional endpoints (kind -> URL list).
Missing entries use the three official providers. Malformed policy fails closed.
"""
from __future__ import annotations

import json
import os
from urllib.parse import urlsplit, urlunsplit

from app.core.identity import require_team_id, require_user_id
from app.core.request_context import current_workspace_id


OFFICIAL_ENDPOINTS = {
    "groq": "https://api.groq.com/openai/v1",
    "openai": "https://api.openai.com/v1",
    "google": "https://generativelanguage.googleapis.com/v1beta",
}


class ProviderPolicyError(ValueError):
    pass


def canonical_endpoint(value: str) -> str:
    try:
        parsed = urlsplit(str(value).strip())
        if (parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password
                or parsed.query or parsed.fragment or parsed.port not in {None, 443}):
            raise ValueError("invalid endpoint")
        return urlunsplit(("https", parsed.hostname.lower(), parsed.path.rstrip("/"), "", ""))
    except ValueError as exc:
        raise ProviderPolicyError("provider_not_approved") from exc


def approved_provider(user: dict, provider: dict) -> tuple[str, str]:
    require_user_id(user)
    kind = str(provider.get("provider") or "").lower().strip()
    if kind == "gemini":
        kind = "google"
    entry = None
    raw = os.getenv("NORIUM_AI_PROVIDER_POLICY", "").strip()
    if raw:
        try:
            policy = json.loads(raw)
            if not isinstance(policy, dict):
                raise ValueError("policy must be an object")
            tenant = policy.get(require_team_id(user), {})
            if not isinstance(tenant, dict):
                raise ValueError("tenant must be an object")
            entry = tenant.get(current_workspace_id())
            if entry is not None and not isinstance(entry, dict):
                raise ValueError("workspace must be an object")
        except (ValueError, TypeError) as exc:
            raise ProviderPolicyError("provider_policy_invalid") from exc
    approved = list(OFFICIAL_ENDPOINTS) if entry is None else entry.get("providers")
    if not isinstance(approved, list) or any(not isinstance(item, str) for item in approved):
        raise ProviderPolicyError("provider_policy_invalid")
    approved = ["google" if item == "gemini" else item for item in approved]
    if kind not in approved:
        raise ProviderPolicyError("provider_not_approved")
    endpoint = canonical_endpoint(provider.get("baseUrl") or OFFICIAL_ENDPOINTS.get(kind, ""))
    endpoints = (entry or {}).get("endpoints", {})
    if not isinstance(endpoints, dict):
        raise ProviderPolicyError("provider_policy_invalid")
    explicit = endpoints.get(kind)
    if explicit is not None and (not isinstance(explicit, list) or any(not isinstance(url, str) for url in explicit)):
        raise ProviderPolicyError("provider_policy_invalid")
    allowed_urls = explicit if explicit is not None else ([OFFICIAL_ENDPOINTS[kind]] if kind in OFFICIAL_ENDPOINTS else [])
    if endpoint not in [canonical_endpoint(url) for url in allowed_urls]:
        raise ProviderPolicyError("provider_not_approved")
    return kind, endpoint
