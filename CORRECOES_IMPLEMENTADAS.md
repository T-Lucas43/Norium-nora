# Correções implementadas — etapa parcial

Data de corte: 17/09/2026. Esta entrega registra somente mudanças implementadas e testadas localmente. O veredito geral continua **NO-GO** enquanto os demais achados e as dependências externas não forem concluídos.

## AUD-01 — leitura de persistência não pode apagar dados

**Estado:** implementado e testado no escopo dos stores JSON afetados.

- leitura usa fallback apenas quando a ausência inicial do arquivo é comprovada;
- corrupção, Unicode inválido, permissão, I/O, alteração durante a leitura e schema incompatível geram `PersistenceError`;
- a resposta HTTP é 503 redigida, com `Retry-After`, sem caminho, payload ou exceção bruta;
- stores financeiro, usuários, tarefas e comercial validam o formato antes de normalizar ou gravar;
- campos históricos desconhecidos são preservados nos stores de tarefas e comercial;
- dados inválidos permanecem intactos para investigação e restauração.

**Prova:** cenários vermelhos reproduziram o comportamento anterior; as rodadas verdes específicas executaram 17 e 13 testes sem falhas. A rodada consolidada final também passou.

## AUD-02 — membro normal não recebia acesso funcional ao chat

**Estado:** implementado e testado.

- a capacidade `teamChatEnabled` é derivada do diretório atual, do estado do membro e do plano ativo do proprietário;
- a capacidade não é persistida e não concede administração de equipe;
- remoção, inativação, logout, troca de equipe e perda do plano revogam sessões e sockets existentes;
- o frontend esconde e desmonta chat/chamada quando o acesso deixa de existir;
- acesso cruzado entre equipes e tentativa de elevar papel/permissões permanecem negados.

**Prova:** 11 testes direcionados de autenticação/equipe, 56 testes de regressão de equipe/autorização e 28 testes Vitest passaram.

## AUD-03 — permissões financeiras granulares eram ignoradas

**Estado:** implementado e testado.

- somente o proprietário explícito do sistema pode administrar concessões;
- auxiliares recebem negação por padrão e cada operação consulta a permissão persistida da identidade autenticada;
- todas as rotas administrativas financeiras foram associadas a `view`, gestão específica, importação ou exportação;
- tentativas de autoelevação por ID, papel, equipe ou payload são negadas;
- leitura de permissões negadas não inicializa nem altera o store.

**Prova:** 16 testes, incluindo 59 variantes de autorização e ausência de mutação, passaram. A evidência detalhada está em `docs/evidence/aud03.md`.

## AUD-09 — rate limiting retornava 500

**Estado:** implementado e testado.

- a exceção esperada do limitador é convertida dentro do middleware em HTTP 429;
- `Retry-After`, `X-Request-ID`, cabeçalhos de segurança e `Cache-Control: no-store` são mantidos;
- outras exceções HTTP não são ocultadas por esse tratamento.

**Prova:** o teste vermelho reproduziu a exceção não tratada; a rodada verde passou com 17 testes, incluindo regressão de controle de acesso.

## Achados ainda abertos

AUD-04, AUD-05, AUD-06, AUD-07, AUD-08, AUD-10, AUD-11, AUD-12, AUD-13, AUD-14, AUD-15, AUD-16, AUD-17, AUD-18, AUD-19 e AUD-20. Nenhum deles deve ser considerado corrigido por associação com esta etapa.

## Triagem e evidências — 20/09/2026 (branch codex/nora-brain, sem commit)

Triagem estática do worktree (implementação + testes presentes; execução backend
pendente por falta de interpretador Python acessível à sandbox — ver bloqueios).
Nada abaixo altera o veredito NO-GO sem a validação executada indicada.

### Mapa implementação × teste (inspecionado, não executado no backend)

- AUD-04: `app/services/nora_files.py` (quota + remoção de expulsos) e
  `app/infrastructure/storage_quota.py`; testes em
  `tests/unit/test_audit_upload_quotas.py` (retenção, 413 sem órfão, falha de
  metadados, quota do navegador).
- AUD-05: checkpoints por efeito em `app/modules/automations/router.py`;
  teste `tests/unit/test_audit_automation_checkpoints.py`.
