from __future__ import annotations

import copy
import json
import unittest
from pathlib import Path
from typing import Any

from main import app


BASELINE_PATH = Path(__file__).with_name("openapi-baseline.json")
HTTP_METHODS = {"get", "post", "put", "patch", "delete", "options", "head"}
IGNORED_OPERATION_FIELDS = {"description", "operationId", "summary", "tags"}


def _public_contract(specification: dict[str, Any]) -> dict[str, Any]:
    """Mantém somente dados capazes de quebrar consumidores HTTP existentes."""
    paths: dict[str, Any] = {}
    for path, path_item in specification.get("paths", {}).items():
        operations: dict[str, Any] = {}
        for method, operation in path_item.items():
            if method not in HTTP_METHODS:
                continue
            stable_operation = copy.deepcopy(operation)
            for field in IGNORED_OPERATION_FIELDS:
                stable_operation.pop(field, None)
            operations[method] = stable_operation
        paths[path] = operations

    return {
        "paths": paths,
        "schemas": specification.get("components", {}).get("schemas", {}),
    }


def _assert_schema_backward_compatible(
    test_case: unittest.TestCase,
    baseline: Any,
    current: Any,
    path: str,
) -> None:
    """Aceita campos opcionais novos sem afrouxar o contrato historico."""
    if isinstance(baseline, dict):
        test_case.assertIsInstance(current, dict, path)
        for key, value in baseline.items():
            test_case.assertIn(key, current, f"Campo removido do schema: {path}.{key}")
            _assert_schema_backward_compatible(test_case, value, current[key], f"{path}.{key}")
        return

    test_case.assertEqual(baseline, current, path)


class OpenApiContractTest(unittest.TestCase):
    """Impede mudanças acidentais em rotas, parâmetros e estruturas JSON."""

    def test_public_openapi_contract_is_unchanged(self) -> None:
        baseline = json.loads(BASELINE_PATH.read_text(encoding="utf-8"))
        current = app.openapi()
        baseline_contract = _public_contract(baseline)
        current_contract = _public_contract(current)

        # O Norium cresce por adicao. Contratos historicos permanecem
        # identicos, enquanto novas rotas e novos schemas sao permitidos.
        for path, operations in baseline_contract["paths"].items():
            self.assertIn(path, current_contract["paths"], f"Rota removida: {path}")
            for method, operation in operations.items():
                self.assertIn(method, current_contract["paths"][path], f"Metodo removido: {method.upper()} {path}")
                self.assertEqual(operation, current_contract["paths"][path][method])

        for name, schema in baseline_contract["schemas"].items():
            self.assertIn(name, current_contract["schemas"], f"Schema removido: {name}")
            _assert_schema_backward_compatible(
                self,
                schema,
                current_contract["schemas"][name],
                f"components.schemas.{name}",
            )

    def test_expected_contract_size_is_preserved(self) -> None:
        baseline = json.loads(BASELINE_PATH.read_text(encoding="utf-8"))
        current = app.openapi()
        baseline_operation_count = sum(
            1
            for path_item in baseline.get("paths", {}).values()
            for method in path_item
            if method in HTTP_METHODS
        )
        current_operation_count = sum(
            1
            for path_item in current.get("paths", {}).values()
            for method in path_item
            if method in HTTP_METHODS
        )
        self.assertGreaterEqual(len(current.get("paths", {})), len(baseline.get("paths", {})))
        self.assertGreaterEqual(current_operation_count, baseline_operation_count)
        self.assertGreaterEqual(
            len(current.get("components", {}).get("schemas", {})),
            len(baseline.get("components", {}).get("schemas", {})),
        )


if __name__ == "__main__":
    unittest.main()
