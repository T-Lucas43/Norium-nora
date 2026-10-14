"""Minimização local dos logs; nunca altera os dados usados pela aplicação."""
from __future__ import annotations

import logging
import re
from typing import Any
from urllib.parse import urlsplit

from app.core.ai_guardrails import minimize_for_ai

_EMAIL = re.compile(r"[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}", re.I)
_PHONE = re.compile(r"(?<!\w)(?:\+?55[\s().-]*)?(?:\(?\d{2}\)?[\s.-]*)?\d{4,5}[\s.-]?\d{4}(?!\w)")
_SECRET = re.compile(r"([?&](?:secret|token|key|code|password)=)[^&#\s\"']*", re.I)
_SENSITIVE = re.compile(r"token|secret|password|senha|credential|cookie|authorization|body|conteudo|content|prompt|messagebody", re.I)


def mask_text(value: Any) -> str:
    text = minimize_for_ai(str(value), max_chars=16_000)
    text = _SECRET.sub(r"\1[SEGREDO REMOVIDO]", text)
    text = _EMAIL.sub("[EMAIL REMOVIDO]", text)
    return _PHONE.sub("[TELEFONE REMOVIDO]", text)


def safe_path(value: Any) -> str:
    # Query e fragmento podem carregar tokens OAuth ou filtros pessoais.
    path = urlsplit(str(value or "")).path
    return mask_text(path)[:500]


def mask_metadata(value: Any, *, depth: int = 0) -> Any:
    if depth > 6:
        return "[LIMITE DE METADADOS]"
    if isinstance(value, dict):
        return {str(key)[:80]: "[REMOVIDO]" if _SENSITIVE.search(str(key)) else
                safe_path(item) if str(key).casefold() in {"path", "url", "route"} else
                mask_metadata(item, depth=depth + 1) for key, item in list(value.items())[:50]}
    if isinstance(value, (tuple, list)):
        return [mask_metadata(item, depth=depth + 1) for item in value[:50]]
    if isinstance(value, str):
        return mask_text(value)[:1000]
    if value is None or isinstance(value, (bool, int, float)):
        return value
    return mask_text(value)[:1000]


class PersonalDataLogFilter(logging.Filter):
    _norium_personal_data_filter = True

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            if record.name == "uvicorn.access" and isinstance(record.args, tuple):
                # Uvicorn's AccessFormatter unpacks five positional arguments.
                record.msg = mask_text(record.msg)
                record.args = tuple(mask_text(value) if isinstance(value, str) else value for value in record.args)
            else:
                record.msg = mask_text(record.getMessage())
                record.args = ()
            if record.exc_info:
                # Traceback paths/lines can disclose request or provider bodies.
                record.msg += " · " + type(record.exc_info[1]).__name__
                record.exc_info = None
                record.exc_text = None
        except (ValueError, TypeError):
            record.msg, record.args = "Evento de log minimizado", ()
        return True


def configure_log_minimization() -> None:
    # A factory also covers descendant loggers and handlers configured later.
    factory = logging.getLogRecordFactory()
    if getattr(factory, "_norium_minimized", False):
        return
    privacy_filter = PersonalDataLogFilter()

    def minimized_factory(*args: Any, **kwargs: Any) -> logging.LogRecord:
        record = factory(*args, **kwargs)
        privacy_filter.filter(record)
        return record

    minimized_factory._norium_minimized = True
    logging.setLogRecordFactory(minimized_factory)
