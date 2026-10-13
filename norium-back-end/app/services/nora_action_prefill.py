"""Pure action interpretation. Proposed fields never authorize an external effect."""
from dataclasses import dataclass
import re
import unicodedata

EMAIL = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")
BODY = re.compile(
    r"\b(?:dizendo(?:\s+que)?|informando(?:\s+que)?|avisando(?:\s+que)?|avise|"
    r"perguntando|pergunte|diga|falando|fale|com\s+(?:o\s+|a\s+)?(?:texto|mensagem))\b(?:[ \t]*[:\-])?"
    r"|\b(?:mensagem|corpo|texto)[ \t]*:", re.I,
)
HEADER = re.compile(
    r"\b(?P<label>bcc|cco|(?:em\s+|com\s+)?c[óo]pia\s+oculta|cc|copie|(?:em\s+|com\s+)?c[óo]pia|assunto|sobre)\b(?:[ \t]*[:\-])?"
    r"|\b(?P<recipient>para|pra|ao)(?:[ \t]*:|[ \t]+(?=[^\n;]{0,80}[\w.+-]+@[\w-]+\.[\w.-]+))", re.I,
)
SEND = re.compile(r"\b(?:mande|envie|enviar|mandar|redigir|redija|escrever|escreva)\b", re.I)


def normalize(value):
    return "".join(char for char in unicodedata.normalize("NFKD", value.casefold()) if not unicodedata.combining(char))


def outside_quotes(text):
    # Keep positions stable while quoted subject/body cannot introduce fields.
    result, quote, escaped = [], None, False
    for i, char in enumerate(text):
        if escaped:
            result.append(" " if quote else char)
            escaped = False
        elif char == "\\" and quote:
            result.append(" ")
            escaped = True
        elif char in {"\"", "'"} and not (char == "'" and i > 0 and i + 1 < len(text) and text[i-1].isalnum() and text[i+1].isalnum()):
            if quote == char:
                quote = None
            elif quote is None:
                quote = char
            result.append(" ")
        else:
            result.append(" " if quote else char)
    return "".join(result)


def clean(value):
    value = value.strip(" \n\r\t,;:-")
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
        value = value[1:-1].strip()
    return value


def addresses(value):
    return tuple(dict.fromkeys(match.group(0) for match in EMAIL.finditer(value)))


@dataclass(frozen=True)
class EmailActionPrefill:
    fields: dict
    provided: tuple[str, ...]
    unresolved: tuple[str, ...]
    attachments_requested: bool = False
    explicit: bool = False
    literal_body: bool = False
    action: str = "email.send"


def extract_action_parameters(action, message, *, bare_recipient_kind=None):
    """Email adapter; other agents retain their own domain-specific parsing."""
    if action != "email":
        return None
    text = str(message).strip()
    masked = outside_quotes(text)
    body_marker = BODY.search(masked)
    body_value = None
    head = text[:body_marker.start()] if body_marker else text
    if body_marker:
        remainder = text[body_marker.end():].lstrip()
        if remainder.startswith(('"', "'")):
            quote, escaped, end = remainder[0], False, None
            for i, char in enumerate(remainder[1:], start=1):
                if escaped:
                    escaped = False
                elif char == "\\":
                    escaped = True
                elif char == quote:
                    end = i
                    break
            if end is not None:
                body_value = remainder[1:end].strip()
                head += " " + remainder[end+1:]
    headers = list(HEADER.finditer(outside_quotes(head)))
    fields, unresolved = {}, []
    for index, header in enumerate(headers):
        label = normalize(header.group("label") or header.group("recipient"))
        key = "to" if header.group("recipient") else "subject" if label in {"assunto", "sobre"} else "bcc" if label in {"bcc", "cco"} or "oculta" in label else "cc"
        value = clean(head[header.end():headers[index+1].start() if index+1 < len(headers) else len(head)])
        if key == "subject":
            if value:
                fields[key] = value[:180]
        else:
            found = addresses(value)
            if found:
                fields[key] = list(found)
            elif key != "to" and normalize(value) in {"nenhum", "nenhuma", "nao", "sem copia", "pular"}:
                fields[key] = []
            else:
                unresolved.append(key)
    sending = bool(SEND.search(outside_quotes(head)))
    if "to" not in fields and "to" not in unresolved and sending:
        # Only the unlabelled header prefix may contain primary recipients.
        prefix = head[:headers[0].start()] if headers else head
        found = addresses(prefix)
        if found:
            fields["to"] = list(found)
    if body_marker:
        body = body_value if body_value is not None else clean(text[body_marker.end():])
        if body:
            fields["body"] = body[:12000]
    elif "to" in fields and not any(key in fields for key in ("subject", "cc", "bcc")):
        matches = list(EMAIL.finditer(head))
        tail = clean(head[matches[-1].end():]) if matches else ""
        if tail and not tail.startswith(("e ", "ou ")):
            fields["body"] = tail[:12000]
    if not headers and not body_marker and not sending and bare_recipient_kind in {"to", "cc", "bcc"}:
        found = addresses(text)
        if found:
            fields[bare_recipient_kind] = list(found)
    attachment_request = bool(re.search(r"\b(?:com\s+anexos?|anexe|anexar|inclua\s+(?:o\s+)?(?:arquivo|documento|pdf))\b", masked, re.I))
    labelled = bool(re.match(r"\s*(?:para|pra|ao|assunto|sobre|cc|cco|bcc|c[óo]pia(?:\s+oculta)?)\s*:", masked, re.I))
    return EmailActionPrefill(fields=fields, provided=tuple(fields), unresolved=tuple(dict.fromkeys(unresolved)),
                              attachments_requested=attachment_request, explicit=bool(labelled or len(headers) > 1 or body_marker or sending),
                              literal_body=body_value is not None and not re.search(r"\b(?:redigir|redija|escrever|escreva)\b", outside_quotes(head), re.I))
