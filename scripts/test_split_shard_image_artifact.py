import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

from scripts.split_shard_image_artifact import REQUIRED_GATES, split_artifact


class ImageTransferTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.archive = self.root / "original.zip"
        self.output = self.root / "parts"
        self.revision = "a" * 40
        image = "sha256:" + "b" * 64
        self.entries = {
            "image.tar.gz": b"synthetic-image-bytes",
            "image.tar.gz.sha256": hashlib.sha256(b"synthetic-image-bytes").hexdigest() + "  image.tar.gz\n",
            "image-provenance.json": json.dumps({"commitSha": self.revision, "dockerImageId": image}),
            "image-audit-receipt.json": json.dumps({"commitSha": self.revision, "dockerImageId": image,
                "complete": True, "missingReports": [], "vulnerabilityGatePassed": True}),
        }
        self.run = {"id": 12, "head_sha": self.revision, "status": "completed", "conclusion": "success"}
        self.jobs = {"jobs": [{"name": name, "status": "completed", "conclusion": "success"} for name in REQUIRED_GATES]}
        self.artifact = {"id": 34, "name": "shard-deploy-image-" + self.revision, "expired": False,
                         "workflow_run": {"id": 12, "head_sha": self.revision}}
        self.write_archive()

    def write_archive(self):
        with zipfile.ZipFile(self.archive, "w") as archive:
            for name, value in self.entries.items():
                archive.writestr(name, value)
        self.artifact.update(size_in_bytes=self.archive.stat().st_size,
            digest="sha256:" + hashlib.sha256(self.archive.read_bytes()).hexdigest())

    def split(self, **options):
        return split_artifact(self.archive, self.output, self.revision, self.run, self.jobs, self.artifact, **options)

    def test_parts_recreate_identical_archive(self):
        receipt = self.split(part_bytes=(self.archive.stat().st_size + 2) // 3)
        self.assertEqual(len(receipt["parts"]), 3)
        reconstructed = b"".join((self.output / part["name"]).read_bytes() for part in receipt["parts"])
        self.assertEqual(reconstructed, self.archive.read_bytes())
        self.assertFalse(receipt["rebuilt"])
        self.assertTrue(receipt["sourceGatesPassed"])
        for part in receipt["parts"]:
            self.assertEqual(hashlib.sha256((self.output / part["name"]).read_bytes()).hexdigest(), part["sha256"])

    def test_missing_or_failed_gate_rejects_before_writing(self):
        for change in ("missing", "failure", "in_progress"):
            jobs = copy.deepcopy(self.jobs)
            if change == "missing": jobs["jobs"].pop()
            elif change == "failure": jobs["jobs"][0]["conclusion"] = change
            else: jobs["jobs"][0]["status"] = change
            with self.subTest(change=change), self.assertRaises(ValueError):
                split_artifact(self.archive, self.output, self.revision, self.run, jobs, self.artifact)
            self.assertFalse(self.output.exists())

    def test_unsuccessful_run_and_wrong_provenance_rejected(self):
        for field, value in (("conclusion", "failure"), ("head_sha", "c" * 40), ("status", "in_progress")):
            run = {**self.run, field: value}
            with self.subTest(field=field), self.assertRaises(ValueError):
                split_artifact(self.archive, self.output, self.revision, run, self.jobs, self.artifact)
        self.artifact["workflow_run"]["id"] = 999
        with self.assertRaises(ValueError): self.split()

    def test_corrupted_archive_rejected(self):
        self.artifact["digest"] = "sha256:" + "0" * 64
        with self.assertRaises(ValueError): self.split()
        self.assertFalse(self.output.exists())

    def test_corrupted_image_rejected(self):
        self.entries["image.tar.gz"] = b"tampered"
        self.write_archive()
        with self.assertRaises(ValueError): self.split()

    def test_failed_audit_rejected(self):
        audit = json.loads(self.entries["image-audit-receipt.json"])
        audit["vulnerabilityGatePassed"] = False
        self.entries["image-audit-receipt.json"] = json.dumps(audit)
        self.write_archive()
        with self.assertRaises(ValueError): self.split()

    def test_unexpected_paths_rejected(self):
        self.entries["../unexpected"] = b"unsafe"
        self.write_archive()
        with self.assertRaises(ValueError): self.split()

    def test_more_than_three_parts_rejected_without_partial_output(self):
        with self.assertRaises(ValueError): self.split(part_bytes=1)
        self.assertFalse(self.output.exists())

    def test_transfer_workflow_only_reads_github_and_never_deploys(self):
        import yaml
        path = Path(".github/workflows/shard-image-transfer.yml")
        workflow = yaml.safe_load(path.read_text())
        self.assertEqual(workflow["permissions"], {"contents": "read", "actions": "read"})
        self.assertEqual(set(workflow.get("on", workflow.get(True))), {"workflow_dispatch"})
        self.assertEqual(workflow["jobs"]["transfer"]["if"], "github.ref == 'refs/heads/main'")
        text = path.read_text()
        for forbidden in ("secrets.", "docker build", "ssh ", "scp ", "deploy_shard_vps"):
            self.assertNotIn(forbidden, text)


if __name__ == "__main__":
    unittest.main()
