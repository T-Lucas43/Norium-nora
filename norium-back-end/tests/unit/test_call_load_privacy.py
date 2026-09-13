from __future__ import annotations

import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from tests import team_call_load


class LoadPrivacyTests(unittest.TestCase):
    def test_failure_artifact_excludes_exception_text_and_trace_source(self):
        sensitive = "candidate:fixture 192.0.2.1 ticket=private v=0 media-payload"
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            printed = io.StringIO()
            with patch("sys.argv", ["load", "--artifacts-dir", directory]), \
                 patch.object(team_call_load, "_run", AsyncMock(side_effect=RuntimeError(sensitive))), \
                 contextlib.redirect_stdout(printed):
                self.assertEqual(1, team_call_load.main())
            report = (output / "team-call-load.json").read_text(encoding="utf-8")
            self.assertFalse(sensitive in report + printed.getvalue())
            self.assertEqual("RuntimeError", json.loads(report)["error"])

    def test_fixture_failure_does_not_copy_raw_service_log(self):
        sensitive = "candidate:fixture 192.0.2.1 ticket=private v=0 media-payload"
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            raw_log = output / "service.log"
            raw_log.write_text(sensitive, encoding="utf-8")
            fixture = team_call_load.ManagedFixture(output, "127.0.0.1", 0, 1, 2, output)
            fixture.log_path = raw_log
            fixture.stop(passed=False, artifacts_dir=output)
            self.assertFalse(raw_log.exists())
            for artifact in output.iterdir():
                self.assertFalse(sensitive in artifact.read_text(encoding="utf-8"))
