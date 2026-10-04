"""Prove that the repository scanner loads and exercises its default rules."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import secrets
import string
import subprocess
import tempfile
import tomllib


def validate_config(config: dict) -> None:
    extension = config.get("extend", {})
    if extension.get("useDefault") is not True:
        raise ValueError("Gitleaks must extend the built-in detection rules")
    if extension.get("path") or extension.get("disabledRules"):
        raise ValueError("Gitleaks default rules must remain enabled")


def probe(gitleaks: str, config_path: Path) -> dict:
    with tempfile.TemporaryDirectory(prefix="norium-scanner-canary-") as scratch:
        root = Path(scratch)
        source = root / "source"
        source.mkdir()
        # Generated only in a temporary directory, never issued by GitHub and
        # never committed or sent to a provider. No real credential is used.
        canary = "ghp_" + "".join(secrets.choice(string.ascii_letters + string.digits) for _ in range(36))
        (source / "synthetic.txt").write_text("synthetic_canary=" + canary, encoding="utf-8")
        report = root / "redacted.json"
        result = subprocess.run(
            [gitleaks, "dir", str(source), "--config", str(config_path.resolve()),
             "--redact=100", "--no-banner", "--no-color", "--exit-code=1",
             "--report-format=json", "--report-path", str(report),
             "--gitleaks-ignore-path", str(root)],
            capture_output=True, text=True, timeout=30,
        )
        findings = json.loads(report.read_text(encoding="utf-8")) if report.exists() else []
        return {
            "exitCode": result.returncode,
            "githubPatDetected": any(item.get("RuleID") == "github-pat" for item in findings),
            "fullyRedacted": bool(findings) and all(item.get("Secret") == "REDACTED" for item in findings),
        }


def require_detection(result: dict) -> None:
    if result.get("exitCode") != 1 or not result.get("githubPatDetected") or not result.get("fullyRedacted"):
        raise RuntimeError("Secret scanner did not detect and redact the synthetic canary")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--gitleaks", default="gitleaks")
    parser.add_argument("--config", type=Path, default=Path(__file__).resolve().parents[1] / ".gitleaks.toml")
    args = parser.parse_args()
    validate_config(tomllib.loads(args.config.read_text(encoding="utf-8")))
    result = probe(args.gitleaks, args.config)
    require_detection(result)
    print(json.dumps({"secret_scanner_canary_passed": True, **result}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
