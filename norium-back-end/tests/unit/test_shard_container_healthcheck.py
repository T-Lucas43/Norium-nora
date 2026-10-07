from __future__ import annotations

import os
from pathlib import Path
import re
import unittest
from unittest.mock import patch
from urllib.error import URLError


class ShardContainerHealthcheckTests(unittest.TestCase):
    def healthcheck_code(self):
        dockerfile = (Path(__file__).resolve().parents[3] / "Dockerfile.shard").read_text(encoding="utf-8")
        match = re.search(r'CMD python -c "([^\n]+)"', dockerfile)
        self.assertIsNotNone(match)
        return match.group(1)

    def test_probe_uses_the_same_port_as_uvicorn(self):
        code = self.healthcheck_code()
        for port, expected in (("80", "80"), ("8000", "8000"), ("8080", "8080"), ("", "80"), (None, "80")):
            with self.subTest(port=port), patch.dict(os.environ, {}, clear=True):
                if port is not None:
                    os.environ["PORT"] = port
                with patch("urllib.request.urlopen") as request:
                    exec(code, {})
                request.assert_called_once_with(f"http://127.0.0.1:{expected}/health", timeout=5)

    def test_failed_probe_propagates_error_for_nonzero_exit(self):
        with patch("urllib.request.urlopen", side_effect=URLError("synthetic unavailable")):
            with self.assertRaises(URLError):
                exec(self.healthcheck_code(), {})


if __name__ == "__main__":
    unittest.main()
