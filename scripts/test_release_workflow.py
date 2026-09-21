import unittest
from pathlib import Path

import yaml


class ReleaseWorkflowTests(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
