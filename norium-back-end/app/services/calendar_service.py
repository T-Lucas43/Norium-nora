from __future__ import annotations

import json
import logging
import os
import re
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from dotenv import load_dotenv
from google.auth.exceptions import RefreshError
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import Flow
from googleapiclient.discovery import build

from app.core.tenant import get_data_root, read_profile_db, write_profile_db

BASE_DIR = Path(__file__).resolve().parents[2]
load_dotenv(BASE_DIR / ".env")
logger = logging.getLogger(__name__)

SCOPES = ["https://www.googleapis.com/auth/calendar"]
TIMEZONE = "America/Sao_Paulo"
DEFAULT_REDIRECT_URI = "http://localhost:8000/api/integracoes/google/callback"
OAUTH_STATE_TTL_SECONDS = 10 * 60

TOKEN_PATH = BASE_DIR / "google_token.json"
LEGACY_TOKENS_PATH = BASE_DIR / "mock_database.json"
LOCAL_EVENTS_PATH = BASE_DIR / "agenda_local_events.json"
SYNC_STATE_PATH = BASE_DIR / "agenda_sync_state.json"
OAUTH_STATE_PATH = BASE_DIR / "google_oauth_state.json"
ACCOUNT_DIR = get_data_root() / "oauth_accounts" / "calendar"
ACCOUNT_DIR.mkdir(parents=True, exist_ok=True)


class CalendarConfigError(RuntimeError):
    pass


