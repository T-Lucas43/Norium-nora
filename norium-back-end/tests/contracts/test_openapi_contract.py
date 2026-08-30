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
INTENTIONAL_SECURITY_STRENGTHENING = {
    "GET /api/chat/foto-perfil",
    "GET /api/chat/media-proxy",
    "GET /api/chat/uploads/{file_name}",
}
INTENTIONAL_PARAMETER_STRENGTHENING = {
    ("GET /api/agenda/oauth2callback", ("user_id", "query")),
    ("GET /api/integracoes/google/callback", ("user_id", "query")),
    ("GET /api/auth/callback/gmail", ("user_id", "query")),
    ("GET /api/chat/status-canais", ("user_id", "query")),
    ("GET /api/chat/conversas", ("user_id", "query")),
    ("GET /api/chat/contatos-disponiveis", ("user_id", "query")),
    ("DELETE /api/chat/conversas/{conversa_id}", ("user_id", "query")),
}
INTENTIONAL_PARAMETER_DESCRIPTION_CHANGES = {
    ("GET /api/chat/media-proxy", ("url", "query")),
}
INTENTIONAL_PARAMETER_MIGRATIONS = {
    # A URL legada agora e opcional e serve apenas para localizar uma origem
    # previamente registrada; novos consumidores usam o media_id opaco.
    ("GET /api/chat/media-proxy", ("url", "query")),
}
INTENTIONAL_SCHEMA_CHANGES = {
    "components.schemas.NoraBoardPayload.properties.action.enum",
    "components.schemas.ComentarioPayload.properties.author.default",
    "components.schemas.PerfilOperador.properties.nome.default",
    "components.schemas.ProjetoPayload.properties.owner.default",
    "components.schemas.InicializarLoginPayload.properties.user_id",
    "components.schemas.InicializarLoginPayload.required",
    "components.schemas.EnviarMensagemPayload.properties.user_id",
    "components.schemas.EnviarMensagemPayload.required",
    "components.schemas.EnviarArquivoPayload.properties.user_id",
    "components.schemas.EnviarArquivoPayload.required",
    "components.schemas.ModificarChatPayload.properties.user_id",
    "components.schemas.ModificarChatPayload.required",
    "components.schemas.ApagarMensagemPayload.properties.user_id",
    "components.schemas.ApagarMensagemPayload.required",
}


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
    if path in INTENTIONAL_SCHEMA_CHANGES:
        return
    if isinstance(baseline, dict):
        test_case.assertIsInstance(current, dict, path)
        for key, value in baseline.items():
            test_case.assertIn(key, current, f"Campo removido do schema: {path}.{key}")
            _assert_schema_backward_compatible(test_case, value, current[key], f"{path}.{key}")
        return

    test_case.assertEqual(baseline, current, path)


def _assert_operation_backward_compatible(
    test_case: unittest.TestCase,
    baseline: dict[str, Any],
    current: dict[str, Any],
    path: str,
) -> None:
    """Aceita apenas parametros opcionais novos em operacoes existentes."""
    baseline_operation = copy.deepcopy(baseline)
    current_operation = copy.deepcopy(current)
    if (
        path in INTENTIONAL_SECURITY_STRENGTHENING
        and "security" not in baseline_operation
        and current_operation.get("security") == [{"HTTPBearer": []}]
    ):
        current_operation.pop("security")
    baseline_parameters = baseline_operation.pop("parameters", [])
    current_parameters = current_operation.pop("parameters", [])

    test_case.assertEqual(baseline_operation, current_operation, path)

    current_by_identity = {
        (parameter.get("name"), parameter.get("in")): parameter
        for parameter in current_parameters
    }
    baseline_identities = set()
    for parameter in baseline_parameters:
        identity = (parameter.get("name"), parameter.get("in"))
        baseline_identities.add(identity)
        test_case.assertIn(identity, current_by_identity, f"Parametro removido: {path}.{identity}")
        if (
            (path, identity) not in INTENTIONAL_PARAMETER_STRENGTHENING
            and (path, identity) not in INTENTIONAL_PARAMETER_MIGRATIONS
        ):
            current_parameter = current_by_identity[identity]
            if (path, identity) in INTENTIONAL_PARAMETER_DESCRIPTION_CHANGES:
                parameter = copy.deepcopy(parameter)
                current_parameter = copy.deepcopy(current_parameter)
                parameter.pop("description", None)
                current_parameter.pop("description", None)
                parameter.get("schema", {}).pop("description", None)
                current_parameter.get("schema", {}).pop("description", None)
            test_case.assertEqual(parameter, current_parameter, f"Parametro alterado: {path}.{identity}")

    for identity, parameter in current_by_identity.items():
        if identity not in baseline_identities:
            test_case.assertFalse(
                parameter.get("required", False),
                f"Novo parametro obrigatorio quebra compatibilidade: {path}.{identity}",
            )


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
                _assert_operation_backward_compatible(
                    self,
                    operation,
                    current_contract["paths"][path][method],
                    f"{method.upper()} {path}",
                )

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
