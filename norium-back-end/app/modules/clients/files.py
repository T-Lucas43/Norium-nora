"""Private client attachments and normalized profile images."""
from __future__ import annotations

import base64
import binascii
import io
import re
import uuid
import warnings
import zipfile
from pathlib import Path

from fastapi import HTTPException
from PIL import Image, ImageOps, UnidentifiedImageError

from app.core.tenant import get_user_db_path
from app.infrastructure.persistence import files as persistent_files

MAX_FILE_BYTES = 15 * 1024 * 1024
MIME_TYPES = {".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".txt": "text/plain", ".csv": "text/csv", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"}


def directory(user_id: str, client_id: str) -> Path:
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,180}", client_id):
        raise HTTPException(404, "Cliente não encontrado.")
    return Path(get_user_db_path(user_id, "clientes")).parent / "client_files" / client_id


def file_path(user_id: str, client_id: str, file_id: str) -> Path:
    if not re.fullmatch(r"[a-f0-9]{32}", file_id):
        raise HTTPException(404, "Arquivo não encontrado.")
    return directory(user_id, client_id) / file_id


def decoded_file(file_name: str, data_base64: str) -> tuple[str, str, bytes]:
    name = re.sub(r"[\x00-\x1f]", "", file_name.replace("\\", "/").split("/")[-1]).strip()[:180]
    extension = Path(name).suffix.lower()
    mime = MIME_TYPES.get(extension)
    if not mime:
        raise HTTPException(422, "Use PDF, DOCX, XLSX, TXT, CSV, PNG, JPG ou WebP.")
    try:
        data = base64.b64decode(data_base64, validate=True)
    except (ValueError, binascii.Error) as exc:
        raise HTTPException(422, "O arquivo enviado é inválido.") from exc
    if not data or len(data) > MAX_FILE_BYTES:
        raise HTTPException(413, "Envie um arquivo de até 15 MB.")
    if extension == ".pdf" and not data.lstrip().startswith(b"%PDF-"):
        raise HTTPException(422, "O conteúdo não corresponde a um PDF.")
    if extension in {".docx", ".xlsx"}:
        try:
            with zipfile.ZipFile(io.BytesIO(data)) as archive:
                names = archive.namelist()
                if len(names) > 10000 or "[Content_Types].xml" not in names or not any(name.startswith("word/" if extension == ".docx" else "xl/") for name in names):
                    raise ValueError("invalid office document")
        except (ValueError, zipfile.BadZipFile) as exc:
            raise HTTPException(422, "O conteúdo não corresponde ao documento informado.") from exc
    if extension in {".txt", ".csv"} and b"\x00" in data:
        raise HTTPException(422, "O arquivo de texto contém dados binários.")
    if mime.startswith("image/"):
        validate_image(data)
    return name, mime, data


def validate_image(data: bytes) -> None:
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(data)) as image:
                if image.format not in {"PNG", "JPEG", "WEBP"} or image.width * image.height > 20_000_000:
                    raise ValueError("image too large or unsupported")
                image.verify()
    except (OSError, ValueError, UnidentifiedImageError, Image.DecompressionBombWarning, Image.DecompressionBombError) as exc:
        raise HTTPException(422, "Use uma imagem PNG, JPG ou WebP válida, de até 20 megapixels.") from exc


def profile_image(data: bytes) -> bytes:
    validate_image(data)
    with Image.open(io.BytesIO(data)) as source:
        photo = ImageOps.fit(ImageOps.exif_transpose(source).convert("RGBA"), (320, 320), method=Image.Resampling.LANCZOS)
        background = Image.new("RGB", photo.size, (24, 24, 27))
        background.paste(photo, mask=photo.getchannel("A"))
        output = io.BytesIO()
        background.save(output, "WEBP", quality=84)
        return output.getvalue()


def write_file(user_id: str, client_id: str, data: bytes) -> str:
    file_id = uuid.uuid4().hex
    path = file_path(user_id, client_id, file_id)
    persistent_files.write(path, data)
    return file_id


def remove_file(user_id: str, client_id: str, file_id: str) -> None:
    persistent_files.delete(file_path(user_id, client_id, file_id))


def read_file(user_id: str, client_id: str, file_id: str) -> bytes | None:
    path = file_path(user_id, client_id, file_id)
    try:
        return persistent_files.read(path)
    except FileNotFoundError:
        return None
