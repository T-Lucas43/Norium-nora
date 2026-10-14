"""Bounded, volatile meeting transcript and derived views.

Nothing is written to disk. Durable retention/export/delete remain a separate
reviewed adapter. Every segment retains its actual audience; late joiners cannot
implicitly read speech captured before their admission/consent.
"""
from __future__ import annotations

import math
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta

from app.core.ai_guardrails import minimize_for_ai
from app.modules.team.meeting_intelligence import MeetingUnderstanding
from app.modules.team.nora_call_agent import TranscriptSegment


class MeetingSessionError(ValueError):
    pass


@dataclass
class MeetingSession:
    call_id: str
    expires_at: datetime
    records: dict[str, tuple[TranscriptSegment, frozenset[str]]] = field(default_factory=dict)
    byte_count: int = 0
    sequence: int = 0
    understanding: MeetingUnderstanding | None = None
    connected_revision: int = -1
    connected_until: datetime | None = None

    def check_expiry(self, now: datetime) -> None:
        if now >= self.expires_at:
            raise MeetingSessionError("O prazo da transcrição desta reunião expirou.")

    def connected(self, revision: int, now: datetime) -> bool:
        return bool(self.connected_revision == revision and self.connected_until and now < self.connected_until)

    def heartbeat(self, revision: int, now: datetime) -> None:
        self.check_expiry(now)
        self.connected_revision = revision
        self.connected_until = now + timedelta(seconds=5)

    def append(self, values: tuple[TranscriptSegment, ...], audience: frozenset[str], now: datetime) -> list[dict]:
        self.check_expiry(now)
        if not 1 <= len(values) <= 100 or not audience:
            raise MeetingSessionError("Trecho de transcrição inválido.")
        staged = {}
        additional = 0
        for value in values:
            if (value.call_id != self.call_id or value.user_id not in audience
                    or not isinstance(value.id, str) or not 1 <= len(value.id) <= 100
                    or any(type(t) not in {int, float} or not math.isfinite(t) for t in (value.start, value.end))
                    or not 0 <= value.start < value.end or value.end - value.start > 10.25
                    or not isinstance(value.text, str) or len(value.text) > 2000):
                raise MeetingSessionError("Trecho de transcrição inválido.")
            text = minimize_for_ai(value.text, max_chars=2000).strip()
            if not text:
                continue
            clean = TranscriptSegment(value.id, value.call_id, value.user_id, value.start, value.end, text)
            item = (clean, audience)
            previous = self.records.get(clean.id) or staged.get(clean.id)
            if previous is not None:
                if previous != item:
                    raise MeetingSessionError("Trecho já registrado com outro conteúdo.")
                continue
            staged[clean.id] = item
            additional += len(text.encode("utf-8")) + 256 + sum(len(user.encode()) for user in audience)
        if len(self.records) + len(staged) > 2000 or self.byte_count + additional > 2 * 1024 * 1024:
            raise MeetingSessionError("A transcrição atingiu o limite desta reunião.")
        self.records.update(staged)
        self.byte_count += additional
        if staged:
            self.sequence += 1
        return [self.public_segment(item[0]) for item in staged.values()]

    @staticmethod
    def public_segment(segment: TranscriptSegment) -> dict:
        return {"id": segment.id, "callId": segment.call_id, "userId": segment.user_id,
                "start": segment.start, "end": segment.end, "text": segment.text}

    def visible_segments(self, user_id: str, now: datetime) -> tuple[TranscriptSegment, ...]:
        self.check_expiry(now)
        return tuple(sorted((segment for segment, audience in self.records.values() if user_id in audience),
                            key=lambda segment: (segment.start, segment.end, segment.id)))

    def view(self, user_id: str, now: datetime) -> dict:
        visible = self.visible_segments(user_id, now)
        visible_ids = {value.id for value in visible}
        facts = {}
        for category in ("summary", "decisions", "tasks", "questions"):
            values = getattr(self.understanding, category) if self.understanding else ()
            facts[category] = [asdict(fact) for fact in values if fact.segment_id in visible_ids]
        return {"callId": self.call_id, "sequence": self.sequence,
                "expiresAt": self.expires_at.isoformat(), "volatile": True,
                "segments": [self.public_segment(value) for value in visible[-200:]],
                "visibleSegmentCount": len(visible), "understanding": facts}
