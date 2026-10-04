"""Build a disposable CI profile from the pinned, unmodified upstream policy.

Chromium's user-namespace sandbox chroots into an empty proc directory. Upstream
conditionally permits chroot only when Docker retains CAP_SYS_CHROOT; our CI
drops ALL capabilities. Allowing that syscall does not grant the capability:
the kernel still refuses chroot in the container's initial user namespace.
This script configures no provider, host, capability, sysctl or AppArmor rule.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import sys

BASE_SHA256 = "cc3e61cabda6bbc1e53e54d27ba4d55a9d3be829b6dd1a596f4a7b31b1cc7849"


def profile(source: Path) -> dict:
    # Git's Windows checkout may use CRLF; the pinned upstream bytes use LF.
    raw = source.read_bytes().replace(b"\r\n", b"\n")
    if hashlib.sha256(raw).hexdigest() != BASE_SHA256:
        raise RuntimeError("Pinned Playwright seccomp policy differs from upstream")
    policy = json.loads(raw)
    if policy["defaultAction"] != "SCMP_ACT_ERRNO":
        raise RuntimeError("A denying default seccomp policy is mandatory")
    policy["syscalls"].append({
        "names": ["chroot"], "action": "SCMP_ACT_ALLOW", "args": [],
        "includes": {}, "excludes": {},
        "comment": "Chromium filesystem sandbox inside its own user namespace; CI drops ALL capabilities",
    })
    return policy


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: build_browser_seccomp.py OUTPUT_PATH")
    destination = Path(sys.argv[1])
    destination.write_text(json.dumps(profile(Path(__file__).with_name("playwright-seccomp-v1.62.0.json")), indent=2) + "\n", encoding="utf-8")
