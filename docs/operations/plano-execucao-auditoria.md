# Plano de execução da auditoria — execução local

Data: 16/09/2026. Base conferida: branch `main`, SHA `a8196d82620b867692203295e5b35130adbed8a7`. Estado inicial: somente os cinco documentos da auditoria não rastreados; nenhuma alteração de código prévia indicada pelo Git. Os cinco documentos foram lidos integralmente, incluindo as 21 páginas do PDF. A classificação canônica é a de `AUDITORIA_PRE_LANCAMENTO.md`; o estado inicial permanece NO-GO.

`BE` neste plano significa `norium-back-end`; `FE`, `norium-front-end`. A presença de teste abaixo é inventário de cobertura relacionada, não resultado de execução nem prova suficiente do achado.

## Restrições e decisões de arquitetura

- Não acessar produção, provedores reais, dados reais, tokens reais; não fazer push/deploy. Testes escrevem somente em `NORIUM_DATA_DIR` temporário, com `PYTHON_DOTENV_DISABLED=1`, `ENVIRONMENT=test`, `APP_ENV=test`, workers externos desativados e transporte externo bloqueado ou fake.
- Manter formato dos dados íntegros existentes. Leitura não repara corrupção silenciosamente. Dados inválidos ficam preservados para restauração; migrações necessárias devem ter simulação, cópia íntegra e procedimento reversível.
- Autorizações e escopo derivam da sessão/contexto autorizado. Participação em equipe não concede gestão; permissões financeiras têm negação por padrão. Toda rota pública valida o ciclo de vida do proprietário/workspace.
- Efeitos externos com resultado incerto não são reenviados automaticamente. Lease vencido exige conciliação; checkpoint concluído nunca é executado de novo.
- Adotar a menor topologia segura atual: uma réplica e um worker, validada em IaC. Múltiplas réplicas ficam vedadas até migração transacional e prova específica.
- Preservar catálogo público corrente como base versionada ao reconciliar divergências, sem reprecificar silenciosamente contratos existentes; novos planos e assinaturas históricas devem ser tratados separadamente.
- Revisão jurídica, credenciais de homologação, entrega externa de alertas e auditoria da imagem final são dependências externas se não puderem ser comprovadas localmente. Não inventar aprovações ou digest.

## Lotes e propriedade de arquivos

1. **P0-A, persistência (root):** `BE/app/infrastructure/persistence/json_repository.py`, `BE/app/services/finance_store.py`, `BE/app/bootstrap.py`, testes próprios. Erro tipado distingue ausência comprovada, JSON/Unicode inválido, I/O, permissão e schema. HTTP 503 seguro e alerta sem payload/segredos. Provar bytes preservados, inicialização ausente, restore e stores consumidores.
2. **P0-B, membros (auxiliar de identidade):** dono exclusivo de `BE/app/modules/auth/router.py`, `BE/app/modules/team/*` e testes próprios. Inclui a parte AUD-01 de `read_user_store` em coordenação com root: validar schema antes de normalizar/persistir e nunca inferir ausência a partir de `exists()` que esconda erro. AUD-02 exige criação normal, login, chat/chamada, administração negada, equipe B negada, desativação/remoção/revogação.
3. **P0-C, financeiro (auxiliar financeiro):** dono exclusivo de `BE/app/modules/admin_finance/*` e testes próprios. AUD-03 exige inventário de todas as rotas, matriz operação→flag, owner explícito, flags falsas sem mutação, permissões individuais e negação de autoelevação.
4. **Gate P0:** revisar localmente o diff integral dos três P0 e a evidência executada, inclusive regressões de autorização existentes. Qualquer lacuna bloqueia P1. Não basta testar guards diretamente; cobrir HTTP e fluxo normal.
5. **P1-A, confiabilidade:** root assume AUD-08 e depois AUD-05 (`reliability/idempotency.py`, bootstrap, automations). Auxiliar armazenamento assume AUD-04 (`nora_files`, uploads, browser_runtime). Auxiliar operações assume AUD-06/10 (`operations`, `system`, novos utilitários). Mudanças em bootstrap ou IaC são coordenadas com um único dono por vez.
6. **P1-B, integridade e escopo:** auxiliar financeiro AUD-07, depois catálogo AUD-14 em coordenação exclusiva com auth/FE. Auxiliar identidade AUD-18 e ciclo de exclusão AUD-12 (`platform`, auth); root ou auxiliar distinto AUD-19 (`commercial`). Não editar auth ou platform simultaneamente.
7. **P1-C, release local:** AUD-11 e AUD-16; reconstrução descartável, pins/constraints, SBOM, auditorias; backup/restore e rollback local com dados sintéticos e tempos. A revisão técnica local cobre segurança de IA, arquivos e isolamento ampliado.
8. **P2:** AUD-09 bootstrap; AUD-13 sessão e documentos; AUD-17 webhook/logs; AUD-20 FE. Um auxiliar pode cuidar de FE enquanto root cobre backend, após P1. Remover warnings pela causa, preservar testes e adicionar orçamento verificável.
9. **P3 e gates:** AUD-15 restrição de escala, concorrência dentro da topologia suportada; suíte backend completa, lint/build/Vitest/interações, matriz A/B e navegador desktop/mobile compilado. Revisão técnica final, classificação dos 20 AUD e veredito; só então gerar e renderizar integralmente o PDF.

