"""Offline review lint only. Never starts a daemon or declares the host ready."""
import argparse
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
FLAGS = ("no-udp no-tcp no-dtls no-tcp-relay no-tlsv1 no-tlsv1_1 no-rfc5780 "
         "no-stun-backward-compatibility no-stun fingerprint use-auth-secret "
         "no-cli syslog no-stdout-log no-multicast-peers").split()
FIXED = dict.fromkeys(FLAGS, "")
FIXED.update({
    "listening-ip": "__PUBLIC_IPV4_ON_HOST__", "relay-ip": "__PUBLIC_IPV4_ON_HOST__",
    "tls-listening-port": "5349", "realm": "__TURN_FQDN__",
    "static-auth-secret": "__GENERATE_EXCLUSIVE_SECRET_ONLY_ON_HOST__",
    "cert": "/etc/coturn/certs/fullchain.pem", "pkey": "/etc/coturn/certs/privkey.pem",
    "stale-nonce": "600", "min-port": "50000", "max-port": "50199",
    "total-quota": "100", "user-quota": "4", "max-bps": "1000000",
    "bps-capacity": "12500000", "proc-user": "turnserver",
    "proc-group": "turnserver", "web-admin": "0",
})
DENIED = {
    "0.0.0.0-0.255.255.255", "10.0.0.0-10.255.255.255",
    "100.64.0.0-100.127.255.255", "127.0.0.0-127.255.255.255",
    "169.254.0.0-169.254.255.255", "172.16.0.0-172.31.255.255",
    "192.0.0.0-192.0.0.255", "192.0.2.0-192.0.2.255",
    "192.168.0.0-192.168.255.255", "198.18.0.0-198.19.255.255",
    "198.51.100.0-198.51.100.255", "203.0.113.0-203.0.113.255",
    "224.0.0.0-255.255.255.255", "::-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
}
GATES = ("package_origin_patches_and_exact_artifact public_ipv4_on_host_and_dns "
         "tls_chain_hostname_expiry_key_match_and_renewal root_owned_secret_and_key_permissions "
         "service_privileges_and_egress_isolation quota_capacity_bandwidth_and_cost "
         "private_logs_aggregate_counters_and_alerts rollback_and_application_regressions "
         "specialist_human_review external_auth_peer_denial_and_relay_acceptance").split()


def inspect(plan, config, candidate=None):
    errors, values = [], {}
    if not isinstance(plan, dict):
        return {"ready": False, "errors": ["plan must be an object"], "pending": GATES}
    if set(plan) != {"state", "base_commit", "ubuntu_release", "package",
                     "apt_candidate", "coturn_installed", "required_review"}:
        errors.append("unexpected or missing plan metadata; never store secrets here")
    for key, expected in (("state", "review_only"), ("base_commit", "9176971"),
                          ("package", "coturn"),
                          ("ubuntu_release", "24.04"), ("coturn_installed", False)):
        if plan.get(key) != expected:
            errors.append("invalid review metadata: " + key)
    if not isinstance(plan.get("apt_candidate"), str) or not plan["apt_candidate"].strip():
        errors.append("apt candidate missing")
    if candidate is not None and candidate != plan.get("apt_candidate"):
        errors.append("apt candidate changed; review exact artifact again")
    review = plan.get("required_review")
    if not isinstance(review, dict) or set(review) != set(GATES):
        errors.append("required review gates missing or unexpected")
    elif any(value is not None and not isinstance(value, str) for value in review.values()):
        errors.append("review references must be text or null; acknowledgments are not evidence")
    for line in config.splitlines():
        line = line.partition("#")[0].strip()
        if line:
            key, _, value = line.partition("=")
            values.setdefault(key.strip(), []).append(value.strip())
    for key, expected in FIXED.items():
        if values.get(key) != [expected]:
            errors.append("missing, duplicated or changed protected directive: " + key)
    if set(values) - set(FIXED) - {"denied-peer-ip"}:
        errors.append("unexpected directives; includes and relaxed auth/TLS are forbidden")
    if set(values.get("denied-peer-ip", [])) != DENIED:
        errors.append("peer deny ranges changed")
    # References are unverified metadata. A lint success never approves activation.
    return {"ready": False, "errors": errors, "pending": GATES,
            "candidate_revalidation": "provided" if candidate is not None else "not_executed"}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--lint-only", action="store_true")
    parser.add_argument("--candidate", help="exact candidate from a separately authorized read-only host check")
    args = parser.parse_args(argv)
    try:
        result = inspect(json.loads((ROOT / "plan.json").read_text(encoding="utf-8")),
                         (ROOT / "turnserver.conf.template").read_text(encoding="utf-8"),
                         args.candidate)
    except (OSError, UnicodeError, ValueError):
        result = {"ready": False, "errors": ["review files missing or malformed"], "pending": GATES}
    print(json.dumps(result, ensure_ascii=True))
    return 1 if result["errors"] else (0 if args.lint_only else 2)


if __name__ == "__main__":
    raise SystemExit(main())
