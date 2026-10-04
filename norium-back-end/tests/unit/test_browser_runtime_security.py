from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

from app.infrastructure.browser_runtime_smoke import check_container_status

SECURITY = Path(__file__).resolve().parents[3] / "infra" / "security"
spec = importlib.util.spec_from_file_location("browser_seccomp_builder", SECURITY / "build_browser_seccomp.py")
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


class BrowserRuntimeSecurityTests(unittest.TestCase):
    def test_policy_preserves_upstream_and_adds_only_chroot_no_capabilities(self):
        source = SECURITY / "playwright-seccomp-v1.62.0.json"
        base = json.loads(source.read_text())
        derived = builder.profile(source)
        added = derived["syscalls"].pop()
        self.assertEqual(base, derived)
        self.assertEqual(["chroot"], added["names"])
        self.assertEqual("SCMP_ACT_ALLOW", added["action"])
        self.assertEqual({}, added["includes"])

    def test_policy_rejects_a_modified_upstream_even_if_valid_json(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / "modified.json"
            source.write_text('{"defaultAction": "SCMP_ACT_ALLOW", "syscalls": []}')
            with self.assertRaises(RuntimeError):
                builder.profile(source)

    def test_runtime_requires_every_privilege_guard(self):
        status = "NoNewPrivs:\t1\nSeccomp:\t2\n" + "".join(f"{name}:\t0000000000000000\n" for name in ("CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"))
        check_container_status(status, 10001)
        for changed in (status.replace("NoNewPrivs:\t1", "NoNewPrivs:\t0"),
                        status.replace("Seccomp:\t2", "Seccomp:\t0"),
                        status.replace("CapEff:\t0000000000000000", "CapEff:\t0000000000000001"),
                        status.replace("CapBnd:\t0000000000000000\n", "")):
            with self.assertRaises(RuntimeError):
                check_container_status(changed, 10001)
        with self.assertRaises(RuntimeError):
            check_container_status(status, 0)
