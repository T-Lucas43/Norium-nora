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
from app.modules.scheduling.schemas import AvailabilityPayload, BookingField, BookingPayload, PagePayload, Period, ServicePayload
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

    def test_weekly_periods_exclude_lunch(self):
        _item, page = self.configured()
        day = self.next_monday_at(8).astimezone(ZoneInfo("America/Sao_Paulo")).date()
        slots = self.scheduling.available_slots(page["public_id"], day, 60)["slots"]
        hours = [datetime.fromisoformat(slot["startAt"]).astimezone(ZoneInfo("America/Sao_Paulo")).hour for slot in slots]
        self.assertIn(8, hours); self.assertIn(14, hours)
        self.assertNotIn(12, hours); self.assertNotIn(13, hours)

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


if __name__ == "__main__": unittest.main()
