"""Consulta repetida da agenda nao reacende aviso ja lido (Codex, rodada 2, P1).

Reproduz o GET do card: _record_calendar_events chama record_event com
timestamp novo a cada chamada. O mesmo conteudo nao deve regravar nem
retransmitir; mudanca material (titulo/inicio) deve atualizar.
"""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from app.modules.inbox import router as inbox_router


class CalendarNotificationIdempotencyTests(unittest.IsolatedAsyncioTestCase):
    async def test_repeated_sync_with_new_timestamp_is_idempotent(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)

            def isolated_path(user_id: str) -> Path:
                path = root / user_id / "events.json"
                path.parent.mkdir(parents=True, exist_ok=True)
                return path

            broadcast = AsyncMock()
            with (
                patch.object(inbox_router, "event_db_path", side_effect=isolated_path),
                patch.object(inbox_router.manager, "broadcast", broadcast),
            ):
                base = {
                    "source": "calendar",
                    "title": "Compromisso no Google Agenda",
                    "description": "Daily - 2026-09-19T09:00:00-03:00",
                    "metadata": {
                        "userId": "usuario-a",
                        "eventId": "g1",
                        "inicio": "2026-09-19T09:00:00-03:00",
                        "fim": "2026-09-19T09:30:00-03:00",
                    },
                    "event_id": "calendar_google_usuario-a_g1",
                }
                first = await inbox_router.record_event(
                    **base, timestamp="2026-09-19T12:00:00+00:00"
                )
                second = await inbox_router.record_event(
                    **base, timestamp="2026-09-19T12:05:00+00:00"
                )

                stored = await inbox_router.read_events("usuario-a")

            broadcast.assert_awaited_once()
            self.assertEqual(1, len(stored))
            # Timestamp original preservado: aviso lido antes continua lido.
            self.assertEqual(first["timestamp"], second["timestamp"])
            self.assertEqual("2026-09-19T12:00:00+00:00", stored[0]["timestamp"])

    async def test_material_change_still_updates_and_broadcasts(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)

            def isolated_path(user_id: str) -> Path:
                path = root / user_id / "events.json"
                path.parent.mkdir(parents=True, exist_ok=True)
                return path

            broadcast = AsyncMock()
            with (
                patch.object(inbox_router, "event_db_path", side_effect=isolated_path),
                patch.object(inbox_router.manager, "broadcast", broadcast),
            ):
                await inbox_router.record_event(
                    source="calendar",
                    title="Compromisso no Google Agenda",
                    description="Daily - 2026-09-19T09:00:00-03:00",
                    metadata={
                        "userId": "usuario-a",
                        "eventId": "g1",
                        "inicio": "2026-09-19T09:00:00-03:00",
                        "fim": "2026-09-19T09:30:00-03:00",
                    },
                    event_id="calendar_google_usuario-a_g1",
                    timestamp="2026-09-19T12:00:00+00:00",
                )
                await inbox_router.record_event(
                    source="calendar",
                    title="Compromisso no Google Agenda",
                    description="Daily adiada - 2026-09-19T10:00:00-03:00",
                    metadata={
                        "userId": "usuario-a",
                        "eventId": "g1",
                        "inicio": "2026-09-19T10:00:00-03:00",
                        "fim": "2026-09-19T10:30:00-03:00",
                    },
                    event_id="calendar_google_usuario-a_g1",
                    timestamp="2026-09-19T12:05:00+00:00",
                )

                stored = await inbox_router.read_events("usuario-a")

            self.assertEqual(2, broadcast.await_count)
            self.assertEqual(1, len(stored))
            self.assertIn("10:00", stored[0]["description"])


if __name__ == "__main__":
    unittest.main()
