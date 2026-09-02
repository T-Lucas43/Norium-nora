from __future__ import annotations

import os
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import httpx

from app.core.tenant import is_production


STIRLING_ENDPOINTS: dict[str, str] = {
    "merge": "/api/v1/general/merge-pdfs",
    "compress": "/api/v1/misc/compress-pdf",
    "watermark": "/api/v1/security/add-watermark",
    "ocr": "/api/v1/misc/ocr-pdf",
}


class StirlingPdfError(RuntimeError):
    pass


def _configured_base_url() -> str:
    value = os.getenv("STIRLING_PDF_URL", "").strip().rstrip("/")
    if not value:
        return ""
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise StirlingPdfError("STIRLING_PDF_URL invalida.")
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise StirlingPdfError("STIRLING_PDF_URL nao pode conter credenciais, query ou fragmento.")
    if is_production() and parsed.scheme != "https" and parsed.hostname not in {
        "127.0.0.1",
        "localhost",
        "stirling-pdf",
    }:
        raise StirlingPdfError("O Stirling PDF deve usar HTTPS ou rede interna em producao.")
    return value


class StirlingPdfClient:
    def __init__(self) -> None:
        self.base_url = _configured_base_url()
        self.api_key = os.getenv("STIRLING_PDF_API_KEY", "").strip()
        self.timeout_seconds = max(10, min(int(os.getenv("STIRLING_PDF_TIMEOUT_SECONDS", "180")), 900))

    @property
    def configured(self) -> bool:
        return bool(self.base_url)

    def _headers(self) -> dict[str, str]:
        return {"X-API-KEY": self.api_key} if self.api_key else {}

    async def openapi_paths(self) -> set[str]:
        if not self.configured:
            return set()
        async with httpx.AsyncClient(timeout=12, follow_redirects=False) as client:
            response = await client.get(f"{self.base_url}/v3/api-docs", headers=self._headers())
            response.raise_for_status()
            payload = response.json()
        paths = payload.get("paths") if isinstance(payload, dict) else {}
        return {str(path) for path in paths} if isinstance(paths, dict) else set()

    async def capabilities(self) -> dict[str, Any]:
        if not self.configured:
            return {
                "configured": False,
                "available": False,
                "operations": [],
                "message": "Motor Stirling PDF nao configurado; as ferramentas nativas continuam disponiveis.",
            }
        try:
            paths = await self.openapi_paths()
        except Exception:
            return {
                "configured": True,
                "available": False,
                "operations": [],
                "message": "Motor Stirling PDF temporariamente indisponivel.",
            }
        operations = [operation for operation, path in STIRLING_ENDPOINTS.items() if path in paths]
        return {
            "configured": True,
            "available": bool(operations),
            "operations": operations,
            "message": "Operacoes confirmadas pelo OpenAPI da instancia Stirling PDF.",
        }

    async def process(
        self,
        operation: str,
        input_paths: list[Path],
        options: dict[str, Any],
    ) -> tuple[bytes, str, str]:
        endpoint = STIRLING_ENDPOINTS.get(operation)
        if not endpoint:
            raise StirlingPdfError("Operacao Stirling PDF nao permitida.")
        capabilities = await self.capabilities()
        if operation not in capabilities.get("operations", []):
            raise StirlingPdfError("A instancia Stirling PDF nao confirmou suporte a esta operacao.")

        data = self._operation_fields(operation, options)
        handles = [path.open("rb") for path in input_paths]
        files = [
            ("fileInput", (path.name, handle, "application/pdf"))
            for path, handle in zip(input_paths, handles, strict=True)
        ]
        try:
            timeout = httpx.Timeout(self.timeout_seconds, connect=10)
            async with httpx.AsyncClient(timeout=timeout, follow_redirects=False) as client:
                response = await client.post(
                    f"{self.base_url}{endpoint}",
                    headers=self._headers(),
                    data=data,
                    files=files,
                )
            if response.status_code >= 400:
                raise StirlingPdfError(f"Stirling PDF recusou o processamento ({response.status_code}).")
            content_type = response.headers.get("content-type", "application/pdf").split(";", 1)[0]
            filename = self._response_filename(response.headers.get("content-disposition", ""), operation)
            return response.content, filename, content_type
        except httpx.TimeoutException as exc:
            raise StirlingPdfError("O processamento excedeu o tempo limite configurado.") from exc
        except httpx.HTTPError as exc:
            raise StirlingPdfError("Falha de comunicacao com o motor Stirling PDF.") from exc
        finally:
            for handle in handles:
                handle.close()

    @staticmethod
    def _response_filename(content_disposition: str, operation: str) -> str:
        marker = "filename="
        if marker in content_disposition:
            value = content_disposition.split(marker, 1)[1].split(";", 1)[0].strip().strip('"')
            if value:
                return Path(value).name
        return f"{operation}-resultado.pdf"

    @staticmethod
    def _operation_fields(operation: str, options: dict[str, Any]) -> dict[str, str]:
        if operation == "merge":
            return {"sortType": "orderProvided", "removeCertSign": "true"}
        if operation == "watermark":
            return {
                "watermarkType": "text",
                "watermarkText": str(options.get("text") or "CONFIDENCIAL")[:120],
                "alphabet": "roman",
                "fontSize": str(max(8, min(int(options.get("fontSize") or 30), 120))),
                "rotation": str(max(-360, min(int(options.get("rotation") or 45), 360))),
                "opacity": str(max(0.05, min(float(options.get("opacity") or 0.25), 1))),
                "widthSpacer": "50",
                "heightSpacer": "50",
            }
        if operation == "ocr":
            languages = str(options.get("languages") or "por,eng")
            return {
                "languages": languages[:80],
                "sidecar": "false",
                "deskew": str(bool(options.get("deskew", True))).lower(),
                "clean": str(bool(options.get("clean", False))).lower(),
                "cleanFinal": "false",
                "ocrType": "skip-text",
                "ocrRenderType": "hocr",
                "removeImagesAfter": "false",
            }
        if operation == "compress":
            return {"optimizeLevel": str(max(1, min(int(options.get("level") or 2), 4)))}
        return {}
