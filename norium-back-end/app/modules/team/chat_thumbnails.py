from __future__ import annotations
from io import BytesIO
from fastapi import HTTPException
from PIL import Image, ImageOps, UnidentifiedImageError


def thumbnail(content: bytes) -> bytes:
    try:
        with Image.open(BytesIO(content)) as image:
            if image.width*image.height > 20_000_000:
                raise HTTPException(413, "Imagem grande demais para miniatura.")
            image = ImageOps.exif_transpose(image).convert("RGB")
            image.thumbnail((480, 480), Image.Resampling.LANCZOS)
            output = BytesIO(); image.save(output, "WEBP", quality=82)
            return output.getvalue()
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError):
        raise HTTPException(415, "Miniatura indisponível para este arquivo.") from None
