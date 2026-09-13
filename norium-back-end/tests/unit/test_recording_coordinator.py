from __future__ import annotations

import asyncio
import copy
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Awaitable, Callable

from app.modules.team.recording_coordinator import (
    CallRecordingContext,
    LocalRecordingFiles,
    RecordingActor,
    RecordingAbort,
    RecordingComplete,
    RecordingCoordinator,
    RecordingError,
    RecordingLimits,
    RecordingStart,
    RecordingUpload,
)


class MemoryRecordingStore:
    def __init__(self) -> None:
        self.documents: dict[str, dict[str, Any]] = {}
        self.lock = asyncio.Lock()

    async def load(self, team_id: str) -> dict[str, Any]:
        return copy.deepcopy(self.documents.get(team_id, {"recordings": [], "messages": []}))

    async def transact(
        self,
        team_id: str,
        operation: Callable[[dict[str, Any]], Awaitable[Any]],
    ) -> Any:
        async with self.lock:
            document = copy.deepcopy(self.documents.get(team_id, {"recordings": [], "messages": []}))
            result = await operation(document)
            self.documents[team_id] = copy.deepcopy(document)
            return result


class FailingCommitRecordingStore(MemoryRecordingStore):
    def __init__(self) -> None:
        super().__init__()
        self.fail_next_commit = False

    async def transact(
        self,
        team_id: str,
        operation: Callable[[dict[str, Any]], Awaitable[Any]],
    ) -> Any:
        async with self.lock:
            document = copy.deepcopy(self.documents.get(team_id, {"recordings": [], "messages": []}))
            result = await operation(document)
            if self.fail_next_commit:
                self.fail_next_commit = False
                raise OSError("simulated commit failure")
            self.documents[team_id] = copy.deepcopy(document)
            return result


class MemoryCallAccess:
    def __init__(self) -> None:
        self.calls: dict[str, CallRecordingContext] = {}

    async def authorize(
        self,
        actor: RecordingActor,
        call_id: str,
        client_id: str,
        *,
        require_host: bool,
    ) -> CallRecordingContext:
        context = self.calls.get(call_id)
        if context is None:
            raise RecordingError(404, "Chamada ativa nao encontrada.")
        if actor.user_id not in context.participant_ids:
            raise RecordingError(403, "Usuario nao participa da chamada.")
        if context.participant_clients.get(actor.user_id) != client_id:
            raise RecordingError(409, "Cliente nao esta associado a chamada.")
        if require_host and context.host_user_id != actor.user_id:
            raise RecordingError(403, "Somente o anfitriao pode gravar.")
        return context


class MemoryEvents:
    def __init__(self) -> None:
        self.published: list[tuple[str, set[str], dict[str, Any]]] = []
        self.audited: list[tuple[str, str, dict[str, Any]]] = []

    async def publish(self, team_id: str, recipients: set[str], payload: dict[str, Any]) -> None:
        self.published.append((team_id, set(recipients), copy.deepcopy(payload)))

    async def audit(self, team_id: str, action: str, metadata: dict[str, Any]) -> None:
        self.audited.append((team_id, action, copy.deepcopy(metadata)))


class FixedClock:
    def __init__(self) -> None:
        self.value = datetime(2026, 9, 3, 20, 0, tzinfo=timezone.utc)

    def now(self) -> datetime:
        return self.value

    def advance(self, **kwargs: float) -> None:
        self.value += timedelta(**kwargs)


