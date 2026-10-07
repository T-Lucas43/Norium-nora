"""Verified PostgreSQL TLS policy for operational and Nora stores."""
from __future__ import annotations


_VERIFIED_MODES = frozenset({"verify-ca", "verify-full"})


def production_tls_mode_allowed(sslmode: str, *, local: bool = False) -> bool:
    """Shared runtimes must verify certificates, regardless of legacy flags."""
    return local or sslmode in _VERIFIED_MODES
