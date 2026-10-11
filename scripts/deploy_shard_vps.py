"""GitHub Actions transport for a separately reviewed, host-owned release executor.

No customer data or application configuration is downloaded by this transport.
Missing configuration/executor or incomplete acceptance evidence blocks deployment.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
from urllib.parse import urlsplit


class DeploymentError(RuntimeError):
    pass


def configuration(env: dict[str, str]) -> dict[str, str]:
    names = ("SHARD_VPS_HOST", "SHARD_VPS_USER", "SHARD_VPS_SSH_KEY",
             "SHARD_VPS_KNOWN_HOSTS", "SHARD_HOMOLOGACAO_URL")
    if any(not env.get(name, "").strip() for name in names):
        raise DeploymentError("Configure the homologacao SSH secrets and HTTPS URL before dispatch.")
    host, user, port = env[names[0]], env[names[1]], env.get("SHARD_VPS_PORT", "22")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9.-]{0,252}", host):
        raise DeploymentError("Invalid VPS host.")
    if not re.fullmatch(r"[a-z_][a-z0-9_-]{0,31}", user):
        raise DeploymentError("Invalid VPS user.")
    if not port.isdecimal() or not 1 <= int(port) <= 65535:
        raise DeploymentError("Invalid SSH port.")
    url = urlsplit(env["SHARD_HOMOLOGACAO_URL"])
    if (url.scheme != "https" or not url.hostname or url.username or url.password
            or url.query or url.fragment or url.path not in ("", "/")):
        raise DeploymentError("Homologation requires an HTTPS origin without credentials.")
    # The host public key must come from an independently verified fingerprint.
    # Do not obtain trust with ssh-keyscan during the release.
    if "PRIVATE KEY" in env["SHARD_VPS_KNOWN_HOSTS"]:
        raise DeploymentError("The known-hosts field must contain host public keys.")
    return {**env, "SHARD_VPS_PORT": port,
            "SHARD_HOMOLOGACAO_URL": env["SHARD_HOMOLOGACAO_URL"].rstrip("/")}


def verify_image(directory: Path, commit: str) -> tuple[str, str]:
    if not re.fullmatch(r"[0-9a-f]{40}", commit):
        raise DeploymentError("Expected a full immutable commit SHA.")
    for name in ("image.tar.gz", "image.tar.gz.sha256", "image-provenance.json", "image-audit-receipt.json"):
        if not (directory / name).is_file() or (directory / name).is_symlink():
            raise DeploymentError("Missing regular audited image artifact.")
    checksum = (directory / "image.tar.gz.sha256").read_text().strip()
    match = re.fullmatch(r"([0-9a-f]{64})  image\.tar\.gz", checksum)
    if not match:
        raise DeploymentError("Invalid archive checksum receipt.")
    with (directory / "image.tar.gz").open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    if digest != match[1]:
        raise DeploymentError("Audited image archive integrity failed.")
    provenance = json.loads((directory / "image-provenance.json").read_text())
    audit = json.loads((directory / "image-audit-receipt.json").read_text())
    image = provenance.get("dockerImageId", "")
    if (not re.fullmatch(r"sha256:[0-9a-f]{64}", image)
            or provenance.get("commitSha") != commit or audit.get("commitSha") != commit
            or audit.get("dockerImageId") != image or audit.get("complete") is not True
            or audit.get("missingReports") != [] or audit.get("vulnerabilityGatePassed") is not True):
        raise DeploymentError("The exact image must have a complete successful CI audit.")
    return image, digest


def ssh_options(private: Path, known: Path) -> list[str]:
    return ["-i", str(private), "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes",
            "-o", "StrictHostKeyChecking=yes", "-o", "UserKnownHostsFile=" + str(known),
            "-o", "ConnectTimeout=20", "-o", "ServerAliveInterval=15",
            "-o", "ServerAliveCountMax=3"]


ACCEPTANCE = ("backupRestoredInIsolation", "dataInventoryMatched", "configurationPreserved",
              "containerSecurityPreserved", "browserSandboxPassed", "postgresReady",
              "publicHttpsReady", "authenticatedSmokePassed", "websocketSmokePassed",
              "previousContainerPreserved")


def verify_acceptance(receipt: dict, commit: str, image: str, origin: str) -> dict:
    if (receipt.get("protocolVersion") != 1 or receipt.get("state") != "deployed"
            or receipt.get("revision") != commit or receipt.get("imageId") != image
            or receipt.get("environment") != "homologacao" or receipt.get("origin") != origin
            or any(receipt.get(name) is not True for name in ACCEPTANCE)):
        raise DeploymentError("The VPS did not prove all homologation acceptance gates.")
    # Allowlist only non-sensitive, schema-bounded evidence into GitHub artifacts.
    return {"protocolVersion": 1, "state": "deployed", "revision": commit,
            "imageId": image, "environment": "homologacao", "origin": origin,
            **{name: True for name in ACCEPTANCE}}


def execute(command: list[str], *, timeout: int = 60) -> str:
    result = subprocess.run(command, capture_output=True, text=True, timeout=timeout, check=False)
    # Remote stderr/stdout can contain application secrets. Never print it on failure.
    if result.returncode:
        raise DeploymentError("SSH release step failed; inspect private VPS evidence and rollback state.")
    return result.stdout


def deploy(env: dict[str, str], directory: Path, commit: str) -> dict:
    config = configuration(env)
    image, digest = verify_image(directory, commit)
    with tempfile.TemporaryDirectory(prefix="norium-release-ssh-") as temp:
        private, known = Path(temp) / "identity", Path(temp) / "known_hosts"
        private.write_text(config["SHARD_VPS_SSH_KEY"].rstrip() + "\n")
        known.write_text(config["SHARD_VPS_KNOWN_HOSTS"].rstrip() + "\n")
        private.chmod(0o600)
        known.chmod(0o600)
        options = ssh_options(private, known)
        target = config["SHARD_VPS_USER"] + "@" + config["SHARD_VPS_HOST"]
        ssh = ["ssh", *options, "-p", config["SHARD_VPS_PORT"], target]
        # Static, root-owned executable installed only after specialist review.
        # The protocol performs its own integrity checks, isolated backup restore,
        # configuration/security preservation and transactional rollback.
        executor = "sudo -n /usr/local/sbin/norium-release"
        preflight = execute([*ssh, executor + " preflight --protocol 1 --environment homologacao"])
        if json.loads(preflight) != {"protocolVersion": 1, "ready": True}:
            raise DeploymentError("The reviewed VPS release executor is not ready.")
        remote = "/srv/norium/releases/" + commit
        execute([*ssh, executor + " prepare --revision " + commit])
        for name in ("image.tar.gz", "image.tar.gz.sha256", "image-provenance.json", "image-audit-receipt.json"):
            execute(["scp", *options, "-P", config["SHARD_VPS_PORT"],
                     str(directory / name), target + ":" + remote + "/" + name], timeout=900)
        # Origin is passed only after strict validation and shell quoting.
        import shlex
        command = (executor + " deploy --revision " + commit + " --image " + image
                   + " --archive-sha256 " + digest + " --origin "
                   + shlex.quote(config["SHARD_HOMOLOGACAO_URL"]))
        receipt = json.loads(execute([*ssh, command], timeout=1200))
        return verify_acceptance(receipt, commit, image, config["SHARD_HOMOLOGACAO_URL"])


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--commit", required=True)
    parser.add_argument("--image-dir", type=Path, required=True)
    parser.add_argument("--receipt", type=Path, required=True)
    args = parser.parse_args()
    receipt = {"state": "blocked", "revision": args.commit, "environment": "homologacao"}
    status = 1
    try:
        receipt = deploy(dict(os.environ), args.image_dir, args.commit)
        status = 0
    except (DeploymentError, OSError, ValueError, subprocess.TimeoutExpired) as error:
        # Do not include untrusted exception text, subprocess data or environment.
        receipt["reason"] = str(error) if isinstance(error, DeploymentError) else type(error).__name__
    args.receipt.parent.mkdir(parents=True, exist_ok=True)
    args.receipt.write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps(receipt))
    return status


if __name__ == "__main__":
    raise SystemExit(main())
