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


if __name__ == "__main__": unittest.main()
