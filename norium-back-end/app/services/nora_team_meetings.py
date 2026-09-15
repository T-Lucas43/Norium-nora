from __future__ import annotations

import re
import unicodedata
import uuid
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta, timezone
from typing import Any


TZ = timezone(timedelta(hours=-3))


def _normalize(value: Any) -> str:
    text = unicodedata.normalize("NFKD", str(value or "").casefold())
    return "".join(character for character in text if not unicodedata.combining(character)).strip()


def is_team_meeting_intent(message: str) -> bool:
    text = _normalize(message)
    return bool(
        re.search(r"\b(?:agend\w*|marc\w*|cri\w*)\b", text)
        and re.search(r"\b(?:reuniao|call|chamada)\b", text)
        and re.search(r"\b(?:equipe|time|chat da equipe|chat do time)\b", text)
    )


@dataclass
class TeamMeetingSession:
    id: str
    user_id: str
    team_id: str
    fields: dict[str, Any] = field(default_factory=dict)
    awaiting: str = "title"
    updated_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))


class NoraTeamMeetingAgent:
    """Agenda reunioes internas sem expor o diretorio de outras equipes."""

    SESSION_TTL = timedelta(minutes=20)

    def __init__(self) -> None:
        self.sessions: dict[str, TeamMeetingSession] = {}

    def has_session(self, session_id: str | None, user: dict[str, Any]) -> bool:
        session = self.sessions.get(session_id or "")
        if not session:
            return False
        return session.user_id == str(user.get("id") or "") and session.team_id == self._team_id(user)

    def cancel_session(self, session_id: str | None) -> None:
        if session_id:
            self.sessions.pop(session_id, None)

    async def handle(self, *, message: str, session_id: str | None, user: dict[str, Any]) -> dict[str, Any]:
        from app.modules.team.router import ScheduleMeetingPayload, schedule_meeting, visible_team_members

        user_id = str(user.get("id") or "")
        team_id = self._team_id(user)
        normalized = _normalize(message)
        session = self.sessions.get(session_id or "") if session_id else None
        if session and (
            datetime.now(timezone.utc) - session.updated_at > self.SESSION_TTL
            or session.user_id != user_id
            or session.team_id != team_id
        ):
            self.sessions.pop(session.id, None)
            session = None

        if normalized in {"cancelar", "cancela", "desistir", "parar"}:
            if session:
                self.sessions.pop(session.id, None)
            return {"session_id": session_id, "status": "cancelado", "response": "Agendamento da reunião de equipe cancelado."}

        members = await visible_team_members(user)
        allowed_members = {
            str(member.get("id") or ""): {
                "id": str(member.get("id") or ""),
                "name": str(member.get("nome") or member.get("email") or "Membro"),
                "email": str(member.get("email") or ""),
            }
            for member in members
            if str(member.get("id") or "")
        }
        if user_id not in allowed_members:
            allowed_members[user_id] = {"id": user_id, "name": str(user.get("nome") or "Você"), "email": str(user.get("email") or "")}

        if session and session.awaiting == "confirmation":
            if normalized in {"sim", "s", "confirmo", "confirmar", "pode", "pode criar", "agende", "ok", "isso"}:
                fields = session.fields
                start = datetime.combine(date.fromisoformat(fields["date"]), time.fromisoformat(fields["time"]), tzinfo=TZ)
                end = start + timedelta(minutes=int(fields["durationMinutes"]))
                result = await schedule_meeting(
                    ScheduleMeetingPayload(
                        scope="team",
                        title=str(fields["title"]),
                        description="Reunião de equipe agendada pela Nora.",
                        startsAt=start.isoformat(),
                        endsAt=end.isoformat(),
                        participantIds=list(fields["participantIds"]),
                    ),
                    user,
                )
                self.sessions.pop(session.id, None)
                names = self._participant_names(fields["participantIds"], allowed_members)
                return {
                    "session_id": session.id,
                    "status": "criado",
                    "response": f"Reunião de equipe agendada: {fields['title']} em {start.strftime('%d/%m/%Y às %H:%M')}, com {names}.",
                    "meeting": result.get("meeting"),
                    "message": result.get("message"),
                }
            if normalized in {"nao", "não", "n", "corrigir", "alterar"}:
                session.awaiting = "title"
                session.fields.clear()
                return self._question(session, "Vamos corrigir. Qual é o título da reunião de equipe?")

        if not session:
            session = TeamMeetingSession(id=session_id or uuid.uuid4().hex, user_id=user_id, team_id=team_id)
            self.sessions[session.id] = session
        session.updated_at = datetime.now(timezone.utc)

        parse_error = self._apply_message(session, message, normalized, allowed_members)
        if parse_error:
            return self._question(session, parse_error)
        return self._next_question(session, allowed_members)

    @staticmethod
    def _team_id(user: dict[str, Any]) -> str:
        return str(user.get("teamOwnerId") or user.get("id") or "")

    def _apply_message(
        self,
        session: TeamMeetingSession,
        original: str,
        normalized: str,
        members: dict[str, dict[str, str]],
    ) -> str | None:
        fields = session.fields
        if not fields.get("date"):
            parsed_date = self._extract_date(normalized)
            if parsed_date:
                fields["date"] = parsed_date.isoformat()
        if not fields.get("time"):
            parsed_time = self._extract_time(normalized)
            if parsed_time:
                fields["time"] = parsed_time.strftime("%H:%M")
        if not fields.get("durationMinutes"):
            fields["durationMinutes"] = self._extract_duration(normalized) or 60

        if session.awaiting == "title" and not fields.get("title"):
            title = self._extract_title(original)
            if title:
                fields["title"] = title

        if session.awaiting == "participants" or re.search(r"\bcom\s+", normalized):
            selected, unknown = self._match_participants(normalized, members, session.user_id)
            if selected is not None:
                fields["participantIds"] = selected
            if unknown:
                allowed = ", ".join(item["name"] for item in members.values())
                return f"Não encontrei {unknown} nesta equipe. Posso incluir somente: {allowed}. Quem deseja convidar?"
        return None

    def _next_question(self, session: TeamMeetingSession, members: dict[str, dict[str, str]]) -> dict[str, Any]:
        fields = session.fields
        if not fields.get("title"):
            session.awaiting = "title"
            return self._question(session, "Qual é o título da reunião de equipe?")
        if not fields.get("date"):
            session.awaiting = "date"
            return self._question(session, "Para qual dia? Pode responder como amanhã, sexta-feira ou 20/09.")
        if not fields.get("time"):
            session.awaiting = "time"
            return self._question(session, "Que horas a reunião começa?")
        if "participantIds" not in fields:
            session.awaiting = "participants"
            choices = ", ".join(item["name"] for item in members.values())
            return self._question(session, f"Quem participa? Escolha entre {choices}, diga toda a equipe ou somente eu.")
        session.awaiting = "confirmation"
        start = datetime.combine(date.fromisoformat(fields["date"]), time.fromisoformat(fields["time"]), tzinfo=TZ)
        names = self._participant_names(fields["participantIds"], members)
        return self._question(
            session,
            f"Confirma agendar a reunião de equipe?\n\nTítulo: {fields['title']}\nInício: {start.strftime('%d/%m/%Y às %H:%M')}\nDuração: {fields['durationMinutes']} minutos\nParticipantes: {names}",
            status="confirmar",
        )

    @staticmethod
    def _question(session: TeamMeetingSession, response: str, status: str = "coletando") -> dict[str, Any]:
        return {"session_id": session.id, "status": status, "response": response, "fields": dict(session.fields)}

    @staticmethod
    def _participant_names(ids: list[str], members: dict[str, dict[str, str]]) -> str:
        return ", ".join(members[item]["name"] for item in ids if item in members) or "você"

    def _match_participants(
        self,
        normalized: str,
        members: dict[str, dict[str, str]],
        current_user_id: str,
    ) -> tuple[list[str] | None, str | None]:
        if re.search(r"\b(?:toda a equipe|todos da equipe|todo o time|todos)\b", normalized):
            return sorted(members), None
        if re.search(r"\b(?:somente eu|so eu|apenas eu|sem convidados|pular)\b", normalized):
            return [current_user_id], None

        selected = {current_user_id}
        matched_terms: list[str] = []
        for member_id, member in members.items():
            if member_id == current_user_id:
                continue
            full_name = _normalize(member["name"])
            email = _normalize(member["email"])
            first_name = full_name.split()[0] if full_name else ""
            first_is_unique = first_name and sum(_normalize(item["name"]).split()[0] == first_name for item in members.values() if _normalize(item["name"])) == 1
            if (full_name and full_name in normalized) or (email and email in normalized) or (first_is_unique and re.search(rf"\b{re.escape(first_name)}\b", normalized)):
                selected.add(member_id)
                matched_terms.append(full_name or email)
        if len(selected) > 1:
            return sorted(selected), None
        if re.search(r"\bcom\s+", normalized):
            unknown = re.split(r"\bcom\s+", normalized, maxsplit=1)[-1]
            unknown = re.split(r"\b(?:amanha|hoje|segunda|terca|quarta|quinta|sexta|sabado|domingo|as|às|durante|por)\b", unknown, maxsplit=1)[0].strip(" .,;")
            return None, unknown or "essa pessoa"
        return None, None

    @staticmethod
    def _extract_title(text: str) -> str:
        cleaned = re.sub(r"^\s*(?:nora[, ]*)?(?:agende|agendar|marque|marcar|crie|criar)\s+(?:uma\s+)?", "", text, flags=re.I)
        cleaned = re.sub(r"^(?:reuni[aã]o|call|chamada)\s+(?:da|de|do|para\s+a|com\s+a)?\s*(?:equipe|time)\s*", "", cleaned, flags=re.I)
        cleaned = re.sub(r"^(?:sobre|chamada|intitulada|com\s+o\s+t[ií]tulo)\s+", "", cleaned, flags=re.I)
        cleaned = re.split(r"\b(?:hoje|amanh[aã]|segunda|ter[cç]a|quarta|quinta|sexta|s[aá]bado|domingo|dia\s+\d|\d{1,2}[/-]\d{1,2}|[àa]s\s+\d|com\s+\w)\b", cleaned, maxsplit=1, flags=re.I)[0]
        title = re.sub(r"\s+(?:em|no dia|para)$", "", cleaned.strip(" .,:;-"), flags=re.I).strip()
        return title[:120]

    @staticmethod
    def _extract_date(normalized: str) -> date | None:
        today = datetime.now(TZ).date()
        if "amanha" in normalized:
            return today + timedelta(days=1)
        if "hoje" in normalized:
            return today
        match = re.search(r"\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b", normalized)
        if match:
            year = int(match.group(3) or today.year)
            year = 2000 + year if year < 100 else year
            try:
                parsed = date(year, int(match.group(2)), int(match.group(1)))
                return date(year + 1, parsed.month, parsed.day) if parsed < today and not match.group(3) else parsed
            except ValueError:
                return None
        weekdays = {"segunda": 0, "terca": 1, "quarta": 2, "quinta": 3, "sexta": 4, "sabado": 5, "domingo": 6}
        for name, weekday in weekdays.items():
            if name in normalized:
                delta = (weekday - today.weekday()) % 7
                return today + timedelta(days=delta or 7)
        return None

    @staticmethod
    def _extract_time(normalized: str) -> time | None:
        for pattern in (r"\b(?:as|a)\s+([01]?\d|2[0-3])(?:[:h]([0-5]\d))?\b", r"\b([01]?\d|2[0-3])[:h]([0-5]\d)?\b"):
            match = re.search(pattern, normalized)
            if match:
                return time(int(match.group(1)), int(match.group(2) or 0))
        return None

    @staticmethod
    def _extract_duration(normalized: str) -> int | None:
        match = re.search(r"\b(?:durante|por|duracao\s+de)\s+(\d{1,2})\s*(?:h|hora|horas)\b", normalized)
        if match:
            return min(int(match.group(1)) * 60, 480)
        match = re.search(r"\b(?:durante|por|duracao\s+de)\s+(\d{1,3})\s*(?:min|minuto|minutos)\b", normalized)
        return min(int(match.group(1)), 480) if match else None


team_meeting_agent = NoraTeamMeetingAgent()
