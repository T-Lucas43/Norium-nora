import ast
import unittest
from pathlib import Path

import yaml


WORKFLOW_PATH = Path(".github/workflows/shard-homologacao.yml")


class ReleaseWorkflowTests(unittest.TestCase):
    def workflow(self):
        return yaml.safe_load(WORKFLOW_PATH.read_text(encoding="utf-8"))

    def test_only_shard_workflow_is_active_and_cannot_deploy_azure(self):
        active = {path.name for pattern in ("*.yml", "*.yaml") for path in WORKFLOW_PATH.parent.glob(pattern)}
        self.assertEqual(active, {WORKFLOW_PATH.name, "shard-image-transfer.yml"})
        workflow = self.workflow()
        self.assertEqual(workflow["name"], "Shard Cloud - validacao e homologacao")
        self.assertEqual(set(workflow["jobs"]), {
            "validate", "postgres-persistence", "team-call-quality", "shard-image-security", "shard-source-artifact", "deploy-homologacao",
        })
        text = WORKFLOW_PATH.read_text(encoding="utf-8")
        for forbidden in ("azure/login", "AZURE_", "az bicep", "az containerapp", "az webapp", "Dockerfile.azure"):
            with self.subTest(forbidden=forbidden):
                self.assertNotIn(forbidden, text)

    def test_historical_manual_workflows_are_outside_active_directory(self):
        files = {path.name for path in Path("docs/archives/azure-workflows").glob("*.yml")}
        self.assertEqual(len(files), 14)
        self.assertIn("azure-container-apps-main-7075b65.yml", files)
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
        self.assertIn("NORIUM_RELEASE_VERSION=$release_version", image_build["run"])
        self.assertIn("NORIUM_DEPLOYMENT_STAGE=homologacao", image_build["run"])
        self.assertIn('"--format=%ct"', image_build["run"])
        artifact_names = {step.get("with", {}).get("name", "") for step in workflow["jobs"]["validate"]["steps"]}
        self.assertIn("backend-sbom-${{ github.event.pull_request.head.sha || github.sha }}", artifact_names)
        self.assertIn("secret-history-${{ github.event.pull_request.head.sha || github.sha }}", artifact_names)

    def test_version_badge_is_bound_to_root_owned_image_metadata(self):
        job = self.workflow()["jobs"]["shard-image-security"]
        proof = next(step for step in job["steps"] if step.get("name") == "Verify release identity from the running image")
        for required in ("release_snapshot", "NORIUM_DEPLOYMENT_STAGE=producao", "--read-only",
                         "--network", "none", "--cap-drop=ALL", "Running image release identity"):
            self.assertIn(required, proof["run"])
        self.assertNotIn("continue-on-error", proof)
        dockerfile = Path("Dockerfile.shard").read_text(encoding="utf-8")
        self.assertLess(dockerfile.index("RUN python -m app.infrastructure.release_metadata"), dockerfile.index("USER norium"))
        self.assertEqual(dockerfile.count('ARG NORIUM_RELEASE_VERSION=""'), 1)

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
                         "--read-only", "browser_inventory(runtime.chromium)",
                         'inventory["browserChannel"] != "chrome"'):
            with self.subTest(required=required):
                self.assertIn(required, audit["run"])
        inventory_source = Path("norium-back-end/app/infrastructure/browser_runtime_smoke.py").read_text(encoding="utf-8")
        for required in ("browser_executable_path(browser_type)", "chromiumVersion", "chromiumBinarySha256",
                         "playwrightRevision", "playwrightManifestSha256", "chromePackageVersion",
                         "expectedChromePackageSha256", 'version != expected["browserVersion"]',
                         'CHROME_MINIMUM_VERSION = "154.0.8037.97"',
                         'CHROME_PACKAGE_VERSION = "154.0.8037.97-1"',
                         "a4edbe95e9b01db6c9b97d7a1323121eda18362b5620df06abac1b59bee80053",
                         "not a complete browser vulnerability assessment"):
            with self.subTest(required=required):
                self.assertIn(required, inventory_source)
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

    def test_runtime_image_pins_the_official_chrome_package_and_removes_installers(self):
        dockerfile = Path("Dockerfile.shard").read_text(encoding="utf-8")
        inventory_source = Path("norium-back-end/app/infrastructure/browser_runtime_smoke.py").read_text(encoding="utf-8")
        constants = {node.targets[0].id: ast.literal_eval(node.value)
                     for node in ast.parse(inventory_source).body
                     if isinstance(node, ast.Assign) and isinstance(node.targets[0], ast.Name)
                     and node.targets[0].id in {"CHROME_MINIMUM_VERSION", "CHROME_PACKAGE_VERSION", "CHROME_PACKAGE_SHA256"}}
        self.assertEqual(constants["CHROME_MINIMUM_VERSION"], constants["CHROME_PACKAGE_VERSION"].rsplit("-", 1)[0])
        for required in (
            "ENV NORIUM_BROWSER_CHANNEL=chrome", "apt-get upgrade -y",
            'version = "' + constants["CHROME_PACKAGE_VERSION"] + '"',
            'expected_sha256 = "' + constants["CHROME_PACKAGE_SHA256"] + '"',
            "expected_bytes = 142172388",
            "https://dl.google.com/linux/chrome/deb/pool/main/g/google-chrome-stable/google-chrome-stable_",
            "received > expected_bytes", "received != expected_bytes or digest.hexdigest() != expected_sha256",
            "apt-get install -y --no-install-recommends /tmp/norium-google-chrome-stable.deb",
            "dpkg-query -W -f='${Version}' google-chrome-stable", "python -m pip uninstall --yes pip",
            "FROM ${NORIUM_RUNTIME_BASE} AS backend-build", "FROM ${NORIUM_RUNTIME_BASE} AS runtime",
            "COPY --from=backend-build /opt/norium-venv /opt/norium-venv",
            "ENV PATH=/opt/norium-venv/bin:${PATH}",
            'sys.version_info[:2] != (3, 14)', 'for module in ("pip", "ensurepip")',
            "importlib.util.find_spec(module) is not None", "USER norium",
            "python -m app.infrastructure.browser_runtime_smoke --inventory-only",
        ):
            with self.subTest(required=required):
                self.assertIn(required, dockerfile)
        self.assertIn("= '" + constants["CHROME_PACKAGE_VERSION"] + "'", dockerfile)
        self.assertRegex(dockerfile, r"ARG NORIUM_RUNTIME_BASE=ubuntu:26\.04@sha256:[0-9a-f]{64}\n")
        runtime = dockerfile.split("FROM ${NORIUM_RUNTIME_BASE} AS runtime", 1)[1]
        self.assertNotIn("python3.14-venv ", runtime)
        self.assertNotIn("pip install", runtime)
        self.assertLess(dockerfile.index("digest.hexdigest() != expected_sha256"),
                        dockerfile.index("apt-get install -y --no-install-recommends /tmp/norium-google-chrome-stable.deb"))
        self.assertLess(dockerfile.index("pip install --no-cache-dir"), dockerfile.index("python -m pip uninstall --yes pip"))
        self.assertNotIn("playwright install", dockerfile)
        for forbidden in ("--no-sandbox", "--allow-unauthenticated", "trusted=yes", ".dist-info"):
            with self.subTest(forbidden=forbidden):
                self.assertNotIn(forbidden, dockerfile)

    def test_final_runtime_checks_native_dependencies_with_network_disabled(self):
        steps = self.workflow()["jobs"]["shard-image-security"]["steps"]
        smoke = next(step for step in steps if step.get("name") == "Verify unprivileged image identity and real sandboxed DOM")
        commands = smoke["run"]
        self.assertIn("-m app.infrastructure.runtime_dependency_smoke", commands)
        self.assertEqual(commands.count("--network none"), 2)
        self.assertEqual(commands.count("--read-only"), 2)
        self.assertEqual(commands.count("--cap-drop=ALL"), 2)
        self.assertNotIn("continue-on-error", smoke)

    def test_runtime_excludes_unused_pebble_and_preserves_application_tools(self):
        runtime = Path("Dockerfile.shard").read_text(encoding="utf-8").split("FROM ${NORIUM_RUNTIME_BASE} AS runtime", 1)[1]
        self.assertIn("ENTRYPOINT []", runtime)
        self.assertIn('Path("/usr/bin/pebble").unlink(missing_ok=True)', runtime)
        self.assertIn('if Path("/usr/bin/pebble").exists()', runtime)
        self.assertIn("ca-certificates python3.14 ffmpeg", runtime)
        self.assertIn("google-chrome-stable", runtime)
        self.assertIn("exec uvicorn --app-dir /opt/norium", runtime)
        self.assertIn("--workers 1", runtime)

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

    def test_deploy_is_explicit_main_only_and_depends_on_every_gate(self):
        workflow = self.workflow()
        job = workflow["jobs"]["deploy-homologacao"]
        self.assertEqual(set(job["needs"]), set(workflow["jobs"]) - {"deploy-homologacao"})
        self.assertEqual(job["if"], "github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main' && inputs.deploy_homologacao")
        self.assertEqual(job["environment"], "homologacao")
        self.assertFalse(job["concurrency"]["cancel-in-progress"])
        events = workflow.get("on", workflow.get(True))
        self.assertFalse(events["workflow_dispatch"]["inputs"]["deploy_homologacao"]["default"])
        for step in job["steps"]:
            self.assertNotIn("continue-on-error", step)
        steps = str(job["steps"])
        self.assertNotIn("docker build", steps)
        self.assertNotIn("StrictHostKeyChecking=no", steps)
        self.assertNotIn("ssh-keyscan", steps)
        self.assertNotIn("SHARD_PASSWORD", steps)

    def test_deploy_transports_the_same_audited_image(self):
        jobs = self.workflow()["jobs"]
        export = next(step for step in jobs["shard-image-security"]["steps"] if step.get("name") == "Export the exact audited image for the homologation deployment")
        self.assertEqual(export["shell"], "bash")
        self.assertIn('docker save "$image_id"', export["run"])
        self.assertIn("image-audit-receipt.json", export["run"])
        self.assertIn("sha256sum image.tar.gz", export["run"])
        download = next(step for step in jobs["deploy-homologacao"]["steps"] if step.get("uses", "").startswith("actions/download-artifact@"))
        self.assertEqual(download["with"]["name"], "shard-deploy-image-${{ github.sha }}")
        self.assertEqual(len(download["uses"].split("@")[1]), 40)

    def test_manual_shard_export_does_not_enable_ssh_deployment(self):
        workflow = self.workflow()
        events = workflow.get("on", workflow.get(True))
        self.assertFalse(events["workflow_dispatch"]["inputs"]["export_image"]["default"])
        image_job = workflow["jobs"]["shard-image-security"]
        export_steps = [step for step in image_job["steps"] if step.get("name") in (
            "Export the exact audited image for the homologation deployment",
            "Preserve the exact audited image without rebuilding on the VPS",
        )]
        self.assertEqual(len(export_steps), 2)
        for step in export_steps:
            self.assertEqual(step["if"], "github.ref == 'refs/heads/main' && (github.event_name == 'push' || (github.event_name == 'workflow_dispatch' && (inputs.deploy_homologacao || inputs.export_image)))")
        self.assertNotIn("secrets.SHARD_VPS", str(image_job))
        self.assertNotIn("inputs.export_image", workflow["jobs"]["deploy-homologacao"]["if"])


if __name__ == "__main__":
    unittest.main()