class CalendarService:
    def __init__(self, user_id: str = "lucas123") -> None:
        self.user_id = user_id

    @staticmethod
    def user_id_from_state(state: str | None) -> str | None:
        if not state:
            return None
        parts = state.split(":", 1)
        if len(parts) != 2 or not re.fullmatch(r"[0-9a-f]{32}", parts[1]):
            return None
        user_id = parts[0].strip()
        return user_id or None

    def status(self) -> dict[str, Any]:
        configured = bool(self._client_config())
        connected = False
        detail = ""
        if configured:
            try:
                creds = self._credentials(refresh=True)
                connected = bool(creds and creds.valid)
            except Exception:
                logger.exception("Falha ao validar a conexao do Google Agenda.")
                detail = "Falha ao validar a conexao."

        sync_state = self._read_profile_section("calendarSync", {})
        return {
            "configured": configured,
            "connected": connected,
            "source": "google" if connected else "local",
            "calendar": "primary",
            "timezone": TIMEZONE,
            "lastSync": sync_state.get("lastSync"),
            "detail": detail,
        }

    def authorization_url(self) -> dict[str, str]:
        state_value = f"{self._safe_user_id()}:{uuid.uuid4().hex}"
        flow = self._flow(state=state_value)
        auth_url, state = flow.authorization_url(
            access_type="offline",
            prompt="consent",
        )
        self._write_profile_section("calendarOauthState", {
            "state": state,
            "codeVerifier": flow.code_verifier,
            "createdAt": self._now_iso(),
        })
        return {"auth_url": auth_url, "state": state}

    def finish_oauth(self, *, code: str, state: str | None) -> dict[str, Any]:
        oauth_state = self._read_profile_section("calendarOauthState", {})
        saved_state = str(oauth_state.get("state") or "")
        if not state or not saved_state or not secrets.compare_digest(state, saved_state):
            raise CalendarConfigError("Estado OAuth invalido. Gere um novo link de conexao.")

        try:
            created_at = datetime.fromisoformat(str(oauth_state.get("createdAt") or ""))
            if created_at.tzinfo is None:
                created_at = created_at.replace(tzinfo=timezone.utc)
        except ValueError as exc:
            raise CalendarConfigError("Sessao OAuth expirada. Gere um novo link de conexao do Google Agenda.") from exc
        if datetime.now(timezone.utc) - created_at > timedelta(seconds=OAUTH_STATE_TTL_SECONDS):
            self._write_profile_section("calendarOauthState", {})
            raise CalendarConfigError("Sessao OAuth expirada. Gere um novo link de conexao do Google Agenda.")

        code_verifier = oauth_state.get("codeVerifier")
        if not code_verifier:
            raise CalendarConfigError("Sessao OAuth expirada. Gere um novo link de conexao do Google Agenda.")

        self._write_profile_section("calendarOauthState", {})
        flow = self._flow(state=state, code_verifier=code_verifier)
        self._fetch_token(flow, code)
        payload = json.loads(flow.credentials.to_json())
        self._assert_required_scopes(payload.get("scopes") or SCOPES)
        previous = self._read_profile_section("calendarToken", {})
        if previous.get("refresh_token") and not payload.get("refresh_token"):
            payload["refresh_token"] = previous["refresh_token"]
        profile = self._read_profile()
        profile.pop("calendarTokenRevoked", None)
        self._write_profile(profile)
        self._write_profile_section("calendarToken", payload)
        return {"connected": True, "scopes": payload.get("scopes", SCOPES)}

    def list_events(
        self,
        *,
        time_min: str | None,
        time_max: str | None,
        query: str | None = None,
        max_results: int = 2500,
    ) -> dict[str, Any]:
        current_status = self.status()
        if current_status["connected"]:
            try:
                eventos = self._list_google_events(time_min, time_max, query, max_results)
                self._mark_sync()
                return {"eventos": eventos, **self.status()}
            except Exception as exc:
                if not self._is_invalid_grant(exc):
                    raise
                self._clear_google_auth()
                fallback_status = self.status()
                fallback_status["detail"] = "Conexao com Google Agenda expirada ou revogada. Clique em Conectar novamente."
                return {"eventos": self._list_local_events(time_min, time_max, query), **fallback_status}
        return {"eventos": self._list_local_events(time_min, time_max, query), **current_status}

    def create_event(
        self,
        *,
        titulo: str,
        inicio: str,
        fim: str,
        descricao: str = "",
        local: str = "",
        participantes: list[str] | None = None,
        criar_meet: bool = False,
    ) -> dict[str, Any]:
        participantes = participantes or []
        current_status = self.status()
        if current_status["connected"]:
            try:
                evento = self._create_google_event(titulo, inicio, fim, descricao, local, participantes, criar_meet)
                self._mark_sync()
                return {"evento": evento, **self.status()}
            except Exception as exc:
                if not self._is_invalid_grant(exc):
                    raise
                self._clear_google_auth()
                current_status = self.status()
                current_status["detail"] = "Conexao com Google Agenda expirada ou revogada. Evento salvo localmente."

        evento = self._create_local_event(titulo, inicio, fim, descricao, local, participantes, criar_meet)
        return {"evento": evento, **current_status}

    def update_event(self, event_id: str, updates: dict[str, Any]) -> dict[str, Any]:
        current_status = self.status()
        if current_status["connected"]:
            try:
                evento = self._update_google_event(event_id, updates)
                self._mark_sync()
                return {"evento": evento, **self.status()}
            except Exception as exc:
                if not self._is_invalid_grant(exc):
                    raise
                self._clear_google_auth()
                current_status = self.status()
                current_status["detail"] = "Conexao com Google Agenda expirada ou revogada. Usando agenda local."

        evento = self._update_local_event(event_id, updates)
        return {"evento": evento, **current_status}

    def _service(self):
        creds = self._credentials(refresh=True)
        if not creds or not creds.valid:
            raise CalendarConfigError("Google Agenda ainda nao esta conectado.")
        return build("calendar", "v3", credentials=creds, cache_discovery=False)

    def _credentials(self, *, refresh: bool) -> Credentials | None:
        info = self._authorized_user_info()
        if not info:
            return None
        legacy_token = bool(info.pop("_legacy", False))
        if legacy_token:
            creds = Credentials(
                token=info.get("token"),
                refresh_token=info.get("refresh_token"),
                token_uri=info.get("token_uri"),
                client_id=info.get("client_id"),
                client_secret=info.get("client_secret"),
            )
        else:
            creds = Credentials.from_authorized_user_info(info, info.get("scopes") or SCOPES)
        if refresh and creds.expired and creds.refresh_token:
            try:
                creds.refresh(Request())
                self._save_credentials(creds)
            except Exception as exc:
                if self._is_invalid_grant(exc):
                    self._clear_google_auth()
                    raise CalendarConfigError(
                        "Conexao com Google Agenda expirada ou revogada. Clique em Conectar novamente."
                    ) from exc
                raise
        return creds

    def _authorized_user_info(self) -> dict[str, Any] | None:
        profile = self._read_profile()
        if profile.get("calendarTokenRevoked"):
            return None
        token_payload = self._read_profile_section("calendarToken", {})
        if token_payload.get("client_id") and token_payload.get("client_secret"):
            return token_payload

        legacy = self._legacy_tokens()
        if not legacy:
            return None
        return {
            "token": legacy.get("access_token"),
            "refresh_token": legacy.get("refresh_token"),
            "client_id": legacy.get("client_id"),
            "client_secret": legacy.get("client_secret"),
            "token_uri": "https://oauth2.googleapis.com/token",
            "scopes": SCOPES,
            "_legacy": True,
        }

    def _save_credentials(self, creds: Credentials) -> None:
        payload = json.loads(creds.to_json())
        previous = self._read_profile_section("calendarToken", {})
        if previous.get("refresh_token") and not payload.get("refresh_token"):
            payload["refresh_token"] = previous["refresh_token"]
        self._write_profile_section("calendarToken", payload)

    def _is_invalid_grant(self, exc: Exception) -> bool:
        if isinstance(exc, RefreshError):
            message = " ".join(str(item) for item in exc.args)
        else:
            message = str(exc)
        return "invalid_grant" in message or "expired or revoked" in message.lower()

    def _clear_google_auth(self) -> None:
        profile = self._read_profile()
        for key in ("calendarToken", "calendarOauthState"):
            profile.pop(key, None)
        profile["calendarTokenRevoked"] = True
        self._write_profile(profile)

    def _flow(self, state: str | None = None, code_verifier: str | None = None) -> Flow:
        config = self._client_config()
        if not config:
            raise CalendarConfigError("Configure GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET no backend.")
        return Flow.from_client_config(
            config,
            scopes=SCOPES,
            state=state,
            redirect_uri=self._redirect_uri(),
            code_verifier=code_verifier,
            autogenerate_code_verifier=code_verifier is None,
        )

    def _fetch_token(self, flow: Flow, code: str) -> None:
        previous_relax_scope = os.environ.get("OAUTHLIB_RELAX_TOKEN_SCOPE")
        os.environ["OAUTHLIB_RELAX_TOKEN_SCOPE"] = "1"
        try:
            flow.fetch_token(code=code)
        finally:
            if previous_relax_scope is None:
                os.environ.pop("OAUTHLIB_RELAX_TOKEN_SCOPE", None)
            else:
                os.environ["OAUTHLIB_RELAX_TOKEN_SCOPE"] = previous_relax_scope

    def _assert_required_scopes(self, scopes: Any) -> None:
        granted = set(scopes.split() if isinstance(scopes, str) else scopes or [])
        missing = [scope for scope in SCOPES if scope not in granted]
        if missing:
            raise CalendarConfigError("Permissoes do Google Agenda incompletas. Gere um novo link de conexao.")

    def _client_config(self) -> dict[str, Any] | None:
        client_id = os.getenv("GOOGLE_CLIENT_ID")
        client_secret = os.getenv("GOOGLE_CLIENT_SECRET")
        legacy = self._legacy_tokens()
        client_id = client_id or (legacy or {}).get("client_id")
        client_secret = client_secret or (legacy or {}).get("client_secret")
        if not client_id or not client_secret:
            return None
        return {
            "web": {
                "client_id": client_id,
                "client_secret": client_secret,
                "auth_uri": "https://accounts.google.com/o/oauth2/auth",
                "token_uri": "https://oauth2.googleapis.com/token",
                "redirect_uris": [self._redirect_uri()],
            }
        }

    def _legacy_tokens(self) -> dict[str, Any] | None:
        payload = self._read_json(LEGACY_TOKENS_PATH, {})
        if not isinstance(payload, dict):
            return None
        user_payload = payload.get(self.user_id)
        if isinstance(user_payload, dict):
            return user_payload
        if self.user_id != "lucas123":
            return None
        return next((value for value in payload.values() if isinstance(value, dict)), None)

    def _list_google_events(
        self,
        time_min: str | None,
        time_max: str | None,
        query: str | None,
        max_results: int,
    ) -> list[dict[str, Any]]:
        params: dict[str, Any] = {
            "calendarId": "primary",
            "singleEvents": True,
            "orderBy": "startTime",
            "maxResults": max(1, min(max_results, 2500)),
            "timeMin": self._rfc3339(time_min or datetime.now(timezone.utc).isoformat()),
        }
        if time_max:
            params["timeMax"] = self._rfc3339(time_max)
        if query:
            params["q"] = query

        service = self._service()
        eventos: list[dict[str, Any]] = []
        page_token: str | None = None
        while True:
            if page_token:
                params["pageToken"] = page_token
            result = service.events().list(**params).execute()
            eventos.extend(self._normalize_event(item, "google") for item in result.get("items", []))
            page_token = result.get("nextPageToken")
            if not page_token:
                return eventos

    def _create_google_event(
        self,
        titulo: str,
        inicio: str,
        fim: str,
        descricao: str,
        local: str,
        participantes: list[str],
        criar_meet: bool,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {
            "summary": titulo,
            "description": descricao,
            "location": local,
            "start": {"dateTime": self._rfc3339(inicio), "timeZone": TIMEZONE},
            "end": {"dateTime": self._rfc3339(fim), "timeZone": TIMEZONE},
        }
        if participantes:
            body["attendees"] = [{"email": email} for email in participantes]
        if criar_meet:
            body["conferenceData"] = {
                "createRequest": {
                    "requestId": uuid.uuid4().hex,
                    "conferenceSolutionKey": {"type": "hangoutsMeet"},
                }
            }

        created = self._service().events().insert(
            calendarId="primary",
            body=body,
            conferenceDataVersion=1 if criar_meet else 0,
            sendUpdates="all" if participantes else "none",
        ).execute()
        return self._normalize_event(created, "google")

    def _update_google_event(self, event_id: str, updates: dict[str, Any]) -> dict[str, Any]:
        body: dict[str, Any] = {}
        if "titulo" in updates:
            body["summary"] = updates["titulo"]
        if "descricao" in updates:
            body["description"] = updates["descricao"]
        if "local" in updates:
            body["location"] = updates["local"]
        if updates.get("inicio"):
            body["start"] = {"dateTime": self._rfc3339(str(updates["inicio"])), "timeZone": TIMEZONE}
        if updates.get("fim"):
            body["end"] = {"dateTime": self._rfc3339(str(updates["fim"])), "timeZone": TIMEZONE}
        if "participantes" in updates:
            participantes = updates.get("participantes") or []
            body["attendees"] = [{"email": email} for email in participantes]
        if updates.get("criar_meet"):
            body["conferenceData"] = {
                "createRequest": {
                    "requestId": uuid.uuid4().hex,
                    "conferenceSolutionKey": {"type": "hangoutsMeet"},
                }
            }
        if not body:
            existing = self._service().events().get(calendarId="primary", eventId=event_id).execute()
            return self._normalize_event(existing, "google")

        updated = self._service().events().patch(
            calendarId="primary",
            eventId=event_id,
            body=body,
            conferenceDataVersion=1 if updates.get("criar_meet") else 0,
            sendUpdates="all" if "participantes" in updates else "none",
        ).execute()
        return self._normalize_event(updated, "google")

    def _list_local_events(self, time_min: str | None, time_max: str | None, query: str | None) -> list[dict[str, Any]]:
        eventos = self._read_profile_section("calendarLocalEvents", [])
        if not isinstance(eventos, list):
            return []
        min_dt = self._parse_dt(time_min) if time_min else None
        max_dt = self._parse_dt(time_max) if time_max else None
        q = (query or "").lower().strip()

        filtrados = []
        for evento in eventos:
            inicio = self._parse_dt(evento.get("inicio"))
            if min_dt and inicio and inicio < min_dt:
                continue
            if max_dt and inicio and inicio > max_dt:
                continue
            texto = f"{evento.get('titulo', '')} {evento.get('descricao', '')}".lower()
            if q and q not in texto:
                continue
            filtrados.append(evento)
        return sorted(filtrados, key=lambda item: str(item.get("inicio", "")))

    def _create_local_event(
        self,
        titulo: str,
        inicio: str,
        fim: str,
        descricao: str,
        local: str,
        participantes: list[str],
        criar_meet: bool,
    ) -> dict[str, Any]:
        evento = {
            "id": f"local_{uuid.uuid4().hex}",
            "titulo": titulo,
            "inicio": self._rfc3339(inicio),
            "fim": self._rfc3339(fim),
            "descricao": descricao,
            "local": local,
            "participantes": [{"email": email, "nome": email, "resposta": "needsAction"} for email in participantes],
            "allDay": False,
            "source": "local",
            "calendar": "Norium local",
            "htmlLink": None,
            "link_reuniao": "Google Meet solicitado" if criar_meet else None,
        }
        eventos = self._read_profile_section("calendarLocalEvents", [])
        if not isinstance(eventos, list):
            eventos = []
        eventos.append(evento)
        self._write_profile_section("calendarLocalEvents", eventos)
        return evento

    def _update_local_event(self, event_id: str, updates: dict[str, Any]) -> dict[str, Any]:
        eventos = self._read_profile_section("calendarLocalEvents", [])
        if not isinstance(eventos, list):
            eventos = []
        for index, evento in enumerate(eventos):
            if str(evento.get("id")) != str(event_id):
                continue
            changed = dict(evento)
            for key in ("titulo", "inicio", "fim", "descricao", "local"):
                if key in updates and updates[key] is not None:
                    changed[key] = self._rfc3339(str(updates[key])) if key in {"inicio", "fim"} else updates[key]
            if "participantes" in updates:
                changed["participantes"] = [
                    {"email": email, "nome": email, "resposta": "needsAction"}
                    for email in (updates.get("participantes") or [])
                ]
            if updates.get("criar_meet") and not changed.get("link_reuniao"):
                changed["link_reuniao"] = "Google Meet solicitado"
            eventos[index] = changed
            self._write_profile_section("calendarLocalEvents", eventos)
            return changed
        raise CalendarConfigError("Evento nao encontrado na agenda local.")

    def _normalize_event(self, event: dict[str, Any], source: str) -> dict[str, Any]:
        start = (event.get("start") or {}).get("dateTime") or (event.get("start") or {}).get("date")
        end = (event.get("end") or {}).get("dateTime") or (event.get("end") or {}).get("date")
        entry_points = ((event.get("conferenceData") or {}).get("entryPoints") or [])
        meet_link = event.get("hangoutLink") or next(
            (entry.get("uri") for entry in entry_points if entry.get("entryPointType") == "video"),
            None,
        )
        return {
            "id": event.get("id"),
            "titulo": event.get("summary") or "Compromisso sem titulo",
            "inicio": start,
            "fim": end,
            "descricao": event.get("description") or "",
            "local": event.get("location") or "",
            "participantes": [
                {
                    "email": attendee.get("email"),
                    "nome": attendee.get("displayName") or attendee.get("email"),
                    "resposta": attendee.get("responseStatus"),
                }
                for attendee in (event.get("attendees") or [])
                if attendee.get("email")
            ],
            "allDay": bool(start and "T" not in start),
            "htmlLink": event.get("htmlLink"),
            "link_reuniao": meet_link,
            "calendar": "Google Agenda" if source == "google" else "Norium local",
            "source": source,
            "status": event.get("status"),
            "updated": event.get("updated"),
        }

    def _rfc3339(self, value: str) -> str:
        parsed = self._parse_dt(value)
        return parsed.isoformat() if parsed else value

    def _parse_dt(self, value: Any) -> datetime | None:
        if not isinstance(value, str) or not value:
            return None
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            try:
                parsed = datetime.fromisoformat(f"{value}T00:00:00-03:00")
            except ValueError:
                return None
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone(timedelta(hours=-3)))

    def _mark_sync(self) -> None:
        self._write_profile_section("calendarSync", {"lastSync": self._now_iso()})

    def _now_iso(self) -> str:
        return datetime.now(timezone.utc).isoformat()

    def _read_json(self, path: Path, fallback: Any) -> Any:
        try:
            return json.loads(path.read_text(encoding="utf-8")) if path.exists() else fallback
        except Exception:
            return fallback

    def _write_json(self, path: Path, payload: Any) -> None:
        path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    def _redirect_uri(self) -> str:
        return os.getenv("GOOGLE_REDIRECT_URI") or DEFAULT_REDIRECT_URI

    def _read_profile(self) -> dict[str, Any]:
        profile = read_profile_db(self.user_id, {})
        if profile:
            return profile
        if self.user_id == "lucas123":
            legacy_profile_path = BASE_DIR / "perfil_db.json"
            legacy_profile = self._read_json(legacy_profile_path, {})
            if isinstance(legacy_profile, dict):
                if "nome" in legacy_profile:
                    return legacy_profile
                if isinstance(legacy_profile.get(self.user_id), dict):
                    return legacy_profile[self.user_id]
        return {}

    def _write_profile(self, profile: dict[str, Any]) -> None:
        write_profile_db(self.user_id, profile)

    def _read_profile_section(self, section: str, fallback: Any) -> Any:
        profile = self._read_profile()
        value = profile.get(section)
        if value is not None:
            return value
        if self.user_id != "lucas123":
            return fallback
        legacy_map = {
            "calendarToken": TOKEN_PATH,
            "calendarOauthState": OAUTH_STATE_PATH,
            "calendarSync": SYNC_STATE_PATH,
            "calendarLocalEvents": LOCAL_EVENTS_PATH,
        }
        legacy_path = legacy_map.get(section)
        return self._read_json(legacy_path, fallback) if legacy_path else fallback

    def _write_profile_section(self, section: str, value: Any) -> None:
        profile = self._read_profile()
        profile[section] = value
        self._write_profile(profile)

    def _safe_user_id(self) -> str:
        return re.sub(r"[^a-zA-Z0-9_.-]+", "_", self.user_id or "lucas123").strip("._") or "lucas123"
