# AUD-03 — autorização do financeiro administrativo

Evidência local em 17/09/2026, base `a8196d82620b867692203295e5b35130adbed8a7`. Implementação e regressões concluídas; aprovação final do Astra é um gate separado. Nenhum acesso à produção, provedor externo ou dado real.

## Causa e implementação

`require_owner` usava `can_manage_system`, que aceita proprietário e auxiliar, sem consultar as flags persistidas. Um auxiliar restrito podia executar todas as ações e alterar sua própria matriz.

Cada handler agora verifica a ação antes de ler dados financeiros ou mutar o store. `require_permissions` consulta somente as flags do ID da identidade autenticada; campos do request não participam da decisão. Flags ausentes negam acesso. O padrão de `view` no payload também é falso. O proprietário do sistema, identificado por `is_system_owner`, mantém bypass explícito; proprietário de equipe/conta comum não recebe esse bypass. A compatibilidade anterior de administradores legados sem `systemAdminRole` é mantida pela função central de autenticação.

Somente o proprietário do sistema pode ler/alterar concessões. Nem `manageSettings` nem todas as flags juntas permitem ao auxiliar alterar concessões. Importação precisa da flag de importação e da gestão da coleção de destino, impedindo contornar a política trocando `kind`. Relatório PDF e CSV/XLSX exigem exportação. A leitura de permissões usa `permissions_for`, que nunca inicializa ou migra arquivos: até uma negação no primeiro acesso preserva ausência/bytes.

## Matriz completa

Prefixo de todos os caminhos: `/api/admin/finance`. `view` autoriza leitura; flags de gestão autorizam criação/alteração/exclusão da respectiva área, sem conceder leitura global ou exportação. O contrato existente contém oito flags; não foram inventadas novas flags de CRUD. Concessões combinadas estão ligadas por **E**.

| Método | Caminho | Permissão do auxiliar |
| --- | --- | --- |
| GET | `/dashboard` | `view` |
| GET | `/cash-flow` | `view` |
| GET | `/plans` | `view` |
| POST | `/plans` | `managePlans` |
| POST | `/plans/{plan_id}/duplicate` | `managePlans` |
| PATCH | `/plans/{plan_id}` | `managePlans` |
| DELETE | `/plans/{plan_id}` | `managePlans` |
| GET | `/subscriptions` | `view` |
| POST | `/subscriptions` | `manageSubscriptions` |
| PATCH | `/subscriptions/{record_id}` | `manageSubscriptions` |
| DELETE | `/subscriptions/{record_id}` | `manageSubscriptions` |
| GET | `/payments` | `view` |
| POST | `/payments` | `managePayments` |
| PATCH | `/payments/{record_id}` | `managePayments` |
| DELETE | `/payments/{record_id}` | `managePayments` |
| GET | `/expenses` | `view` |
| POST | `/expenses` | `manageExpenses` |
| POST | `/expenses/bulk-status` | `manageExpenses` |
| POST | `/expenses/{record_id}/duplicate` | `manageExpenses` |
| PATCH | `/expenses/{record_id}` | `manageExpenses` |
| DELETE | `/expenses/{record_id}` | `manageExpenses` |
| GET | `/references/{kind}` | `view` |
| POST | `/references/{kind}` | `manageSettings` |
| PATCH | `/references/{kind}/{record_id}` | `manageSettings` |
| DELETE | `/references/{kind}/{record_id}` | `manageSettings` |
| GET | `/goals` | `view` |
| POST | `/goals` | `manageSettings` |
| PATCH | `/goals/{record_id}` | `manageSettings` |
| DELETE | `/goals/{record_id}` | `manageSettings` |
| GET | `/budgets` | `view` |
| POST | `/budgets` | `manageSettings` |
| PATCH | `/budgets/{record_id}` | `manageSettings` |
| DELETE | `/budgets/{record_id}` | `manageSettings` |
| GET | `/settings` | `view` |
| PUT | `/settings` | `manageSettings` |
| GET | `/audit` | `view` |
| GET | `/permissions/{user_id}` | Sempre negado; somente proprietário do sistema |
| PUT | `/permissions/{user_id}` | Sempre negado; somente proprietário do sistema |
| POST | `/import/preview` | `importData` |
| POST | `/import/commit` | `importData` E `managePayments` para payments; E `manageExpenses` para expenses/jorro |
| GET | `/jorro/status` | `view` |
| POST | `/jorro/sync` | `importData` E `manageExpenses` E `manageSettings` |
| GET | `/export/{file_format}` | `exportData`; inclui CSV, XLSX e relatório PDF |

