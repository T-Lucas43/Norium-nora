# Plano — Tela de login, pendências da Fase 1, Fase 6 (Nora) e Fase 7 (LGPD e operação)

## Contexto
O usuário perguntou se as correções do plano de ação (PDF `Norium-plano-de-acao.pdf`) já foram todas feitas e pediu para executar as Fases 6 e 7, sem esquecer a tela de login. A auditoria item a item (55 itens, verificador + revisor cético) mostrou: **2 feitos, 28 parciais, 25 não feitos**. Fases 6 e 7 são mudanças estruturais (banco, dependências, contratos de API), por isso este plano vem antes da implementação (política Atenza).

Regras permanentes: nenhuma tela ou funcionalidade é removida, escondida ou mascarada; logo oficial do Norium; pt-BR; commits pequenos `tipo: descrição` + `CHANGELOG.md`; nada publicado em homologação/produção sem autorização explícita.

## Resultado da auditoria (resumo)
- **Feitos:** menu lateral (F3.1); módulos carregados só quando abertos (F5a.1).
- **Fase 1 — parciais que entram neste plano (são correções de segurança):**
  - F1.1 financeiro: frases "apaga/exclua/remova…" não são reconhecidas como exclusão; execução aceita aprovação genérica sem digest; busca do alvo por trecho, não por palavra.
  - F1.2 WhatsApp: envio direto ainda não passa pela Central de aprovação.
  - F1.3 `/natural/stream` não filtra mensagens "system" do cliente.
  - F1.4/F1.5 segundo mascarador em `nora/brain/planner.py` ainda confunde celular com CPF; caminhos de IA fora do mascaramento.
  - F1.6 `lucas123` ainda como valor padrão em ~20 funções internas.
  - F1.8 provedores de IA não aprovados não são bloqueados.
- **Fora deste plano (ficam para depois, registrados no `BACKLOG.md`):** Fase 0 (README, linha de base, regressão visual, ambiente em um comando), Fase 2 (camada única de cores, componentes React únicos, lint), Fase 3 (busca que pergunta à Nora, painel da Nora encaixado, barra inferior no celular), Fase 4 (quebrar componentes gigantes, botões únicos), Fase 5 (virtualização, cache de consultas, CSS que cresceu de 12,6 mil para 19,2 mil linhas, paginação, alertas, metas), Fase 8.

## Decisões do usuário (10–11/10/2026)
- Tokens: franquia padrão configurável por plano + limite por pessoa, alertas 80%/95%, editável no admin.
- Pesquisa web: Brave Search API (`BRAVE_SEARCH_API_KEY`, o usuário criará a chave e colocará no `.env`; até lá, testes com respostas simuladas).
- Conhecimento: OpenAI embeddings (textos mascarados antes de sair).
- Chaves locais: **só a Groq** pode ser lida do `.env` local → cérebro e embeddings testados com modelo simulado; planner do cérebro configurado para `NORA_BRAIN_PROVIDER=groq` no teste local real.
- Cérebro da Nora: ativar e testar no PostgreSQL local (Docker) primeiro; homologação só com autorização posterior.

## Etapa 0 — Tela de login (retomar)
`norium-front-end/src/components/auth/**`: login, cadastro, esqueci a senha, escolha "Usar sistema / Gerenciar sistema", ações de e-mail. Padrão do PDF (fonte: `scratchpad/mockup/pages2.js`), logo oficial `BrandLogo`, claro/escuro, 375px, autocomplete correto, sem mexer em lógica de autenticação. Testes `src/components/auth` + conferência no navegador.

