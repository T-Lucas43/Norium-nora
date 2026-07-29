from __future__ import annotations

import re
import unicodedata
import uuid
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta, timezone
from typing import Any

from app.services.calendar_service import CalendarService

TZ = timezone(timedelta(hours=-3))


@dataclass
class AgendaSession:
    id: str
    user_id: str
    fields: dict[str, Any] = field(default_factory=dict)
    awaiting: str = "titulo"
    updated_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))


class AgendaAgent:
    SESSION_TTL = timedelta(minutes=20)

    def __init__(self) -> None:
        self.sessions: dict[str, AgendaSession] = {}

    def cancel_session(self, session_id: str | None) -> None:
        if session_id:
            self.sessions.pop(session_id, None)

    def handle(self, *, message: str, session_id: str | None, user_id: str = "lucas123") -> dict[str, Any]:
        text = message.strip()
        normalized = self._normalize(text)
        session = self.sessions.get(session_id or "") if session_id else None
        if session and datetime.now(timezone.utc) - session.updated_at > self.SESSION_TTL:
            self.sessions.pop(session.id, None)
            session = None

        if self._is_cancel(normalized):
            if session:
                self.sessions.pop(session.id, None)
            return {
                "session_id": session_id,
                "status": "cancelado",
                "response": "Agendamento cancelado. Quando quiser, eu recomeco do zero.",
            }

        if session and session.awaiting == "confirmacao":
            if self._is_yes(normalized):
                return self._create_event(session)
            if self._is_no(normalized):
                session.awaiting = "titulo"
                session.fields.clear()
                return {
                    "session_id": session.id,
                    "status": "coletando",
                    "response": "Sem problema. Qual e o titulo do compromisso?",
                    "fields": session.fields,
                }
            changed = self._apply_inline_updates(session, text, normalized)
            if changed:
                return self._next_question(session)

        if not session and self._is_edit_intent(normalized):
            return self._edit_existing_event(text, normalized, user_id)

        if not session and self._is_check_intent(normalized) and not self._is_create_intent(normalized):
            return self._check_calendar(text, user_id)

        if not session:
            session = AgendaSession(id=session_id or uuid.uuid4().hex, user_id=user_id)
            self.sessions[session.id] = session

        session.updated_at = datetime.now(timezone.utc)
        self._apply_message(session, text, normalized)
        return self._next_question(session)

    def _apply_message(self, session: AgendaSession, text: str, normalized: str) -> None:
        fields = session.fields

        if session.awaiting == "titulo" and not fields.get("titulo"):
            title = self._extract_title(text, normalized)
            if title:
                fields["titulo"] = title
        elif session.awaiting == "data" and not fields.get("data"):
            parsed_date = self._extract_date(normalized)
            if parsed_date:
                fields["data"] = parsed_date.isoformat()
        elif session.awaiting == "hora" and not fields.get("hora"):
            parsed_time = self._extract_time(normalized)
            if parsed_time:
                fields["hora"] = parsed_time.strftime("%H:%M")
        elif session.awaiting == "duracao" and not fields.get("duracao_minutos"):
            duration = self._extract_duration(normalized)
            if duration:
                fields["duracao_minutos"] = duration
        elif session.awaiting == "local" and "local" not in fields:
            fields["local"] = "" if self._is_skip(normalized) else text[:160]
        elif session.awaiting == "participantes" and "participantes" not in fields:
            fields["participantes"] = [] if self._is_skip(normalized) else self._extract_emails(text)
        elif session.awaiting == "meet" and "criar_meet" not in fields:
            fields["criar_meet"] = self._is_yes(normalized)

        if "data" not in fields:
            parsed_date = self._extract_date(normalized)
            if parsed_date:
                fields["data"] = parsed_date.isoformat()
        if "hora" not in fields:
            parsed_time = self._extract_time(normalized)
            if parsed_time:
                fields["hora"] = parsed_time.strftime("%H:%M")
        if "duracao_minutos" not in fields:
            duration = self._extract_duration(normalized)
            if duration:
                fields["duracao_minutos"] = duration
        if "participantes" not in fields:
            emails = self._extract_emails(text)
            if emails:
                fields["participantes"] = emails

        self._apply_inline_updates(session, text, normalized)

    def _next_question(self, session: AgendaSession) -> dict[str, Any]:
        fields = session.fields
        if not fields.get("titulo"):
            session.awaiting = "titulo"
            response = "Qual e o titulo do compromisso?"
        elif not fields.get("data"):
            session.awaiting = "data"
            response = "Para qual dia? Pode responder como hoje, amanha ou 12/07."
        elif not fields.get("hora"):
            session.awaiting = "hora"
            response = "Que horas comeca?"
        elif not fields.get("duracao_minutos"):
            session.awaiting = "duracao"
            response = "Qual a duracao? Exemplo: 30 minutos, 1 hora ou 2h."
        elif "local" not in fields:
            session.awaiting = "local"
            response = "Tem local ou chamada? Se nao tiver, responda pular."
        elif "participantes" not in fields:
            session.awaiting = "participantes"
            response = "Quer adicionar convidados? Envie os e-mails separados por virgula ou responda pular."
        elif "criar_meet" not in fields:
            session.awaiting = "meet"
            response = "Quer que eu crie um link do Google Meet?"
        else:
            session.awaiting = "confirmacao"
            response = f"Confirma criar este evento?\n\n{self._summary(fields)}"

        return {
            "session_id": session.id,
            "status": "coletando" if session.awaiting != "confirmacao" else "confirmar",
            "response": response,
            "fields": fields,
        }

    def _create_event(self, session: AgendaSession) -> dict[str, Any]:
        fields = session.fields
        start_date = date.fromisoformat(fields["data"])
        hour, minute = [int(part) for part in fields["hora"].split(":")]
        start = datetime.combine(start_date, time(hour, minute), tzinfo=TZ)
        end = start + timedelta(minutes=int(fields["duracao_minutos"]))

        result = CalendarService(session.user_id).create_event(
            titulo=fields["titulo"],
            inicio=start.isoformat(),
            fim=end.isoformat(),
            descricao="Criado pela Nora via Agente de Agenda.",
            local=fields.get("local", ""),
            participantes=fields.get("participantes", []),
            criar_meet=bool(fields.get("criar_meet")),
        )
        self.sessions.pop(session.id, None)
        source_label = "Google Agenda" if result.get("connected") else "agenda local"
        return {
            "session_id": session.id,
            "status": "criado",
            "response": f"Pronto, criei no {source_label}:\n\n{self._summary(fields)}",
            "event": result.get("evento"),
            "source": result.get("source"),
            "connected": result.get("connected"),
        }

    def _check_calendar(self, text: str, user_id: str) -> dict[str, Any]:
        normalized = self._normalize(text)
        selected_date = self._extract_date(normalized) or datetime.now(TZ).date()
        start = datetime.combine(selected_date, time(0, 0), tzinfo=TZ)
        end = start + timedelta(days=1)
        result = CalendarService(user_id).list_events(time_min=start.isoformat(), time_max=end.isoformat())
        eventos = result.get("eventos", [])
        if not eventos:
            response = f"Nao encontrei compromissos em {selected_date.strftime('%d/%m/%Y')}."
        else:
            linhas = []
            for evento in eventos[:8]:
                inicio = str(evento.get("inicio", ""))
                hora = inicio[11:16] if "T" in inicio else "dia todo"
                linhas.append(f"- {hora} - {evento.get('titulo', 'Sem titulo')}")
            response = f"Seus compromissos em {selected_date.strftime('%d/%m/%Y')}:\n" + "\n".join(linhas)
        return {"session_id": None, "status": "consulta", "response": response, "events": eventos}

    def _edit_existing_event(self, text: str, normalized: str, user_id: str) -> dict[str, Any]:
        service = CalendarService(user_id)
        selected_date = self._extract_date(normalized)
        now = datetime.now(TZ)
        time_min = (now - timedelta(days=31)).isoformat()
        time_max = (now + timedelta(days=400)).isoformat()
        query = self._extract_edit_query(text, normalized)
        result = service.list_events(time_min=time_min, time_max=time_max, query=query or None, max_results=20)
        eventos = result.get("eventos", [])
        if not eventos and query:
            result = service.list_events(time_min=time_min, time_max=time_max, max_results=30)
            eventos = [
                evento for evento in result.get("eventos", [])
                if self._normalize(query) in self._normalize(str(evento.get("titulo") or ""))
            ]
        if not eventos:
            return {
                "session_id": None,
                "status": "nao_encontrado",
                "response": "Nao encontrei esse compromisso. Me diga um trecho do titulo ou a data do evento.",
            }

        evento = eventos[0]
        updates = self._updates_from_text(text, normalized, evento)
        if selected_date and not updates.get("inicio"):
            start_dt = self._event_start(evento) or now
            end_dt = self._event_end(evento) or (start_dt + timedelta(minutes=60))
            new_start = datetime.combine(selected_date, start_dt.timetz(), tzinfo=start_dt.tzinfo or TZ)
            updates["inicio"] = new_start.isoformat()
            updates["fim"] = (new_start + (end_dt - start_dt)).isoformat()

        if not updates:
            return {
                "session_id": None,
                "status": "precisa_dados",
                "response": f"Encontrei '{evento.get('titulo')}', mas preciso saber o que alterar: titulo, data, hora, duracao, local ou convidados.",
                "event": evento,
            }

        updated = service.update_event(str(evento.get("id")), updates).get("evento", {})
        return {
            "session_id": None,
            "status": "atualizado",
            "response": f"Atualizei o compromisso:\n\n{updated.get('titulo')}\n{updated.get('inicio')}",
            "event": updated,
        }

    def _apply_inline_updates(self, session: AgendaSession, text: str, normalized: str) -> bool:
        updates = self._updates_from_text(text, normalized)
        changed = False
        fields = session.fields
        if updates.get("titulo"):
            fields["titulo"] = updates["titulo"]
            changed = True
        if updates.get("inicio"):
            start = datetime.fromisoformat(str(updates["inicio"]))
            fields["data"] = start.date().isoformat()
            fields["hora"] = start.strftime("%H:%M")
            changed = True
        elif self._extract_date(normalized):
            fields["data"] = self._extract_date(normalized).isoformat()
            changed = True
        elif self._extract_time(normalized):
            fields["hora"] = self._extract_time(normalized).strftime("%H:%M")
            changed = True
        if updates.get("fim") and updates.get("inicio"):
            start = datetime.fromisoformat(str(updates["inicio"]))
            end = datetime.fromisoformat(str(updates["fim"]))
            fields["duracao_minutos"] = max(15, int((end - start).total_seconds() // 60))
            changed = True
        elif self._extract_duration(normalized):
            fields["duracao_minutos"] = self._extract_duration(normalized)
            changed = True
        if "local" in updates:
            fields["local"] = updates["local"]
            changed = True
        if "participantes" in updates:
            fields["participantes"] = updates["participantes"]
            changed = True
        if "criar_meet" in updates:
            fields["criar_meet"] = updates["criar_meet"]
            changed = True
        return changed

    def _updates_from_text(self, text: str, normalized: str, event: dict[str, Any] | None = None) -> dict[str, Any]:
        updates: dict[str, Any] = {}
        title_match = re.search(r"\b(?:titulo|nome)\s*(?:para|=|:)\s*(.+?)(?:\s+(?:em|no dia|dia|as|às|a\s+\d|com local|local|por|duracao|duração)\b|$)", text, flags=re.I)
        if title_match:
            updates["titulo"] = title_match.group(1).strip(" .,:;-")[:120]
        local_match = re.search(r"\b(?:local|endereco|endereço)\s*(?:para|=|:)?\s*(.+)$", text, flags=re.I)
        if local_match:
            updates["local"] = local_match.group(1).strip(" .,:;-")[:160]
        emails = self._extract_emails(text)
        if emails:
            updates["participantes"] = emails
        if "meet" in normalized or "link" in normalized:
            updates["criar_meet"] = True

        parsed_date = self._extract_date(normalized)
        parsed_time = self._extract_time(normalized)
        duration = self._extract_duration(normalized)
        if parsed_date or parsed_time or duration:
            base_start = self._event_start(event or {}) or datetime.now(TZ).replace(minute=0, second=0, microsecond=0)
            base_end = self._event_end(event or {}) or (base_start + timedelta(minutes=60))
            start_date = parsed_date or base_start.date()
            start_time = parsed_time or base_start.time().replace(tzinfo=None)
            new_start = datetime.combine(start_date, start_time, tzinfo=TZ)
            current_duration = int((base_end - base_start).total_seconds() // 60) if base_end > base_start else 60
            new_end = new_start + timedelta(minutes=duration or current_duration or 60)
            updates["inicio"] = new_start.isoformat()
            updates["fim"] = new_end.isoformat()
        return updates

    def _event_start(self, event: dict[str, Any]) -> datetime | None:
        return self._parse_event_dt(event.get("inicio"))

    def _event_end(self, event: dict[str, Any]) -> datetime | None:
        return self._parse_event_dt(event.get("fim"))

    def _parse_event_dt(self, value: Any) -> datetime | None:
        if not isinstance(value, str) or not value:
            return None
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=TZ)

    def _summary(self, fields: dict[str, Any]) -> str:
        data_br = date.fromisoformat(fields["data"]).strftime("%d/%m/%Y")
        lines = [
            f"- Titulo: {fields['titulo']}",
            f"- Quando: {data_br} as {fields['hora']}",
            f"- Duracao: {fields['duracao_minutos']} minutos",
        ]
        if fields.get("local"):
            lines.append(f"- Local: {fields['local']}")
        if fields.get("participantes"):
            lines.append(f"- Convidados: {', '.join(fields['participantes'])}")
        lines.append(f"- Google Meet: {'sim' if fields.get('criar_meet') else 'nao'}")
        return "\n".join(lines)

    def _extract_title(self, text: str, normalized: str) -> str:
        cleaned = re.sub(r"\b(agendar|agenda|marcar|criar|novo|nova|compromisso|evento|reuniao|reunião)\b", "", text, flags=re.I)
        cleaned = re.split(r"\b(hoje|amanh[aã]|dia\s+\d{1,2}|as\s+\d{1,2}|às\s+\d{1,2}|\d{1,2}[/-]\d{1,2})\b", cleaned, maxsplit=1, flags=re.I)[0]
        cleaned = re.sub(r"\b(crie|agende|marque|um|uma|minha|meu|no|na|do|da)\b", "", cleaned, flags=re.I)
        cleaned = cleaned.strip(" ,.-:")
        if len(cleaned) >= 3 and not self._looks_like_time_or_date(normalized):
            return cleaned[:120]
        return ""

    def _extract_date(self, normalized: str) -> date | None:
        today = datetime.now(TZ).date()
        if "hoje" in normalized:
            return today
        if "amanha" in normalized:
            return today + timedelta(days=1)

        match = re.search(r"\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b", normalized)
        if match:
            day = int(match.group(1))
            month = int(match.group(2))
            year = int(match.group(3) or today.year)
            year = 2000 + year if year < 100 else year
            try:
                parsed = date(year, month, day)
                if parsed < today and not match.group(3):
                    parsed = date(today.year + 1, month, day)
                return parsed
            except ValueError:
                return None

        weekdays = {
            "domingo": 6,
            "segunda": 0,
            "terca": 1,
            "terça": 1,
            "quarta": 2,
            "quinta": 3,
            "sexta": 4,
            "sabado": 5,
            "sábado": 5,
        }
        for name, target in weekdays.items():
            if name in normalized:
                delta = (target - today.weekday()) % 7
                return today + timedelta(days=delta or 7)
        return None

    def _extract_time(self, normalized: str) -> time | None:
        patterns = [
            r"\b(?:as|às|a)\s+([01]?\d|2[0-3])(?:[:h]([0-5]\d))?\b",
            r"\b([01]?\d|2[0-3])[:h]([0-5]\d)?\b",
            r"\b([01]?\d|2[0-3])\s*horas\b",
        ]
        for pattern in patterns:
            match = re.search(pattern, normalized)
            if match:
                hour = int(match.group(1))
                minute = int(match.group(2) or 0)
                return time(hour, minute)
        return None

    def _extract_duration(self, normalized: str) -> int | None:
        match = re.search(r"\b(\d{1,2})\s*(h|hora|horas)\b", normalized)
        if match:
            return int(match.group(1)) * 60
        match = re.search(r"\b(\d{1,3})\s*(min|minuto|minutos)\b", normalized)
        if match:
            return int(match.group(1))
        return None

    def _extract_emails(self, text: str) -> list[str]:
        return re.findall(r"[\w.+-]+@[\w-]+\.[\w.-]+", text)

    def _is_check_intent(self, normalized: str) -> bool:
        if self._is_create_intent(normalized):
            return False
        return any(word in normalized for word in ("agenda", "compromisso", "evento", "eventos", "livre", "ocupado", "tenho algo", "tenho reuniao"))

    def _is_create_intent(self, normalized: str) -> bool:
        return any(
            word in normalized
            for word in (
                "agendar",
                "agende",
                "marcar",
                "marque",
                "criar evento",
                "crie evento",
                "crie um evento",
                "criar um evento",
                "novo evento",
                "nova reuniao",
                "criar compromisso",
                "crie compromisso",
            )
        )

    def _is_edit_intent(self, normalized: str) -> bool:
        return any(word in normalized for word in ("alterar", "mudar", "editar", "remarcar", "trocar horario", "trocar data"))

    def _extract_edit_query(self, text: str, normalized: str) -> str:
        cleaned = re.sub(r"\b(alterar|mudar|editar|remarcar|trocar|evento|compromisso|reuniao|reunião)\b", "", text, flags=re.I)
        cleaned = re.split(r"\b(para|pro|pra|no dia|dia|hoje|amanh[aã]|as|às|\d{1,2}[/-]\d{1,2})\b", cleaned, maxsplit=1, flags=re.I)[0]
        cleaned = cleaned.strip(" .,:;-")
        return cleaned[:120]

    def _is_cancel(self, normalized: str) -> bool:
        return normalized in {"cancelar", "cancela", "desistir", "parar"}

    def _is_yes(self, normalized: str) -> bool:
        return normalized in {"sim", "s", "confirmo", "confirmar", "pode", "pode criar", "cria", "ok", "isso"}

    def _is_no(self, normalized: str) -> bool:
        return normalized in {"nao", "não", "n", "negativo"}

    def _is_skip(self, normalized: str) -> bool:
        return normalized in {"pular", "sem", "nao", "não", "nenhum", "nenhuma"}

    def _looks_like_time_or_date(self, normalized: str) -> bool:
        return bool(self._extract_date(normalized) or self._extract_time(normalized) or self._extract_duration(normalized))

    def _normalize(self, value: str) -> str:
        lowered = value.lower().strip()
        return "".join(
            char for char in unicodedata.normalize("NFKD", lowered) if not unicodedata.combining(char)
        )
