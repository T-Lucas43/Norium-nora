"""Scan frontend source/build without printing any matched secret values."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re


PATTERNS = {
    "private_key": re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    "github_token": re.compile(r"gh[pousr]_[A-Za-z0-9]{36,}"),
    "frontend_permanent_call_secret": re.compile(r"VITE_[A-Z_]*(?:TURN_SHARED_SECRET|LIVEKIT_API_SECRET|LIVEKIT_API_KEY|METRICS_TOKEN)"),
    "test_harness_in_bundle": re.compile(r"tests/browser/calls\.html|__test__/reset"),
}


def scan(frontend: Path) -> dict:
    findings = []
    built = frontend / "dist"
    if not (built / "index.html").is_file():
        return {"status": "blocked", "reason": "production_build_missing", "findings": []}
    files = [file for file in built.rglob("*") if file.is_file() and file.suffix in {".js", ".html", ".css", ".map"}]
    files.extend((frontend / "src" / "components" / "team-chat").rglob("*.ts*"))
    for file in files:
        if ".test." in file.name:
            continue
        content = file.read_text(encoding="utf-8", errors="replace")
        for code, pattern in PATTERNS.items():
            if pattern.search(content):
                findings.append({"file": file.relative_to(frontend).as_posix(), "code": code})
        for key in ("TEAM_CALL_TURN_SHARED_SECRET", "TEAM_CALL_LIVEKIT_API_SECRET", "TEAM_CALL_METRICS_TOKEN"):
            value = os.getenv(key, "")
            if len(value) >= 16 and value in content:
                findings.append({"file": file.relative_to(frontend).as_posix(), "code": "runtime_secret_value:" + key})
    return {"status": "failed" if findings else "passed", "filesChecked": len(files), "findings": findings,
            "scope": "call source + complete production build; complements gitleaks and dependency audits"}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("frontend", type=Path)
    args = parser.parse_args()
    result = scan(args.frontend)
    print(json.dumps(result, indent=2))
    raise SystemExit(0 if result["status"] == "passed" else 1)
