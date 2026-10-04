from __future__ import annotations

import importlib.util
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

from app.infrastructure import browser_runtime_smoke as smoke_runtime
from app.infrastructure.browser_runtime_smoke import check_container_status, check_chromium_sandbox_status

SECURITY = Path(__file__).resolve().parents[3] / "infra" / "security"
spec = importlib.util.spec_from_file_location("browser_seccomp_builder", SECURITY / "build_browser_seccomp.py")
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


class BrowserRuntimeSecurityTests(unittest.TestCase):
    def inventory(self, *, channel="chrome", version="154.0.8037.97", package_version="154.0.8037.97-1"):
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary)
            binary = folder / "synthetic-browser"
            binary.write_bytes(b"synthetic browser binary")
            manifest = folder / "driver/package/browsers.json"
            manifest.parent.mkdir(parents=True)
            manifest_bytes = json.dumps({"browsers": [{"name": "chromium", "revision": "1234",
                                                      "browserVersion": "151.0.7922.34"}]}).encode()
            manifest.write_bytes(manifest_bytes)
            with patch.object(smoke_runtime, "chromium_launch_options", return_value={"channel": channel, "env": {"PATH": "/synthetic"}}), \
                    patch.object(smoke_runtime, "browser_executable_path", return_value=binary), \
                    patch.object(smoke_runtime.playwright, "__file__", str(folder / "__init__.py")), \
                    patch.object(smoke_runtime.importlib.metadata, "version", return_value="1.62.0"), \
                    patch.object(smoke_runtime.subprocess, "run", side_effect=[Mock(stdout="Google Chrome " + version),
                                                                             Mock(stdout=package_version)]) as run:
                inventory = smoke_runtime.browser_inventory(Mock())
            return inventory, run.call_args_list, hashlib.sha256(manifest_bytes).hexdigest()

    def test_chrome_inventory_checks_the_selected_binary_package_and_manifest_hash(self):
        inventory, calls, manifest_hash = self.inventory()
        self.assertEqual("chrome", inventory["browserChannel"])
        self.assertEqual("154.0.8037.97", inventory["chromiumVersion"])
        self.assertEqual("154.0.8037.97-1", inventory["chromePackageVersion"])
        self.assertEqual(smoke_runtime.CHROME_PACKAGE_SHA256, inventory["expectedChromePackageSha256"])
        self.assertEqual(manifest_hash, inventory["playwrightManifestSha256"])
        self.assertEqual("151.0.7922.34", inventory["bundledChromiumVersion"])
        self.assertEqual(hashlib.sha256(b"synthetic browser binary").hexdigest(), inventory["chromiumBinarySha256"])
        self.assertEqual(["dpkg-query", "--show", "--showformat=${Version}", "google-chrome-stable"], calls[1].args[0])
        for call in calls:
            self.assertEqual({"PATH": "/synthetic"}, call.kwargs["env"])
            self.assertTrue(call.kwargs["check"])
        self.assertIn("not a complete", inventory["coverage"])

    def test_chrome_inventory_rejects_older_unverifiable_or_unpinned_binaries(self):
        for version, package in (("154.0.8037.92", "154.0.8037.92-1"),
                                 ("invalid", "154.0.8037.97-1"),
                                 ("154.0.8037.97", "154.0.8037.92-1"),
                                 ("154.0.8037.98", "154.0.8037.97-1")):
            with self.subTest(version=version, package=package), self.assertRaises(RuntimeError):
                self.inventory(version=version, package_version=package)

    def test_bundled_inventory_retains_exact_playwright_manifest_matching(self):
        inventory, calls, _ = self.inventory(channel="chromium", version="151.0.7922.34")
        self.assertEqual("chromium", inventory["browserChannel"])
        self.assertNotIn("chromePackageVersion", inventory)
        self.assertEqual(1, len(calls))
        with self.assertRaises(RuntimeError):
            self.inventory(channel="chromium", version="151.0.7922.71")

    def test_chromium_151_rows_require_namespace_pid_network_seccomp_and_good_evaluation(self):
        rows = {"Layer 1 Sandbox": "Namespace", "PID namespaces": "Yes",
                "Network namespaces": "Yes", "Seccomp-BPF sandbox": "Yes"}
        check_chromium_sandbox_status(rows, "You are adequately sandboxed.")
        for name in rows:
            with self.assertRaises(RuntimeError):
                check_chromium_sandbox_status({**rows, name: "No"}, "You are adequately sandboxed.")
        for evaluation in ("", "You are NOT adequately sandboxed."):
            with self.assertRaises(RuntimeError):
                check_chromium_sandbox_status(rows, evaluation)
        with self.assertRaises(RuntimeError):
            check_chromium_sandbox_status({**rows, "Layer 1 Sandbox": "SUID"}, "You are adequately sandboxed.")

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