Dependências principais: AUD-01 → AUD-06/10/12; AUD-02 → AUD-14; AUD-03 → AUD-07; AUD-08 → AUD-05; AUD-06 → AUD-16; AUD-12/18 → validação de lifecycle AUD-19; AUD-11 + suites + AUD-16 → evidência de candidato. Os lotes 5–7 podem alternar tarefas pequenas independentes conforme disponibilidade, sempre depois do gate P0.

## Mapa por achado e regressão necessária

| AUD | Arquivos/fronteira | Testes relacionados existentes | Prova adicional obrigatória |
| --- | --- | --- | --- |
| 01 | `infrastructure/persistence/json_repository.py`, `services/finance_store.py`, `modules/auth/router.py`, bootstrap | `unit/test_json_repository.py`, `unit/test_store_loading.py` | Corrupção/Unicode/I/O/permissão/schema mantêm bytes; ausência inicializa; HTTP seguro; restore. O teste antigo que espera fallback em corrupção deve ser substituído pela nova garantia, não suprimido. |
| 02 | auth e team routers | `unit/test_access_control.py`, `unit/test_team_roles.py`, `test_team_collaboration.py`, `test_team_call_lifecycle.py` | Owner Equipe→membro→login→chat/call; gestão/admin/outro tenant negados; revogação. |
| 03 | admin_finance router/schemas, guard | `unit/test_access_control.py`, `unit/test_auth_administrative_hierarchy.py` | Matriz HTTP de todas as rotas/flags, ausência de mutação e bypass por ID/payload; owner. |
| 04 | `services/nora_files.py`, nora router, intelligence browser_runtime/service, arquivos privados | `unit/test_nora_files.py`, `unit/test_browser_access.py`, `unit/test_recording_retention_storage.py` | Quota arquivo/tenant/global, tipo/extensão, falha intermediária, substituição, exclusão, GC sem apagar referências. |
| 05 | automations router/events e store de execuções | `unit/test_automation_events.py`, `unit/test_automation_messages.py` | Falha pós-envio fake + retry envia uma vez; checkpoint durável, incerteza e conciliação. |
| 06 | operations router, `infra/azure/restore_local_data.py`, utilitário novo de backup integral | `test_operations_expansion.py` (export e redação apenas) | Backup consistente JSON/SQLite/anexos/contas/subworkspaces; hashes, SQLite integrity_check, login e download restaurados; criptografia/retenção. |
| 07 | admin_finance router/schemas/repository | Não identificado teste específico de relações; usar novo módulo dedicado | Referências inexistentes/incoerentes e tenant B dão 404/422 sem persistir; exclusão restrita; auditoria e inventário legado sem mutação. |
| 08 | `infrastructure/reliability/idempotency.py`, bootstrap | Não identificado teste específico de lease; novo módulo dedicado | Expiração não duplica; lease concorrente único; recuperação conhecida versus incerta; outbox conciliada. |
| 09 | bootstrap, `core/rate_limit.py` | `unit/test_access_control.py` (buckets) | Duas requisições HTTP reproduzem 401/429 com Retry-After. |
| 10 | system router, Bicep, Dockerfile | `unit/test_access_control.py`, `unit/test_spa.py` | Liveness 200; readiness 503 para storage inválido/sem escrita/sem espaço/dependência inválida, timeout e resposta redigida. |
| 11 | requirements/constraints, Dockerfile, workflow | Gates pip check/SCA existentes no CI; não equivalem a novo release | Ambiente limpo reproduzível, SBOM, SCA da imagem associada ao digest quando possível; registrar qualquer impedimento. |
| 12 | LegalPage, auth, platform, novo serviço de direitos/retensão | `unit/test_access_control.py`, FE `SettingsDashboard.test.tsx`, `PlatformDashboard.test.tsx` | Exportação/exclusão/anonimização e revogação sintéticas, consentimentos e trilha; aprovação jurídica externa explícita. |
| 13 | FE useAuthSession/config; security; SECURITY e SECURITY_CONTROLS | FE `useAuthSession.test.ts`, `core/api/client.test.ts`; BE `unit/test_security.py`, reauthentication | Política coincide com storage real; lembrar sessão explícito, revogação e ações sensíveis; documentar avaliação HttpOnly/CSRF. |
| 14 | catálogo compartilhado; auth; admin_finance repository; AuthScreen | `unit/test_access_control.py`, FE `AdminDashboard.test.tsx`, `TeamDashboard.test.tsx` | UI/API/seeds iguais, criação/convite no limite e concorrentes não excedem assentos; legado preservado. |
| 15 | Bicep, Dockerfile, locks; docs | `unit/test_call_release.py`, `unit/test_wapi_binding_concurrency.py` | IaC rejeita múltiplas réplicas/workers; capacidade/limites explícitos e concorrência sintética sem perda no escopo suportado. |
| 16 | workflow; diagnostics/system_logs; Bicep/runbooks | `unit/test_system_logs.py`, `unit/test_team_call_alert_probe.py`, `unit/test_team_call_release_gates.py` | Rollback local cronometrado, dados compatíveis; métricas erro/latência/disco/jobs/filas; alerta fake recebido; entrega externa pendente se não autorizada. |
| 17 | wapi_connect, chat webhook, bootstrap redaction | `unit/test_webhook_configuration.py`, `unit/test_wapi_webhook.py`, `unit/test_wapi_webhook_debug.py`, `unit/test_chat_security.py` | Segredo sintético não aparece em URL/log/tracing; rotação, replay e instância; contrato externo não presumido. |
| 18 | platform service/router e lifecycle | `unit/test_access_control.py`, `unit/test_user_isolation.py`; FE PlatformDashboard | Formulário secundário GET/POST funciona antes e é negado após remover/arquivar/revogar; nenhum efeito residual. |
| 19 | commercial service/repository, tenant context | `test_commercial_module.py` (assinatura pública existente) | Token com workspace secundário resolve sem header; alteração/expiração/revogação falham; contexto/ID B nunca resolve. |
| 20 | FE arquivos de maior risco, Vite, componentes/controles | Vitest atual, `TasksDashboard.test.tsx`, `NoraWorkspace.test.tsx`, `AutomationsDashboard.test.tsx` | Lint sem aumento e redução real, orçamento chunks, lazy loading seguro, teclado/foco/nomes, desktop/mobile sem overflow/JS. |

## Evidência, revisão e encerramento

Cada tarefa entrega causa raiz, diff, comando exato, data, exit code, contagem, log, limitações e teste que reproduzia o defeito sem a correção. Evidências temporárias ficam em `output/auditoria-pos-correcao/` ou diretório descartável não versionado. Testes permanentes e relatórios entram em commits pequenos por área; nenhum artefato sintético de conta ou segredo entra no Git.

O responsável consolida `CORRECOES_IMPLEMENTADAS.md`, `RESULTADOS_DOS_TESTES_POS_CORRECAO.md`, plano e checklist. A revisão técnica final do diff emite `AUDITORIA_POS_CORRECAO.md`, diferenciando corrigido, parcial, não corrigido e dependente de validação externa. Sem comprovar os bloqueadores, o veredito continua NO-GO. O PDF só é gerado após aprovação do conteúdo e inspeção de todas as páginas renderizadas.

Antes de encerrar: `git diff --check`, ausência de segredos/dados temporários, lista de commits, suites com saída final recuperável, matriz A/B (CRUD/export/relações indiretas) e limitações explícitas. Produção permanece fora desta execução.
