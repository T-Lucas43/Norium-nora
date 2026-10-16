import contextlib
import copy
import io
import json
import unittest

from preflight import ROOT, inspect, main


class ReviewChecks(unittest.TestCase):
    def setUp(self):
        self.plan = json.loads((ROOT / "plan.json").read_text(encoding="utf-8"))
        self.config = (ROOT / "turnserver.conf.template").read_text(encoding="utf-8")

    def test_coherent_template_never_means_ready(self):
        result = inspect(self.plan, self.config, self.plan["apt_candidate"])
        self.assertFalse(result["errors"])
        self.assertFalse(result["ready"])
        self.assertEqual(10, len(result["pending"]))
        for args, code in (([], 2), (["--lint-only"], 0), (["--candidate", "unreviewed"], 1)):
            with contextlib.redirect_stdout(io.StringIO()) as output:
                self.assertEqual(code, main(args))
            self.assertFalse(json.loads(output.getvalue())["ready"])

    def test_rejects_security_regressions_and_accidental_secret(self):
        mutations = (
            self.config + "\nno-auth=1", self.config + "\nno-tls",
            self.config + "\nallowed-peer-ip=127.0.0.1",
            self.config + "\ninclude=/tmp/unsafe.conf",
            self.config + "\nrealm=another",
            self.config.replace("total-quota=100", "total-quota=0"),
            self.config.replace("max-port=50199", "max-port=65535"),
            self.config.replace("no-tcp-relay\n", ""),
            self.config.replace("denied-peer-ip=127.0.0.0-127.255.255.255\n", ""),
            self.config.replace("__GENERATE_EXCLUSIVE_SECRET_ONLY_ON_HOST__", "a" * 64),
        )
        for config in mutations:
            with self.subTest(case=mutations.index(config)):
                self.assertTrue(inspect(self.plan, config)["errors"])

    def test_acknowledgment_or_candidate_change_cannot_authorize(self):
        plan = copy.deepcopy(self.plan)
        plan["required_review"] = dict.fromkeys(plan["required_review"], True)
        self.assertTrue(inspect(plan, self.config)["errors"])
        plan["required_review"] = dict.fromkeys(plan["required_review"], "human says yes")
        result = inspect(plan, self.config)
        self.assertFalse(result["ready"])
        self.assertEqual(10, len(result["pending"]))
        self.assertTrue(inspect(self.plan, self.config, "different-candidate")["errors"])
        self.assertTrue(inspect([], self.config)["errors"])


if __name__ == "__main__":
    unittest.main()
