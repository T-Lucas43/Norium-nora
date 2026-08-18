from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.infrastructure.http.spa import configure_spa
from app.modules.system.router import router as system_router


class SpaHostingTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.static_root = Path(self.temporary_directory.name)
        (self.static_root / "assets").mkdir()
        (self.static_root / "index.html").write_text("<title>Norium</title>", encoding="utf-8")
        (self.static_root / "env.js").write_text("window.__NORIUM_CONFIG__ = {};", encoding="utf-8")
        (self.static_root / "assets" / "app.js").write_text("console.log('norium');", encoding="utf-8")

        app = FastAPI()

        @app.get("/api/ping")
        async def ping() -> dict[str, bool]:
            return {"ok": True}

        app.include_router(system_router)
        self.assertTrue(configure_spa(app, self.static_root))
        self.client = TestClient(app)

    def tearDown(self) -> None:
        self.temporary_directory.cleanup()

    def test_keeps_api_routes_ahead_of_spa_fallback(self) -> None:
        response = self.client.get("/api/ping")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"ok": True})

    def test_returns_index_for_browser_navigation(self) -> None:
        response = self.client.get("/dashboard/agenda", headers={"Accept": "text/html"})
        self.assertEqual(response.status_code, 200)
        self.assertIn("Norium", response.text)
        self.assertEqual(response.headers["cache-control"], "no-store")

    def test_returns_index_at_root_for_browser_navigation(self) -> None:
        response = self.client.get("/", headers={"Accept": "text/html"})
        self.assertEqual(response.status_code, 200)
        self.assertIn("Norium", response.text)
        self.assertEqual(response.headers["cache-control"], "no-store")

    def test_preserves_root_status_for_api_clients(self) -> None:
        response = self.client.get("/", headers={"Accept": "application/json"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"status": "Online", "engine": "Norium Chat API"})

    def test_does_not_mask_missing_api_routes(self) -> None:
        response = self.client.get("/api/missing", headers={"Accept": "text/html"})
        self.assertEqual(response.status_code, 404)

    def test_serves_assets_with_long_lived_cache(self) -> None:
        response = self.client.get("/assets/app.js")
        self.assertEqual(response.status_code, 200)
        self.assertIn("immutable", response.headers["cache-control"])

    def test_skips_registration_without_an_index(self) -> None:
        empty_root = self.static_root / "empty"
        empty_root.mkdir()
        self.assertFalse(configure_spa(FastAPI(), empty_root))


if __name__ == "__main__":
    unittest.main()
