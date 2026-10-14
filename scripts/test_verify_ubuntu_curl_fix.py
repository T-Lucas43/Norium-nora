import copy
from datetime import datetime, timezone
import unittest

from scripts.verify_ubuntu_curl_fix import CVE, EXPIRES, PACKAGE, PURL, VERSION, verify


class CanonicalFixVerificationTests(unittest.TestCase):
    def setUp(self):
        self.provenance = {"dockerImageId": "sha256:" + "a" * 64, "commitSha": "b" * 40,
                           "architecture": "amd64", "os": "linux"}
        self.report = {"Metadata": {"ImageID": self.provenance["dockerImageId"],
                                   "OS": {"Family": "ubuntu", "Name": "26.04"}},
                       "Results": [{"Vulnerabilities": [{"VulnerabilityID": CVE, "PkgName": PACKAGE,
                           "InstalledVersion": VERSION, "PkgIdentifier": {"PURL": PURL},
                           "DataSource": {"ID": "ubuntu"}}]}]}
        self.notice = f"<h1>USN-8927-1: curl vulnerabilities</h1><p>{CVE}</p><table><tr><td>26.04 LTS resolute</td><td>{PACKAGE} – {VERSION}</td></tr></table>"
        self.changelog = f"curl ({VERSION}) resolute-security; urgency=medium\n - debian/patches/{CVE}.patch: cleanup\n"
        self.now = datetime(2026, 10, 14, 22, tzinfo=timezone.utc)

    def call(self, **overrides):
        args = dict(report=self.report, provenance=self.provenance, installed_version=VERSION,
                    notice=self.notice, changelog=self.changelog, now=self.now)
        args.update(overrides)
        return verify(**args)

    def test_exact_package_is_fixed_without_mutating_raw_report(self):
        previous = copy.deepcopy(self.report)
        vex = self.call()
        self.assertEqual(vex["statements"][0]["status"], "fixed")
        self.assertEqual(vex["statements"][0]["products"], [{"@id": PURL}])
        self.assertEqual(self.report, previous)

    def test_other_cves_and_packages_never_receive_a_statement(self):
        self.report["Results"][0]["Vulnerabilities"].extend([
            {"VulnerabilityID": "CVE-2026-999999", "PkgName": PACKAGE},
            {"VulnerabilityID": CVE, "PkgName": "libcurl4t64"},
        ])
        vex = self.call()
        self.assertEqual(len(vex["statements"]), 1)
        self.assertEqual(vex["statements"][0]["vulnerability"]["name"], CVE)

    def test_updated_database_needs_no_statement(self):
        self.report["Results"][0]["Vulnerabilities"] = None
        self.assertEqual(self.call()["statements"], [])
        self.assertEqual(self.call(now=EXPIRES.replace(day=16), notice="", changelog="")["statements"], [])

    def test_real_rowspan_layout_keeps_package_bound_to_its_release(self):
        notice = f"<h1>USN-8927-1: curl vulnerabilities</h1><p>{CVE}</p><table><tr><td rowspan='2'>26.04 LTS resolute</td><td>curl – {VERSION}</td></tr><tr><td>{PACKAGE} – {VERSION}</td></tr></table>"
        self.assertEqual(len(self.call(notice=notice)["statements"]), 1)
        with self.assertRaises(ValueError):
            self.call(notice=notice.replace("<tr><td>" + PACKAGE, "<tr><td>24.04 LTS noble</td><td>" + PACKAGE))
        with self.assertRaises(ValueError):
            self.call(notice=notice.replace("</tr><tr><td>" + PACKAGE, "</tr></table><table><tr><td>" + PACKAGE))

    def test_old_package_different_platform_or_image_fail_closed(self):
        for modification in ("version", "platform", "image", "purl", "source", "duplicate"):
            with self.subTest(modification=modification):
                report, provenance = copy.deepcopy(self.report), copy.deepcopy(self.provenance)
                finding = report["Results"][0]["Vulnerabilities"][0]
                if modification == "version": finding["InstalledVersion"] = "8.18.0-1ubuntu2.7"
                if modification == "platform": provenance["architecture"] = "arm64"
                if modification == "image": report["Metadata"]["ImageID"] = "sha256:" + "c" * 64
                if modification == "purl": finding["PkgIdentifier"]["PURL"] = PURL.replace("26.04", "24.04")
                if modification == "source": finding["DataSource"]["ID"] = "nvd"
                if modification == "duplicate": report["Results"][0]["Vulnerabilities"].append(copy.deepcopy(finding))
                with self.assertRaises(ValueError): self.call(report=report, provenance=provenance)

    def test_vendor_disagreement_expiration_or_installed_mismatch_fail_closed(self):
        for overrides in ({"notice": self.notice.replace(VERSION, "8.18.0-1ubuntu2.7")},
                          {"notice": self.notice.replace(CVE, "CVE-2026-00000")},
                          {"notice": self.notice.replace("26.04", "24.04")},
                          {"changelog": self.changelog.replace(CVE, "CVE-2026-00000")},
                          {"installed_version": "8.18.0-1ubuntu2.7"},
                          {"now": EXPIRES.replace(day=16)},
                          {"now": self.now.replace(tzinfo=None)}):
            with self.subTest(overrides=overrides):
                with self.assertRaises(ValueError): self.call(**overrides)


if __name__ == "__main__":
    unittest.main()
