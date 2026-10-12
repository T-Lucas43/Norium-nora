from __future__ import annotations

import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch
from zoneinfo import ZoneInfo

from fastapi import HTTPException

from app.modules.scheduling.repository import SchedulingRepository
from app.modules.scheduling.router import _booking_calendar_details
from app.modules.scheduling.schemas import AvailabilityPayload, BookingField, BookingPayload, PagePayload, Period, ServicePayload, TeamProfessionalPayload, TeamSettingsPayload
from app.modules.scheduling.service import SchedulingService, validate_cpf


class SchedulingTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.scheduling = SchedulingService(SchedulingRepository(Path(self.temporary.name) / "scheduling.sqlite3"))

    def tearDown(self):
        self.temporary.cleanup()

    def configured(self, scope=("tenant-a", "primary", "user-a"), capacity=1):
        item = self.scheduling.create_service(scope, ServicePayload(name="Consultoria", durations=[30, 60], capacity=capacity, bufferBefore=10, bufferAfter=10))
        self.scheduling.set_availability(scope, AvailabilityPayload(serviceId=item["id"], timezone="America/Sao_Paulo", weekly={"0": [Period(start="08:00", end="12:00"), Period(start="14:00", end="18:00")]}))
        page = self.scheduling.create_page(scope, PagePayload(serviceId=item["id"], title="Consultoria", slug="consultoria", fields=[BookingField(id="cpf", type="cpf", label="CPF", required=True, maxLength=14)]))
        return item, page

    @staticmethod
    def next_monday_at(hour: int) -> datetime:
        current = datetime.now(timezone.utc) + timedelta(days=2)
        while current.weekday() != 0:
            current += timedelta(days=1)
        return current.replace(hour=hour + 3, minute=0, second=0, microsecond=0)

    @classmethod
    def booking_payload(cls, start: datetime, key: str) -> BookingPayload:
        return BookingPayload(startAt=start.isoformat(), duration=60, name="Cliente Teste", email="CLIENTE@example.com", phone="+55 11 99999-9999", responses={"cpf": "529.982.247-25"}, idempotencyKey=key)

    def test_completion_outcome_persists_and_is_scoped(self):
        scope = ("tenant-a", "primary", "user-a")
        _, page = self.configured(scope)
        booking = self.scheduling.create_booking(page["public_id"], self.booking_payload(self.next_monday_at(8), "outcome-test"))["booking"]
        result = self.scheduling.update_booking_status(scope, booking["id"], "COMPLETED", "service")
        self.assertEqual("service", result["completion_type"])
        self.assertEqual("COMPLETED", result["status"])
        self.scheduling.repo.migrate()
        self.assertEqual("service", self.scheduling.get_booking(scope, booking["id"])["completion_type"])
        with self.assertRaises(HTTPException) as error:
            self.scheduling.update_booking_status(("tenant-b", "primary", "user-b"), booking["id"], "COMPLETED", "meeting")
        self.assertEqual(404, error.exception.status_code)
        with self.assertRaises(HTTPException):
            self.scheduling.update_booking_status(scope, booking["id"], "NO_SHOW", "service")
        row = self.scheduling.repo.one("SELECT * FROM scheduling_bookings WHERE id=?", (booking["id"],))
        # Public bearer links cannot overwrite an outcome recorded by the owner.
        from app.modules.scheduling.repository import token_hash
        for action in ("cancel", "reschedule"):
            token = "synthetic-closed-link-" + action
            column = "cancel_token_hash" if action == "cancel" else "reschedule_token_hash"
            with self.scheduling.repo.transaction() as db:
                db.execute(f"UPDATE scheduling_bookings SET {column}=? WHERE id=?", (token_hash(token), row["id"]))
            with self.assertRaises(HTTPException) as closed:
                if action == "cancel": self.scheduling.cancel(token)
                else: self.scheduling.reschedule(token, self.next_monday_at(9).isoformat(), 60)
            self.assertEqual(409, closed.exception.status_code)

    def test_page_design_preserves_dark_palette_and_rejects_invalid_options(self):
        item, _ = self.configured()
        theme = {"fontFamily":"serif", "layout":"stacked", "cardStyle":"square", "darkBackground":"#101828", "darkSurface":"#182230", "darkText":"#ffffff", "darkMuted":"#ccd5e0", "darkBorder":"#334155", "showFooter":"false"}
        page = self.scheduling.create_page(("tenant-a","primary","user-a"), PagePayload(serviceId=item["id"],title="Serviço sintético",theme=theme))
        self.assertEqual(theme, self.scheduling.public_page(page["public_id"])["page"]["theme"])
        for invalid in ({"fontFamily":[]}, {"layout":"javascript"}, {"background":"url(secret)"}, {"darkBackground":"#ffffff","darkText":"#ffffff"}):
            with self.assertRaises(ValueError):
                PagePayload(serviceId=item["id"],title="Teste",theme=invalid)

    def test_uploaded_logo_public_bytes_and_version_change(self):
        import base64
        from app.modules.scheduling.service import get_user_dir
        _, page = self.configured()
        scope = ("tenant-a", "primary", "user-a")
        first = b"\x89PNG\r\n\x1a\nsynthetic-a"
        second = b"\x89PNG\r\n\x1a\nsynthetic-b"
        with patch("app.modules.scheduling.service.get_user_dir", return_value=Path(self.temporary.name)):
            url = self.scheduling.upload_logo(scope, page["id"], base64.b64encode(first).decode())["logoUrl"]
            asset, mime = self.scheduling.logo_asset(page["public_id"])
            self.assertEqual(first, Path(asset).read_bytes())
            self.assertEqual("image/png", mime)
            changed = self.scheduling.upload_logo(scope, page["id"], base64.b64encode(second).decode())["logoUrl"]
            self.assertNotEqual(url, changed)
            self.assertEqual(changed, self.scheduling.public_page(page["public_id"])["page"]["logo_url"])

    def test_weekly_periods_exclude_lunch(self):
        _item, page = self.configured()
        day = self.next_monday_at(8).astimezone(ZoneInfo("America/Sao_Paulo")).date()
        slots = self.scheduling.available_slots(page["public_id"], day, 60)["slots"]
        hours = [datetime.fromisoformat(slot["startAt"]).astimezone(ZoneInfo("America/Sao_Paulo")).hour for slot in slots]
        self.assertIn(8, hours); self.assertIn(14, hours)
        self.assertNotIn(12, hours); self.assertNotIn(13, hours)

    def test_custom_public_texts_are_validated_persisted_and_updated(self):
        scope = ("tenant-a", "primary", "user-a")
        item = self.scheduling.create_service(scope, ServicePayload(name="Manutenção", durations=[45]))
        page = self.scheduling.create_page(scope, PagePayload(serviceId=item["id"], title="Agende seu serviço",
            theme={"introTitle": "Agende a manutenção.", "serviceLabel": "Seu serviço", "closingNote": ""}))
        public = self.scheduling.public_page(page["public_id"])
        self.assertEqual(public["page"]["theme"]["introTitle"], "Agende a manutenção.")
        self.assertEqual(public["service"]["durations"], [45])
        self.scheduling.update_page(scope, page["id"], PagePayload(serviceId=item["id"], title="Agende seu serviço",
            theme={"introTitle": "Novo título", "closingNote": "Até breve."}))
        self.assertEqual(self.scheduling.public_page(page["public_id"])["page"]["theme"]["closingNote"], "Até breve.")
        for invalid in ({"introTitle": "x" * 161}, {"closingNote": ["texto"]}, {"primary": "azul"}):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                PagePayload(serviceId=item["id"], title="Serviço", theme=invalid)

    def test_fixed_service_duration_cannot_be_changed_by_public_client(self):
        scope = ("tenant-a", "primary", "user-a")
        item = self.scheduling.create_service(scope, ServicePayload(name="Serviço fixo", durations=[45]))
        page = self.scheduling.create_page(scope, PagePayload(serviceId=item["id"], title="Serviço fixo"))
        with self.assertRaises(HTTPException) as error:
            self.scheduling.available_slots(page["public_id"], self.next_monday_at(8).date(), 30)
        self.assertEqual(error.exception.status_code, 422)

    def test_tenant_and_user_ownership_is_enforced(self):
        item, _page = self.configured()
        with self.assertRaises(HTTPException) as error:
            self.scheduling.get_service(("tenant-b", "primary", "user-b"), item["id"])
        self.assertEqual(error.exception.status_code, 404)

    def test_database_rejects_duplicate_public_slug(self):
        item, _page = self.configured()
        other_scope = ("tenant-b", "primary", "user-b")
        other = self.scheduling.create_service(other_scope, ServicePayload(name="Outro", durations=[30]))
        with self.assertRaises(HTTPException) as error:
            self.scheduling.create_page(other_scope, PagePayload(serviceId=other["id"], title="Outra", slug="consultoria"))
        self.assertEqual(error.exception.status_code, 409)

    def test_backend_rejects_time_outside_availability(self):
        _item, page = self.configured()
        with self.assertRaises(HTTPException) as error:
            self.scheduling.create_booking(page["public_id"], self.booking_payload(self.next_monday_at(12), "lunch-attack"))
        self.assertEqual(error.exception.status_code, 409)

    def test_fields_normalize_personal_data(self):
        _item, page = self.configured()
        result = self.scheduling.create_booking(page["public_id"], self.booking_payload(self.next_monday_at(8), "idem-fields"))
        stored = self.scheduling.repo.one("SELECT * FROM scheduling_bookings WHERE public_id=?", (result["booking"]["public_id"],))
        self.assertEqual(stored["responses"]["cpf"], "52998224725")
        self.assertEqual(stored["attendee_email"], "cliente@example.com")
        self.assertEqual(stored["attendee_phone"], "+5511999999999")
        with self.assertRaises(ValueError): validate_cpf("111.111.111-11")

    def test_idempotency_replays_without_duplicate(self):
        _item, page = self.configured()
        payload = self.booking_payload(self.next_monday_at(8), "idem-repeat")
        first = self.scheduling.create_booking(page["public_id"], payload)
        second = self.scheduling.create_booking(page["public_id"], payload)
        self.assertTrue(second["idempotentReplay"])
        self.assertEqual(first["booking"]["public_id"], second["booking"]["public_id"])
        self.assertEqual(self.scheduling.repo.one("SELECT COUNT(*) AS total FROM scheduling_bookings")["total"], 1)

    def test_last_slot_concurrency_allows_one_booking(self):
        _item, page = self.configured(capacity=1); start = self.next_monday_at(8)
        def attempt(index: int) -> int:
            try:
                self.scheduling.create_booking(page["public_id"], self.booking_payload(start, f"concurrent-{index}")); return 201
            except HTTPException as exc: return exc.status_code
        with ThreadPoolExecutor(max_workers=2) as pool:
            statuses = sorted(pool.map(attempt, (1, 2)))
        self.assertEqual(statuses, [201, 409])

    def test_capacity_allows_seats_then_closes_slot(self):
        _item, page = self.configured(capacity=2); start = self.next_monday_at(8)
        self.scheduling.create_booking(page["public_id"], self.booking_payload(start, "seat-one"))
        self.scheduling.create_booking(page["public_id"], self.booking_payload(start, "seat-two"))
        with self.assertRaises(HTTPException) as error:
            self.scheduling.create_booking(page["public_id"], self.booking_payload(start, "seat-three"))
        self.assertEqual(error.exception.status_code, 409)

    def test_buffers_block_adjacent_start(self):
        _item, page = self.configured(capacity=1); start = self.next_monday_at(8)
        self.scheduling.create_booking(page["public_id"], self.booking_payload(start, "buffer-one"))
        with self.assertRaises(HTTPException) as error:
            self.scheduling.create_booking(page["public_id"], self.booking_payload(start + timedelta(minutes=60), "buffer-two"))
        self.assertEqual(error.exception.status_code, 409)

    def test_public_cannot_inject_responsible_id(self):
        _item, page = self.configured()
        payload = self.booking_payload(self.next_monday_at(8), "owner-injection").model_copy(update={"responsibleId": "other-user"})
        with self.assertRaises(HTTPException) as error:
            self.scheduling.create_booking(page["public_id"], payload)
        self.assertEqual(error.exception.status_code, 422)

    def test_team_mode_links_professionals_services_and_isolates_conflicts(self):
        scope = ("team-a", "primary", "team-a")
        members = {
            "pro-a": {"id": "pro-a", "nome": "Ana", "email": "ana@example.com", "jobTitle": "Advogada"},
            "pro-b": {"id": "pro-b", "nome": "Bruno", "email": "bruno@example.com", "jobTitle": "Consultor"},
        }
        self.scheduling.save_team_settings(
            scope,
            TeamSettingsPayload(enabled=True, professionals=[
                TeamProfessionalPayload(userId="pro-a", active=True, profession="Direito", position="Sócia", color="#2563eb"),
                TeamProfessionalPayload(userId="pro-b", active=True, profession="Consultoria", position="Especialista", color="#16a34a"),
            ]),
            members,
        )
        item = self.scheduling.create_service(scope, ServicePayload(name="Consulta", durations=[60], professionalIds=["pro-a", "pro-b"]))
        weekly = {"0": [Period(start="08:00", end="12:00")]}
        self.scheduling.set_availability(scope, AvailabilityPayload(serviceId=item["id"], responsibleId="pro-a", weekly=weekly))
        self.scheduling.set_availability(scope, AvailabilityPayload(serviceId=item["id"], responsibleId="pro-b", weekly=weekly))
        page = self.scheduling.create_page(scope, PagePayload(serviceId=item["id"], title="Equipe", slug="equipe"))
        public = self.scheduling.public_page(page["public_id"])
        self.assertTrue(public["teamMode"])
        self.assertEqual({value["id"] for value in public["professionals"]}, {"pro-a", "pro-b"})

        start = self.next_monday_at(8)
        first = self.booking_payload(start, "team-a-booking").model_copy(update={"serviceId": item["id"], "responsibleId": "pro-a", "responses": {}})
        second = self.booking_payload(start, "team-b-booking").model_copy(update={"serviceId": item["id"], "responsibleId": "pro-b", "responses": {}})
        self.scheduling.create_booking(page["public_id"], first)
        self.scheduling.create_booking(page["public_id"], second)
        bookings = self.scheduling.team_calendar(scope)
        self.assertEqual(len(bookings), 2)
        self.assertEqual({value["responsible_id"] for value in bookings}, {"pro-a", "pro-b"})

    def test_team_mode_rejects_unlinked_professional(self):
        scope = ("team-a", "primary", "team-a")
        members = {"pro-a": {"id": "pro-a", "nome": "Ana"}, "pro-b": {"id": "pro-b", "nome": "Bruno"}}
        self.scheduling.save_team_settings(scope, TeamSettingsPayload(enabled=True, professionals=[TeamProfessionalPayload(userId="pro-a"), TeamProfessionalPayload(userId="pro-b")]), members)
        item = self.scheduling.create_service(scope, ServicePayload(name="Consulta", durations=[60], professionalIds=["pro-a"]))
        page = self.scheduling.create_page(scope, PagePayload(serviceId=item["id"], title="Equipe", slug="equipe-restrita"))
        payload = self.booking_payload(self.next_monday_at(8), "unlinked").model_copy(update={"serviceId": item["id"], "responsibleId": "pro-b", "responses": {}})
        with self.assertRaises(HTTPException) as error:
            self.scheduling.create_booking(page["public_id"], payload)
        self.assertEqual(error.exception.status_code, 422)

    def test_team_mode_and_service_links_survive_repository_reload(self):
        scope = ("team-a", "primary", "team-a")
        members = {"pro-a": {"id": "pro-a", "nome": "Ana", "email": "ana@example.com"}}
        self.scheduling.save_team_settings(
            scope,
            TeamSettingsPayload(enabled=True, professionals=[TeamProfessionalPayload(userId="pro-a", active=True, profession="Direito")]),
            members,
        )
        item = self.scheduling.create_service(scope, ServicePayload(name="Consulta", durations=[60], professionalIds=["pro-a"]))

        reloaded = SchedulingService(SchedulingRepository(self.scheduling.repo.path))
        settings = reloaded.team_settings(scope)
        service = reloaded.get_service(scope, item["id"])

        self.assertTrue(settings["enabled"])
        self.assertTrue(settings["professionals"][0]["active"])
        self.assertEqual(service["professionalIds"], ["pro-a"])

    def test_cancel_and_transactional_reschedule(self):
        _item, page = self.configured()
        result = self.scheduling.create_booking(page["public_id"], self.booking_payload(self.next_monday_at(8), "move-one"))
        self.assertEqual(self.scheduling.reschedule(result["rescheduleToken"], self.next_monday_at(9).isoformat(), 60)["status"], "CONFIRMED")
        self.assertEqual(self.scheduling.cancel(result["cancelToken"])["status"], "CANCELLED")

    def test_repository_uses_delete_journal_instead_of_wal(self):
        connection = self.scheduling.repo.connect()
        try:
            journal_mode = connection.execute("PRAGMA journal_mode").fetchone()[0]
        finally:
            connection.close()
        self.assertEqual(journal_mode.lower(), "delete")

    def test_shared_runtime_uses_dotfile_locking(self):
        repository = object.__new__(SchedulingRepository)
        repository.path = Path(self.temporary.name) / "production.sqlite3"
        with patch.dict("os.environ", {}, clear=True), patch(
            "app.modules.scheduling.repository.is_shared_environment", return_value=True
        ):
            target, uri = repository._connection_target()
        self.assertTrue(uri)
        self.assertTrue(target.endswith("?vfs=unix-dotfile"))


    def test_availability_roundtrip_per_service_is_exact(self):
        scope = ("tenant-a", "primary", "user-a")
        first = self.scheduling.create_service(scope, ServicePayload(name="A", durations=[30]))
        second = self.scheduling.create_service(scope, ServicePayload(name="B", durations=[60]))
        self.scheduling.set_availability(scope, AvailabilityPayload(serviceId=first["id"], timezone="America/Sao_Paulo", weekly={"0": [Period(start="08:00", end="12:00"), Period(start="14:00", end="18:00")]}))
        self.scheduling.set_availability(scope, AvailabilityPayload(serviceId=second["id"], timezone="America/Bahia", weekly={"2": [Period(start="09:00", end="17:00")]}))
        reopened = SchedulingService(SchedulingRepository(self.scheduling.repo.path))
        saved_a = reopened.get_availability(scope, first["id"])
        self.assertEqual(saved_a["timezone"], "America/Sao_Paulo")
        self.assertEqual(saved_a["weekly"]["0"], [{"start": "08:00", "end": "12:00"}, {"start": "14:00", "end": "18:00"}])
        saved_b = reopened.get_availability(scope, second["id"])
        self.assertEqual(saved_b["timezone"], "America/Bahia")
        self.assertEqual(saved_b["weekly"]["2"], [{"start": "09:00", "end": "17:00"}])

    def test_empty_service_id_means_general_availability(self):
        scope = ("tenant-a", "primary", "user-a")
        payload = AvailabilityPayload(serviceId="", timezone="America/Sao_Paulo", weekly={"1": [Period(start="08:00", end="10:00")]})
        self.assertIsNone(payload.serviceId)
        saved = self.scheduling.set_availability(scope, payload)
        self.assertIsNone(saved["service_id"])
        self.assertEqual(self.scheduling.get_availability(scope, None)["weekly"]["1"], [{"start": "08:00", "end": "10:00"}])

    def test_archive_service_preserves_pages_and_bookings(self):
        scope = ("tenant-a", "primary", "user-a")
        item, page = self.configured(scope)
        self.scheduling.create_booking(page["public_id"], self.booking_payload(self.next_monday_at(8), "archive-keep"))
        result = self.scheduling.archive_service(scope, item["id"])
        self.assertEqual(result["activePages"], 1)
        self.assertEqual(result["activeBookings"], 1)
        with self.assertRaises(HTTPException) as error:
            self.scheduling.get_service(scope, item["id"])
        self.assertEqual(error.exception.status_code, 404)
        bookings = self.scheduling.list_bookings(scope)
        self.assertEqual(len(bookings), 1)
        self.assertEqual(bookings[0]["status"], "CONFIRMED")
        self.assertIsNotNone(self.scheduling.repo.one("SELECT * FROM scheduling_audit WHERE action='service_archived'"))

    def test_admin_reschedule_moves_booking_without_duplicate(self):
        scope = ("tenant-a", "primary", "user-a")
        _item, page = self.configured(scope)
        booking = self.scheduling.create_booking(page["public_id"], self.booking_payload(self.next_monday_at(8), "admin-move"))["booking"]
        stored = self.scheduling.repo.one("SELECT * FROM scheduling_bookings WHERE public_id=?", (booking["public_id"],))
        result = self.scheduling.admin_reschedule(scope, stored["id"], self.next_monday_at(9).isoformat(), 60)
        self.assertFalse(result["replay"])
        self.assertEqual(result["booking"]["id"], stored["id"])
        self.assertEqual(result["booking"]["status"], "CONFIRMED")
        self.assertEqual(self.scheduling.repo.one("SELECT COUNT(*) AS total FROM scheduling_bookings")["total"], 1)
        self.assertIsNotNone(self.scheduling.repo.one("SELECT * FROM scheduling_audit WHERE action='booking_rescheduled'"))

    def test_admin_reschedule_can_change_to_linked_professional(self):
        scope = ("team-a", "primary", "team-a")
        members = {"pro-a": {"id": "pro-a", "nome": "Ana"}, "pro-b": {"id": "pro-b", "nome": "Bruno"}}
        self.scheduling.save_team_settings(scope, TeamSettingsPayload(enabled=True, professionals=[TeamProfessionalPayload(userId="pro-a"), TeamProfessionalPayload(userId="pro-b")]), members)
        item = self.scheduling.create_service(scope, ServicePayload(name="Consulta", durations=[60], professionalIds=["pro-a", "pro-b"]))
        weekly = {"0": [Period(start="08:00", end="12:00")]}
        self.scheduling.set_availability(scope, AvailabilityPayload(serviceId=item["id"], responsibleId="pro-a", weekly=weekly))
        self.scheduling.set_availability(scope, AvailabilityPayload(serviceId=item["id"], responsibleId="pro-b", weekly=weekly))
        page = self.scheduling.create_page(scope, PagePayload(serviceId=item["id"], title="Equipe", slug="equipe-reagendar"))
        payload = self.booking_payload(self.next_monday_at(8), "team-reschedule").model_copy(update={"serviceId": item["id"], "responsibleId": "pro-a", "responses": {}})
        booking = self.scheduling.create_booking(page["public_id"], payload)["booking"]
        stored = self.scheduling.repo.one("SELECT * FROM scheduling_bookings WHERE public_id=?", (booking["public_id"],))

        result = self.scheduling.admin_reschedule(scope, stored["id"], self.next_monday_at(9).isoformat(), 60, "pro-b")

        self.assertFalse(result["replay"])
        self.assertEqual(result["booking"]["responsible_id"], "pro-b")

    def test_admin_reschedule_rejects_unlinked_professional(self):
        scope = ("team-a", "primary", "team-a")
        members = {"pro-a": {"id": "pro-a", "nome": "Ana"}, "pro-b": {"id": "pro-b", "nome": "Bruno"}}
        self.scheduling.save_team_settings(scope, TeamSettingsPayload(enabled=True, professionals=[TeamProfessionalPayload(userId="pro-a"), TeamProfessionalPayload(userId="pro-b")]), members)
        item = self.scheduling.create_service(scope, ServicePayload(name="Consulta", durations=[60], professionalIds=["pro-a"]))
        weekly = {"0": [Period(start="08:00", end="12:00")]}
        self.scheduling.set_availability(scope, AvailabilityPayload(serviceId=item["id"], responsibleId="pro-a", weekly=weekly))
        page = self.scheduling.create_page(scope, PagePayload(serviceId=item["id"], title="Equipe", slug="equipe-reagendar-restrita"))
        payload = self.booking_payload(self.next_monday_at(8), "team-reschedule-restricted").model_copy(update={"serviceId": item["id"], "responsibleId": "pro-a", "responses": {}})
        booking = self.scheduling.create_booking(page["public_id"], payload)["booking"]
        stored = self.scheduling.repo.one("SELECT * FROM scheduling_bookings WHERE public_id=?", (booking["public_id"],))

        with self.assertRaises(HTTPException) as error:
            self.scheduling.admin_reschedule(scope, stored["id"], self.next_monday_at(9).isoformat(), 60, "pro-b")
        self.assertEqual(error.exception.status_code, 422)

    def test_admin_reschedule_ignores_self_overlap(self):
        scope = ("tenant-a", "primary", "user-a")
        _item, page = self.configured(scope)
        booking = self.scheduling.create_booking(page["public_id"], self.booking_payload(self.next_monday_at(8), "admin-self"))["booking"]
        stored = self.scheduling.repo.one("SELECT * FROM scheduling_bookings WHERE public_id=?", (booking["public_id"],))
        # A janela com buffers cruza o proprio agendamento; sem a exclusao, daria 409.
        result = self.scheduling.admin_reschedule(scope, stored["id"], self.next_monday_at(9).isoformat(), 60)
        self.assertFalse(result["replay"])

    def test_admin_reschedule_replay_and_guards(self):
        scope = ("tenant-a", "primary", "user-a")
        _item, page = self.configured(scope)
        start = self.next_monday_at(8)
        booking = self.scheduling.create_booking(page["public_id"], self.booking_payload(start, "admin-guards"))["booking"]
        stored = self.scheduling.repo.one("SELECT * FROM scheduling_bookings WHERE public_id=?", (booking["public_id"],))
        self.assertTrue(self.scheduling.admin_reschedule(scope, stored["id"], start.isoformat(), 60)["replay"])
        with self.assertRaises(HTTPException) as error:
            self.scheduling.admin_reschedule(scope, stored["id"], self.next_monday_at(12).isoformat(), 60)
        self.assertEqual(error.exception.status_code, 409)
        self.scheduling.update_booking_status(scope, stored["id"], "CANCELLED")
        with self.assertRaises(HTTPException) as error:
            self.scheduling.admin_reschedule(scope, stored["id"], self.next_monday_at(9).isoformat(), 60)
        self.assertEqual(error.exception.status_code, 409)

    def test_admin_reschedule_rejects_foreign_scope(self):
        _item, page = self.configured()
        booking = self.scheduling.create_booking(page["public_id"], self.booking_payload(self.next_monday_at(8), "admin-scope"))["booking"]
        stored = self.scheduling.repo.one("SELECT * FROM scheduling_bookings WHERE public_id=?", (booking["public_id"],))
        with self.assertRaises(HTTPException) as error:
            self.scheduling.admin_reschedule(("tenant-b", "primary", "user-b"), stored["id"], self.next_monday_at(9).isoformat(), 60)
        self.assertEqual(error.exception.status_code, 404)

    def test_notification_attempts_are_scoped_and_updatable(self):
        scope = ("tenant-a", "primary", "user-a")
        _item, page = self.configured(scope)
        booking = self.scheduling.create_booking(page["public_id"], self.booking_payload(self.next_monday_at(8), "notify-scope"))["booking"]
        stored = self.scheduling.repo.one("SELECT * FROM scheduling_bookings WHERE public_id=?", (booking["public_id"],))
        self.assertIsNone(self.scheduling.get_notification_attempt(scope, "op-1", "gmail"))
        self.scheduling.save_notification_attempt(scope, "op-1", "gmail", stored["id"], "failed", error="boom")
        self.assertEqual(self.scheduling.get_notification_attempt(scope, "op-1", "gmail")["status"], "failed")
        self.assertIsNone(self.scheduling.get_notification_attempt(("tenant-b", "primary", "user-b"), "op-1", "gmail"))
        self.scheduling.save_notification_attempt(scope, "op-1", "gmail", stored["id"], "sent", {"messageId": "m-1"})
        attempt = self.scheduling.get_notification_attempt(scope, "op-1", "gmail")
        self.assertEqual(attempt["status"], "sent")
        self.assertEqual(attempt["receipt"], {"messageId": "m-1"})

    def test_same_notification_key_is_isolated_between_tenants(self):
        first_scope = ("tenant-a", "primary", "user-a")
        _first_service, first_page = self.configured(first_scope)
        first = self.scheduling.create_booking(first_page["public_id"], self.booking_payload(self.next_monday_at(8), "notify-a"))["booking"]
        first_row = self.scheduling.repo.one("SELECT * FROM scheduling_bookings WHERE public_id=?", (first["public_id"],))

        second_scope = ("tenant-b", "primary", "user-b")
        second_service = self.scheduling.create_service(second_scope, ServicePayload(name="Outra", durations=[60]))
        self.scheduling.set_availability(second_scope, AvailabilityPayload(serviceId=second_service["id"], timezone="America/Sao_Paulo", weekly={"0": [Period(start="08:00", end="12:00")]}))
        second_page = self.scheduling.create_page(second_scope, PagePayload(serviceId=second_service["id"], title="Outra", slug="outra", fields=[BookingField(id="cpf", type="cpf", label="CPF", required=True, maxLength=14)]))
        second = self.scheduling.create_booking(second_page["public_id"], self.booking_payload(self.next_monday_at(8), "notify-b"))["booking"]
        second_row = self.scheduling.repo.one("SELECT * FROM scheduling_bookings WHERE public_id=?", (second["public_id"],))

        self.scheduling.save_notification_attempt(first_scope, "same-operation", "gmail", first_row["id"], "sent", {"messageId": "a"})
        self.scheduling.save_notification_attempt(second_scope, "same-operation", "gmail", second_row["id"], "sent", {"messageId": "b"})

        self.assertEqual(self.scheduling.get_notification_attempt(first_scope, "same-operation", "gmail")["receipt"], {"messageId": "a"})
        self.assertEqual(self.scheduling.get_notification_attempt(second_scope, "same-operation", "gmail")["receipt"], {"messageId": "b"})
        self.assertEqual(self.scheduling.repo.one("SELECT COUNT(*) AS total FROM scheduling_notification_attempts")["total"], 2)

    def test_notification_claim_is_atomic_and_pending_requires_reconciliation(self):
        scope = ("tenant-a", "primary", "user-a")
        _item, page = self.configured(scope)
        booking = self.scheduling.create_booking(page["public_id"], self.booking_payload(self.next_monday_at(8), "notify-claim"))["booking"]
        stored = self.scheduling.repo.one("SELECT * FROM scheduling_bookings WHERE public_id=?", (booking["public_id"],))

        first = self.scheduling.begin_notification_attempt(scope, "op-claim", "gmail", stored["id"])
        pending_replay = self.scheduling.begin_notification_attempt(scope, "op-claim", "gmail", stored["id"])
        self.assertTrue(first["claimed"])
        self.assertFalse(pending_replay["claimed"])
        self.assertEqual(pending_replay["attempt"]["status"], "pending")

        self.scheduling.save_notification_attempt(scope, "op-claim", "gmail", stored["id"], "failed", error="configuration")
        deterministic_retry = self.scheduling.begin_notification_attempt(scope, "op-claim", "gmail", stored["id"])
        self.assertTrue(deterministic_retry["claimed"])
        self.scheduling.save_notification_attempt(scope, "op-claim", "gmail", stored["id"], "sent", {"messageId": "m-final"})
        sent_replay = self.scheduling.begin_notification_attempt(scope, "op-claim", "gmail", stored["id"])
        self.assertFalse(sent_replay["claimed"])
        self.assertEqual(sent_replay["attempt"]["status"], "sent")

    def test_reschedule_templates_include_old_new_service_and_timezone(self):
        email = SchedulingService.render_reschedule_email(service_name="Consultoria", attendee_name="Maria", old_start="2026-09-28T11:00:00+00:00", new_start="2026-09-29T12:00:00+00:00", timezone_name="America/Sao_Paulo")
        self.assertIn("Consultoria", email["subject"])
        self.assertIn("28/09/2026", email["body"])
        self.assertIn("29/09/2026", email["body"])
        self.assertIn("America/Sao_Paulo", email["body"])
        text = SchedulingService.render_reschedule_whatsapp(service_name="Consultoria", attendee_name="Maria", old_start="2026-09-28T11:00:00+00:00", new_start="2026-09-29T12:00:00+00:00", timezone_name="America/Sao_Paulo")
        self.assertIn("28/09/2026", text)
        self.assertIn("29/09/2026", text)

    def test_booking_calendar_details_include_registration_fields_and_address(self):
        payload = self.booking_payload(self.next_monday_at(8), "calendar-details")
        payload.responses = {"cpf": "52998224725", "address": "Rua das Flores, 100", "newsletter": True}
        description, location = _booking_calendar_details(
            payload,
            [
                {"id": "cpf", "type": "cpf", "label": "CPF"},
                {"id": "address", "type": "address", "label": "Endereço"},
                {"id": "newsletter", "type": "boolean", "label": "Aceita novidades"},
            ],
            {"location_type": "in_person", "location": "Endereço do serviço"},
        )
        self.assertIn("Nome: Cliente Teste", description)
        self.assertIn("CPF: 52998224725", description)
        self.assertIn("Aceita novidades: Sim", description)
        self.assertEqual(location, "Rua das Flores, 100")


if __name__ == "__main__": unittest.main()