Os quatro valores de `kind` dos cadastros auxiliares são testados (`categories`, `suppliers`, `cost-centers`, `providers`). A matriz de teste compara cobertura com todas as 43 rotas/métodos registrados; 59 variantes concretas incluem todos os tipos de importação/exportação/cadastro.

## Proteção de persistência administrativa — parte do AUD-01

`ensure_store` rejeita contêineres incompatíveis, registros não-objeto, versão desconhecida e concessões não booleanas. Campos ausentes de stores legados são completados em cópia sem substituir valores inválidos. Coleções vazias válidas permanecem vazias. A camada comum de persistência, alterada pelo agente principal, distingue ausência comprovada de JSON null/corrupto, I/O e permissões; `PersistenceError` impede `_read_sync` de inicializar sobre falha de leitura. A migração histórica de dados demonstrativos só ocorre após validação do store; nunca durante leitura para autorização.

Arquivos alterados:

- `norium-back-end/app/modules/admin_finance/router.py`
- `norium-back-end/app/modules/admin_finance/repository.py`
- `norium-back-end/app/modules/admin_finance/schemas.py`
- `norium-back-end/tests/unit/test_admin_finance_authorization.py`

## Execuções e aceites

Comando da reprodução anterior à correção do módulo:

```powershell
& .\norium-back-end\venv\Scripts\python.exe -X utf8 .\scripts\run_backend_audit_tests.py --label aud03-red tests.unit.test_admin_finance_authorization
```

Início `2026-09-17T11:16:22.013301+00:00`; exit **1**; 12 testes, 492 falhas de subcasos, zero erros, zero skips; 51,109 s incluindo isolamento. A infraestrutura comum AUD-01 já estava corrigida; a reprodução demonstra os defeitos ainda existentes de autorização e validação do schema administrativo. Evidência: `output/pos-correcao/aud03-red.log` e `.json`.

Comando depois da implementação, incluindo quatro testes adicionais de combinação/revogação/ausência de efeitos:

```powershell
& .\norium-back-end\venv\Scripts\python.exe -X utf8 .\scripts\run_backend_audit_tests.py --label aud03-green tests.unit.test_admin_finance_authorization
```

Início `2026-09-17T11:20:22.357124+00:00`; exit **0**; **16 testes**, zero falhas, zero erros, zero skips; 31,095 s incluindo isolamento. Evidência: `output/pos-correcao/aud03-green.log` e `.json`.

O runner cria cópia descartável de fontes e raiz de dados temporária, remove o ambiente de credenciais, define `ENVIRONMENT=test`, `APP_ENV=test`, `PYTHON_DOTENV_DISABLED=1` e bloqueia sockets externos. As rotas são exercitadas por ASGI em memória sem lifespan/workers. Um teste usa `current_user` e token assinado reais com cadastro sintético em memória, e confirma que query/header de outro ID não alteram a identidade. A maioria dos testes substitui apenas a identidade autenticada, mantendo HTTP, schemas, guards e persistência reais.

Aceites executados: todas as flags falsas = 403 com bytes idênticos; cada flag isolada libera somente suas operações; owner mantém 200/201 em toda a matriz; autoelevação por payload/ID/rota é negada; importação não muda de coleção sem autorização; CSV/XLSX/PDF respeitam exportação; concessão/revogação tem efeito no request seguinte; arquivos ausentes não são criados por negação; corrupção/schema inválido preservam bytes; restauração da cópia íntegra recupera leitura. `git diff --check` direcionado retornou exit 0.

## Limites

Este lote não resolve AUD-07 (referências financeiras), AUD-14 (catálogo) ou outras fases. Não houve auditoria visual dos relatórios exportados, testes de provedor Jorro ou frontend neste lote. A prova HTTP controlada de `PersistenceError` é parte do lote AUD-01 do agente principal. Concessões inexistentes passam a negar auxiliares anteriormente irrestritos: o proprietário deve conceder explicitamente as ações necessárias. Nenhuma migração destrutiva é necessária. Permanece NO-GO global até aprovação dos P0 e demais gates obrigatórios.
