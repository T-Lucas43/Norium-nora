from __future__ import annotations

import re
from typing import Any, Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import Field, field_validator, model_validator

from app.shared.schemas import StrictModel

HEX_COLOR = re.compile(r"^#[0-9a-fA-F]{6}$")
SLUG = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$")
EMAIL = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")


def contrast_ratio(first: str, second: str) -> float:
    def luminance(color: str) -> float:
        values = [int(color[index:index + 2], 16) / 255 for index in (1, 3, 5)]
        channels = [value / 12.92 if value <= .04045 else ((value + .055) / 1.055) ** 2.4 for value in values]
        return .2126 * channels[0] + .7152 * channels[1] + .0722 * channels[2]
    light, dark = sorted((luminance(first), luminance(second)), reverse=True)
    return (light + .05) / (dark + .05)


def validate_timezone(value: str) -> str:
    try:
        ZoneInfo(value)
    except ZoneInfoNotFoundError as exc:
        raise ValueError("Timezone IANA invalido.") from exc
    return value


class Period(StrictModel):
    start: str = Field(pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    end: str = Field(pattern=r"^([01]\d|2[0-3]):[0-5]\d$")

    @model_validator(mode="after")
    def ordered(self):
        if self.start >= self.end:
            raise ValueError("O fim deve ser posterior ao inicio.")
        return self


class BlockedPeriod(StrictModel):
    start: str
    end: str
    reason: str = Field(default="", max_length=160)


class AvailabilityPayload(StrictModel):
    serviceId: str | None = Field(default=None, max_length=80)
    timezone: str = "America/Sao_Paulo"
    weekly: dict[str, list[Period]] = Field(default_factory=dict)
    exceptions: dict[str, list[Period]] = Field(default_factory=dict)
    blocked: list[BlockedPeriod] = Field(default_factory=list, max_length=500)

    @field_validator("timezone")
    @classmethod
    def timezone_known(cls, value: str) -> str:
        return validate_timezone(value)

    @field_validator("weekly")
    @classmethod
    def weekdays_known(cls, value: dict[str, list[Period]]):
        allowed = {"0", "1", "2", "3", "4", "5", "6"}
        if set(value) - allowed:
            raise ValueError("Dia da semana invalido.")
        if any(len(periods) > 8 for periods in value.values()):
            raise ValueError("Limite de periodos por dia excedido.")
        return value


class ServicePayload(StrictModel):
    name: str = Field(min_length=1, max_length=120)
    description: str = Field(default="", max_length=2000)
    durations: list[int] = Field(default_factory=lambda: [30], min_length=1, max_length=12)
    color: str = "#6d5dfc"
    locationType: Literal["online", "in_person", "phone"] = "online"
    location: str = Field(default="", max_length=500)
    instructions: str = Field(default="", max_length=2000)
    bufferBefore: int = Field(default=0, ge=0, le=1440)
    bufferAfter: int = Field(default=0, ge=0, le=1440)
    capacity: int = Field(default=1, ge=1, le=500)
    minimumNoticeMinutes: int = Field(default=0, ge=0, le=525600)
    maximumDays: int = Field(default=60, ge=1, le=730)
    slotInterval: int = Field(default=15, ge=5, le=1440)
    active: bool = True

    @field_validator("durations")
    @classmethod
    def valid_durations(cls, value: list[int]):
        unique = sorted(set(value))
        if any(item < 5 or item > 1440 for item in unique):
            raise ValueError("Duracoes devem estar entre 5 e 1440 minutos.")
        return unique

    @field_validator("color")
    @classmethod
    def valid_color(cls, value: str):
        if not HEX_COLOR.fullmatch(value):
            raise ValueError("Cor hexadecimal invalida.")
        return value.lower()


FieldType = Literal["full_name", "first_name", "last_name", "email", "phone", "cpf", "cnpj", "date", "datetime", "time", "address", "text", "textarea", "number", "select", "multiselect", "checkbox", "radio", "boolean"]


class BookingField(StrictModel):
    id: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")
    type: FieldType
    label: str = Field(min_length=1, max_length=120)
    placeholder: str = Field(default="", max_length=160)
    description: str = Field(default="", max_length=500)
    required: bool = False
    active: bool = True
    hidden: bool = False
    minLength: int | None = Field(default=None, ge=0, le=5000)
    maxLength: int | None = Field(default=None, ge=1, le=5000)
    options: list[str] = Field(default_factory=list, max_length=100)


class PagePayload(StrictModel):
    serviceId: str = Field(min_length=1, max_length=80)
    title: str = Field(min_length=1, max_length=120)
    description: str = Field(default="", max_length=2000)
    slug: str | None = Field(default=None, max_length=64)
    fields: list[BookingField] = Field(default_factory=list, max_length=50)
    theme: dict[str, Any] = Field(default_factory=dict)
    logoUrl: str | None = Field(default=None, max_length=1000)
    active: bool = True

    @field_validator("slug")
    @classmethod
    def valid_slug(cls, value: str | None):
        if value and not SLUG.fullmatch(value):
            raise ValueError("Slug invalido.")
        return value

    @field_validator("theme")
    @classmethod
    def valid_theme(cls, value: dict[str, Any]):
        allowed = {"primary", "secondary", "accent", "background", "text", "mode"}
        cleaned = {key: item for key, item in value.items() if key in allowed}
        for key, item in cleaned.items():
            if key != "mode" and (not isinstance(item, str) or not HEX_COLOR.fullmatch(item)):
                raise ValueError(f"Cor {key} invalida.")
        if cleaned.get("mode") not in (None, "light", "dark", "auto"):
            raise ValueError("Modo de tema invalido.")
        if cleaned.get("background") and cleaned.get("text") and contrast_ratio(cleaned["background"], cleaned["text"]) < 4.5:
            raise ValueError("As cores de fundo e texto nao possuem contraste acessivel.")
        return cleaned


class HoldPayload(StrictModel):
    startAt: str
    duration: int = Field(ge=5, le=1440)
    responsibleId: str | None = Field(default=None, max_length=80)


class BookingPayload(HoldPayload):
    name: str = Field(min_length=1, max_length=160)
    email: str = Field(min_length=3, max_length=254)
    phone: str | None = Field(default=None, max_length=32)
    timezone: str = "America/Sao_Paulo"
    responses: dict[str, Any] = Field(default_factory=dict)
    holdToken: str | None = Field(default=None, max_length=200)
    idempotencyKey: str = Field(min_length=8, max_length=128)
    honeypot: str = Field(default="", max_length=0)

    @field_validator("email")
    @classmethod
    def valid_email(cls, value: str):
        normalized = value.strip().lower()
        if not EMAIL.fullmatch(normalized):
            raise ValueError("Email invalido.")
        return normalized

    @field_validator("timezone")
    @classmethod
    def timezone_known(cls, value: str) -> str:
        return validate_timezone(value)

    @field_validator("phone")
    @classmethod
    def normalize_phone(cls, value: str | None):
        if not value:
            return None
        prefix = "+" if value.strip().startswith("+") else ""
        digits = re.sub(r"\D", "", value)
        if not 8 <= len(digits) <= 15:
            raise ValueError("Telefone invalido.")
        return prefix + digits


class CancelPayload(StrictModel):
    token: str = Field(min_length=32, max_length=200)
    reason: str = Field(default="", max_length=500)


class ReschedulePayload(StrictModel):
    token: str = Field(min_length=32, max_length=200)
    startAt: str
    duration: int = Field(ge=5, le=1440)


class LogoPayload(StrictModel):
    dataBase64: str = Field(min_length=16, max_length=2_800_000)
