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
