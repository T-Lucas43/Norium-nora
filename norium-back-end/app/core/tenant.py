from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any, Mapping

from app.infrastructure.persistence.json_repository import read_json, write_json
from app.core.request_context import current_workspace_id


BACKEND_ROOT = Path(__file__).resolve().parents[2]
PRODUCTION_DATA_ROOT = Path("/app/data")
# O runtime serverless da Vercel disponibiliza somente /tmp para escrita. O
# subdiretorio e fixo, nao recebe entrada do usuario e continua segregado pelo
# identificador normalizado de cada conta.
VERCEL_DATA_ROOT = Path("/tmp/norium")  # nosec B108
LOCAL_DATA_ROOT = BACKEND_ROOT / "data"

LOCAL_TEST_ENVIRONMENTS = frozenset({"local", "development", "dev", "test", "testing"})
SHARED_RUNTIME_MARKERS = (
    "RAILWAY_ENVIRONMENT",
    "RAILWAY_PROJECT_ID",
    "RAILWAY_SERVICE_ID",
    "VERCEL",
    "WEBSITE_INSTANCE_ID",
)


def environment_names(environ: Mapping[str, str] | None = None) -> frozenset[str]:
    """Retorna todos os nomes de ambiente declarados pelo runtime."""
    source = os.environ if environ is None else environ
    return frozenset(
        value
        for name in ("ENVIRONMENT", "APP_ENV")
        if (value := source.get(name, "").strip().lower())
    )


def is_local_or_test_environment(
    environ: Mapping[str, str] | None = None,
    *,
    require_explicit: bool = False,
) -> bool:
    """Classifica o runtime por uma whitelist pequena de ambientes seguros."""
    source = os.environ if environ is None else environ
    if any(source.get(name, "").strip() for name in SHARED_RUNTIME_MARKERS):
        return False
    names = environment_names(source)
    if not names:
        # Mantém o comportamento histórico do desenvolvimento local quando a
        # classificação não é usada como fronteira de segurança.
        return not require_explicit
    return names.issubset(LOCAL_TEST_ENVIRONMENTS)


def is_shared_environment(
    environ: Mapping[str, str] | None = None,
    *,
    require_explicit: bool = False,
) -> bool:
    """Identifica produção, staging e qualquer runtime fora da whitelist local."""
    return not is_local_or_test_environment(environ, require_explicit=require_explicit)


def is_production() -> bool:
    return is_shared_environment()


def is_vercel() -> bool:
    return os.getenv("VERCEL", "").strip() == "1"


def get_data_root() -> Path:
    configured = os.getenv("NORIUM_DATA_DIR")
    if configured:
        root = Path(configured)
    elif is_vercel():
        # Vercel Functions only allow runtime writes in the ephemeral /tmp directory.
        root = VERCEL_DATA_ROOT
    else:
        root = PRODUCTION_DATA_ROOT if is_production() else LOCAL_DATA_ROOT
    if not (os.getenv("NORIUM_DATABASE_URL", "").strip() or os.getenv("NORIUM_POSTGRES_REQUIRED", "").strip().lower() in {"1", "true", "yes"}):
        root.mkdir(parents=True, exist_ok=True)
    return root


def safe_tenant_id(user_id: str) -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9_.-]+", "_", str(user_id or "").strip())
    return cleaned.strip("._") or "anonymous"


def get_user_dir(user_id: str) -> Path:
    path = get_data_root() / f"user_{safe_tenant_id(user_id)}"
    if not (os.getenv("NORIUM_DATABASE_URL", "").strip() or os.getenv("NORIUM_POSTGRES_REQUIRED", "").strip().lower() in {"1", "true", "yes"}):
        path.mkdir(parents=True, exist_ok=True)
    return path


