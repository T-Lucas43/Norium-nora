"""Fail-closed release preflight; prints missing names/codes, never values."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys
from collections.abc import Mapping
from urllib.parse import urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.modules.team.call_configuration import validate_team_call_configuration
from app.modules.team.call_release import CallReleasePolicy
from app.modules.team.turn_credentials import validate_turn_configuration
from app.modules.team.sfu_tokens import validate_sfu_configuration


def is_release_turn_url(value: str) -> bool:
    scheme, separator, authority = value.partition(":")
    try:
        parsed = urlsplit("//" + authority)
        return bool(separator and scheme == "turns" and parsed.hostname and parsed.port == 443
                    and not parsed.username and not parsed.password and not parsed.path and not parsed.fragment
                    and parsed.query == "transport=tcp" and not any(c.isspace() for c in value))
    except ValueError:
        return False


def has_evidence_reference(value: str) -> bool:
    try:
        parsed = urlsplit(value)
        return bool(parsed.scheme == "https" and parsed.hostname and parsed.path.strip("/")
                    and not parsed.username and not parsed.password and parsed.port in {None, 443}
                    and not any(c.isspace() for c in value))
    except ValueError:
        return False


def assess(source: Mapping[str, str]) -> list[str]:
    blockers: list[str] = []
    profile = source.get("TEAM_CALL_RELEASE_PROFILE", "public")
    internal = profile == "internal-test"
    if profile not in {"public", "internal-test"}:
        blockers.append("invalid_release_profile")
    required = ("AZURE_PUBLIC_URL", "AZURE_CONTAINER_APP_NAME", "AZURE_RESOURCE_GROUP",
                "AZURE_CLIENT_ID", "AZURE_TENANT_ID", "AZURE_SUBSCRIPTION_ID")
    if not internal:
        required += ("TEAM_CALL_TURN_URLS", "TEAM_CALL_TURN_SHARED_SECRET", "TEAM_CALL_METRICS_TOKEN",
                "NORIUM_SMOKE_EMAIL", "NORIUM_SMOKE_PASSWORD", "NORIUM_SMOKE_PEER_EMAIL",
                "NORIUM_SMOKE_PEER_PASSWORD", "TEAM_CALL_SMOKE_TEAM_ID", "TEAM_CALL_INTERNAL_TEAMS")
    blockers.extend("missing:" + name for name in required if not source.get(name, "").strip())
    for name, validator in (("calls", validate_team_call_configuration),
                            ("turn", validate_turn_configuration), ("sfu", validate_sfu_configuration)):
        try:
            validator(source)
        except (RuntimeError, ValueError):
            blockers.append("invalid_configuration:" + name)
    try:
        policy = CallReleasePolicy.from_env(source)
        if policy.recording_enabled:
            blockers.append("recording_consent_protocol_not_approved")
        if not internal and not policy.allows_new_call(source.get("TEAM_CALL_SMOKE_TEAM_ID", "")):
            blockers.append("smoke_team_not_in_cohort")
    except (RuntimeError, ValueError):
        pass
    if not internal and source.get("TEAM_CALL_TURN_REQUIRED") != "true":
        blockers.append("turn_must_be_required")
    if source.get("TEAM_CALL_SFU_ENABLED", "false") != "false":
        blockers.append("sfu_server_revocation_not_implemented")
    urls = [value.strip() for value in source.get("TEAM_CALL_TURN_URLS", "").split(",") if value.strip()]
    if not internal and urls and any(not is_release_turn_url(url) for url in urls):
        blockers.append("release_requires_exclusive_turn_tls_443")
    # These are operator attestations backed by a reviewable external record.
    # This configuration gate does not contact the collector or prove delivery.
    for name in ("TEAM_CALL_METRICS_COLLECTOR_READY", "TEAM_CALL_ALERT_RECEIVER_READY",
                 "TEAM_CALL_ALERT_TEST_DELIVERED"):
        if not internal and source.get(name) != "true":
            blockers.append("operational_attestation_required:" + name)
    if not internal and not has_evidence_reference(source.get("TEAM_CALL_OBSERVABILITY_EVIDENCE_URL", "")):
        blockers.append("observability_evidence_reference_required")
    parsed = urlsplit(source.get("AZURE_PUBLIC_URL", ""))
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.query:
        blockers.append("invalid_production_destination")
    if source.get("WEB_CONCURRENCY", "1") != "1":
        blockers.append("single_worker_required")
    return sorted(set(blockers))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    blockers = assess(os.environ)
    result = {"schema": 1, "status": "blocked" if blockers else "passed", "blockers": blockers,
              "releaseProfile": os.getenv("TEAM_CALL_RELEASE_PROFILE", "public"),
              "deferred": ["external_turn_tls", "external_metrics_alerts", "dedicated_two_account_smoke"]
                  if os.getenv("TEAM_CALL_RELEASE_PROFILE") == "internal-test" else [],
              "scope": ("internal-test deployment only; deferred checks remain mandatory before public launch"
                        if os.getenv("TEAM_CALL_RELEASE_PROFILE") == "internal-test" else
                        "configuration_and_operator_attestations_only; alert delivery is not automatically verified; "
                        "external TURN and production smoke are separate mandatory gates")}
    output = json.dumps(result, indent=2) + "\n"
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(output, encoding="utf-8")
    print(output, end="")
    return 2 if blockers else 0


if __name__ == "__main__":
    raise SystemExit(main())
