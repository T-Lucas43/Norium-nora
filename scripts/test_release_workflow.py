import unittest
from pathlib import Path

import yaml


WORKFLOW_PATH = Path(".github/workflows/shard-homologacao.yml")


class ReleaseWorkflowTests(unittest.TestCase):
    def workflow(self):
        return yaml.safe_load(WORKFLOW_PATH.read_text(encoding="utf-8"))

    def test_only_shard_workflow_is_active_and_cannot_deploy_azure(self):
        active = {path.name for pattern in ("*.yml", "*.yaml") for path in WORKFLOW_PATH.parent.glob(pattern)}
        self.assertEqual(active, {WORKFLOW_PATH.name})
        workflow = self.workflow()
        self.assertEqual(workflow["name"], "Shard Cloud - validacao e pacote")
        self.assertEqual(set(workflow["jobs"]), {
            "validate", "postgres-persistence", "team-call-quality", "shard-image-security", "shard-source-artifact",
        })
        text = WORKFLOW_PATH.read_text(encoding="utf-8")
        for forbidden in ("azure/login", "AZURE_", "az bicep", "az containerapp", "az webapp", "Dockerfile.azure"):
            with self.subTest(forbidden=forbidden):
                self.assertNotIn(forbidden, text)

    def test_historical_manual_workflows_are_outside_active_directory(self):
        files = {path.name for path in Path("docs/archives/azure-workflows").glob("*.yml")}
        self.assertEqual(len(files), 13)
        self.assertIn("azure-container-webapp.yml", files)
        self.assertIn("deploy-whatsapp-api.yml", files)
        self.assertIn("migrate-postgresql.yml", files)
        for name in files:
            self.assertFalse((WORKFLOW_PATH.parent / name).exists())

    def test_all_candidate_gates_checkout_reviewed_head(self):
        workflow = self.workflow()
        for job in ("validate", "postgres-persistence", "team-call-quality", "shard-image-security"):
            with self.subTest(job=job):
                checkout = next(step for step in workflow["jobs"][job]["steps"] if step.get("uses", "").startswith("actions/checkout@"))
                self.assertEqual("${{ github.event.pull_request.head.sha || github.sha }}", checkout["with"]["ref"])
        image_build = next(step for step in workflow["jobs"]["shard-image-security"]["steps"] if step.get("name") == "Build exact Shard candidate with mandatory browser sandbox")
        self.assertIn("NORIUM_RELEASE_SHA=$(git rev-parse HEAD)", image_build["run"])
        artifact_names = {step.get("with", {}).get("name", "") for step in workflow["jobs"]["validate"]["steps"]}
        self.assertIn("backend-sbom-${{ github.event.pull_request.head.sha || github.sha }}", artifact_names)
        self.assertIn("secret-history-${{ github.event.pull_request.head.sha || github.sha }}", artifact_names)

    def test_frontend_audit_covers_development_and_runtime_dependencies(self):
        job = self.workflow()["jobs"]["validate"]
        validation = next(step for step in job["steps"] if step.get("name") == "Validate frontend")
        commands = validation["run"].splitlines()
        self.assertIn("npm audit --audit-level=moderate", commands)
        self.assertIn("npm audit --omit=dev --audit-level=moderate", commands)
        self.assertNotIn("continue-on-error", validation)

    def test_image_audit_pins_scanner_and_scans_exact_local_image_without_suppressions(self):
        job = self.workflow()["jobs"]["shard-image-security"]
        self.assertEqual(job["permissions"], {"contents": "read"})
        audit = next(step for step in job["steps"] if step.get("name") == "Audit exact image packages and browser inventory")
        self.assertEqual(audit["id"], "image_audit")
        self.assertEqual(audit["env"]["TRIVY_VERSION"], "0.75.0")
        self.assertEqual(audit["env"]["TRIVY_ARCHIVE_SHA256"],
                         "c6e65abddb348e25f10549df887045629cf28cc72453cd1c63acb717316b3f3f")
        commands = audit["run"]
        for required in (
            "https://github.com/aquasecurity/trivy/releases/download/v",
            "sha256sum --check --strict", "git rev-parse HEAD",
            "NORIUM_AUDIT_IMAGE_ID", "dockerImageId", "hostingRegistryDigest",
            "--image-src docker", "--scanners vuln --pkg-types os,library",
            "--format cyclonedx", "image-sbom.cdx.json", "image-vulnerabilities.json",
            "--severity UNKNOWN,LOW,MEDIUM,HIGH,CRITICAL",
            "--severity HIGH,CRITICAL --exit-code 1 --exit-on-eol 1",
            "--ignorefile", "empty-trivyignore", "--skip-db-update", "--disable-telemetry",
        ):
            with self.subTest(required=required):
                self.assertIn(required, commands)
        for forbidden in ("--ignore-unfixed", "--insecure", "--no-sandbox", "secrets.", "shardcloud"):
            with self.subTest(forbidden=forbidden):
                self.assertNotIn(forbidden, commands)
        for step in job["steps"]:
            self.assertNotIn("continue-on-error", step)
        self.assertNotIn("secrets.", str(job))
        self.assertIn('image["Id"] != image_id', commands)
        self.assertIn('"NORIUM_RELEASE_SHA=" + commit', commands)
        self.assertLess(commands.index("sha256sum --check --strict"), commands.index('trivy" --version'))

    def test_image_audit_preserves_failed_gate_evidence_and_browser_version_hash(self):
        job = self.workflow()["jobs"]["shard-image-security"]
        audit = next(step for step in job["steps"] if step.get("name") == "Audit exact image packages and browser inventory")
        for required in ("--network none", "--cap-drop=ALL", "--security-opt no-new-privileges",
                         "--read-only", "chromiumVersion", "chromiumBinarySha256", "playwrightRevision",
                         'numeric_version.group(1) != expected["browserVersion"]'):
            with self.subTest(required=required):
                self.assertIn(required, audit["run"])
        binding = next(step for step in job["steps"] if step.get("name") == "Bind image audit reports to exact image and revision")
        self.assertEqual(binding["if"], "always()")
        self.assertEqual(binding["env"]["AUDIT_STEP_OUTCOME"], "${{ steps.image_audit.outcome }}")
        for required in ("sha256", "commitSha", "dockerImageId", "hostingRegistryDigest",
                         "image-audit-receipt.json", "missingReports", "complete",
                         "auditStepOutcome", "vulnerabilityGatePassed"):
            self.assertIn(required, binding["run"])
        self.assertIn('os.environ["AUDIT_STEP_OUTCOME"] == "success"', binding["run"])
        artifact = next(step for step in job["steps"] if step.get("name") == "Preserve image SBOM vulnerability reports and browser inventory")
        self.assertEqual(artifact["if"], "always()")
        self.assertEqual(artifact["uses"], "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02")
        self.assertEqual(artifact["with"]["name"], "shard-image-audit-${{ github.event.pull_request.head.sha || github.sha }}")
        self.assertEqual(artifact["with"]["path"], "${{ runner.temp }}/shard-image-audit/*")
        self.assertEqual(artifact["with"]["if-no-files-found"], "error")

    def test_shard_source_artifact_requires_all_gates_and_has_no_provider_credentials(self):
        workflow = self.workflow()
        job = workflow["jobs"]["shard-source-artifact"]
        self.assertEqual(set(job["needs"]), {"validate", "postgres-persistence", "team-call-quality", "shard-image-security"})
        self.assertNotIn("if", job)
        checkout = next(step for step in job["steps"] if step.get("uses", "").startswith("actions/checkout@"))
        self.assertEqual("${{ github.event.pull_request.head.sha || github.sha }}", checkout["with"]["ref"])
        commands = "\n".join(step.get("run", "") for step in job["steps"])
        self.assertIn('build_shard_release.py --repo . --commit "$(git rev-parse HEAD)"', commands)
        self.assertNotIn("shardcloud", commands)
        self.assertNotIn("secrets.", str(job))
        self.assertNotIn("environment", job)
        self.assertTrue(any("scripts.test_shard_release_package" in step.get("run", "") for step in workflow["jobs"]["validate"]["steps"]))


if __name__ == "__main__":
    unittest.main()
