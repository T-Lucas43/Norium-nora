from __future__ import annotations

import copy
import json
import re
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
    # Project workflows accept custom stage IDs. Legacy enum values remain
    # accepted, the create default is unchanged, and malformed IDs stay invalid
    # (covered by the status compatibility tests below).
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
    # A Central de Documentos amplia o enum historico sem remover os valores
    # proposal/contract aceitos pelos consumidores existentes.
    "components.schemas.TemplateCreate.properties.documentType.enum",
}

KANBAN_STATUS_SCHEMAS = {
    "components.schemas.CriarTarefaPayload.properties.status",
    "components.schemas.AtualizarTarefaPayload.properties.status.anyOf[0]",
}
KANBAN_NULLABLE_STATUS = "components.schemas.AtualizarTarefaPayload.properties.status.anyOf"


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
    if path == KANBAN_NULLABLE_STATUS and isinstance(baseline, list):
        test_case.assertIsInstance(current, list, path)
        test_case.assertEqual(len(baseline), len(current), path)
        for index, (old, new) in enumerate(zip(baseline, current)):
            _assert_schema_backward_compatible(test_case, old, new, f"{path}[{index}]")
        return
    if isinstance(baseline, dict):
        test_case.assertIsInstance(current, dict, path)
        for key, value in baseline.items():
            if path in KANBAN_STATUS_SCHEMAS and key == "enum" and "enum" not in current:
                # Custom Kanban column IDs widen the historical status enum.
                # Every historical value must still satisfy the real pattern.
                pattern = current.get("pattern")
                test_case.assertIsInstance(pattern, str, path)
                for legacy in value:
                    test_case.assertIsNotNone(re.fullmatch(pattern, legacy), f"Status removido: {legacy}")
                continue
            test_case.assertIn(key, current, f"Campo removido do schema: {path}.{key}")
            _assert_schema_backward_compatible(test_case, value, current[key], f"{path}.{key}")
        return

    test_case.assertEqual(baseline, current, path)


class KanbanStatusCompatibilityTests(unittest.TestCase):
    def test_wider_pattern_preserves_every_legacy_status(self):
        old = {"type": "string", "enum": ["pendente", "andamento", "revisao", "concluida"]}
        new = {"type": "string", "pattern": "^[a-z0-9_-]{1,64}$"}
        _assert_schema_backward_compatible(self, old, new, next(iter(KANBAN_STATUS_SCHEMAS)))

    def test_narrower_pattern_and_missing_pattern_are_rejected(self):
        old = {"type": "string", "enum": ["pendente", "andamento"]}
        for new in ({"type": "string", "pattern": "^pendente$"}, {"type": "string"}):
            with self.assertRaises(AssertionError):
                _assert_schema_backward_compatible(self, old, new, next(iter(KANBAN_STATUS_SCHEMAS)))

    def test_other_enums_and_nullable_branch_remain_protected(self):
        with self.assertRaises(AssertionError):
            _assert_schema_backward_compatible(self, {"enum": ["ativo"]}, {"pattern": ".*"}, "other.status")
        with self.assertRaises(AssertionError):
            _assert_schema_backward_compatible(self, [{"type": "string"}, {"type": "null"}],
                                              [{"type": "string"}], KANBAN_NULLABLE_STATUS)


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
    baseline_responses = baseline_operation.pop("responses", {})
    current_responses = current_operation.pop("responses", {})

    test_case.assertEqual(baseline_operation, current_operation, path)
    # An optional query parameter adds FastAPI's 422 validation response. Existing
    # response contracts must stay identical; additional status codes are additive.
    for status, response in baseline_responses.items():
        test_case.assertIn(status, current_responses, f"Resposta removida: {path}.{status}")
        test_case.assertEqual(response, current_responses[status], f"Resposta alterada: {path}.{status}")

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

    def test_optional_parameter_may_add_validation_response(self) -> None:
        baseline = {"responses": {"200": {"description": "OK"}}}
        current = {
            "responses": {"200": {"description": "OK"}, "422": {"description": "Validation error"}},
            "parameters": [{"name": "include_team", "in": "query", "required": False}],
        }
        _assert_operation_backward_compatible(self, baseline, current, "GET /example")

    def test_changed_existing_response_is_rejected(self) -> None:
        with self.assertRaises(AssertionError):
            _assert_operation_backward_compatible(
                self,
                {"responses": {"200": {"description": "OK"}}},
                {"responses": {"200": {"description": "Changed"}}},
                "GET /example",
            )

    def test_new_required_parameter_is_rejected(self) -> None:
        with self.assertRaises(AssertionError):
            _assert_operation_backward_compatible(
                self,
                {"responses": {}},
                {"responses": {}, "parameters": [{"name": "scope", "in": "query", "required": True}]},
                "GET /example",
            )

    def test_task_status_expansion_preserves_legacy_and_custom_stages(self) -> None:
        from app.modules.tasks.router import CriarTarefaPayload, AtualizarTarefaPayload
        baseline = json.loads(BASELINE_PATH.read_text(encoding="utf-8"))
        values = baseline["components"]["schemas"]["CriarTarefaPayload"]["properties"]["status"]["enum"]
        for status in [*values, "qualificacao", "etapa_2"]:
            with self.subTest(status=status):
                self.assertEqual(status, CriarTarefaPayload(projectId="default", title="Synthetic", status=status).status)
                self.assertEqual(status, AtualizarTarefaPayload(status=status).status)
        self.assertEqual("pendente", CriarTarefaPayload(projectId="default", title="Synthetic").status)
        self.assertIsNone(AtualizarTarefaPayload(status=None).status)

    def test_task_status_expansion_still_rejects_malformed_identifiers(self) -> None:
        from pydantic import ValidationError
        from app.modules.tasks.router import CriarTarefaPayload, AtualizarTarefaPayload
        for status in ("", "A" * 65, "status com espaco", "../privado", "Etapa"):
            with self.subTest(status=status):
                with self.assertRaises(ValidationError):
                    CriarTarefaPayload(projectId="default", title="Synthetic", status=status)
                with self.assertRaises(ValidationError):
                    AtualizarTarefaPayload(status=status)

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
