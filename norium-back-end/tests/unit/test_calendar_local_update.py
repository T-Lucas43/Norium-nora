"""Edicao de evento local com Google conectado (Codex, rodada 2, P2).

list_events expoe Google + locais; update_event deve rotear ids local_*
para a agenda local mesmo quando conectado, sem chamar o Google.
"""

from __future__ import annotations

import unittest
from unittest.mock import MagicMock, patch

from app.services.calendar_service import CalendarService


class LocalUpdateRoutingTests(unittest.TestCase):
    def test_local_id_updates_locally_when_google_connected(self) -> None:
        service = CalendarService("teste-local-update")
        updated = {"id": "local_abc", "titulo": "Local editado"}

        with (
            patch.object(CalendarService, "status", return_value={"connected": True}),
            patch.object(
                CalendarService, "_update_local_event", return_value=updated
            ) as local_update,
            patch.object(CalendarService, "_update_google_event") as google_update,
        ):
            result = service.update_event("local_abc", {"titulo": "Local editado"})

        local_update.assert_called_once_with("local_abc", {"titulo": "Local editado"})
        google_update.assert_not_called()
        self.assertEqual("local_abc", result["evento"]["id"])

    def test_google_id_still_updates_google_when_connected(self) -> None:
        service = CalendarService("teste-local-update")
        updated = {"id": "google123", "titulo": "Google editado"}

        with (
            patch.object(CalendarService, "status", side_effect=[{"connected": True}, {"connected": True}]),
            patch.object(CalendarService, "_update_local_event") as local_update,
            patch.object(
                CalendarService, "_update_google_event", return_value=updated
            ) as google_update,
            patch.object(CalendarService, "_mark_sync", return_value=None),
        ):
            result = service.update_event("google123", {"titulo": "Google editado"})

        google_update.assert_called_once()
        local_update.assert_not_called()
        self.assertEqual("google123", result["evento"]["id"])

    def test_local_id_updates_locally_when_disconnected(self) -> None:
        service = CalendarService("teste-local-update")
        updated = {"id": "local_xyz", "titulo": "Local offline"}

        with (
            patch.object(CalendarService, "status", return_value={"connected": False}),
            patch.object(
                CalendarService, "_update_local_event", return_value=updated
            ) as local_update,
            patch.object(CalendarService, "_update_google_event") as google_update,
        ):
            result = service.update_event("local_xyz", {"titulo": "Local offline"})

        local_update.assert_called_once()
        google_update.assert_not_called()
        self.assertEqual("local_xyz", result["evento"]["id"])

    def test_local_id_deletes_locally_even_when_google_connected(self) -> None:
        service = CalendarService("teste-local-delete")
        with (
            patch.object(CalendarService, "status", return_value={"connected": True}),
            patch.object(CalendarService, "_delete_local_event") as local_delete,
            patch.object(CalendarService, "_service") as google_service,
        ):
            result = service.delete_event("local_abc")

        local_delete.assert_called_once_with("local_abc")
        google_service.assert_not_called()
        self.assertTrue(result["deleted"])

    def test_google_id_deletes_from_google_when_connected(self) -> None:
        service = CalendarService("teste-google-delete")
        google = MagicMock()
        with (
            patch.object(CalendarService, "status", side_effect=[{"connected": True}, {"connected": True}]),
            patch.object(CalendarService, "_service", return_value=google),
            patch.object(CalendarService, "_mark_sync") as mark_sync,
            patch.object(CalendarService, "_delete_local_event") as local_delete,
        ):
            result = service.delete_event("google123")

        google.events.return_value.delete.assert_called_once_with(calendarId="primary", eventId="google123", sendUpdates="all")
        google.events.return_value.delete.return_value.execute.assert_called_once_with()
        mark_sync.assert_called_once_with()
        local_delete.assert_not_called()
        self.assertTrue(result["deleted"])


if __name__ == "__main__":
    unittest.main()
