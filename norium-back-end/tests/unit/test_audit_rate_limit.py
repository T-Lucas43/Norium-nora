"""AUD-09: throttled HTTP requests have a usable 429 response."""
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from app import bootstrap
from app.core.rate_limit import SlidingWindowRateLimiter


class AuditRateLimitTests(unittest.TestCase):
    def test_second_login_attempt_is_429_with_retry_after_and_request_id(self):
        with patch.object(bootstrap, "auth_ip_limiter", SlidingWindowRateLimiter(limit=1, window_seconds=60)):
            client = TestClient(bootstrap.create_app())
            payload = {"email": "nobody@example.test", "password": "synthetic-password"}
            first = client.post("/api/auth/login", json=payload)
            second = client.post("/api/auth/login", json=payload)
        self.assertEqual(401, first.status_code)
        self.assertEqual(429, second.status_code)
        self.assertGreater(int(second.headers["Retry-After"]), 0)
        self.assertTrue(second.headers["X-Request-ID"])
        self.assertEqual("no-store", second.headers["Cache-Control"])


if __name__ == "__main__":
    unittest.main()
