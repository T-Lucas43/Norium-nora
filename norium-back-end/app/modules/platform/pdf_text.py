"""Extração local e busca determinística em PDFs pesquisáveis.

Serviço compartilhado para que a plataforma, a Nora e o comercial usem o
mesmo parser sem duplicação. Conversão PDF→texto e buscas por páginas não
consomem tokens de modelo.

Conteúdo de PDF é dado não confiável: os trechos retornados são apenas
evidência para exibição. Nunca os trate como instrução do sistema nem os
encaminhe a ferramentas.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import re
import unicodedata
from io import BytesIO
from typing import Any

from fastapi import HTTPException

try:
    from pypdf import PdfReader
except ImportError:  # Mantém o backend inicializável até a dependência ser instalada.
    PdfReader = None

PDF_MAX_BYTES = 12 * 1024 * 1024
PDF_MAX_PAGES = 200
# Teto total de caracteres extraídos em todas as páginas somadas: limita o
# custo de memória do primeiro processamento além dos tetos de 12 MB e
# 200 páginas.
PDF_MAX_TOTAL_CHARS = 2_000_000
PDF_MIN_CHARS = 2
EXCERPT_CHARS = 420
# Distância máxima (em caracteres normalizados) entre o primeiro e o último
# termo da consulta para que a página conte como evidência da expressão.
PHRASE_WINDOW = 300
MAX_VALUES_PER_PAGE = 5

_VALUE_PATTERN = re.compile(
    r"R\$\s?\d[\d\.,]*"
    r"|\d{2}/\d{2}/\d{4}"
    r"|\d+(?:[.,]\d+)?\s?(?:dias?|meses?|anos?|horas?|%|por\s+cento|reais?|parcelas?)",
    re.IGNORECASE,
)


def pdf_tokens(value: Any) -> set[str]:
    """Tokenização determinística usada na busca por páginas."""
    text = unicodedata.normalize("NFKD", str(value or ""))
    text = "".join(char for char in text if not unicodedata.combining(char)).lower()
    return {part for part in re.findall(r"[a-z0-9]{3,}", text)}


def decode_pdf_data_url(data_url: str) -> bytes:
    """Decodifica o dataUrl de upload, com erro 422 para conteúdo corrompido."""
    try:
        encoded = data_url.split(",", 1)[1] if "," in data_url else data_url
        return base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error) as exc:
        raise HTTPException(
            status_code=422,
            detail="O PDF enviado esta corrompido ou em formato invalido.",
        ) from exc


def extract_pdf_pages(pdf_bytes: bytes) -> list[str]:
    """Valida e extrai o texto de cada página, preservando a ordem.

    Função síncrona pura (CPU + descompressão): fluxos assíncronos devem usar
    `extract_pdf_pages_async` para não bloquear o event loop. Mantém os
    limites e mensagens do endpoint de conhecimento: 12 MB, 200 páginas,
    teto total de caracteres extraídos e erro claro para PDF sem texto
    pesquisável.
    """
    if PdfReader is None:
        raise HTTPException(
            status_code=503,
            detail="Leitor de PDF indisponivel. Instale a dependencia pypdf.",
        )
    if len(pdf_bytes) > PDF_MAX_BYTES:
        raise HTTPException(status_code=413, detail="O PDF deve ter no maximo 12 MB.")
    if not pdf_bytes.startswith(b"%PDF"):
        raise HTTPException(status_code=422, detail="O arquivo enviado nao e um PDF valido.")
    try:
        reader = PdfReader(BytesIO(pdf_bytes))
        if len(reader.pages) > PDF_MAX_PAGES:
            raise HTTPException(status_code=413, detail="O PDF deve ter no maximo 200 paginas.")
        pages: list[str] = []
        total_chars = 0
        for page in reader.pages:
            text = (page.extract_text() or "").strip()
            total_chars += len(text)
            if total_chars > PDF_MAX_TOTAL_CHARS:
                raise HTTPException(
                    status_code=413,
                    detail="O texto extraido do PDF excede o limite de 2.000.000 caracteres.",
                )
            pages.append(text)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(
            status_code=422,
            detail="Nao foi possivel ler o conteudo deste PDF.",
        ) from exc
    if len("\n\n".join(pages).strip()) < PDF_MIN_CHARS:
        raise HTTPException(
            status_code=422,
            detail="Este PDF nao possui texto pesquisavel. Envie uma versao com OCR para indexacao.",
        )
    return pages


async def extract_pdf_pages_async(pdf_bytes: bytes) -> list[str]:
    """Extrai páginas fora do event loop (thread), com os mesmos limites.

    Mecanismo padrão do projeto (`asyncio.to_thread`, sem dependência nova).
    """
    return await asyncio.to_thread(extract_pdf_pages, pdf_bytes)


def _normalize_term(value: str) -> str:
    """Minúsculas sem acentos, mesma normalização de `pdf_tokens`."""
    text = unicodedata.normalize("NFKD", str(value or ""))
    return "".join(char for char in text if not unicodedata.combining(char)).lower()


def find_accent_insensitive(haystack: str, needle: str) -> tuple[int, int] | None:
    """Localiza `needle` em `haystack` ignorando acentos e caixa.

    Retorna os índices (início, fim) no texto ORIGINAL ou None. A normalização
    NFKD pode alterar o comprimento, por isso cada caractere normalizado
    carrega o índice original de origem.
    """
    wanted = _normalize_term(needle).strip()
    if len(wanted) < 1:
        return None
    norm_chars: list[str] = []
    origins: list[int] = []
    for pos, char in enumerate(str(haystack or "")):
        for piece in _normalize_term(char):
            norm_chars.append(piece)
            origins.append(pos)
    at = "".join(norm_chars).find(wanted)
    if at < 0 or at + len(wanted) - 1 >= len(origins):
        return None
    return (origins[at], origins[at + len(wanted) - 1] + 1)


_MAX_OCCURRENCES_PER_TERM = 500


def _term_occurrences(normalized: str, term: str) -> list[int]:
    occurrences: list[int] = []
    start = 0
    while len(occurrences) < _MAX_OCCURRENCES_PER_TERM:
        at = normalized.find(term, start)
        if at < 0:
            break
        occurrences.append(at)
        start = at + 1
    return occurrences


def _match_positions(page_text: str, query_terms: set[str]) -> list[int] | None:
    """Menor janela normalizada contendo todos os termos; None sem janela válida.

    Todas as ocorrências de cada termo participam: uma ocorrência posterior
    válida na mesma página não é perdida por causa da primeira.
    """
    normalized = _normalize_term(page_text)
    bags = [_term_occurrences(normalized, term) for term in query_terms]
    if any(not bag for bag in bags):
        return None
    if len(bags) == 1:
        return [bags[0][0], bags[0][0]]
    tagged = sorted((pos, idx) for idx, bag in enumerate(bags) for pos in bag)
    best: list[int] | None = None
    counts = [0] * len(bags)
    covered = 0
    left = 0
    for right in range(len(tagged)):
        if counts[tagged[right][1]] == 0:
            covered += 1
        counts[tagged[right][1]] += 1
        while covered == len(bags):
            span = (tagged[left][0], tagged[right][0])
            if best is None or span[1] - span[0] < best[1] - best[0]:
                best = [span[0], span[1]]
            if counts[tagged[left][1]] == 1:
                covered -= 1
            counts[tagged[left][1]] -= 1
            left += 1
    if best is None:
        return None
    if len(query_terms) > 1 and best[1] - best[0] > PHRASE_WINDOW:
        return None
    return best


def search_pdf_pages(
    pages: list[str],
    query: str,
    limit: int = 5,
    excerpt_chars: int = EXCERPT_CHARS,
) -> list[dict[str, Any]]:
    """Busca determinística por páginas, sem chamada a modelo.

    Uma página só conta como evidência quando contém TODOS os termos da
    consulta próximos entre si (janela `PHRASE_WINDOW`): encontrar uma palavra
    comum isolada não fundamenta a resposta. Retorna no máximo `limit`
    trechos ordenados por página, cada um com `page` (1-based), `excerpt`,
    `matchedTerms` e `values` (números/datas próximos do trecho).
    """
    query_terms = pdf_tokens(query)
    if not query_terms:
        return []
    scored: list[tuple[int, str]] = []
    for index, page_text in enumerate(pages):
        if _match_positions(page_text, query_terms) is None:
            continue
        scored.append((index, page_text))
    scored.sort(key=lambda item: item[0])
    results: list[dict[str, Any]] = []
    for index, page_text in scored[: max(1, limit)]:
        excerpt, center = page_excerpt(page_text, query_terms, excerpt_chars)
        results.append(
            {
                "page": index + 1,
                "excerpt": excerpt,
                "matchedTerms": len(query_terms),
                "values": extract_nearby_values(page_text, center),
            }
        )
    return results


def _best_cluster_center(cleaned: str, query_terms: set[str]) -> int:
    """Centro do menor aglomerado com todos os termos (coordenadas originais)."""
    tagged: list[tuple[int, int]] = []
    terms = sorted(query_terms)
    for idx, term in enumerate(terms):
        if len(term) < 3:
            continue
        start = 0
        while len(tagged) < 2000:
            found = find_accent_insensitive(cleaned[start:], term)
            if found is None:
                break
            tagged.append((start + found[0], idx))
            start = start + found[0] + 1
    wanted = {idx for idx, term in enumerate(terms) if len(term) >= 3}
    if not wanted:
        return 0
    tagged.sort()
    best: int | None = None
    counts: dict[int, int] = {}
    covered = 0
    left = 0
    for right in range(len(tagged)):
        idx = tagged[right][1]
        if counts.get(idx, 0) == 0 and idx in wanted:
            covered += 1
        counts[idx] = counts.get(idx, 0) + 1
        while covered == len(wanted):
            span = (tagged[left][0], tagged[right][0])
            if best is None or span[1] - span[0] < best:
                best = span[1] - span[0]
                center = span[0]
            left_idx = tagged[left][1]
            counts[left_idx] -= 1
            if counts[left_idx] == 0 and left_idx in wanted:
                covered -= 1
            left += 1
    if best is None:
        return min((pos for pos, _ in tagged), default=0)
    return center


def page_excerpt(
    page_text: str, query_terms: set[str], excerpt_chars: int = EXCERPT_CHARS
) -> tuple[str, int]:
    """Recorta uma janela de evidência em torno do aglomerado dos termos.

    As posições são localizadas sem diferenciar acentos, então o trecho
    citado sempre contém a expressão encontrada no texto original. Retorna o
    trecho e o centro do recorte (para extração de valores próximos).
    """
    cleaned = re.sub(r"\s+", " ", str(page_text or "")).strip()
    if len(cleaned) <= excerpt_chars:
        return cleaned, 0
    center = _best_cluster_center(cleaned, query_terms)
    start = max(0, center - 120)
    return cleaned[start : start + excerpt_chars].strip(), center


def extract_nearby_values(
    page_text: str, center: int, radius: int = 160, limit: int = MAX_VALUES_PER_PAGE
) -> list[str]:
    """Números com unidade, valores em R$ e datas próximos do trecho citado."""
    cleaned = re.sub(r"\s+", " ", str(page_text or "")).strip()
    window = cleaned[max(0, center - radius) : center + radius]
    values: list[str] = []
    for match in _VALUE_PATTERN.finditer(window):
        value = re.sub(r"\s+", " ", match.group(0)).strip()
        if value and value not in values:
            values.append(value)
        if len(values) >= limit:
            break
    return values


def _field_values_in_page(page_text: str, page: int) -> list[tuple[str, str]]:
    """Pares (campo, valor) da página; o campo é o rótulo da linha do valor.

    Valores sem rótulo na linha ficam restritos à página, para nunca comparar
    números de campos diferentes entre páginas.
    """
    pairs: list[tuple[str, str]] = []
    for raw_line in str(page_text or "").split("\n"):
        line = re.sub(r"\s+", " ", raw_line).strip()
        if not line:
            continue
        for match in _VALUE_PATTERN.finditer(line):
            value = re.sub(r"\s+", " ", match.group(0)).strip()
            before = line[: match.start()]
            if before.rstrip().endswith((":", "-", "–", "—", "=")):
                segment = before.rstrip()[:-1]
                for sep in (";", ":", ".", "!", "?"):
                    segment = segment.split(sep)[-1]
                field = _normalize_term(segment).strip()
            else:
                field = ""
            pairs.append((field, value))
    return pairs


def detect_value_conflicts(pages: list[str], query: str) -> list[dict[str, Any]]:
    """Divergências de valor para o MESMO campo, na mesma ou entre páginas.

    Números de campos diferentes nunca geram conflito: sem campo comum, a
    comparação é inconclusiva e nada é sinalizado.
    """
    terms = pdf_tokens(query)
    if not terms:
        return []
    groups: dict[tuple[str, int | None], list[tuple[int, str]]] = {}
    order: list[tuple[str, int | None]] = []
    for number, page in enumerate(pages, start=1):
        if _match_positions(page, terms) is None:
            continue
        for field, value in _field_values_in_page(page, number):
            key = (field, None) if field else ("", number)
            if key not in groups:
                groups[key] = []
                order.append(key)
            if value not in [seen for _, seen in groups[key]]:
                groups[key].append((number, value))
    conflicts: list[dict[str, Any]] = []
    for key in order:
        items = groups[key]
        distinct = sorted({value for _, value in items})
        if len(distinct) > 1:
            field, _scope = key
            conflicts.append(
                {
                    "field": field or "trecho sem rótulo na p. %d" % items[0][0],
                    "values": distinct,
                    "occurrences": [{"page": page, "value": value} for page, value in items],
                }
            )
    return conflicts
