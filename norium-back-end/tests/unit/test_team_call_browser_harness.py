"""Regression coverage for browser selection and privacy at event boundaries."""
import importlib.util
from pathlib import Path
import sys
import unittest
from unittest.mock import AsyncMock, Mock

path = Path(__file__).resolve().parents[3] / 'norium-front-end/tests/browser/team_call_e2e.py'
spec = importlib.util.spec_from_file_location('team_call_browser_harness', path)
harness = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = harness
spec.loader.exec_module(harness)


class BrowserHarnessTests(unittest.IsolatedAsyncioTestCase):
    def test_state_artifacts_discard_identifiers_and_unexpected_values(self):
        result = harness.sanitized_call_state({
            'phase': 'failed', 'socketState': 'open', 'microphonePermission': 'unavailable',
            'cameraPermission': 'https://synthetic.invalid/?ticket=private',
            'failureNotice': 'candidate:private', 'callId': 'private',
            'mediaRequests': [{'audio': 'private'}],
        })
        self.assertEqual({
            'phase': 'failed', 'socketState': 'open',
            'microphonePermission': 'unavailable', 'cameraPermission': 'unknown',
        }, result)

    async def test_default_browser_uses_full_chromium_and_never_silently_falls_back(self):
        playwright = Mock()
        playwright.chromium.launch = AsyncMock(side_effect=RuntimeError('missing binary'))
        with self.assertRaises(RuntimeError):
            await harness.launch_browser(playwright, harness.parser().parse_args([]), Path('synthetic-media'))
        self.assertEqual(1, playwright.chromium.launch.await_count)
        self.assertEqual('chromium', playwright.chromium.launch.call_args.kwargs['channel'])

    async def test_event_artifacts_never_read_request_urls_or_exception_contents(self):
        handlers = {}
        page = Mock()
        page.on.side_effect = lambda event, handler: handlers.update({event: handler})
        events = []
        harness.register_browser_diagnostics(page, events)

        class SensitivePayload:
            def __getattribute__(self, key):
                raise AssertionError('diagnostics must not read raw event contents')

        for _ in range(300):
            handlers['requestfailed'](SensitivePayload())
            handlers['pageerror'](SensitivePayload())
        self.assertEqual(256, len(events))
        self.assertEqual({'requestfailed', 'pageerror'}, set(events))


if __name__ == '__main__':
    unittest.main()
