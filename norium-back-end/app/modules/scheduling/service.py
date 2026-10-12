from __future__ import annotations

import base64
import binascii
import hashlib
import json
import re
import sqlite3
from datetime import date, datetime, time, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo

from fastapi import HTTPException

from app.modules.scheduling.repository import SchedulingRepository, now_iso, opaque_id, public_id, token_hash, token_pair
from app.modules.scheduling.schemas import AvailabilityPayload, BookingField, BookingPayload, HoldPayload, PagePayload, ServicePayload, TeamSettingsPayload
from app.core.tenant import get_user_dir

ACTIVE = ("PENDING", "CONFIRMED")
CPF_DIGITS = re.compile(r"\D")


def validate_cpf(value: str) -> str:
    digits = CPF_DIGITS.sub("", value)
    if len(digits) != 11 or digits == digits[0] * 11:
        raise ValueError("CPF invalido.")
    for size in (9, 10):
        total = sum(int(digits[index]) * (size + 1 - index) for index in range(size))
        check = (total * 10 % 11) % 10
        if check != int(digits[size]):
            raise ValueError("CPF invalido.")
    return digits


def parse_utc(value: str) -> datetime:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise HTTPException(422, "Data e hora invalidas.") from exc
    if parsed.tzinfo is None:
        raise HTTPException(422, "Data e hora devem incluir timezone.")
    return parsed.astimezone(timezone.utc)


def scope_from_user(user: dict[str, Any], workspace_id: str) -> tuple[str, str, str]:
    user_id = str(user.get("id") or "").strip()
    if not user_id:
        raise HTTPException(401, "Sessao invalida.")
    # Recursos de agenda pertencem ao tenant da equipe. O terceiro campo
    # continua sendo o owner persistido; dentro de uma equipe ele e estavel e
    # impede que cada membro crie uma agenda paralela invisivel aos demais.
    team_owner_id = str(user.get("teamOwnerId") or user_id).strip()
    return team_owner_id, workspace_id, team_owner_id


