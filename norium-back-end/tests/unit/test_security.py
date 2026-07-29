from __future__ import annotations

import unittest

from app.core.security import (
    TokenValidationError,
    create_signed_token,
    decode_signed_token,
    hash_password,
    password_needs_rehash,
    verify_password,
)


class SecurityTest(unittest.TestCase):
    def test_password_hash_is_salted_and_verifiable(self) -> None:
        first = hash_password("senha-forte")
        second = hash_password("senha-forte")
        self.assertNotEqual(first, second)
        self.assertTrue(verify_password("senha-forte", first))
        self.assertFalse(verify_password("senha-errada", first))
        self.assertFalse(password_needs_rehash(first))

    def test_legacy_password_hash_remains_compatible(self) -> None:
        import hashlib

        salt = "00112233445566778899aabbccddeeff"
        digest = hashlib.pbkdf2_hmac(
            "sha256",
            b"senha-legada",
            bytes.fromhex(salt),
            180_000,
        )
        legacy = f"pbkdf2_sha256${salt}${digest.hex()}"
        self.assertTrue(verify_password("senha-legada", legacy))
        self.assertTrue(password_needs_rehash(legacy))

    def test_token_rejects_different_secret(self) -> None:
        token = create_signed_token(
            {"id": "user-1", "email": "user@example.com"},
            secret=b"a" * 64,
        )
        payload = decode_signed_token(token, secret=b"a" * 64)
        self.assertEqual("user-1", payload["sub"])
        with self.assertRaises(TokenValidationError):
            decode_signed_token(token, secret=b"b" * 64)


if __name__ == "__main__":
    unittest.main()
