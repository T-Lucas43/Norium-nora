"""Verify the public Azure PostgreSQL root bundle before a production cutover."""
from __future__ import annotations

import os
import ssl
from datetime import datetime, timezone
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes


EXPECTED_SHA1 = {
    "DF3C24F9BFD666761B268073FE06D1CC8D4F82A4",  # DigiCert Global Root G2
    "73A5E64A3BFF8316FF0EDCCC618A906E4EAE4D74",  # Microsoft RSA Root CA 2017
}


def main() -> None:
    path = Path(os.environ["NORIUM_DATABASE_SSLROOTCERT"])
    certs = x509.load_pem_x509_certificates(path.read_bytes())
    fingerprints = {cert.fingerprint(hashes.SHA1()).hex().upper() for cert in certs}
    if fingerprints != EXPECTED_SHA1:
        raise RuntimeError("unexpected_postgresql_root_ca_bundle")
    now = datetime.now(timezone.utc)
    for cert in certs:
        if cert.not_valid_before_utc > now or cert.not_valid_after_utc <= now:
            raise RuntimeError("postgresql_root_ca_outside_validity_period")
        if not cert.extensions.get_extension_for_class(x509.BasicConstraints).value.ca:
            raise RuntimeError("postgresql_root_certificate_not_ca")
    ssl.create_default_context(cafile=str(path))
    print("postgresql_root_ca_bundle_verified")


if __name__ == "__main__":
    main()

