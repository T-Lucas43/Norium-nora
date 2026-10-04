"""Fail closed when a custom secret scan configuration disables detection."""

import importlib.util
from pathlib import Path
import unittest


path = Path(__file__).resolve().parents[3] / "scripts/check_secret_scanner.py"
spec = importlib.util.spec_from_file_location("norium_secret_scanner_check", path)
scanner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scanner)


class SecretScannerConfigurationTests(unittest.TestCase):
    def test_allowlist_only_is_not_a_scanner(self):
        with self.assertRaises(ValueError):
            scanner.validate_config({"allowlist": {"paths": ["synthetic.py"]}})

    def test_default_rules_cannot_be_disabled_or_replaced(self):
        for extension in ({"useDefault": False}, {"useDefault": True, "disabledRules": ["github-pat"]},
                          {"useDefault": True, "path": "empty.toml"}):
            with self.subTest(extension=extension), self.assertRaises(ValueError):
                scanner.validate_config({"extend": extension})

    def test_default_rules_with_narrow_fixture_exceptions_are_accepted(self):
        scanner.validate_config({"extend": {"useDefault": True}, "allowlist": {"paths": ["synthetic.py"]}})

    def test_no_findings_or_tool_failure_blocks_the_canary_gate(self):
        for result in ({"exitCode": 0, "githubPatDetected": False, "fullyRedacted": False},
                       {"exitCode": 2, "githubPatDetected": True, "fullyRedacted": True}):
            with self.subTest(result=result), self.assertRaises(RuntimeError):
                scanner.require_detection(result)

    def test_findings_must_be_detected_and_redacted(self):
        with self.assertRaises(RuntimeError):
            scanner.require_detection({"exitCode": 1, "githubPatDetected": True, "fullyRedacted": False})
        scanner.require_detection({"exitCode": 1, "githubPatDetected": True, "fullyRedacted": True})


if __name__ == "__main__":
    unittest.main()
