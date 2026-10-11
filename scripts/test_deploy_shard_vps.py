import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from scripts import deploy_shard_vps as deploy


SHA = "a" * 40
IMAGE = "sha256:" + "b" * 64
ORIGIN = "https://homologacao.example.test"


class DeploymentTransportTests(unittest.TestCase):
    def config(self):
        return {"SHARD_VPS_HOST": "vps.example.test", "SHARD_VPS_USER": "release",
                "SHARD_VPS_SSH_KEY": "synthetic-test-key", "SHARD_VPS_KNOWN_HOSTS": "synthetic-public-key",
                "SHARD_HOMOLOGACAO_URL": ORIGIN}

    def artifact(self, path):
        (path / "image.tar.gz").write_bytes(b"synthetic archive")
        digest = hashlib.sha256(b"synthetic archive").hexdigest()
        (path / "image.tar.gz.sha256").write_text(digest + "  image.tar.gz\n")
        (path / "image-provenance.json").write_text(json.dumps({"commitSha": SHA, "dockerImageId": IMAGE}))
        (path / "image-audit-receipt.json").write_text(json.dumps({"commitSha": SHA, "dockerImageId": IMAGE,
            "complete": True, "missingReports": [], "vulnerabilityGatePassed": True}))
        return digest

    def receipt(self):
        return {"protocolVersion": 1, "state": "deployed", "revision": SHA, "imageId": IMAGE,
                "origin": ORIGIN, "environment": "homologacao", **{name: True for name in deploy.ACCEPTANCE}}

    def test_configuration_is_required_before_any_ssh_or_mutation(self):
        with patch.object(deploy, "execute") as run:
            with self.assertRaises(deploy.DeploymentError):
                deploy.deploy({}, Path("missing"), SHA)
            run.assert_not_called()

    def test_rejects_shell_host_user_port_and_untrusted_https_origin(self):
        for field, value in (("SHARD_VPS_HOST", "-oProxyCommand=bad"), ("SHARD_VPS_HOST", "a;bad"),
                             ("SHARD_VPS_USER", "root;bad"), ("SHARD_VPS_PORT", "22;bad"),
                             ("SHARD_HOMOLOGACAO_URL", "http://example.test"),
                             ("SHARD_HOMOLOGACAO_URL", "https://user:password@example.test")):
            with self.subTest(field=field, value=value), self.assertRaises(deploy.DeploymentError):
                deploy.configuration({**self.config(), field: value})

    def test_exact_revision_image_and_archive_required(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp)
            digest = self.artifact(path)
            self.assertEqual(deploy.verify_image(path, SHA), (IMAGE, digest))
            with self.assertRaises(deploy.DeploymentError):
                deploy.verify_image(path, "c" * 40)
            (path / "image.tar.gz").write_bytes(b"tampered")
            with self.assertRaises(deploy.DeploymentError):
                deploy.verify_image(path, SHA)

    def test_failed_vulnerability_gate_is_never_transportable(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp)
            self.artifact(path)
            audit = json.loads((path / "image-audit-receipt.json").read_text())
            audit["vulnerabilityGatePassed"] = False
            (path / "image-audit-receipt.json").write_text(json.dumps(audit))
            with self.assertRaises(deploy.DeploymentError):
                deploy.verify_image(path, SHA)

    def test_all_backup_security_and_authenticated_gates_required(self):
        for field in deploy.ACCEPTANCE:
            with self.subTest(field=field), self.assertRaises(deploy.DeploymentError):
                deploy.verify_acceptance({**self.receipt(), field: False}, SHA, IMAGE, ORIGIN)
        with self.assertRaises(deploy.DeploymentError):
            deploy.verify_acceptance({**self.receipt(), "state": "rolled_back"}, SHA, IMAGE, ORIGIN)

    def test_receipt_drops_non_allowlisted_fields(self):
        receipt = deploy.verify_acceptance({**self.receipt(), "opaquePrivateData": "synthetic"}, SHA, IMAGE, ORIGIN)
        self.assertNotIn("opaquePrivateData", receipt)

    def test_strict_host_verification_and_no_interactive_auth(self):
        options = deploy.ssh_options(Path("identity"), Path("hosts"))
        self.assertIn("StrictHostKeyChecking=yes", options)
        self.assertIn("BatchMode=yes", options)
        self.assertIn("IdentitiesOnly=yes", options)

    def test_preflight_failure_blocks_transfer_and_deploy(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp)
            self.artifact(path)
            with patch.object(deploy, "execute", return_value='{"protocolVersion":1,"ready":false}') as run:
                with self.assertRaises(deploy.DeploymentError):
                    deploy.deploy(self.config(), path, SHA)
                self.assertEqual(run.call_count, 1)

    def test_success_transfers_artifact_then_requires_full_receipt(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp)
            self.artifact(path)
            responses = ['{"protocolVersion":1,"ready":true}', "", "", "", "", "", json.dumps(self.receipt())]
            with patch.object(deploy, "execute", side_effect=responses) as run:
                self.assertEqual(deploy.deploy(self.config(), path, SHA)["state"], "deployed")
                self.assertEqual(run.call_count, 7)
                self.assertIn("/usr/local/sbin/norium-release preflight", run.call_args_list[0].args[0][-1])
                self.assertEqual(run.call_args_list[2].args[0][0], "scp")


if __name__ == "__main__":
    unittest.main()