## Etapa 1 — Fechar a Fase 1
- `finance/router.py:1103-1118` reconhecer verbos reais (apaga, exclua, remova, deleta, altera, muda, edita, corrige); `execute_finance_exact` recusa aprovação sem digest/tenant; casar título por palavra inteira. Teste com a frase "apaga o lançamento X".
- `/agentes/mensagens/enviar` (`nora/router.py:2152-2178`) cria aprovação exata (digest, `expiresAt`, idempotência via `approval_digest`/`_enforce_approval_binding`, `operations/service.py:364-433`) em vez de enviar; WhatsApp legado (`nora_whatsapp_execute`) ganha digest; edição de texto recalcula.
- `/natural/stream` aplica `client_messages_for_model`.
- `brain/planner.py` `sanitize` passa a usar `core/ai_guardrails.minimize_for_ai`; varrer chamadas de IA restantes.
- Remover `lucas123` como padrão nas funções internas restantes (manter só migração de dados legados).
- F1.8: política de provedores por tenant no gateway `complete_with_provider` (`intelligence/service.py:931`) — provedor fora da lista aprovada é bloqueado; lista padrão = provedores embutidos (Groq, OpenAI, Gemini).

## Fase 6 — Nora: cérebro único e tokens
Base existente: `app/modules/nora/brain/` (PostgreSQL, ponte HMAC, aprovação exata por etapa com digest e 24 h, estado `unknown`, 34 testes).

- **6.1 Corrigir e ativar localmente:** bug `system/router.py:101-104` (importa `repository` do lugar errado; está em `brain/runtime.py:12`); alinhar modelos `planner.py:75` vs `.env.example:106-107`; executor `python -m app.modules.nora.brain.worker` contra o banco `norium_brain` do Docker; `scripts/nora_brain_smoke.py` com os passos 2-5 do `docs/operations/nora-brain-runbook.md`.
- **6.2 Aprovação exata em tudo que sai:** pedidos compostos (`orchestrator.py:290-318`) e `request_sensitive_approval` (`nora/router.py:285`) passam a uma aprovação exata por operação, sem reexecutar texto livre; `mailbox_start` C → D.
- **6.3 Reconciliação:** e-mail do cérebro (`brain/tools.py:248`) envia `X-Norium-Email-Key=operationId` e ganha `reconcile` por esse cabeçalho (fallback `reconcile_email_send`, `operations/service.py:1032`); WhatsApp grava recibo por `operationId` (modelo `brain/task_bridge.py`) e confere com o eco `fromMe`; sem prova → `unknown` com caminho manual.
- **6.4 Especialistas → ferramentas do cérebro:** financeiro criar/alterar/excluir (R), tarefas compartilhadas/projetos, agenda editar/cancelar, automações criar/executar (R), chat da equipe enviar (R), brainstorm criar, busca no Conhecimento; `/natural` usa o cérebro quando ativo, caminho atual mantido como reserva; unificar memória (`save_nora_memory` ↔ `nora_preferences`).
- **6.5 Tokens:** medidor único — `brain/budget.py` e o planner registram no `services/ai_costs.py` (`Meter`); franquia por plano em `app/shared/plan_catalog.py` (novo campo de tokens; `noraCalls` passa a valer) aplicada aos limites de `ai_costs` e aos tetos do `Budget`; alertas 80%/95% como notificação do sistema; trabalhos pausados retomam na virada do ciclo; tarifas padrão para os modelos em uso (`default_rate`, `ai_costs.py:166`); seções "Consumo da Nora" e "Consumo por pessoa" em Configurações.
- **6.6 Economia:** modelo rápido para conversa/classificação e avançado só para documentos em `services/nora.py`; cache curto de respostas idênticas por tenant; resumo da conversa por IA no lugar do corte de texto (`nora/context.py:151`).
- **6.7 Qualidade:** bateria pt-BR versionada em `tests/eval/` (negações, ambiguidades, pedidos compostos), comando manual contra o modelo real (Groq), meta ≥ 90%.
- **6.8 Conhecimento e web:** embeddings OpenAI guardados no PostgreSQL com fallback para a busca atual (`search_knowledge`, `intelligence/service.py:498`) + normalização de acentos; citação mantida; pesquisa web via Brave no lugar do RSS do Bing (`nora/router.py:164-174`), cobrada do usuário certo; teste de isolamento entre empresas.
- **6.9 Gmail sem a tela aberta:** worker leve com sincronização incremental por `historyId` (intervalo adaptativo, economia de banda).
- **6.10 Inventário de modelos** em `docs/AI_GOVERNANCE.md`.