- AUD-06: `infra/azure/backup_archive.py` (Fernet, manifest SHA-256, snapshot
  SQLite, `integrity_check`) + `infra/azure/test_backup_archive.py` +
  `docs/operations/backup-and-restore.md` (RPO/RTO/retenção). Ensaio isolado
  com login ainda não registrado.
- AUD-07: `validate_payment_relations` em `app/modules/admin_finance/router.py`
  (422 para plano/assinatura/cliente incoerentes); teste HTTP
  `tests/unit/test_audit_finance_references.py`.
- AUD-08: lease + `uncertain` + `reconcile_request` em
  `app/infrastructure/reliability/idempotency.py`; endpoint
  `POST /api/system/idempotency/reconcile` em `app/modules/system/router.py`
  (404 chave desconhecida, 409 fora de `uncertain`, auditoria actor+note);
  testes `test_audit_idempotency_recovery.py` e
  `test_audit_idempotency_reconcile.py` (este último escrito nesta sessão).
- AUD-10: `/health` leve + `/health/ready` (fsync, espaço, Postgres da Nora)
  em `app/modules/system/router.py`; teste `test_audit_readiness.py`.
- AUD-11: `requirements.lock.txt` (69 linhas pinadas) adotado por
  `Dockerfile.azure` e `norium-back-end/Dockerfile`. Faltam evidências de
  pip-audit/SBOM executados.
- AUD-12: módulo `app/modules/privacy/` + `test_privacy_lifecycle.py` +
  `LEGAL_VERSION 2026-09-20` + ajustes em `LegalPage.tsx`. Falta conteúdo
  jurídico (dados da empresa, canal DPO, prazos) — decisão do usuário.
- AUD-13: sessão em `sessionStorage` (`useAuthSession`, remove `localStorage`)
  + revogação `sessionVersion` no backend. Teste de isolamento de fotos
  corrigido para o store real (ver frontend).
- AUD-14: catálogo único `app/shared/plan_catalog.py`; teste
  `test_audit_plan_catalog.py`.
- AUD-15: `validate_runtime_topology` (WEB_CONCURRENCY=1) + teste
  `test_audit_topology.py`.
- AUD-16: `docs/operations/release-rollback.md` + gates no workflow
  `azure-container-apps.yml` + `scripts/test_release_workflow.py`. Ensaio real
  de rollback e alertas externos pendentes.
- AUD-17: redação de segredo em logs + validação W-API; teste
  `test_audit_webhook_secret_transport.py`.
- AUD-18/19: teste `test_audit_workspace_lifecycle.py` (remoção revoga
  formulário público; assinatura por workspace).
- AUD-20: `vite.config.ts` com code-splitting + `check-bundle-budget.mjs`
  verde (LiveKit 514,61 KB sob exceção de 520 KB); dashboard refeito (abaixo).

### Frontend — executado e verde em 20/09/2026

- Dashboard: hero 218→132px, onda suavizada, entrada única da Nora,
  KPIs semânticos, Agenda/Tarefas priorizadas, Atividade rebaixada,
  "Seu dia" decisório, cabeçalho simplificado, navegação agrupada.
- Vitest completo: 114 arquivos, 675 testes — 114/114 arquivos e 675/675
  testes passando (inclui correção do setup de sessão em
  `WhatsAppDirectory.photo-refresh.test.tsx`, que assumia token em
  `localStorage` contra o contrato `sessionStorage` vigente).
- `tsc -b` exit 0; oxlint 0 erros (18 avisos preexistentes);
  `vite build` exit 0 + bundle budget verde.

### Bloqueios para fechar a validação

- Nenhum Python executável para a sandbox (venv aponta para base com ACL
  negada; sem winget/outro interpretador): suíte backend, pip-audit, SBOM
  e servidores locais não executados aqui. Escalar no Zed está desabilitado
  ("approval prompts are disabled").
- `listen EACCES` para qualquer porta: dev servers e inspeção em navegador
  pelo agente, impossíveis; sem ferramenta de navegador neste ambiente.
- Push/deploy/pipeline: aguardando validação backend + credenciais de rede.

Comandos para o dono validar o backend:
`cd norium-back-end; .\venv\Scripts\python.exe -m unittest discover -s tests -v`
e `python scripts/run_backend_audit_tests.py --label pos-correcao` na raiz.
