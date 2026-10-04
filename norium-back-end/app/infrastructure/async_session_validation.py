"""Bounded fresh registry reads for contemporaneous socket validations."""
from __future__ import annotations

import asyncio
import contextlib
from collections.abc import Callable

from app.infrastructure import auth_sessions

Binding = tuple[str, str, int]


class FreshSessionValidator:
    """One worker at a time; every batch reads the authoritative registry anew.

    This object belongs to one event loop. It retains no validation results:
    requests arriving during a read are handled by a subsequent fresh read.
    """

    def __init__(self, lookup: Callable[[list[Binding]], set[Binding]] | None = None):
        self._lookup = lookup or auth_sessions.valid_bindings
        self._pending: list[tuple[set[Binding], asyncio.Future]] = []
        self._outstanding_size = 0
        self._worker: asyncio.Task | None = None

    async def validate(self, bindings: list[Binding]) -> set[Binding]:
        if not bindings:
            return set()
        requested = set(bindings)
        if len(bindings) > 1000 or self._outstanding_size + len(requested) > 1000:
            raise auth_sessions.SessionError('session_batch_limit', 503)
        future = asyncio.get_running_loop().create_future()
        self._pending.append((requested, future))
        self._outstanding_size += len(requested)
        if self._worker is None:
            self._worker = asyncio.create_task(self._flush())
            self._worker.add_done_callback(self._worker_finished)
        return await future

    def _worker_finished(self, task: asyncio.Task) -> None:
        if not task.cancelled():
            task.exception()
        # A task cancelled before its first step never enters its finally.
        # Only that generation may clear its queue; an old callback must not
        # erase requests owned by a newly scheduled worker.
        if self._worker is task:
            for _, future in self._pending:
                if not future.done():
                    future.set_result(set())
            self._pending.clear()
            self._outstanding_size = 0
            self._worker = None

    async def _fresh_lookup(self, requested: set[Binding]) -> set[Binding]:
        read = asyncio.create_task(asyncio.to_thread(self._lookup, list(requested)))
        try:
            return await asyncio.shield(read)
        except asyncio.CancelledError:
            # Do not reset the scheduler or admit a second registry worker
            # while the cancelled scheduler's read-only thread remains alive.
            while not read.done():
                try:
                    await asyncio.shield(read)
                except asyncio.CancelledError:
                    continue
                except Exception:
                    break
            with contextlib.suppress(Exception):
                read.result()
            raise

    async def _flush(self) -> None:
        active: list[tuple[set[Binding], asyncio.Future]] = []
        try:
            while self._pending:
                active, self._pending = self._pending, []
                requested = set().union(*(bindings for bindings, future in active if not future.done()))
                try:
                    valid = await self._fresh_lookup(requested) if requested else set()
                except Exception:
                    # Registry failures never authorize a transport. No raw
                    # identity, SID, exception or credential is logged here.
                    valid = set()
                for bindings, future in active:
                    if not future.done():
                        future.set_result(bindings & valid)
                self._outstanding_size -= sum(len(bindings) for bindings, _ in active)
                active = []
        finally:
            for _, future in active + self._pending:
                if not future.done():
                    future.set_result(set())
            self._pending.clear()
            self._outstanding_size = 0
            self._worker = None