def get_user_db_path(user_id: str, db_name: str) -> str:
    safe_name = re.sub(r"[^a-zA-Z0-9_-]+", "_", str(db_name or "").strip()).strip("_") or "database"
    workspace_id = current_workspace_id()
    base_dir = get_user_dir(user_id)
    if workspace_id != "primary":
        base_dir = base_dir / f"workspace_{workspace_id}"
    path = base_dir / f"{safe_name}_db.json"
    if not (os.getenv("NORIUM_DATABASE_URL", "").strip() or os.getenv("NORIUM_POSTGRES_REQUIRED", "").strip().lower() in {"1", "true", "yes"}):
        path.parent.mkdir(parents=True, exist_ok=True)
    return str(path)


def get_account_db_path(user_id: str, db_name: str) -> str:
    """Retorna um banco compartilhado pelos workspaces da mesma conta."""
    safe_name = re.sub(r"[^a-zA-Z0-9_-]+", "_", str(db_name or "").strip()).strip("_") or "database"
    path = get_user_dir(user_id) / f"{safe_name}_db.json"
    if not (os.getenv("NORIUM_DATABASE_URL", "").strip() or os.getenv("NORIUM_POSTGRES_REQUIRED", "").strip().lower() in {"1", "true", "yes"}):
        path.parent.mkdir(parents=True, exist_ok=True)
    return str(path)


def get_system_db_path(db_name: str) -> str:
    safe_name = re.sub(r"[^a-zA-Z0-9_-]+", "_", str(db_name or "").strip()).strip("_") or "database"
    path = get_data_root() / f"{safe_name}_db.json"
    if not (os.getenv("NORIUM_DATABASE_URL", "").strip() or os.getenv("NORIUM_POSTGRES_REQUIRED", "").strip().lower() in {"1", "true", "yes"}):
        path.parent.mkdir(parents=True, exist_ok=True)
    return str(path)


def public_api_base_url() -> str:
    configured = os.getenv("BACKEND_PUBLIC_URL") or os.getenv("API_PUBLIC_URL")
    if configured and configured.strip():
        return configured.strip().rstrip("/")
    vercel_domain = os.getenv("VERCEL_PROJECT_PRODUCTION_URL") or os.getenv("VERCEL_URL")
    if vercel_domain and vercel_domain.strip():
        normalized = vercel_domain.strip().rstrip("/")
        return normalized if "://" in normalized else f"https://{normalized}"
    if is_production():
        return ""
    return "http://127.0.0.1:8000"


def public_api_url(path: str) -> str:
    normalized_path = path if path.startswith("/") else f"/{path}"
    base_url = public_api_base_url()
    return f"{base_url}{normalized_path}" if base_url else normalized_path


def read_json_file(path: str | Path, fallback: Any) -> Any:
    return read_json(path, fallback)


def write_json_file(path: str | Path, payload: Any) -> None:
    write_json(path, payload)


def read_user_db(user_id: str, db_name: str, fallback: Any) -> Any:
    return read_json_file(get_user_db_path(user_id, db_name), fallback)


def write_user_db(user_id: str, db_name: str, payload: Any) -> None:
    write_json_file(get_user_db_path(user_id, db_name), payload)


def read_account_db(user_id: str, db_name: str, fallback: Any) -> Any:
    return read_json_file(get_account_db_path(user_id, db_name), fallback)


def write_account_db(user_id: str, db_name: str, payload: Any) -> None:
    write_json_file(get_account_db_path(user_id, db_name), payload)


def read_profile_db(user_id: str, fallback: dict[str, Any] | None = None) -> dict[str, Any]:
    payload = read_user_db(user_id, "perfil", fallback or {})
    return payload if isinstance(payload, dict) else (fallback or {})


def write_profile_db(user_id: str, profile: dict[str, Any]) -> None:
    write_user_db(user_id, "perfil", profile)


def get_profile_section(user_id: str, section: str, fallback: Any) -> Any:
    profile = read_profile_db(user_id, {})
    value = profile.get(section)
    return value if value is not None else fallback


def set_profile_section(user_id: str, section: str, value: Any) -> None:
    profile = read_profile_db(user_id, {})
    profile[section] = value
    write_profile_db(user_id, profile)


def legacy_path(file_name: str) -> Path:
    return BACKEND_ROOT / file_name