class RecordingCoordinatorTests(unittest.IsolatedAsyncioTestCase):
    async def test_broken_team_does_not_starve_other_teams_or_trigger_unsafe_orphan_scan(self) -> None:
        from unittest.mock import AsyncMock, patch
        good = ({"expiredActive": 0, "deletedCompleted": 1}, set())
        with patch.object(self.coordinator, "_maintain_team", AsyncMock(side_effect=[OSError("broken"), good])) as maintain, \
             patch.object(self.coordinator._files, "list_parts", AsyncMock()) as scan:
            with self.assertRaises(OSError):
                await self.coordinator.maintain(["broken", "healthy"])
            self.assertEqual(2, maintain.await_count)
            scan.assert_not_called()

    async def test_retention_retries_file_deletion_after_storage_failure(self) -> None:
        from unittest.mock import AsyncMock, patch
        self.allow_team_call()
        result = await self.coordinator.start(self.owner, RecordingStart(
            "call_0123456789abcdef", "owner-client", "retention-retry", "audio/webm"))
        recording_id = result["recording"]["id"]
        await self.coordinator.upload(self.owner, recording_id, RecordingUpload("owner-client", "chunk", b"audio"))
        await self.coordinator.complete(self.owner, recording_id, RecordingComplete("owner-client", "complete"))
        path = Path(self.temp.name) / self.store.documents["owner"]["recordings"][0]["storedName"]
        self.clock.advance(hours=25)
        with patch.object(self.coordinator._files, "delete", AsyncMock(side_effect=OSError("storage down"))):
            with self.assertRaises(OSError):
                await self.coordinator.maintain(["owner"])
        self.assertTrue(path.exists())
        self.assertEqual("deleted", self.store.documents["owner"]["recordings"][0]["status"])
        result = await self.coordinator.maintain(["owner"])
        self.assertEqual(1, result["deletedCompleted"])
        self.assertFalse(path.exists())
        self.assertEqual(0, (await self.coordinator.maintain(["owner"]))["deletedCompleted"])

    async def asyncSetUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="norium_recording_")
        self.store = MemoryRecordingStore()
        self.access = MemoryCallAccess()
        self.events = MemoryEvents()
        self.clock = FixedClock()
        self.coordinator = RecordingCoordinator(
            store=self.store,
            files=LocalRecordingFiles(Path(self.temp.name)),
            call_access=self.access,
            events=self.events,
            clock=self.clock,
            limits=RecordingLimits(),
        )
        self.owner = RecordingActor("owner", "owner", "Owner")

    def allow_team_call(self) -> None:
        self.access.calls["call_0123456789abcdef"] = CallRecordingContext(
            call_id="call_0123456789abcdef",
            host_user_id="owner",
            participant_ids=frozenset({"owner", "member"}),
            participant_clients={"owner": "owner-client", "member": "member-client"},
        )

    async def asyncTearDown(self) -> None:
        self.temp.cleanup()

    async def test_arbitrary_call_id_cannot_create_recording(self) -> None:
        with self.assertRaises(RecordingError) as error:
            await self.coordinator.start(
                self.owner,
                RecordingStart(
                    call_id="call_0123456789abcdef",
                    client_id="owner-client",
                    operation_id="start-1",
                    mime_type="video/webm",
                ),
            )

        self.assertEqual(404, error.exception.status_code)
        self.assertEqual({}, self.store.documents)
        self.assertEqual([], list(Path(self.temp.name).iterdir()))

    async def test_start_is_host_only_idempotent_and_unique_per_call(self) -> None:
        self.allow_team_call()
        request = RecordingStart(
            call_id="call_0123456789abcdef",
            client_id="owner-client",
            operation_id="start-1",
            mime_type="video/webm",
        )

        first = await self.coordinator.start(self.owner, request)
        repeated = await self.coordinator.start(self.owner, request)
        competing = await self.coordinator.start(
            self.owner,
            RecordingStart(**{**request.__dict__, "operation_id": "start-2"}),
        )
        self.access.calls.clear()
        repeated_after_call = await self.coordinator.start(self.owner, request)

        self.assertEqual(first["recording"]["id"], repeated["recording"]["id"])
        self.assertEqual(first["recording"]["id"], competing["recording"]["id"])
        self.assertEqual(first["recording"]["id"], repeated_after_call["recording"]["id"])
        recordings = self.store.documents["owner"]["recordings"]
        self.assertEqual(1, len(recordings))
        self.assertEqual(1, sum(payload["type"] == "CALL_RECORDING_STARTED" for _, _, payload in self.events.published))
        self.assertEqual(["recording_started"], [action for _, action, _ in self.events.audited])

    async def test_start_requires_host_and_the_active_call_client(self) -> None:
        self.allow_team_call()
        member = RecordingActor("member", "owner", "Member")

        with self.assertRaises(RecordingError) as non_host:
            await self.coordinator.start(member, RecordingStart(
                call_id="call_0123456789abcdef",
                client_id="member-client",
                operation_id="member-start",
                mime_type="audio/webm",
            ))
        with self.assertRaises(RecordingError) as stale_client:
            await self.coordinator.start(self.owner, RecordingStart(
                call_id="call_0123456789abcdef",
                client_id="old-owner-client",
                operation_id="stale-start",
                mime_type="audio/webm",
            ))

        self.assertEqual(403, non_host.exception.status_code)
        self.assertEqual(409, stale_client.exception.status_code)
        self.assertEqual({}, self.store.documents)

    async def test_concurrent_duplicate_chunk_is_appended_once(self) -> None:
        self.allow_team_call()
        started = await self.coordinator.start(self.owner, RecordingStart(
            call_id="call_0123456789abcdef",
            client_id="owner-client",
            operation_id="start-upload",
            mime_type="video/webm",
        ))
        recording_id = started["recording"]["id"]
        upload = RecordingUpload(
            client_id="owner-client",
            chunk_id="chunk-1",
            content=b"webm-content",
        )

        first, repeated = await asyncio.gather(
            self.coordinator.upload(self.owner, recording_id, upload),
            self.coordinator.upload(self.owner, recording_id, upload),
        )

        self.assertEqual(12, first["size"])
        self.assertEqual(12, repeated["size"])
        recording = self.store.documents["owner"]["recordings"][0]
        self.assertEqual(12, recording["acceptedChunks"]["chunk-1"]["size"])
        self.assertTrue(recording["acceptedChunks"]["chunk-1"]["digest"])
        part_path = Path(self.temp.name) / recording["tempStoredName"]
        self.assertEqual(b"webm-content", part_path.read_bytes())

    async def test_reusing_chunk_id_with_other_content_aborts_recording(self) -> None:
        self.allow_team_call()
        started = await self.coordinator.start(self.owner, RecordingStart(
            "call_0123456789abcdef", "owner-client", "chunk-conflict", "audio/webm",
        ))
        recording_id = started["recording"]["id"]
        await self.coordinator.upload(self.owner, recording_id, RecordingUpload(
            "owner-client", "same-id", b"first",
        ))

        with self.assertRaises(RecordingError) as error:
            await self.coordinator.upload(self.owner, recording_id, RecordingUpload(
                "owner-client", "same-id", b"other",
            ))

        self.assertEqual(409, error.exception.status_code)
        recording = self.store.documents["owner"]["recordings"][0]
        self.assertEqual("failed", recording["status"])
        self.assertFalse((Path(self.temp.name) / recording["tempStoredName"]).exists())

    async def test_chunk_quota_failure_aborts_and_notifies_every_participant(self) -> None:
        self.allow_team_call()
        self.coordinator = RecordingCoordinator(
            store=self.store,
            files=LocalRecordingFiles(Path(self.temp.name)),
            call_access=self.access,
            events=self.events,
            clock=self.clock,
            limits=RecordingLimits(max_chunk_bytes=4),
        )
        started = await self.coordinator.start(self.owner, RecordingStart(
            call_id="call_0123456789abcdef",
            client_id="owner-client",
            operation_id="quota-start",
            mime_type="audio/webm",
        ))

        with self.assertRaises(RecordingError) as error:
            await self.coordinator.upload(self.owner, started["recording"]["id"], RecordingUpload(
                client_id="owner-client",
                chunk_id="too-large",
                content=b"12345",
            ))

        self.assertEqual(413, error.exception.status_code)
        recording = self.store.documents["owner"]["recordings"][0]
        self.assertEqual("failed", recording["status"])
        self.assertFalse((Path(self.temp.name) / recording["tempStoredName"]).exists())
        stopped = [item for item in self.events.published if item[2]["type"] == "CALL_RECORDING_STOPPED"]
        self.assertEqual({"owner", "member"}, stopped[-1][1])
        self.assertEqual("failed", stopped[-1][2]["reason"])
        self.assertEqual("recording_failed", self.events.audited[-1][1])

    async def test_team_consumption_quota_counts_other_recordings(self) -> None:
        self.allow_team_call()
        second_call_id = "call_fedcba9876543210"
        self.access.calls[second_call_id] = CallRecordingContext(
            call_id=second_call_id,
            host_user_id="owner",
            participant_ids=frozenset({"owner", "member"}),
            participant_clients={"owner": "owner-client"},
        )
        self.coordinator = RecordingCoordinator(
            store=self.store,
            files=LocalRecordingFiles(Path(self.temp.name)),
            call_access=self.access,
            events=self.events,
            clock=self.clock,
            limits=RecordingLimits(max_team_bytes=10),
        )
        first = await self.coordinator.start(self.owner, RecordingStart(
            "call_0123456789abcdef", "owner-client", "team-quota-1", "audio/webm",
        ))
        await self.coordinator.upload(self.owner, first["recording"]["id"], RecordingUpload(
            "owner-client", "first", b"123456",
        ))
        second = await self.coordinator.start(self.owner, RecordingStart(
            second_call_id, "owner-client", "team-quota-2", "audio/webm",
        ))

        with self.assertRaises(RecordingError) as error:
            await self.coordinator.upload(self.owner, second["recording"]["id"], RecordingUpload(
                "owner-client", "second", b"12345",
            ))

        self.assertEqual(413, error.exception.status_code)
        recordings = self.store.documents["owner"]["recordings"]
        self.assertEqual("recording", recordings[0]["status"])
        self.assertEqual("failed", recordings[1]["status"])

    async def test_concurrent_recording_limit_is_atomic(self) -> None:
        self.allow_team_call()
        second_call_id = "call_fedcba9876543210"
        self.access.calls[second_call_id] = CallRecordingContext(
            call_id=second_call_id,
            host_user_id="owner",
            participant_ids=frozenset({"owner"}),
            participant_clients={"owner": "owner-client"},
        )
        self.coordinator = RecordingCoordinator(
            store=self.store,
            files=LocalRecordingFiles(Path(self.temp.name)),
            call_access=self.access,
            events=self.events,
            clock=self.clock,
            limits=RecordingLimits(max_concurrent_per_team=1),
        )

        results = await asyncio.gather(
            self.coordinator.start(self.owner, RecordingStart(
                "call_0123456789abcdef", "owner-client", "parallel-1", "audio/webm",
            )),
            self.coordinator.start(self.owner, RecordingStart(
                second_call_id, "owner-client", "parallel-2", "audio/webm",
            )),
            return_exceptions=True,
        )

        self.assertEqual(1, sum(isinstance(item, RecordingError) for item in results))
        self.assertEqual(1, len(self.store.documents["owner"]["recordings"]))

    async def test_duration_expiration_aborts_on_next_upload(self) -> None:
        self.allow_team_call()
        self.coordinator = RecordingCoordinator(
            store=self.store,
            files=LocalRecordingFiles(Path(self.temp.name)),
            call_access=self.access,
            events=self.events,
            clock=self.clock,
            limits=RecordingLimits(max_duration_seconds=5),
        )
        started = await self.coordinator.start(self.owner, RecordingStart(
            "call_0123456789abcdef", "owner-client", "duration", "audio/webm",
        ))
        self.clock.advance(seconds=6)

        with self.assertRaises(RecordingError) as error:
            await self.coordinator.upload(self.owner, started["recording"]["id"], RecordingUpload(
                "owner-client", "late", b"late",
            ))

        self.assertEqual(410, error.exception.status_code)
        self.assertEqual("failed", self.store.documents["owner"]["recordings"][0]["status"])

    async def test_complete_is_transactional_and_idempotent(self) -> None:
        self.allow_team_call()
        started = await self.coordinator.start(self.owner, RecordingStart(
            "call_0123456789abcdef", "owner-client", "complete-start", "video/webm",
        ))
        recording_id = started["recording"]["id"]
        await self.coordinator.upload(self.owner, recording_id, RecordingUpload(
            "owner-client", "only", b"recording",
        ))
        request = RecordingComplete("owner-client", "complete-operation")

        first = await self.coordinator.complete(self.owner, recording_id, request)
        self.access.calls.clear()
        repeated = await self.coordinator.complete(self.owner, recording_id, request)

        recording = self.store.documents["owner"]["recordings"][0]
        self.assertEqual(first, repeated)
        self.assertEqual("completed", recording["status"])
        self.assertFalse((Path(self.temp.name) / recording["tempStoredName"]).exists())
        self.assertTrue((Path(self.temp.name) / recording["storedName"]).exists())
        self.assertEqual(1, len(self.store.documents["owner"]["messages"]))
        self.assertEqual(1, sum(payload[2]["type"] == "CALL_RECORDING_AVAILABLE" for payload in self.events.published))
        self.assertEqual(1, sum(action == "recording_stopped" for _, action, _ in self.events.audited))

    async def test_abort_is_idempotent_and_removes_partial_file(self) -> None:
        self.allow_team_call()
        started = await self.coordinator.start(self.owner, RecordingStart(
            "call_0123456789abcdef", "owner-client", "abort-start", "audio/webm",
        ))
        recording_id = started["recording"]["id"]
        await self.coordinator.upload(self.owner, recording_id, RecordingUpload(
            "owner-client", "some", b"partial",
        ))
        request = RecordingAbort("owner-client", "abort-operation")

        first = await self.coordinator.abort(self.owner, recording_id, request)
        self.access.calls.clear()
        repeated = await self.coordinator.abort(self.owner, recording_id, request)

        self.assertEqual(first, repeated)
        recording = self.store.documents["owner"]["recordings"][0]
        self.assertEqual("aborted", recording["status"])
        self.assertFalse((Path(self.temp.name) / recording["tempStoredName"]).exists())
        self.assertEqual(1, sum(payload[2]["type"] == "CALL_RECORDING_STOPPED" for payload in self.events.published))

    async def test_other_participant_cannot_upload_or_abort_hosts_recording(self) -> None:
        self.allow_team_call()
        started = await self.coordinator.start(self.owner, RecordingStart(
            "call_0123456789abcdef", "owner-client", "protected", "audio/webm",
        ))
        recording_id = started["recording"]["id"]
        member = RecordingActor("member", "owner", "Member")

        with self.assertRaises(RecordingError) as upload_error:
            await self.coordinator.upload(member, recording_id, RecordingUpload(
                "member-client", "attack", b"content",
            ))
        with self.assertRaises(RecordingError) as abort_error:
            await self.coordinator.abort(member, recording_id, RecordingAbort(
                "member-client", "attack-abort",
            ))

        self.assertEqual(403, upload_error.exception.status_code)
        self.assertEqual(403, abort_error.exception.status_code)
        self.assertEqual("recording", self.store.documents["owner"]["recordings"][0]["status"])

    async def test_failed_final_commit_rolls_back_and_leaves_no_orphan(self) -> None:
        self.allow_team_call()
        failing_store = FailingCommitRecordingStore()
        self.store = failing_store
        self.coordinator = RecordingCoordinator(
            store=failing_store,
            files=LocalRecordingFiles(Path(self.temp.name)),
            call_access=self.access,
            events=self.events,
            clock=self.clock,
            limits=RecordingLimits(),
        )
        started = await self.coordinator.start(self.owner, RecordingStart(
            "call_0123456789abcdef", "owner-client", "transaction", "audio/webm",
        ))
        recording_id = started["recording"]["id"]
        await self.coordinator.upload(self.owner, recording_id, RecordingUpload(
            "owner-client", "transaction-data", b"recording",
        ))
        failing_store.fail_next_commit = True

        with self.assertRaises(RecordingError) as error:
            await self.coordinator.complete(
                self.owner,
                recording_id,
                RecordingComplete("owner-client", "transaction-complete"),
            )

        self.assertEqual(500, error.exception.status_code)
        recording = failing_store.documents["owner"]["recordings"][0]
        self.assertEqual("failed", recording["status"])
        self.assertEqual([], list(Path(self.temp.name).glob("*.part")))
        self.assertFalse((Path(self.temp.name) / recording["storedName"]).exists())
        self.assertEqual("CALL_RECORDING_STOPPED", self.events.published[-1][2]["type"])

    async def test_request_rate_limit_stops_an_active_recording(self) -> None:
        self.allow_team_call()
        self.coordinator = RecordingCoordinator(
            store=self.store,
            files=LocalRecordingFiles(Path(self.temp.name)),
            call_access=self.access,
            events=self.events,
            clock=self.clock,
            limits=RecordingLimits(request_limit=2, request_window_seconds=60),
        )
        started = await self.coordinator.start(self.owner, RecordingStart(
            "call_0123456789abcdef", "owner-client", "rate-start", "audio/webm",
        ))
        await self.coordinator.upload(self.owner, started["recording"]["id"], RecordingUpload(
            "owner-client", "one", b"one",
        ))

        with self.assertRaises(RecordingError) as error:
            await self.coordinator.upload(self.owner, started["recording"]["id"], RecordingUpload(
                "owner-client", "two", b"two",
            ))

        self.assertEqual(429, error.exception.status_code)
        self.assertEqual("failed", self.store.documents["owner"]["recordings"][0]["status"])

    async def test_maintenance_expires_active_completed_and_orphan_files(self) -> None:
        self.allow_team_call()
        self.coordinator = RecordingCoordinator(
            store=self.store,
            files=LocalRecordingFiles(Path(self.temp.name)),
            call_access=self.access,
            events=self.events,
            clock=self.clock,
            limits=RecordingLimits(max_duration_seconds=5, retention_hours=1, orphan_grace_seconds=5),
        )
        active = await self.coordinator.start(self.owner, RecordingStart(
            "call_0123456789abcdef", "owner-client", "maintenance-active", "audio/webm",
        ))
        await self.coordinator.upload(self.owner, active["recording"]["id"], RecordingUpload(
            "owner-client", "active-data", b"active",
        ))
        orphan = Path(self.temp.name) / "unreferenced.webm.part"
        orphan.write_bytes(b"orphan")
        old_time = self.clock.now().timestamp() - 10
        os.utime(orphan, (old_time, old_time))
        self.clock.advance(seconds=6)

        await self.coordinator.maintain(["owner"])

        self.assertEqual("failed", self.store.documents["owner"]["recordings"][0]["status"])
        self.assertFalse(orphan.exists())

        # Retencao independe de alguem consultar a mensagem ou o anexo.
        self.access.calls["call_0123456789abcdef"] = self.access.calls["call_0123456789abcdef"]
        completed = await self.coordinator.start(self.owner, RecordingStart(
            "call_0123456789abcdef", "owner-client", "maintenance-completed", "audio/webm",
        ))
        await self.coordinator.upload(self.owner, completed["recording"]["id"], RecordingUpload(
            "owner-client", "completed-data", b"completed",
        ))
        await self.coordinator.complete(
            self.owner,
            completed["recording"]["id"],
            RecordingComplete("owner-client", "maintenance-complete"),
        )
        completed_recording = self.store.documents["owner"]["recordings"][-1]
        completed_path = Path(self.temp.name) / completed_recording["storedName"]
        self.clock.advance(hours=2)

        await self.coordinator.maintain(["owner"])

        completed_recording = self.store.documents["owner"]["recordings"][-1]
        self.assertEqual("deleted", completed_recording["status"])
        self.assertFalse(completed_path.exists())
        self.assertTrue(self.store.documents["owner"]["messages"][-1]["metadata"]["recordingExpired"])
        self.assertEqual("recording_deleted", self.events.audited[-1][1])

    async def test_maintenance_aborts_when_call_or_membership_was_revoked(self) -> None:
        self.allow_team_call()
        started = await self.coordinator.start(self.owner, RecordingStart(
            "call_0123456789abcdef", "owner-client", "revoked", "audio/webm",
        ))
        recording_id = started["recording"]["id"]
        await self.coordinator.upload(self.owner, recording_id, RecordingUpload(
            "owner-client", "revoked-data", b"partial",
        ))
        self.access.calls.clear()

        await self.coordinator.maintain(["owner"])

        recording = self.store.documents["owner"]["recordings"][0]
        self.assertEqual("failed", recording["status"])
        self.assertFalse((Path(self.temp.name) / recording["tempStoredName"]).exists())
        self.assertEqual("CALL_RECORDING_STOPPED", self.events.published[-1][2]["type"])


if __name__ == "__main__":
    unittest.main()
