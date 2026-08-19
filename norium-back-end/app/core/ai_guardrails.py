"""Minimizacao de dados antes de enviar conteudo aos provedores de IA."""

from __future__ import annotations

import re


_SECRET_PATTERNS = (
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----", re.I),
    re.compile(r"\b(?:sk|gsk|ghp|github_pat|xox[baprs])[-_A-Za-z0-9]{16,}\b"),
    re.compile(r"\b(?:api[_-]?key|client[_-]?secret|access[_-]?token|password|senha)\s*[:=]\s*[^\s,;]+", re.I),
    re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b"),
)
_CPF_PATTERN = re.compile(r"(?<!\d)\d{3}[.\s-]?\d{3}[.\s-]?\d{3}[-.\s]?\d{2}(?!\d)")
_CARD_PATTERN = re.compile(r"(?<!\d)(?:\d[ -]?){13,19}(?!\d)")


def minimize_for_ai(value: str, *, max_chars: int = 24_000) -> str:
    text = str(value or "")[:max_chars]
    for pattern in _SECRET_PATTERNS:
        text = pattern.sub("[SEGREDO REMOVIDO]", text)
    text = _CPF_PATTERN.sub("[CPF REMOVIDO]", text)
    text = _CARD_PATTERN.sub("[DADO FINANCEIRO REMOVIDO]", text)
    return text
