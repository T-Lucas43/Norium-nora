"""Interseccao de eventos locais com o intervalo pedido (Codex, rodada 1, item 3).

_list_local_events filtrava so pelo inicio: um evento local de varios dias
que comecou antes da janela nunca aparecia, mesmo ainda ocorrendo hoje.
"""

from __future__ import annotations

import unittest

from app.services.calendar_service import CalendarService


class _LocalService(CalendarService):
    def __init__(self, eventos):
        super().__init__("teste-sobreposicao")
        self._eventos = eventos

    def _read_profile_section(self, section, fallback):
        if section == "calendarLocalEvents":
            return self._eventos
        return fallback


# 00:00 de 19/09 e 00:00 de 20/09 em Sao Paulo, em UTC.
DAY_MIN = "2026-09-19T03:00:00+00:00"
DAY_MAX = "2026-09-20T03:00:00+00:00"


def local(identifier, inicio, fim=None, titulo="Evento"):
    evento = {"id": identifier, "titulo": titulo, "inicio": inicio}
    if fim is not None:
        evento["fim"] = fim
    return evento


class ListLocalEventsOverlapTest(unittest.TestCase):
    def ids(self, eventos, query=None):
        service = _LocalService(eventos)
        return [item["id"] for item in service._list_local_events(DAY_MIN, DAY_MAX, query)]

    def test_multi_day_started_before_window_still_today(self):
        self.assertEqual(
            self.ids([local("longo", "2026-09-17T10:00:00-03:00", "2026-09-19T02:00:00-03:00")]),
            ["longo"],
        )

    def test_ended_before_window_is_excluded(self):
        self.assertEqual(
            self.ids([local("ontem", "2026-09-18T09:00:00-03:00", "2026-09-18T10:00:00-03:00")]),
            [],
        )

    def test_starting_after_window_is_excluded(self):
        self.assertEqual(
            self.ids([local("amanha", "2026-09-20T09:00:00-03:00", "2026-09-20T10:00:00-03:00")]),
            [],
        )

    def test_point_event_before_window_keeps_old_behavior(self):
        self.assertEqual(self.ids([local("pontual", "2026-09-18T09:00:00-03:00")]), [])

    def test_all_day_today_is_included(self):
        self.assertEqual(self.ids([{"id": "dia", "titulo": "Dia", "inicio": "2026-09-19"}]), ["dia"])

    def test_query_filter_still_applies(self):
        self.assertEqual(
            self.ids(
                [
                    local("a", "2026-09-19T10:00:00-03:00", "2026-09-19T11:00:00-03:00", titulo="Reuniao"),
                    local("b", "2026-09-19T10:00:00-03:00", "2026-09-19T11:00:00-03:00", titulo="Almoco"),
                ],
                query="reuniao",
            ),
            ["a"],
        )


if __name__ == "__main__":
    unittest.main()
