"""Migra/rotaciona credenciais W-API ativas e snapshots, sem imprimir valores."""

from __future__ import annotations

import sys
from pathlib import Path


BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.core.credentials import CredentialConfigurationError
from app.services.wapi_binding import migrate_all_binding_credentials
from app.services.wapi_credentials import (
    validate_wapi_credential_encryption_configuration,
)


def main() -> int:
    try:
        validate_wapi_credential_encryption_configuration()
        result = migrate_all_binding_credentials()
    except CredentialConfigurationError as error:
        print(str(error), file=sys.stderr)
        return 2
    except Exception:
        print(
            "Falha na migração de credenciais W-API; verifique a configuração "
            "das chaves e a integridade dos registros.",
            file=sys.stderr,
        )
        return 1

    print(
        "Migração de credenciais W-API concluída: "
        f"{result['scanned']} arquivo(s) verificado(s), "
        f"{result['rewritten']} regravado(s)."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