class SchedulingService:
    def __init__(self, repository: SchedulingRepository | None = None) -> None:
        self.repo = repository or SchedulingRepository()

    @staticmethod
    def _where_scope(scope: tuple[str, str, str]) -> tuple[str, str, str]:
        return scope

    def list_services(self, scope: tuple[str, str, str]) -> list[dict[str, Any]]:
        items = self.repo.all(
            "SELECT * FROM scheduling_services WHERE tenant_id=? AND workspace_id=? AND owner_id=? AND archived_at IS NULL ORDER BY created_at DESC",
            scope,
        )
        for item in items:
            item["professionalIds"] = self.service_professional_ids(scope, item["id"])
        return items

    def service_professional_ids(self, scope: tuple[str, str, str], service_id: str) -> list[str]:
        return [
            str(item["user_id"])
            for item in self.repo.all(
                "SELECT user_id FROM scheduling_service_professionals WHERE tenant_id=? AND workspace_id=? AND service_id=? ORDER BY user_id",
                (scope[0], scope[1], service_id),
            )
        ]

    def _replace_service_professionals(self, db, scope: tuple[str, str, str], service_id: str, user_ids: list[str]) -> None:
        db.execute(
            "DELETE FROM scheduling_service_professionals WHERE tenant_id=? AND workspace_id=? AND service_id=?",
            (scope[0], scope[1], service_id),
        )
        for user_id in user_ids:
            active = db.execute(
                "SELECT 1 FROM scheduling_professionals WHERE tenant_id=? AND workspace_id=? AND user_id=? AND active=1",
                (scope[0], scope[1], user_id),
            ).fetchone()
            if not active:
                raise HTTPException(422, "Profissional nao esta ativo no modo equipe.")
            db.execute(
                "INSERT INTO scheduling_service_professionals (tenant_id,workspace_id,service_id,user_id,created_at) VALUES (?,?,?,?,?)",
                (scope[0], scope[1], service_id, user_id, now_iso()),
            )

    def team_settings(self, scope: tuple[str, str, str]) -> dict[str, Any]:
        row = self.repo.one(
            "SELECT * FROM scheduling_team_settings WHERE tenant_id=? AND workspace_id=?",
            (scope[0], scope[1]),
        )
        professionals = self.repo.all(
            "SELECT * FROM scheduling_professionals WHERE tenant_id=? AND workspace_id=? ORDER BY display_name",
            (scope[0], scope[1]),
        )
        return {"enabled": bool(row and row.get("enabled")), "professionals": professionals}

    def save_team_settings(self, scope: tuple[str, str, str], payload: TeamSettingsPayload, members: dict[str, dict[str, Any]]) -> dict[str, Any]:
        stamp = now_iso()
        requested = {item.userId: item for item in payload.professionals}
        if set(requested) - set(members):
            raise HTTPException(422, "Um profissional nao pertence a esta equipe.")
        with self.repo.transaction() as db:
            current = db.execute(
                "SELECT 1 FROM scheduling_team_settings WHERE tenant_id=? AND workspace_id=?",
                (scope[0], scope[1]),
            ).fetchone()
            if current:
                db.execute(
                    "UPDATE scheduling_team_settings SET enabled=?,updated_at=? WHERE tenant_id=? AND workspace_id=?",
                    (int(payload.enabled), stamp, scope[0], scope[1]),
                )
            else:
                db.execute(
                    "INSERT INTO scheduling_team_settings VALUES (?,?,?,?,?)",
                    (scope[0], scope[1], int(payload.enabled), stamp, stamp),
                )
            db.execute(
                "DELETE FROM scheduling_professionals WHERE tenant_id=? AND workspace_id=?",
                (scope[0], scope[1]),
            )
            for user_id, item in requested.items():
                member = members[user_id]
                db.execute(
                    "INSERT INTO scheduling_professionals VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                    (
                        scope[0], scope[1], user_id,
                        str(member.get("nome") or member.get("email") or "Profissional"),
                        str(member.get("fotoUrl") or ""), item.profession.strip(),
                        item.position.strip() or str(member.get("jobTitle") or "Membro"),
                        item.color, int(item.active), stamp, stamp,
                    ),
                )
            db.execute(
                "DELETE FROM scheduling_service_professionals WHERE tenant_id=? AND workspace_id=? AND user_id NOT IN (SELECT user_id FROM scheduling_professionals WHERE tenant_id=? AND workspace_id=? AND active=1)",
                (scope[0], scope[1], scope[0], scope[1]),
            )
            self.repo.audit(db, scope, "team_scheduling_updated", "team_settings", scope[0], {"enabled": payload.enabled})
        return self.team_settings(scope)

    def create_service(self, scope: tuple[str, str, str], payload: ServicePayload) -> dict[str, Any]:
        stamp, entity_id = now_iso(), opaque_id("svc")
        data = payload.model_dump()
        with self.repo.transaction() as db:
            db.execute("""INSERT INTO scheduling_services
              (id,tenant_id,workspace_id,owner_id,name,description,durations_json,color,location_type,location,instructions,buffer_before,buffer_after,capacity,minimum_notice_minutes,maximum_days,slot_interval,active,created_at,updated_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""", (
                entity_id, *scope, data["name"].strip(), data["description"].strip(), json.dumps(data["durations"]), data["color"],
                data["locationType"], data["location"].strip(), data["instructions"].strip(), data["bufferBefore"], data["bufferAfter"],
                data["capacity"], data["minimumNoticeMinutes"], data["maximumDays"], data["slotInterval"], int(data["active"]), stamp, stamp,
            ))
            self._replace_service_professionals(db, scope, entity_id, data["professionalIds"])
            self.repo.audit(db, scope, "service_created", "service", entity_id, {"name": data["name"]})
        return self.get_service(scope, entity_id)

    def get_service(self, scope: tuple[str, str, str], entity_id: str) -> dict[str, Any]:
        item = self.repo.one("SELECT * FROM scheduling_services WHERE id=? AND tenant_id=? AND workspace_id=? AND owner_id=? AND archived_at IS NULL", (entity_id, *scope))
        if not item:
            raise HTTPException(404, "Servico nao encontrado.")
        item["professionalIds"] = self.service_professional_ids(scope, entity_id)
        return item

    def update_service(self, scope: tuple[str, str, str], entity_id: str, payload: ServicePayload) -> dict[str, Any]:
        self.get_service(scope, entity_id)
        data = payload.model_dump()
        with self.repo.transaction() as db:
            db.execute("""UPDATE scheduling_services SET name=?,description=?,durations_json=?,color=?,location_type=?,location=?,instructions=?,buffer_before=?,buffer_after=?,capacity=?,minimum_notice_minutes=?,maximum_days=?,slot_interval=?,active=?,updated_at=? WHERE id=? AND tenant_id=? AND workspace_id=? AND owner_id=?""", (
                data["name"].strip(), data["description"].strip(), json.dumps(data["durations"]), data["color"], data["locationType"], data["location"].strip(), data["instructions"].strip(), data["bufferBefore"], data["bufferAfter"], data["capacity"], data["minimumNoticeMinutes"], data["maximumDays"], data["slotInterval"], int(data["active"]), now_iso(), entity_id, *scope,
            ))
            self._replace_service_professionals(db, scope, entity_id, data["professionalIds"])
            self.repo.audit(db, scope, "service_updated", "service", entity_id)
        return self.get_service(scope, entity_id)

    def archive_service(self, scope: tuple[str, str, str], entity_id: str) -> dict[str, Any]:
        service = self.get_service(scope, entity_id)
        stamp = now_iso()
        with self.repo.transaction() as db:
            active_pages = db.execute(
                "SELECT COUNT(*) FROM scheduling_pages WHERE service_id=? AND tenant_id=? AND workspace_id=? AND owner_id=? AND archived_at IS NULL",
                (entity_id, *scope),
            ).fetchone()[0]
            active_bookings = db.execute(
                "SELECT COUNT(*) FROM scheduling_bookings WHERE service_id=? AND tenant_id=? AND workspace_id=? AND owner_id=? AND status IN ('PENDING','CONFIRMED')",
                (entity_id, *scope),
            ).fetchone()[0]
            db.execute(
                "UPDATE scheduling_services SET active=0,archived_at=?,updated_at=? WHERE id=? AND tenant_id=? AND workspace_id=? AND owner_id=?",
                (stamp, stamp, entity_id, *scope),
            )
            self.repo.audit(db, scope, "service_archived", "service", entity_id, {"activePages": active_pages, "activeBookings": active_bookings})
        archived = dict(service)
        archived["active"] = False
        archived["archived_at"] = stamp
        return {"service": archived, "activePages": active_pages, "activeBookings": active_bookings}

    def set_availability(self, scope: tuple[str, str, str], payload: AvailabilityPayload) -> dict[str, Any]:
        if payload.serviceId:
            self.get_service(scope, payload.serviceId)
        availability_owner = payload.responsibleId or scope[2]
        if payload.responsibleId:
            self._validate_professional(scope[0], scope[1], payload.serviceId, availability_owner)
        item_id, stamp = opaque_id("avail"), now_iso()
        with self.repo.transaction() as db:
            existing = db.execute("SELECT id FROM scheduling_availability WHERE tenant_id=? AND workspace_id=? AND owner_id=? AND service_id IS ?", (scope[0], scope[1], availability_owner, payload.serviceId)).fetchone()
            if existing:
                item_id = existing["id"]
                db.execute("UPDATE scheduling_availability SET timezone=?,weekly_json=?,exceptions_json=?,blocked_json=?,updated_at=? WHERE id=?", (payload.timezone, json.dumps({k:[p.model_dump() for p in v] for k,v in payload.weekly.items()}), json.dumps({k:[p.model_dump() for p in v] for k,v in payload.exceptions.items()}), json.dumps([p.model_dump() for p in payload.blocked]), stamp, item_id))
            else:
                db.execute("INSERT INTO scheduling_availability VALUES (?,?,?,?,?,?,?,?,?,?,?)", (item_id, scope[0], scope[1], availability_owner, payload.serviceId, payload.timezone, json.dumps({k:[p.model_dump() for p in v] for k,v in payload.weekly.items()}), json.dumps({k:[p.model_dump() for p in v] for k,v in payload.exceptions.items()}), json.dumps([p.model_dump() for p in payload.blocked]), stamp, stamp))
            self.repo.audit(db, scope, "availability_updated", "availability", item_id, {"serviceId": payload.serviceId})
        return self.get_availability(scope, payload.serviceId, availability_owner)

    def get_availability(self, scope: tuple[str, str, str], service_id: str | None, responsible_id: str | None = None) -> dict[str, Any]:
        owner_id = responsible_id or scope[2]
        item = self.repo.one("SELECT * FROM scheduling_availability WHERE tenant_id=? AND workspace_id=? AND owner_id=? AND service_id IS ?", (scope[0], scope[1], owner_id, service_id))
        if not item:
            return {"service_id": service_id, "responsible_id": owner_id, "timezone": "America/Sao_Paulo", "weekly": {}, "exceptions": {}, "blocked": []}
        return item

    def create_page(self, scope: tuple[str, str, str], payload: PagePayload) -> dict[str, Any]:
        self.get_service(scope, payload.serviceId)
        stamp, entity_id = now_iso(), opaque_id("page")
        try:
            with self.repo.transaction() as db:
                db.execute("""INSERT INTO scheduling_pages
                  (id,public_id,tenant_id,workspace_id,owner_id,service_id,slug,title,description,theme_json,fields_json,logo_url,active,created_at,updated_at)
                  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""", (entity_id, public_id(), *scope, payload.serviceId, payload.slug, payload.title.strip(), payload.description.strip(), json.dumps(payload.theme), json.dumps([f.model_dump() for f in payload.fields]), payload.logoUrl, int(payload.active), stamp, stamp))
                self.repo.audit(db, scope, "page_created", "page", entity_id, {"title": payload.title})
        except Exception as exc:
            if not self.repo.is_integrity_error(exc):
                raise
            raise HTTPException(409, "Slug ou identificador publico ja esta em uso.") from exc
        return self.get_page(scope, entity_id)

    def get_page(self, scope: tuple[str, str, str], entity_id: str) -> dict[str, Any]:
        item = self.repo.one("SELECT * FROM scheduling_pages WHERE id=? AND tenant_id=? AND workspace_id=? AND owner_id=? AND archived_at IS NULL", (entity_id, *scope))
        if not item:
            raise HTTPException(404, "Pagina nao encontrada.")
        return item

    def list_pages(self, scope: tuple[str, str, str]) -> list[dict[str, Any]]:
        return self.repo.all("SELECT * FROM scheduling_pages WHERE tenant_id=? AND workspace_id=? AND owner_id=? AND archived_at IS NULL ORDER BY created_at DESC", scope)

    def update_page(self, scope: tuple[str, str, str], entity_id: str, payload: PagePayload) -> dict[str, Any]:
        self.get_page(scope, entity_id)
        self.get_service(scope, payload.serviceId)
        try:
            with self.repo.transaction() as db:
                db.execute("""UPDATE scheduling_pages SET service_id=?,slug=?,title=?,description=?,theme_json=?,fields_json=?,logo_url=?,active=?,updated_at=?
                  WHERE id=? AND tenant_id=? AND workspace_id=? AND owner_id=?""", (payload.serviceId, payload.slug, payload.title.strip(), payload.description.strip(), json.dumps(payload.theme), json.dumps([f.model_dump() for f in payload.fields]), payload.logoUrl, int(payload.active), now_iso(), entity_id, *scope))
                self.repo.audit(db, scope, "page_updated", "page", entity_id)
        except Exception as exc:
            if not self.repo.is_integrity_error(exc):
                raise
            raise HTTPException(409, "Slug ja esta em uso.") from exc
        return self.get_page(scope, entity_id)

    def archive_page(self, scope: tuple[str, str, str], entity_id: str) -> None:
        self.get_page(scope, entity_id)
        with self.repo.transaction() as db:
            db.execute("UPDATE scheduling_pages SET active=0,archived_at=?,updated_at=? WHERE id=? AND tenant_id=? AND workspace_id=? AND owner_id=?", (now_iso(), now_iso(), entity_id, *scope))
            self.repo.audit(db, scope, "page_archived", "page", entity_id)

    def upload_logo(self, scope: tuple[str, str, str], entity_id: str, encoded: str) -> dict[str, str]:
        page = self.get_page(scope, entity_id)
        try:
            raw = base64.b64decode(encoded, validate=True)
        except (ValueError, binascii.Error) as exc:
            raise HTTPException(422, "Logo em base64 invalido.") from exc
        if not 1 <= len(raw) <= 2_000_000:
            raise HTTPException(413, "Logo deve possuir no maximo 2 MB.")
        signatures = ((b"\x89PNG\r\n\x1a\n", "png", "image/png"), (b"\xff\xd8\xff", "jpg", "image/jpeg"), (b"RIFF", "webp", "image/webp"))
        match = next(((extension, mime) for signature, extension, mime in signatures if raw.startswith(signature) and (extension != "webp" or raw[8:12] == b"WEBP")), None)
        if not match:
            raise HTTPException(422, "Formato real do logo deve ser PNG, JPEG ou WebP.")
        extension, mime = match
        from app.infrastructure.persistence import postgres_store
        object_key = f"{scope[0]}/{scope[1]}/scheduling/logo/{entity_id}"
        if postgres_store.configured() or postgres_store.required():
            postgres_store.write_blob(object_key, raw, mime, {"extension": extension, "tenant": scope[0], "workspace": scope[1]})
        else:
            folder = get_user_dir(scope[0]) / "scheduling_assets"; folder.mkdir(parents=True, exist_ok=True)
            target = folder / f"{entity_id}.{extension}"; target.write_bytes(raw)
        url = f"/api/public/scheduling/pages/{page['public_id']}/logo?v={hashlib.sha256(raw).hexdigest()[:16]}"
        with self.repo.transaction() as db:
            db.execute("UPDATE scheduling_pages SET logo_url=?,updated_at=? WHERE id=? AND tenant_id=? AND workspace_id=? AND owner_id=?", (url, now_iso(), entity_id, *scope))
            self.repo.audit(db, scope, "page_logo_updated", "page", entity_id, {"mime": mime, "size": len(raw)})
        return {"logoUrl": url, "mime": mime}

    def logo_asset(self, identifier: str) -> tuple[bytes | str, str]:
        page = self.public_page(identifier)["page"]
        from app.infrastructure.persistence import postgres_store
        if postgres_store.configured() or postgres_store.required():
            blob = postgres_store.read_blob(f"{page['tenant_id']}/{page['workspace_id']}/scheduling/logo/{page['id']}")
            if blob:
                return bytes(blob["content"]), str(blob["content_type"])
            raise HTTPException(404, "Logo nao encontrado.")
        folder = get_user_dir(page["tenant_id"]) / "scheduling_assets"
        for extension, mime in (("png", "image/png"), ("jpg", "image/jpeg"), ("webp", "image/webp")):
            candidate = folder / f"{page['id']}.{extension}"
            if candidate.is_file(): return str(candidate), mime
        raise HTTPException(404, "Logo nao encontrado.")

    def public_page(self, identifier: str) -> dict[str, Any]:
        page = self.repo.one("SELECT * FROM scheduling_pages WHERE (public_id=? OR slug=?) AND active=1 AND archived_at IS NULL", (identifier, identifier))
        if not page:
            raise HTTPException(404, "Pagina de agendamento nao encontrada.")
        service = self.repo.one("SELECT * FROM scheduling_services WHERE id=? AND active=1 AND archived_at IS NULL", (page["service_id"],))
        if not service:
            raise HTTPException(404, "Servico indisponivel.")
        setting = self.repo.one(
            "SELECT enabled FROM scheduling_team_settings WHERE tenant_id=? AND workspace_id=?",
            (page["tenant_id"], page["workspace_id"]),
        )
        team_enabled = bool(setting and setting.get("enabled"))
        services = [service]
        professionals: list[dict[str, Any]] = []
        if team_enabled:
            services = self.repo.all(
                "SELECT * FROM scheduling_services WHERE tenant_id=? AND workspace_id=? AND active=1 AND archived_at IS NULL ORDER BY name",
                (page["tenant_id"], page["workspace_id"]),
            )
            for item in services:
                item["professionalIds"] = [
                    str(link["user_id"])
                    for link in self.repo.all(
                        "SELECT user_id FROM scheduling_service_professionals WHERE tenant_id=? AND workspace_id=? AND service_id=? ORDER BY user_id",
                        (page["tenant_id"], page["workspace_id"], item["id"]),
                    )
                ]
            valid_ids = {user_id for item in services for user_id in item.get("professionalIds", [])}
            professionals = [
                {
                    "id": item["user_id"], "name": item["display_name"],
                    "avatarUrl": item.get("avatar_url") or "", "profession": item.get("profession") or "",
                    "position": item.get("position") or "", "color": item.get("color") or "#6d5dfc",
                }
                for item in self.repo.all(
                    "SELECT * FROM scheduling_professionals WHERE tenant_id=? AND workspace_id=? AND active=1 ORDER BY display_name",
                    (page["tenant_id"], page["workspace_id"]),
                )
                if str(item["user_id"]) in valid_ids
            ]
        return {"page": page, "service": service, "services": services, "professionals": professionals, "teamMode": team_enabled}

    def _availability_for_page(self, page: dict[str, Any], service_id: str | None = None, responsible_id: str | None = None) -> dict[str, Any]:
        resolved_service = service_id or page["service_id"]
        resolved_owner = responsible_id or page["owner_id"]
        specific = self.repo.one("SELECT * FROM scheduling_availability WHERE tenant_id=? AND workspace_id=? AND owner_id=? AND service_id=?", (page["tenant_id"], page["workspace_id"], resolved_owner, resolved_service))
        if specific:
            return specific
        return self.repo.one("SELECT * FROM scheduling_availability WHERE tenant_id=? AND workspace_id=? AND owner_id=? AND service_id IS NULL", (page["tenant_id"], page["workspace_id"], resolved_owner)) or {"timezone":"America/Sao_Paulo","weekly":{},"exceptions":{},"blocked":[]}

    def _validate_professional(self, tenant_id: str, workspace_id: str, service_id: str | None, user_id: str) -> None:
        professional = self.repo.one(
            "SELECT 1 AS ok FROM scheduling_professionals WHERE tenant_id=? AND workspace_id=? AND user_id=? AND active=1",
            (tenant_id, workspace_id, user_id),
        )
        if not professional:
            raise HTTPException(422, "Profissional nao pertence a esta agenda.")
        if service_id:
            linked = self.repo.one(
                "SELECT 1 AS ok FROM scheduling_service_professionals WHERE tenant_id=? AND workspace_id=? AND service_id=? AND user_id=?",
                (tenant_id, workspace_id, service_id, user_id),
            )
            if not linked:
                raise HTTPException(422, "Profissional nao presta este servico.")

    def _resolve_public_selection(self, page: dict[str, Any], service_id: str | None, responsible_id: str | None) -> tuple[dict[str, Any], str]:
        setting = self.repo.one(
            "SELECT enabled FROM scheduling_team_settings WHERE tenant_id=? AND workspace_id=?",
            (page["tenant_id"], page["workspace_id"]),
        )
        team_enabled = bool(setting and setting.get("enabled"))
        resolved_service_id = service_id or page["service_id"]
        service = self.repo.one(
            "SELECT * FROM scheduling_services WHERE id=? AND tenant_id=? AND workspace_id=? AND active=1 AND archived_at IS NULL",
            (resolved_service_id, page["tenant_id"], page["workspace_id"]),
        )
        if not service:
            raise HTTPException(404, "Servico indisponivel.")
        if team_enabled:
            if not responsible_id:
                raise HTTPException(422, "Selecione um profissional.")
            self._validate_professional(page["tenant_id"], page["workspace_id"], service["id"], responsible_id)
            return service, responsible_id
        responsible = responsible_id or page["owner_id"]
        if responsible != page["owner_id"] or resolved_service_id != page["service_id"]:
            raise HTTPException(422, "Selecao nao pertence a esta pagina.")
        return service, responsible

    @staticmethod
    def _overlap(start: datetime, end: datetime, item_start: str, item_end: str) -> bool:
        return start < parse_utc(item_end) and end > parse_utc(item_start)

    @staticmethod
    def _fits_availability(start: datetime, end: datetime, availability: dict[str, Any], service: dict[str, Any]) -> bool:
        zone = ZoneInfo(availability["timezone"])
        local_start, local_end = start.astimezone(zone), end.astimezone(zone)
        if local_start.date() != local_end.date():
            return False
        periods = availability.get("exceptions", {}).get(local_start.date().isoformat())
        if periods is None:
            periods = availability.get("weekly", {}).get(str(local_start.weekday()), [])
        inside = any(
            time.fromisoformat(period["start"]) <= local_start.time().replace(tzinfo=None)
            and local_end.time().replace(tzinfo=None) <= time.fromisoformat(period["end"])
            for period in periods
        )
        now = datetime.now(timezone.utc)
        return inside and start >= now + timedelta(minutes=service["minimum_notice_minutes"]) and start <= now + timedelta(days=service["maximum_days"])

    def available_slots(self, identifier: str, day: date, duration: int, *, bundle: dict[str, Any] | None = None, responsible_id: str | None = None, service_id: str | None = None) -> dict[str, Any]:
        resolved = bundle or self.public_page(identifier)
        page = resolved["page"]
        service, responsible = self._resolve_public_selection(page, service_id, responsible_id)
        if duration not in service["durations"]:
            raise HTTPException(422, "Duracao nao permitida.")
        availability = self._availability_for_page(page, service["id"], responsible)
        zone = ZoneInfo(availability["timezone"])
        periods = availability.get("exceptions", {}).get(day.isoformat())
        if periods is None:
            periods = availability.get("weekly", {}).get(str(day.weekday()), [])
        now = datetime.now(timezone.utc)
        latest = now + timedelta(days=service["maximum_days"])
        step = timedelta(minutes=service["slot_interval"])
        result: list[dict[str, Any]] = []
        connection = self.repo.connect()
        try:
            for period in periods:
                cursor = datetime.combine(day, time.fromisoformat(period["start"]), zone).astimezone(timezone.utc)
                period_end = datetime.combine(day, time.fromisoformat(period["end"]), zone).astimezone(timezone.utc)
                while cursor + timedelta(minutes=duration) <= period_end:
                    end = cursor + timedelta(minutes=duration)
                    if cursor >= now + timedelta(minutes=service["minimum_notice_minutes"]) and cursor <= latest:
                        remaining = self.remaining_capacity(service, responsible, cursor, end, availability, db=connection)
                        if remaining > 0:
                            result.append({"startAt": cursor.isoformat(), "endAt": end.isoformat(), "remaining": remaining})
                    cursor += step
        finally:
            connection.close()
        return {"date": day.isoformat(), "timezone": availability["timezone"], "slots": result, "responsibleId": responsible, "serviceId": service["id"]}

    def remaining_capacity(self, service: dict[str, Any], responsible_id: str, start: datetime, end: datetime, availability: dict[str, Any], *, db: sqlite3.Connection | None = None, exclude_booking_id: str | None = None) -> int:
        blocked_start = start - timedelta(minutes=service["buffer_before"])
        blocked_end = end + timedelta(minutes=service["buffer_after"])
        if any(self._overlap(blocked_start, blocked_end, item["start"], item["end"]) for item in availability.get("blocked", [])):
            return 0
        connection = db or self.repo.connect()
        try:
            # Other services for the same professional remain exclusive.
            other = connection.execute("""SELECT 1 FROM scheduling_bookings b JOIN scheduling_services s ON s.id=b.service_id
              WHERE b.responsible_id=? AND b.status IN ('PENDING','CONFIRMED') AND b.service_id<>?
              AND datetime(b.start_at, '-' || s.buffer_before || ' minutes') < ?
              AND datetime(b.end_at, '+' || s.buffer_after || ' minutes') > ? LIMIT 1""", (responsible_id, service["id"], blocked_end.isoformat(), blocked_start.isoformat())).fetchone()
            if other:
                return 0
            if exclude_booking_id:
                count = connection.execute(
                    "SELECT COUNT(*) FROM scheduling_bookings WHERE service_id=? AND responsible_id=? AND start_at=? AND status IN ('PENDING','CONFIRMED') AND id<>?",
                    (service["id"], responsible_id, start.isoformat(), exclude_booking_id),
                ).fetchone()[0]
            else:
                count = connection.execute(
                    "SELECT COUNT(*) FROM scheduling_bookings WHERE service_id=? AND responsible_id=? AND start_at=? AND status IN ('PENDING','CONFIRMED')",
                    (service["id"], responsible_id, start.isoformat()),
                ).fetchone()[0]
            holds = connection.execute("SELECT COUNT(*) FROM scheduling_holds WHERE service_id=? AND responsible_id=? AND start_at=? AND consumed_at IS NULL AND expires_at>?", (service["id"], responsible_id, start.isoformat(), now_iso())).fetchone()[0]
            if exclude_booking_id:
                overlapping = connection.execute("""SELECT 1 FROM scheduling_bookings
                  WHERE service_id=? AND responsible_id=? AND start_at<>? AND status IN ('PENDING','CONFIRMED') AND id<>?
                  AND start_at < ? AND end_at > ? LIMIT 1""", (service["id"], responsible_id, start.isoformat(), exclude_booking_id, blocked_end.isoformat(), blocked_start.isoformat())).fetchone()
            else:
                overlapping = connection.execute("""SELECT 1 FROM scheduling_bookings
                  WHERE service_id=? AND responsible_id=? AND start_at<>? AND status IN ('PENDING','CONFIRMED')
                  AND start_at < ? AND end_at > ? LIMIT 1""", (service["id"], responsible_id, start.isoformat(), blocked_end.isoformat(), blocked_start.isoformat())).fetchone()
            overlapping_hold = connection.execute("""SELECT 1 FROM scheduling_holds
              WHERE service_id=? AND responsible_id=? AND start_at<>? AND consumed_at IS NULL AND expires_at>?
              AND start_at < ? AND end_at > ? LIMIT 1""", (service["id"], responsible_id, start.isoformat(), now_iso(), blocked_end.isoformat(), blocked_start.isoformat())).fetchone()
            if overlapping or overlapping_hold:
                return 0
            return max(service["capacity"] - count - holds, 0)
        finally:
            if db is None:
                connection.close()

    def create_hold(self, identifier: str, payload: HoldPayload) -> dict[str, Any]:
        bundle = self.public_page(identifier)
        page = bundle["page"]
        service, responsible = self._resolve_public_selection(page, payload.serviceId, payload.responsibleId)
        start = parse_utc(payload.startAt); end = start + timedelta(minutes=payload.duration)
        availability = self._availability_for_page(page, service["id"], responsible)
        if not self._fits_availability(start, end, availability, service):
            raise HTTPException(409, "Horario fora da disponibilidade.")
        raw, hashed = token_pair(); hold_id = opaque_id("hold")
        expires = datetime.now(timezone.utc) + timedelta(minutes=5)
        with self.repo.transaction() as db:
            self.repo.lock_slot(db, service["id"], responsible, start.isoformat())
            if self.remaining_capacity(service, responsible, start, end, availability, db=db) <= 0:
                raise HTTPException(409, "Horario indisponivel.")
            db.execute("INSERT INTO scheduling_holds VALUES (?,?,?,?,?,?,?,?,?,?)", (hold_id, hashed, page["id"], service["id"], responsible, start.isoformat(), end.isoformat(), expires.isoformat(), None, now_iso()))
        return {"holdToken": raw, "expiresAt": expires.isoformat()}

    def _validate_responses(self, fields: list[dict[str, Any]], responses: dict[str, Any]) -> dict[str, Any]:
        builtins = {"full_name", "email", "phone"}
        allowed = {field["id"]: field for field in fields if field["id"] not in builtins and field.get("active", True) and not field.get("hidden")}
        if set(responses) - set(allowed):
            raise HTTPException(422, "O formulario contem campos desconhecidos.")
        cleaned: dict[str, Any] = {}
        for key, field in allowed.items():
            value = responses.get(key)
            if field.get("required") and (value is None or value == "" or value == []):
                raise HTTPException(422, f"O campo {field['label']} e obrigatorio.")
            if value in (None, "", []):
                continue
            if field["type"] == "cpf":
                try: value = validate_cpf(str(value))
                except ValueError as exc: raise HTTPException(422, str(exc)) from exc
            elif field["type"] == "phone":
                digits = re.sub(r"\D", "", str(value))
                if not 8 <= len(digits) <= 15:
                    raise HTTPException(422, "Telefone invalido.")
                value = digits
            elif field["type"] == "email":
                value = str(value).strip().lower()
                if len(value) > 254 or not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", value): raise HTTPException(422, "Email invalido.")
            elif isinstance(value, str):
                maximum = int(field.get("maxLength") or (5000 if field["type"] == "textarea" else 500))
                if len(value) > maximum: raise HTTPException(422, f"O campo {field['label']} excede o limite.")
            cleaned[key] = value
        return cleaned

    def create_booking(self, identifier: str, payload: BookingPayload) -> dict[str, Any]:
        bundle = self.public_page(identifier); page = bundle["page"]
        service, responsible = self._resolve_public_selection(page, payload.serviceId, payload.responsibleId)
        if payload.duration not in service["durations"]: raise HTTPException(422, "Duracao nao permitida.")
        start = parse_utc(payload.startAt); end = start + timedelta(minutes=payload.duration)
        responses = self._validate_responses(page["fields"], payload.responses)
        cancel_raw, cancel_hash = token_pair(); reschedule_raw, reschedule_hash = token_pair()
        booking_id, booking_public = opaque_id("book"), public_id(); stamp = now_iso()
        availability = self._availability_for_page(page, service["id"], responsible)
        if not self._fits_availability(start, end, availability, service):
            raise HTTPException(409, "Horario fora da disponibilidade.")
        try:
            with self.repo.transaction() as db:
                self.repo.lock_slot(db, service["id"], responsible, start.isoformat())
                replay = db.execute("SELECT * FROM scheduling_bookings WHERE page_id=? AND idempotency_key=?", (page["id"], payload.idempotencyKey)).fetchone()
                if replay:
                    item = self.repo.decode(replay) or {}
                    return {"booking": self._public_booking(item), "idempotentReplay": True}
                if payload.holdToken:
                    hold = db.execute("SELECT * FROM scheduling_holds WHERE token_hash=? AND page_id=? AND consumed_at IS NULL AND expires_at>?", (token_hash(payload.holdToken), page["id"], stamp)).fetchone()
                    if not hold or hold["start_at"] != start.isoformat(): raise HTTPException(409, "Reserva temporaria invalida ou expirada.")
                    db.execute("UPDATE scheduling_holds SET consumed_at=? WHERE id=?", (stamp, hold["id"]))
                if self.remaining_capacity(service, responsible, start, end, availability, db=db) <= 0:
                    raise HTTPException(409, "Horario indisponivel.")
                db.execute("""INSERT INTO scheduling_bookings
                  (id,public_id,tenant_id,workspace_id,owner_id,responsible_id,service_id,page_id,start_at,end_at,timezone,status,attendee_name,attendee_email,attendee_phone,responses_json,source,cancel_token_hash,reschedule_token_hash,idempotency_key,created_at,updated_at)
                  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""", (booking_id, booking_public, page["tenant_id"], page["workspace_id"], page["owner_id"], responsible, service["id"], page["id"], start.isoformat(), end.isoformat(), payload.timezone, "CONFIRMED", payload.name.strip(), payload.email, payload.phone, json.dumps(responses, ensure_ascii=False), "public", cancel_hash, reschedule_hash, payload.idempotencyKey, stamp, stamp))
                self.repo.audit(db, (page["tenant_id"], page["workspace_id"], "public"), "booking_created", "booking", booking_id, {"serviceId": service["id"]})
        except Exception as exc:
            if not self.repo.is_integrity_error(exc):
                raise
            raise HTTPException(409, "Agendamento duplicado.") from exc
        item = self.repo.one("SELECT * FROM scheduling_bookings WHERE id=?", (booking_id,)) or {}
        return {"booking": self._public_booking(item), "cancelToken": cancel_raw, "rescheduleToken": reschedule_raw}

    @staticmethod
    def _public_booking(item: dict[str, Any]) -> dict[str, Any]:
        return {key: item.get(key) for key in ("id", "public_id", "owner_id", "responsible_id", "service_id", "page_id", "start_at", "end_at", "timezone", "status")}

    def list_bookings(self, scope: tuple[str, str, str]) -> list[dict[str, Any]]:
        return self.repo.all("""SELECT b.*, s.name AS service_name, p.display_name AS professional_name, p.color AS professional_color
          FROM scheduling_bookings b JOIN scheduling_services s ON s.id=b.service_id
          LEFT JOIN scheduling_professionals p ON p.tenant_id=b.tenant_id AND p.workspace_id=b.workspace_id AND p.user_id=b.responsible_id
          WHERE b.tenant_id=? AND b.workspace_id=? AND b.owner_id=? ORDER BY b.start_at DESC""", scope)

    def team_calendar(self, scope: tuple[str, str, str], start_at: str | None = None, end_at: str | None = None) -> list[dict[str, Any]]:
        query = """SELECT b.*, s.name AS service_name, s.color AS service_color,
          p.display_name AS professional_name, p.color AS professional_color, p.position AS professional_position
          FROM scheduling_bookings b JOIN scheduling_services s ON s.id=b.service_id
          LEFT JOIN scheduling_professionals p ON p.tenant_id=b.tenant_id AND p.workspace_id=b.workspace_id AND p.user_id=b.responsible_id
          WHERE b.tenant_id=? AND b.workspace_id=? AND b.owner_id=?"""
        params: list[Any] = list(scope)
        if start_at:
            query += " AND b.end_at>=?"
            params.append(parse_utc(start_at).isoformat())
        if end_at:
            query += " AND b.start_at<=?"
            params.append(parse_utc(end_at).isoformat())
        query += " ORDER BY b.start_at"
        return self.repo.all(query, tuple(params))

    def update_booking_status(self, scope: tuple[str, str, str], booking_id: str, status: str, completion_type: str | None = None) -> dict[str, Any]:
        allowed = {"PENDING", "CONFIRMED", "CANCELLED", "COMPLETED", "NO_SHOW"}
        if status not in allowed:
            raise HTTPException(422, "Status invalido.")
        if completion_type not in {None, "service", "meeting"} or (completion_type and status != "COMPLETED"):
            raise HTTPException(422, "Tipo de conclusão inválido.")
        with self.repo.transaction() as db:
            query = ("SELECT id,status,completion_type FROM scheduling_bookings WHERE id=? AND tenant_id=? AND workspace_id=? AND owner_id=? FOR UPDATE" if self.repo.postgres
                     else "SELECT id,status,completion_type FROM scheduling_bookings WHERE id=? AND tenant_id=? AND workspace_id=? AND owner_id=?")
            row = db.execute(query, (booking_id, *scope)).fetchone()
            if not row: raise HTTPException(404, "Agendamento nao encontrado.")
            if status == "COMPLETED" and row["status"] == "CANCELLED":
                raise HTTPException(409, "Um agendamento cancelado não pode ser marcado como realizado.")
            outcome = (completion_type or row["completion_type"]) if status == "COMPLETED" else None
            db.execute("UPDATE scheduling_bookings SET status=?,completion_type=?,updated_at=? WHERE id=?", (status, outcome, now_iso(), booking_id))
            self.repo.audit(db, scope, "booking_status_updated", "booking", booking_id, {"status": status, "completionType": outcome})
        return self.repo.one("SELECT * FROM scheduling_bookings WHERE id=? AND tenant_id=? AND workspace_id=? AND owner_id=?", (booking_id, *scope)) or {}

    def get_booking(self, scope: tuple[str, str, str], booking_id: str) -> dict[str, Any]:
        item = self.repo.one("SELECT * FROM scheduling_bookings WHERE id=? AND tenant_id=? AND workspace_id=? AND owner_id=?", (booking_id, *scope))
        if not item:
            raise HTTPException(404, "Agendamento nao encontrado.")
        return item

    def booking_context(self, scope: tuple[str, str, str], booking_id: str) -> dict[str, Any]:
        booking = self.get_booking(scope, booking_id)
        service = self.repo.one(
            "SELECT * FROM scheduling_services WHERE id=? AND tenant_id=? AND workspace_id=? AND owner_id=?",
            (booking["service_id"], *scope),
        )
        if not service:
            raise HTTPException(404, "Servico do agendamento nao encontrado.")
        return {"booking": booking, "service": service}

    def admin_reschedule(self, scope: tuple[str, str, str], booking_id: str, start_at: str, duration: int, responsible_id: str | None = None) -> dict[str, Any]:
        start = parse_utc(start_at); end = start + timedelta(minutes=duration); stamp = now_iso()
        with self.repo.transaction() as db:
            row = db.execute("SELECT * FROM scheduling_bookings WHERE id=? AND tenant_id=? AND workspace_id=? AND owner_id=?", (booking_id, *scope)).fetchone()
            if not row:
                raise HTTPException(404, "Agendamento nao encontrado.")
            booking = self.repo.decode(row) or {}
            if booking.get("status") == "CANCELLED":
                raise HTTPException(409, "Agendamento cancelado nao pode ser reagendado.")
            service = self.repo.decode(db.execute("SELECT * FROM scheduling_services WHERE id=?", (booking["service_id"],)).fetchone()) or {}
            page = self.repo.decode(db.execute("SELECT * FROM scheduling_pages WHERE id=?", (booking["page_id"],)).fetchone()) or {}
            if not service or service.get("archived_at") or not service.get("active"):
                raise HTTPException(409, "Servico indisponivel para reagendamento.")
            if not page:
                raise HTTPException(409, "Pagina do agendamento nao encontrada.")
            if duration not in service.get("durations", []):
                raise HTTPException(422, "Duracao nao permitida.")
            target_responsible = str(responsible_id or booking.get("responsible_id") or booking.get("owner_id") or "").strip()
            current_responsible = str(booking.get("responsible_id") or booking.get("owner_id") or "").strip()
            if target_responsible != current_responsible:
                professional = db.execute(
                    "SELECT 1 AS ok FROM scheduling_professionals WHERE tenant_id=? AND workspace_id=? AND user_id=? AND active=1",
                    (booking["tenant_id"], booking["workspace_id"], target_responsible),
                ).fetchone()
                linked = db.execute(
                    "SELECT 1 AS ok FROM scheduling_service_professionals WHERE tenant_id=? AND workspace_id=? AND service_id=? AND user_id=?",
                    (booking["tenant_id"], booking["workspace_id"], booking["service_id"], target_responsible),
                ).fetchone()
                if not professional:
                    raise HTTPException(422, "Profissional nao pertence a esta agenda.")
                if not linked:
                    raise HTTPException(422, "Profissional nao presta este servico.")
            if booking["start_at"] == start.isoformat() and booking["end_at"] == end.isoformat() and target_responsible == current_responsible:
                return {"booking": booking, "replay": True}
            availability = self._availability_for_page(page, booking["service_id"], target_responsible)
            if not self._fits_availability(start, end, availability, service):
                raise HTTPException(409, "Novo horario fora da disponibilidade.")
            if self.remaining_capacity(service, target_responsible, start, end, availability, db=db, exclude_booking_id=booking["id"]) <= 0:
                raise HTTPException(409, "Novo horario indisponivel.")
            db.execute("UPDATE scheduling_bookings SET start_at=?,end_at=?,responsible_id=?,status='CONFIRMED',updated_at=? WHERE id=?", (start.isoformat(), end.isoformat(), target_responsible, stamp, booking["id"]))
            self.repo.audit(db, scope, "booking_rescheduled", "booking", booking["id"], {"previousStart": booking["start_at"], "startAt": start.isoformat(), "duration": duration, "previousResponsibleId": current_responsible, "responsibleId": target_responsible})
        return {"booking": self.get_booking(scope, booking_id), "replay": False}

    @staticmethod
    def format_local(value_iso: str, timezone_name: str) -> str:
        return parse_utc(value_iso).astimezone(ZoneInfo(timezone_name)).strftime("%d/%m/%Y as %H:%M")

    @classmethod
    def render_reschedule_email(cls, *, service_name: str, attendee_name: str, old_start: str, new_start: str, timezone_name: str, previous_professional_name: str = "", new_professional_name: str = "", signature: str = "Equipe Norium") -> dict[str, str]:
        old_label = cls.format_local(old_start, timezone_name)
        new_label = cls.format_local(new_start, timezone_name)
        subject = f"Reagendamento: {service_name} em {new_label}"
        professional_changed = bool(previous_professional_name and new_professional_name and previous_professional_name != new_professional_name)
        professional_note = (
            f"O profissional responsavel tambem foi alterado de {previous_professional_name} para {new_professional_name}.\n\n"
            if professional_changed else (f"Profissional responsavel: {new_professional_name}.\n\n" if new_professional_name else "")
        )
        body = (
            f"Ola {attendee_name},\n\n"
            f"Entramos em contato para informar uma atualizacao importante no seu agendamento de {service_name}. "
            "Por uma necessidade de reorganizacao da agenda, precisamos realizar o reagendamento abaixo.\n\n"
            "Pedimos desculpas por qualquer inconveniente que essa mudanca possa causar e contamos com a sua compreensao.\n\n"
            f"Data e horario anteriores: {old_label} ({timezone_name})\n"
            f"Nova data e horario: {new_label} ({timezone_name})\n\n"
            f"{professional_note}"
            "Caso o novo horario ou a alteracao de profissional nao seja conveniente, responda esta mensagem para que possamos encontrar a melhor alternativa.\n\n"
            "Agradecemos pela compreensao e permanecemos a disposicao.\n\n"
            f"Atenciosamente,\n{signature}"
        )
        return {"subject": subject, "body": body}

    @classmethod
    def render_reschedule_whatsapp(cls, *, service_name: str, attendee_name: str, old_start: str, new_start: str, timezone_name: str, previous_professional_name: str = "", new_professional_name: str = "", signature: str = "Equipe Norium") -> str:
        old_label = cls.format_local(old_start, timezone_name)
        new_label = cls.format_local(new_start, timezone_name)
        professional_changed = bool(previous_professional_name and new_professional_name and previous_professional_name != new_professional_name)
        professional_note = f" O profissional responsavel mudou de {previous_professional_name} para {new_professional_name}." if professional_changed else (f" Profissional: {new_professional_name}." if new_professional_name else "")
        return (
            f"Ola {attendee_name}! Precisamos atualizar o seu agendamento de {service_name}. "
            "Pedimos desculpas por qualquer inconveniente e contamos com a sua compreensao. "
            f"Horario anterior: {old_label}. Novo horario: {new_label} ({timezone_name})."
            f"{professional_note} Se a mudanca nao for conveniente, responda esta mensagem para buscarmos outra alternativa. "
            f"Atenciosamente, {signature}."
        )

    def get_notification_attempt(self, scope: tuple[str, str, str], operation_key: str, channel: str) -> dict[str, Any] | None:
        scoped_key = self._notification_key(scope, operation_key)
        return self.repo.one(
            "SELECT * FROM scheduling_notification_attempts WHERE operation_key=? AND channel=? AND tenant_id=? AND workspace_id=? AND owner_id=?",
            (scoped_key, channel, *scope),
        )

    @staticmethod
    def _notification_key(scope: tuple[str, str, str], operation_key: str) -> str:
        raw = "\x1f".join((*scope, operation_key))
        return hashlib.sha256(raw.encode("utf-8")).hexdigest()

    def begin_notification_attempt(self, scope: tuple[str, str, str], operation_key: str, channel: str, booking_id: str) -> dict[str, Any]:
        """Reserva um envio antes do efeito externo.

        Um registro ``pending`` nunca e reenviado automaticamente: ele pode
        representar um timeout depois de o provedor ter aceitado a mensagem e
        exige conciliacao. Falhas deterministicas podem ser reivindicadas para
        uma nova tentativa. ``BEGIN IMMEDIATE`` serializa retries concorrentes.
        """
        scoped_key, stamp = self._notification_key(scope, operation_key), now_iso()
        with self.repo.transaction() as db:
            row = db.execute(
                "SELECT * FROM scheduling_notification_attempts WHERE operation_key=? AND channel=? AND tenant_id=? AND workspace_id=? AND owner_id=?",
                (scoped_key, channel, *scope),
            ).fetchone()
            current = self.repo.decode(row)
            if current:
                if current.get("booking_id") != booking_id:
                    raise HTTPException(409, "A chave de operacao ja pertence a outro agendamento.")
                if current.get("status") in {"sent", "pending"}:
                    return {"claimed": False, "attempt": current}
                db.execute(
                    "UPDATE scheduling_notification_attempts SET status='pending',receipt_json='{}',error='',updated_at=? WHERE operation_key=? AND channel=? AND tenant_id=? AND workspace_id=? AND owner_id=? AND status='failed'",
                    (stamp, scoped_key, channel, *scope),
                )
                self.repo.audit(db, scope, f"booking_notify_{channel}_retry_started", "booking", booking_id)
                return {"claimed": True, "attempt": {**current, "status": "pending", "receipt": {}, "error": ""}}
            db.execute(
                """INSERT INTO scheduling_notification_attempts
                   (operation_key, channel, tenant_id, workspace_id, owner_id, booking_id, status, receipt_json, error, created_at, updated_at)
                   VALUES (?,?,?,?,?,?, 'pending','{}','',?,?)""",
                (scoped_key, channel, *scope, booking_id, stamp, stamp),
            )
            self.repo.audit(db, scope, f"booking_notify_{channel}_started", "booking", booking_id)
        return {"claimed": True, "attempt": {"status": "pending", "receipt": {}, "error": ""}}

    def save_notification_attempt(self, scope: tuple[str, str, str], operation_key: str, channel: str, booking_id: str, status: str, receipt: dict[str, Any] | None = None, error: str = "") -> dict[str, Any]:
        stamp = now_iso()
        scoped_key = self._notification_key(scope, operation_key)
        payload = json.dumps(receipt or {}, ensure_ascii=False)
        with self.repo.transaction() as db:
            db.execute(
                """INSERT INTO scheduling_notification_attempts
                   (operation_key, channel, tenant_id, workspace_id, owner_id, booking_id, status, receipt_json, error, created_at, updated_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?)
                   ON CONFLICT(operation_key, channel) DO UPDATE SET status=excluded.status, receipt_json=excluded.receipt_json, error=excluded.error, updated_at=excluded.updated_at""",
                (scoped_key, channel, *scope, booking_id, status, payload, error[:500], stamp, stamp),
            )
            self.repo.audit(db, scope, f"booking_notify_{channel}_{status}", "booking", booking_id, {"operationKeyHash": scoped_key})
        return self.get_notification_attempt(scope, operation_key, channel) or {}

    def attach_external_event(self, booking_public_id: str, event_id: str) -> None:
        with self.repo.transaction() as db:
            db.execute("UPDATE scheduling_bookings SET external_event_id=?,updated_at=? WHERE public_id=?", (event_id, now_iso(), booking_public_id))

    def cancel(self, token: str) -> dict[str, Any]:
        stamp = now_iso()
        with self.repo.transaction() as db:
            row = db.execute("SELECT * FROM scheduling_bookings WHERE cancel_token_hash=?", (token_hash(token),)).fetchone()
            if not row: raise HTTPException(404, "Link de cancelamento invalido.")
            if row["status"] == "CANCELLED": return {"status": "CANCELLED", "idempotentReplay": True}
            if row["status"] in {"COMPLETED", "NO_SHOW"}:
                raise HTTPException(409, "Este atendimento já foi encerrado. Contate o responsável.")
            db.execute("UPDATE scheduling_bookings SET status='CANCELLED',updated_at=? WHERE id=?", (stamp, row["id"]))
            self.repo.audit(db, (row["tenant_id"], row["workspace_id"], "public"), "booking_cancelled", "booking", row["id"])
        return {"status": "CANCELLED"}

    def reschedule(self, token: str, start_at: str, duration: int) -> dict[str, Any]:
        start = parse_utc(start_at); end = start + timedelta(minutes=duration); stamp = now_iso()
        with self.repo.transaction() as db:
            row = db.execute("SELECT * FROM scheduling_bookings WHERE reschedule_token_hash=?", (token_hash(token),)).fetchone()
            if not row: raise HTTPException(404, "Link de reagendamento invalido.")
            if row["status"] in {"COMPLETED", "NO_SHOW"}:
                raise HTTPException(409, "Este atendimento já foi encerrado. Contate o responsável.")
            service = self.repo.decode(db.execute("SELECT * FROM scheduling_services WHERE id=?", (row["service_id"],)).fetchone()) or {}
            page = self.repo.decode(db.execute("SELECT * FROM scheduling_pages WHERE id=?", (row["page_id"],)).fetchone()) or {}
            if duration not in service.get("durations", []): raise HTTPException(422, "Duracao nao permitida.")
            availability = self._availability_for_page(page, row["service_id"], row["responsible_id"])
            if not self._fits_availability(start, end, availability, service):
                raise HTTPException(409, "Novo horario fora da disponibilidade.")
            db.execute("UPDATE scheduling_bookings SET status='RESCHEDULED' WHERE id=?", (row["id"],))
            if self.remaining_capacity(service, row["responsible_id"], start, end, availability, db=db) <= 0:
                raise HTTPException(409, "Novo horario indisponivel.")
            db.execute("UPDATE scheduling_bookings SET start_at=?,end_at=?,status='CONFIRMED',updated_at=? WHERE id=?", (start.isoformat(), end.isoformat(), stamp, row["id"]))
            self.repo.audit(db, (row["tenant_id"], row["workspace_id"], "public"), "booking_rescheduled", "booking", row["id"])
        return {"status": "CONFIRMED", "startAt": start.isoformat(), "endAt": end.isoformat()}
