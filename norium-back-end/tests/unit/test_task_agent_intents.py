from __future__ import annotations

import unittest

from app.modules.tasks.router import (
    extract_project_name,
    extract_title_for_create,
    is_create_intent,
    is_filtered_list_intent,
    is_list_intent,
    normalize,
)


class TaskAgentIntentTests(unittest.TestCase):
    def test_create_with_priority_is_not_misrouted_as_filtered_list(self) -> None:
        message = "Crie uma tarefa chamada Revisar layout final no projeto Operacao Norium com prioridade alta."
        normalized = normalize(message)

        self.assertTrue(is_create_intent(normalized))
        self.assertFalse(is_list_intent(normalized))
        self.assertFalse(is_filtered_list_intent(normalized))
        self.assertEqual(extract_title_for_create(message), "Revisar layout final")
        self.assertEqual(extract_project_name(message), "Operacao Norium")


if __name__ == "__main__":
    unittest.main()
