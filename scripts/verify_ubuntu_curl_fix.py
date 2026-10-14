"""Verify the single, human-approved Canonical correction before emitting VEX.

Raw scanner reports stay unchanged. This is not an exception for an open CVE:
only the exact backported package confirmed by Canonical can be marked fixed.
All unknown findings and all other package versions remain blocking in Trivy.
"""
import argparse
from datetime import datetime, timezone
import hashlib
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import time
import urllib.error
import urllib.request

CVE = "CVE-2026-92392"
PACKAGE = "libcurl3t64-gnutls"
VERSION = "8.18.0-1ubuntu2.8"
PURL = f"pkg:deb/ubuntu/{PACKAGE}@{VERSION}?arch=amd64&distro=ubuntu-26.04"
EXPIRES = datetime(2026, 10, 15, 20, 33, tzinfo=timezone.utc)
CHANGELOG = f"https://changelogs.ubuntu.com/changelogs/pool/main/c/curl/curl_{VERSION}/changelog"
NOTICE = "https://ubuntu.com/security/notices/USN-8927-1"


def fetch(url):
    for attempt in range(3):
        try:
            request = urllib.request.Request(url, headers={"User-Agent": "Norium-release-verification/1.0"})
            with urllib.request.urlopen(request, timeout=20) as response:
                if response.geturl() != url:
                    raise ValueError("Unexpected vendor redirect")
                data = response.read(1024 * 1024 + 1)
            break
        except (urllib.error.URLError, TimeoutError):
            if attempt == 2:
                raise
            time.sleep(attempt + 1)
    if len(data) > 1024 * 1024:
        raise ValueError("Vendor document exceeds limit")
    return data.decode("utf-8")


class NoticeParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.rows = []
        self.text = []
        self.row = None
        self.ignored = 0
        self.table = 0

    def handle_starttag(self, tag, attrs):
        if tag in {"script", "style"}: self.ignored += 1
        if tag == "table": self.table += 1
        if tag == "tr": self.row = []

    def handle_endtag(self, tag):
        if tag in {"script", "style"}: self.ignored = max(0, self.ignored - 1)
        if tag == "tr" and self.row is not None:
            self.rows.append((self.table, " ".join(self.row)))
            self.row = None

    def handle_data(self, data):
        if self.ignored: return
        clean = " ".join(data.split())
        if clean:
            self.text.append(clean)
            if self.row is not None: self.row.append(clean)


def verify(report, provenance, installed_version, notice, changelog, now):
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
    parsed = NoticeParser()
    parsed.feed(notice)
    text = " ".join(parsed.text)
    if "USN-8927-1: curl vulnerabilities" not in text or CVE not in text:
        raise ValueError("Wrong vendor notice")
    release, previous_table = "", None
    rows = []
    for table, row in parsed.rows:
        if table != previous_table: release = ""
        previous_table = table
        match = re.search(r"\b(\d{2}\.\d{2} LTS [a-z]+)\b", row)
        if match: release = match.group(1)
        # Canonical uses rowspan: subsequent package rows inherit the release.
        if release == "26.04 LTS resolute" and re.search(rf"\b{PACKAGE}\s*[–-]\s*{re.escape(VERSION)}\b", row):
            rows.append(row)
    if len(rows) != 1:
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
    notice, changelog = (fetch(NOTICE), fetch(CHANGELOG)) if needed else ("", "")
    now = datetime.now(timezone.utc)
    vex = verify(report, provenance, args.installed_version, notice, changelog, now)
    sources = [{"url": url, "text": content,
                "sha256": hashlib.sha256(content.encode()).hexdigest()}
               for url, content in ((NOTICE, notice), (CHANGELOG, changelog)) if content]
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
