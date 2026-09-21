import os
import unittest
from unittest.mock import patch

from app import bootstrap


class TopologyTests(unittest.TestCase):
    def test_shared_runtime_rejects_multiple_web_workers(self):
        with patch.dict(os.environ, {"ENVIRONMENT": "production", "APP_ENV": "production", "WEB_CONCURRENCY": "2"}, clear=False):
            with self.assertRaises(RuntimeError):
                bootstrap.validate_runtime_topology()

    def test_shared_runtime_accepts_single_writer(self):
        with patch.dict(os.environ, {"ENVIRONMENT": "production", "APP_ENV": "production", "WEB_CONCURRENCY": "1"}, clear=False):
            bootstrap.validate_runtime_topology()


if __name__ == "__main__":
    unittest.main()
