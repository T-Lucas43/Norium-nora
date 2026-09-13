from __future__ import annotations

import unittest

from fastapi.testclient import TestClient

from main import app


class SecurityHeadersTests(unittest.TestCase):
    def test_first_party_meetings_can_request_camera_and_microphone(self) -> None:
        response = TestClient(app).get("/health")

        self.assertEqual(response.status_code, 200)
        policy = response.headers.get("permissions-policy", "")
        self.assertIn("camera=(self)", policy)
        self.assertIn("microphone=(self)", policy)
        self.assertNotIn("camera=()", policy)
        self.assertNotIn("microphone=()", policy)


if __name__ == "__main__":
    unittest.main()
