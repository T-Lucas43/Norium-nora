"""Minimizacao de dados antes de enviar conteudo aos provedores de IA."""

from __future__ import annotations

import re


_SECRET_PATTERNS = (
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----", re.I),
    re.compile(r"\b(?:sk|gsk|ghp|github_pat|xox[baprs])[-_A-Za-z0-9]{16,}\b"),
    re.compile(r"\b(?:api[_-]?key|client[_-]?secret|access[_-]?token|password|senha)\s*[:=]\s*[^\s,;]+", re.I),
    re.compile(r"\bbearer\s+[A-Za-z0-9._~+/-]+=*", re.I),
    re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b"),
    # Also cover relative links and tokens truncated by the input bound.
    re.compile(r"(?:https?://[^\s/<>]+)?/p/(?:budget|portal|documents|satisfaction|site-chat|waitlist)#[A-Za-z0-9_-]+", re.I),
)
# CPF com pontuacao (000.000.000-00) e sempre removido; 11 digitos seguidos so quando o
# digito verificador fecha, para nao confundir celular (11987654321) com CPF.
_CPF_FORMATTED = re.compile(r"(?<!\d)\d{3}\.\d{3}\.\d{3}-\d{2}(?!\d)")
_CPF_DIGITS = re.compile(r"(?<![\d+])\d{11}(?!\d)")
_CARD_PATTERN = re.compile(r"(?<!\d)(?:\d[ -]?){13,19}(?!\d)")


def _valid_cpf(digits: str) -> bool:
    if len(digits) != 11 or digits == digits[0] * 11:
        return False
    for size in (9, 10):
        total = sum(int(digit) * weight for digit, weight in zip(digits[:size], range(size + 1, 1, -1)))
        check = (total * 10) % 11 % 10
        if check != int(digits[size]):
            return False
    return True


def _luhn(digits: str) -> bool:
    total = 0
    for index, digit in enumerate(reversed(digits)):
        value = int(digit)
        if index % 2:
            value = value * 2 - 9 if value > 4 else value * 2
        total += value
    return total % 10 == 0


def _mask_card(match: re.Match[str]) -> str:
    raw = match.group(0)
    digits = re.sub(r"\D", "", raw)
    # Telefone brasileiro com DDI (55 + DDD + numero) nao e cartao.
    if len(digits) in (12, 13) and digits.startswith("55"):
        return raw
    if not 13 <= len(digits) <= 19 or not _luhn(digits):
        return raw
    return "[DADO FINANCEIRO REMOVIDO]" + (" " if raw.endswith((" ", "-")) else "")


def minimize_for_ai(value: str, *, max_chars: int = 24_000) -> str:
    text = str(value or "")[:max_chars]
    for pattern in _SECRET_PATTERNS:
        text = pattern.sub("[SEGREDO REMOVIDO]", text)
    text = _CPF_FORMATTED.sub("[CPF REMOVIDO]", text)
    text = _CPF_DIGITS.sub(lambda match: "[CPF REMOVIDO]" if _valid_cpf(match.group(0)) else match.group(0), text)
    text = _CARD_PATTERN.sub(_mask_card, text)
    return text