## Fase 7 — LGPD e operação
- **7.1 Retenção e cota:** prazos configuráveis (variáveis de ambiente com padrão) aplicados por `run_data_lifecycle_maintenance` (`privacy/router.py:278`) a conversas da Nora, conversas e mídias do WhatsApp, uploads e `norium_system_logs`; anexos de chat da equipe, financeiro e tarefas contados na cota do workspace (`storage_limits.py`); rota de uso de armazenamento por workspace + aviso perto do limite.
- **7.2 Exportar e excluir:** incluir `team_chat_uploads/`, `finance_uploads/`, `task_uploads/`, SQLite locais (`ai_costs.sqlite3`, `automation_events.sqlite3`), log do sistema, `nora_tombstones`; revogar token do Google na exclusão; corrigir `_purge_due_workspace_directories` para limpar o `document_cache`; teste que enumera todos os armazenamentos por usuário e exige cobertura de exportação e exclusão; teste de ponta a ponta.
- **7.3 Subprocessadores e base legal:** `docs/lgpd/subprocessadores.md` + registro de tratamento (ROPA) e tabela de retenção; atualizar `LegalPage.tsx` (Shard, provedores de IA, Brave, ElevenLabs, W-API, Google, e-mail, TURN; encarregado/contato).
- **7.4 Logs e auditoria:** filtro de logging que mascara CPF, telefone e e-mail (reusa `ai_guardrails`) instalado no bootstrap; `record_system_log` sanitiza caminho e metadados; `POST /auditoria` deixa de aceitar registro forjado pelo cliente (só do servidor); trilha completa na Governança.
- **7.5 Backup e restauração:** script de ensaio para PostgreSQL + pasta de dados (dump, restauração em banco isolado, verificação, tempo medido) rodando no Docker local; atualizar `backup-and-restore.md` e `release-rollback.md` para Shard + PostgreSQL; registro de exclusões a reaplicar após restauração.

## Arquivos principais
Backend: `app/modules/nora/{router.py,orchestrator.py,context.py,brain/*}`, `app/modules/operations/service.py`, `app/modules/finance/router.py`, `app/services/{nora.py,ai_costs.py,gmail_service.py,system_logs.py}`, `app/modules/intelligence/service.py`, `app/modules/privacy/router.py`, `app/infrastructure/storage_limits.py`, `app/shared/plan_catalog.py`, `app/modules/system/router.py`, `app/bootstrap.py`. Frontend: `src/components/auth/**`, `src/components/settings/**`, `src/components/public/LegalPage.tsx`. Docs: `docs/AI_GOVERNANCE.md`, `docs/lgpd/`, `docs/operations/*`, `CHANGELOG.md`, handoff `docs/handoffs/2026-10-11-fase6-fase7.md`, `BACKLOG.md`.

## Riscos
- Fluxos que hoje enviam/executam direto passam a pedir aprovação (comportamento novo, intencional).
- Migração da Nora para o cérebro: manter o caminho atual como reserva até a bateria de qualidade passar.
- Sem chave da OpenAI no local: embeddings e planner OpenAI só com testes simulados; teste real do cérebro com Groq.
- Retenção apaga dados antigos: padrões conservadores, desligáveis, com teste e registro no CHANGELOG; nada é apagado em homologação/produção sem autorização.
- Workers novos (Gmail, retenção) com intervalos longos para não repetir a suspensão da Shard por RAM/banda.

## Verificação
- Backend: `python ..\scripts\run_backend_audit_tests.py` (suíte completa, hoje 1.392 testes) a cada etapa + testes novos de cada item.
- Frontend: `tsc -b`, oxlint, vitest completo, `vite build`.
- Cérebro: `scripts/nora_brain_smoke.py` contra o PostgreSQL local (health `driver: postgresql`, job queued→running→completed, nada executa antes da aprovação exata, reinício do executor → `unknown` sem segundo efeito).
- LGPD: teste de cobertura de exportação/exclusão; ensaio de backup/restauração com tempo medido; conferência de que logs não contêm CPF/telefone/e-mail.
- Navegador (http://localhost:5173): login, Nora (aprovação exata e reconciliação), Configurações > Consumo da Nora, Privacidade e dados, claro/escuro e 375px.
- Commits por etapa, CHANGELOG e handoff atualizados; sem push/deploy.
