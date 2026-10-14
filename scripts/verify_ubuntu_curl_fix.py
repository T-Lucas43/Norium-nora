"""Verify the single, human-approved Canonical correction before emitting VEX.

Raw scanner reports stay unchanged. This is not an exception for an open CVE:
only the exact backported package confirmed by Canonical can be marked fixed.
All unknown findings and all other package versions remain blocking in Trivy.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import urllib.request

CVE = "CVE-2026-92392"
PACKAGE = "libcurl3t64-gnutls"
VERSION = "8.18.0-1ubuntu2.8"
PURL = f"pkg:deb/ubuntu/{PACKAGE}@{VERSION}?arch=amd64&distro=ubuntu-26.04"
EXPIRES = datetime(2026, 10, 15, 20, 33, tzinfo=timezone.utc)
TRACKER = f"https://git.launchpad.net/ubuntu-cve-tracker/plain/active/{CVE}"
CHANGELOG = f"https://changelogs.ubuntu.com/changelogs/pool/main/c/curl/curl_{VERSION}/changelog"
NOTICE = "https://ubuntu.com/security/notices/USN-8927-1"


def fetch(url):
    with urllib.request.urlopen(url, timeout=45) as response:
        if response.geturl() != url:
            raise ValueError("Unexpected vendor redirect")
        data = response.read(1024 * 1024 + 1)
    if len(data) > 1024 * 1024:
        raise ValueError("Vendor document exceeds limit")
    return data.decode("utf-8")


def verify(report, provenance, installed_version, tracker, changelog, now):
    if report.get("Metadata", {}).get("ImageID") != provenance["dockerImageId"]:
        raise ValueError("Scanner report does not match exact image")
    if not re.fullmatch(r"[0-9a-f]{40}", provenance["commitSha"]):
        raise ValueError("Invalid revision")
    matches = [item for result in report.get("Results", [])
               for item in result.get("Vulnerabilities") or []
               if item.get("VulnerabilityID") == CVE and item.get("PkgName") == PACKAGE]
    document = {
        "@context": "https://openvex.dev/ns/v0.2.0",
        "@id": "urn:norium:canonical-fixed:" + provenance["commitSha"] + ":" + CVE,
        "author": "Norium - verified Canonical package correction",
        "timestamp": now.isoformat(), "version": 1, "statements": [],
    }
    if not matches:
        return document  # An updated database needs no vendor exception.
    if now.tzinfo is None or now > EXPIRES:
        raise ValueError("Temporary vendor verification expired")
    if report["Metadata"].get("OS") != {"Family": "ubuntu", "Name": "26.04"}:
        raise ValueError("Unexpected distribution")
    if provenance.get("architecture") != "amd64" or provenance.get("os") != "linux":
        raise ValueError("Unexpected image platform")
    if installed_version.strip() != VERSION:
        raise ValueError("Installed package is not the reviewed version")
    if not re.search(rf"^Candidate: {CVE}$", tracker, re.M):
        raise ValueError("Wrong vendor advisory")
    if not re.search(rf"^resolute_curl: released \({re.escape(VERSION)}\)$", tracker, re.M):
        raise ValueError("Vendor no longer confirms correction")
    first_release = changelog.split("\ncurl (", 1)[0]
    if not first_release.startswith(f"curl ({VERSION}) resolute-security;"):
        raise ValueError("Wrong vendor package changelog")
    if f"debian/patches/{CVE}.patch:" not in first_release:
        raise ValueError("Backported correction absent")
    if len(matches) > 1:
        raise ValueError("Ambiguous package findings")
    for item in matches:
        if item.get("InstalledVersion") != VERSION or item.get("PkgIdentifier", {}).get("PURL") != PURL:
            raise ValueError("Finding is outside reviewed package scope")
        if item.get("DataSource", {}).get("ID") != "ubuntu":
            raise ValueError("Unexpected advisory source")
    document["statements"] = [{"vulnerability": {"name": CVE}, "products": [{"@id": PURL}],
                              "status": "fixed", "status_notes": NOTICE,
                              "action_statement": "Install the Canonical backported correction " + VERSION}]
    return document


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--evidence-dir", type=Path, required=True)
    parser.add_argument("--installed-version", required=True)
    args = parser.parse_args()
    root = args.evidence_dir
    report = json.loads((root / "image-vulnerabilities.json").read_text())
    provenance = json.loads((root / "image-provenance.json").read_text())
    needed = any(item.get("VulnerabilityID") == CVE and item.get("PkgName") == PACKAGE
                 for result in report.get("Results", []) for item in result.get("Vulnerabilities") or [])
    tracker, changelog = (fetch(TRACKER), fetch(CHANGELOG)) if needed else ("", "")
    now = datetime.now(timezone.utc)
    vex = verify(report, provenance, args.installed_version, tracker, changelog, now)
    sources = [{"url": url, "text": content,
                "sha256": hashlib.sha256(content.encode()).hexdigest()}
               for url, content in ((TRACKER, tracker), (CHANGELOG, changelog)) if content]
    (root / "ubuntu-vendor-fix.openvex.json").write_text(json.dumps(vex, indent=2) + "\n")
    (root / "ubuntu-vendor-fix-receipt.json").write_text(json.dumps({
        "commitSha": provenance["commitSha"], "dockerImageId": provenance["dockerImageId"],
        "review": "Human reviewer approved this exact Canonical correction on 2026-10-14",
        "verifiedAt": now.isoformat(), "expiresAt": EXPIRES.isoformat(),
        "package": PURL, "cve": CVE, "statementCount": len(vex["statements"]),
        "originalReportSha256": hashlib.sha256((root / "image-vulnerabilities.json").read_bytes()).hexdigest(),
        "notice": NOTICE, "sources": sources,
    }, indent=2) + "\n")


if __name__ == "__main__":
    main()
