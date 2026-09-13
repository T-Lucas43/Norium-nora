from __future__ import annotations

import unittest
from unittest.mock import patch

from app import bootstrap
from app.modules.team.call_configuration import (
    CallConfigurationError,
    DEFAULT_MESH_MAX_PARTICIPANTS,
    mesh_max_participants_from_environment,
)


class TeamCallConfigurationTests(unittest.TestCase):
    def test_default_is_conservative_and_explicit(self) -> None:
        self.assertEqual(6, DEFAULT_MESH_MAX_PARTICIPANTS)
        self.assertEqual(6, mesh_max_participants_from_environment({}))

    def test_configured_capacity_must_be_an_integer_at_least_two(self) -> None:
        self.assertEqual(
            8,
            mesh_max_participants_from_environment({"TEAM_CALL_MESH_MAX_PARTICIPANTS": "8"}),
        )
        for raw_value in ("", "one", "0", "1", "-2"):
            with self.subTest(raw_value=raw_value), self.assertRaises(CallConfigurationError):
                mesh_max_participants_from_environment({
                    "TEAM_CALL_MESH_MAX_PARTICIPANTS": raw_value,
                })

    def test_application_startup_fails_on_invalid_capacity(self) -> None:
        with patch.object(
            bootstrap,
            "validate_team_call_configuration",
            side_effect=CallConfigurationError("capacidade mesh invalida"),
        ):
            with self.assertRaisesRegex(CallConfigurationError, "mesh invalida"):
                bootstrap.create_app()


if __name__ == "__main__":
    unittest.main()
