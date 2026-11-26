"""Generate a bounded preview from the provider's already stored thumbnail.

Never downloads the original media or follows a thumbnail URL.
"""
from __future__ import annotations

import base64
from io import BytesIO
import warnings

from fastapi import HTTPException
from PIL import Image, ImageOps, UnidentifiedImageError


def thumbnail_bytes(message: dict) -> bytes:
    if message.get("visualizacaoUnica") or message.get("viewOnce") or message.get("tipo") != "midia":
        raise HTTPException(404, "Miniatura indisponível.")
    source = (message.get("midiaMeta") or {}).get("thumbnail")
    if not isinstance(source, str) or not source or len(source) > 350_000:
        raise HTTPException(404, "Miniatura indisponível.")
    if source.startswith("data:image/jpeg;base64,") or source.startswith("data:image/png;base64,"):
        source = source.split(",", 1)[1]
    try:
        raw = base64.b64decode(source, validate=True)
        if not raw or len(raw) > 250_000:
            raise ValueError("thumbnail size")
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(BytesIO(raw)) as image:
                if image.format not in {"JPEG", "PNG", "WEBP"} or image.width * image.height > 4_000_000:
                    raise ValueError("thumbnail dimensions")
                preview = ImageOps.exif_transpose(image).convert("RGB")
                preview.thumbnail((320, 240))
                output = BytesIO()
                preview.save(output, format="JPEG", quality=80)
                return output.getvalue()
    except (ValueError, OSError, UnidentifiedImageError, Image.DecompressionBombWarning, Image.DecompressionBombError):
        raise HTTPException(404, "Miniatura indisponível.") from None
