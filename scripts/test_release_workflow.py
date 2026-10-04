import unittest
from pathlib import Path

import yaml


class ReleaseWorkflowTests(unittest.TestCase):
    def test_azure_requires_manual_main_target_and_positive_opt_in(self):
        workflow = yaml.safe_load(Path(".github/workflows/azure-container-apps.yml").read_text(encoding="utf-8"))
        for job in ("publish-image", "team-call-release", "deploy"):
            with self.subTest(job=job):
                guard = workflow["jobs"][job]["if"]
                self.assertIn("github.event_name == 'workflow_dispatch'", guard)
                self.assertIn("inputs.deployment_target == 'azure'", guard)
                self.assertIn("github.ref == 'refs/heads/main'", guard)
                self.assertIn("vars.DEPLOY_AZURE_ENABLED == 'true'", guard)
                self.assertNotIn("!= 'false'", guard)

    def test_all_candidate_gates_checkout_reviewed_head(self):
        workflow = yaml.safe_load(Path(".github/workflows/azure-container-apps.yml").read_text(encoding="utf-8"))
        for job in ("validate", "postgres-persistence", "team-call-quality", "shard-image-security"):
            with self.subTest(job=job):
                checkout = next(step for step in workflow["jobs"][job]["steps"] if step.get("uses", "").startswith("actions/checkout@"))
                self.assertEqual("${{ github.event.pull_request.head.sha || github.sha }}", checkout["with"]["ref"])
        image_build = next(step for step in workflow["jobs"]["shard-image-security"]["steps"] if step.get("name") == "Build exact Shard candidate with mandatory browser sandbox")
        self.assertIn("NORIUM_RELEASE_SHA=$(git rev-parse HEAD)", image_build["run"])

    def test_deploy_records_previous_image_and_has_failure_rollback(self):
        workflow = yaml.safe_load(Path(".github/workflows/azure-container-apps.yml").read_text(encoding="utf-8"))
        deploy = workflow["jobs"]["deploy"]
        steps = deploy["steps"]
        rollback_source = next(step for step in steps if step.get("id") == "rollback")
        rollback = next(step for step in steps if step.get("name") == "Roll back automatically after a failed release gate")
        self.assertIn("properties.template.containers[0].image", rollback_source["run"])
        self.assertIn("failure()", rollback["if"])
        self.assertIn("steps.rollback.outputs.image", rollback["if"])
        self.assertIn("/health/ready", rollback["run"])
        self.assertIn("--max-replicas 1", rollback["run"])

    def test_shard_source_artifact_requires_all_gates_and_has_no_provider_credentials(self):
        workflow = yaml.safe_load(Path(".github/workflows/azure-container-apps.yml").read_text(encoding="utf-8"))
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
        validate_steps = workflow["jobs"]["validate"]["steps"]
        self.assertTrue(any("scripts.test_shard_release_package" in step.get("run", "") for step in validate_steps))


if __name__ == "__main__":
    unittest.main()
