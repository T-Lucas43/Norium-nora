# Prompt para o Codex — concluir o plano de ação do Norium

> Entregue este arquivo inteiro ao Codex. Ele descreve o estado atual, as regras, a ordem de execução e, item por item, o que falta e como verificar.

## 1. Papel e regras obrigatórias

Você é o executor principal neste repositório (veja `AGENTS.md`). Siga também:

- **Política Atenza** (`atenza-digital/atenza-padroes`, pasta `rules/`):
  - Antes de tudo: `git status` e `git fetch`.
  - Commits pequenos `tipo: descrição` (feat, fix, docs, refactor, test, style, chore, perf).
  - `CHANGELOG.md` com uma linha por mudança relevante.
  - Tudo em português do Brasil com acentuação; datas `dd/mm/aaaa`, horas `HH:mm`, moeda `R$ 1.234,56`.
  - Credenciais só em variáveis de ambiente, nunca no código, em logs ou commits.
  - Schema só por migration/DDL idempotente. Nada destrutivo sem backup e confirmação.
- **Regra do usuário (absoluta):** nenhuma tela, funcionalidade ou dado pode ser removido, escondido ou mascarado pelo novo layout ou pelas correções. As correções de segurança só acrescentam aprovação/permissão.
- **Identidade visual:** sempre a logo oficial do Norium (`norium-front-end/src/components/layout/BrandLogo.tsx`, imagens `logo.png` / `logo-text-white.png`). Nunca trocar pelo "N" desenhado do mockup.
- **Agrupamento de telas:** só ficam separadas as telas que o usuário pediu (Modelos de mensagens, Agendamentos). Inteligência é um item único com abas internas; Perfil fica dentro de Configurações.
- **Ambientes:** nada vai para homologação (ShardCloud) ou produção sem autorização explícita do usuário, ação por ação, informando ambiente, ação, impacto e reversão. Não ler `.env` real sem autorização.
- **Shard (homologação):** a aplicação já foi suspensa 24 h por excesso de RAM e de tráfego de internet (PostgreSQL externo). Toda rotina em segundo plano deve ser leve: intervalos longos, pausa com aba oculta, cache, nada de varredura completa a cada requisição.
- **Definição de pronto:** implementado conforme o escopo, testado (backend e frontend), build ok, responsivo (375 px sem rolagem horizontal), claro e escuro, pt-BR, sem placeholders, `CHANGELOG.md` atualizado e handoff em `docs/handoffs/`.

## 2. Estado atual (11/10/2026)

### 2.1 Branch e main

- Todo o trabalho está na branch local **`feat/fase1-seguranca-voz`**, criada a partir de `origin/main` (`3fe718b`).
- **Nada disso está na `main` nem foi enviado ao GitHub.** O `git push` não funcionou nesta máquina por falta de credencial.
- Commits da branch, do mais novo ao mais antigo:

| Commit | O que faz |
|---|---|
| `3a35ee5` | feat(layout): telas de acesso (login, cadastro, recuperar senha) no padrão do layout aprovado |
| `b030eab` | feat(layout): Configurações no padrão do PDF, avatares e busca; perf do chat da equipe |
| `c4e0007` | feat(layout): telas no padrão do layout aprovado |
| `892b77b` | fix(layout): logo oficial do Norium de volta no menu e base visual das telas |
| `e2afa52` | feat(layout): menu e topo no padrão do layout aprovado |
| `6a1dadc` | perf: menos escrita de log, cache de mídia, worker sob demanda e imagens WebP |
| `c65e65b` | perf: cache de documentos com fila por usuário |
| `2f2842f` | perf: menos atualizações automáticas e layout mais leve |
| `7bb73b0` | feat(layout): base visual com tokens, fonte Inter local e azul unificado |
| `fd834b1` | fix(seguranca): falhar fechado sem usuário identificado |
| `c7719a5` | merge da correção do layout inicial da Nora (`codex/nora-welcome-layout-20261008`) |
| `75f78d1` | fix(nora): memória de equipe gravada só por quem gerencia a equipe |
| `4e764e1` | fix(lgpd): mascarar dados pessoais em toda chamada de IA |
| `71984ec` | fix(nora): permissões no envio de WhatsApp e mensagens system do navegador |
| `942a379` | fix(financeiro): exclusão e alteração pela Nora só com aprovação exata |
| `ea51c64` | feat(nora): voz ElevenLabs em tempo real com a voz Alice |
| `1878aa7` | fix(nora): corrige layout inicial e mostra retrato acima da saudação |

- Última verificação completa da branch (antes do trabalho inacabado):
  - backend: 1.392 testes, 0 falhas;
  - frontend: 833 testes, `tsc -b` sem erros, `oxlint` sem erros, `vite build` ok.
- Registro das decisões e desvios da Fase 1: `docs/handoffs/2026-10-10-fase1-seguranca-voz.md`.
- Histórico em `CHANGELOG.md`.
- Plano aprovado desta etapa: seção 4 deste arquivo.

### 2.2 Trabalho inacabado (não commitado)

Três frentes pararam no meio por limite de uso. As alterações estão salvas em **`docs/handoffs/2026-10-11-wip-inacabado.patch`** (18 arquivos, cerca de 400 linhas, mais 3 arquivos novos). O patch **não foi testado**.

- **Fase 1 (pendências):**
  - `app/modules/finance/router.py`, `app/modules/nora/router.py`, `app/modules/operations/service.py`;
  - troca de `lucas123` em `calendar/router.py`, `mail/router.py`, `tasks/router.py`, `services/agenda_agent.py`, `services/calendar_service.py`, `services/email_agent.py`, `services/gmail_service.py`.
- **Cérebro da Nora (reconciliação):**
  - `app/modules/nora/brain/{engine.py,repository.py,tools.py,workspace_tools.py}`;
  - novos `brain/outbound.py`, `app/services/gmail_reconcile.py`, `tests/unit/test_nora_brain_reconcile.py`;
  - `app/modules/system/router.py`.
- **Fase 7 (cotas):** `app/infrastructure/storage_limits.py`, `app/services/finance_store.py`, `app/services/task_store.py`.

**Primeira tarefa:**
1. Aplicar o patch na branch: `git apply docs/handoffs/2026-10-11-wip-inacabado.patch`.
2. Revisar cada arquivo.
3. Concluir o que estiver pela metade.
4. Rodar os testes.
5. Commitar por assunto.

Se algum trecho estiver incorreto, refazer a partir do zero conforme a seção 4. Não commitar código quebrado.

### 2.3 Resultado da auditoria do plano de ação (55 itens)

Cada item foi verificado contra o código e conferido por um segundo revisor.

- **Feitos (2):**
  - F3.1 menu lateral;
  - F5a.1 carregar cada módulo só quando aberto.
- **Parciais (28) e não feitos (25):** detalhes na seção 6, com o que falta em cada um.

## 3. Ambiente local

- **Pastas:**
  - Repositório: `C:\Users\Tarcisio Lucas\norium` (checkout principal);
  - worktree desta branch: `C:\Users\Tarcisio Lucas\worktrees\norium\terse-quartz\norium`.
- **Backend:**
  - Python 3.12 em `norium-back-end/.venv` (criado com `uv`).
  - Suíte completa: na pasta `norium-back-end`, rodar `.venv\Scripts\python.exe ..\scripts\run_backend_audit_tests.py --label <nome>` (cerca de 12 a 15 min). O log fica em `output/pos-correcao/<nome>.log`.
  - Testes pontuais: `ENVIRONMENT=test .venv\Scripts\python.exe -m unittest tests.unit.<modulo>`.
- **Frontend:** o `npm` pelo nvm falha nesta máquina, então use o Node direto, na pasta `norium-front-end`:
  - `"C:\Program Files\nodejs\node.exe" node_modules\typescript\bin\tsc -b`
  - `... node_modules\oxlint\bin\oxlint src`
  - `... node_modules\vitest\vitest.mjs run`
  - `... node_modules\vite\bin\vite.js build`
- **Banco local:**
  - container Docker `norium-postgres-local` (PostgreSQL) em `127.0.0.1:5433`, bancos `norium` e `norium_brain`, usuário `norium`;
  - a senha está num arquivo local fora do repositório e nunca deve ser versionada.
- **Variáveis importantes:**
  - `NORIUM_DATABASE_URL`, `NORA_BRAIN_DATABASE_URL`, `NORIUM_DOCUMENT_CACHE*`;
  - `NORA_TTS_PROVIDER=auto`, `ELEVENLABS_API_KEY`, `ELEVENLABS_MODEL_ID=eleven_flash_v2_5` (voz Alice `Xb7hH8MSUJpSbSDYk0k2`);
  - `GROQ_API_KEY`, `OPENAI_API_KEY`, `BRAVE_SEARCH_API_KEY` (nova);
  - `GOOGLE_*`, `GMAIL_*`.
- **Execução:**
  - Uvicorn com **uma única réplica** (`--workers 1`).
  - Frontend em `http://localhost:5173` com proxy para `http://127.0.0.1:8000`.
- **Chaves de IA no ambiente local:**
  - O usuário autorizou ler do `.env` local **só** `GOOGLE_*`, `GMAIL_*`, `ELEVENLABS_API_KEY`, `GROQ_API_KEY` e `BRAVE_SEARCH_API_KEY`. A Brave é uma chave que o usuário ainda vai criar.
  - A OpenAI **não** foi autorizada no local. Embeddings e o planner via OpenAI são testados com resposta simulada.

## 4. Decisões do usuário (valem para a implementação)

- **Tokens:**
  - franquia padrão configurável por plano e limite por pessoa;
  - alertas em 80% e 95%;
  - tudo editável no painel administrativo.
- **Pesquisa web:** Brave Search API no lugar do RSS do Bing. A Brave entra como novo subprocessador na lista LGPD.
- **Conhecimento:** busca por significado com OpenAI embeddings. Os textos são mascarados antes de sair, e a busca atual por palavras fica como alternativa.
- **Cérebro da Nora:** ativar e testar primeiro no PostgreSQL local. A homologação só com autorização posterior.
- **Funcionalidades novas:** ficam fora do escopo e não devem ser implementadas.
  - Grandes: Funil de vendas, Metas, Catálogo, Atendente Nora no WhatsApp, Portal do cliente, Cobrança Pix.
  - Rápidas: Notas, Importar clientes, Chat do site etc.
  - As propostas estão no PDF separado de novas funcionalidades. O usuário ainda vai escolher quais entram.

## 5. Ordem de execução

1. **Trabalho inacabado:** aplicar, revisar, concluir e testar o patch (seção 2.2). Commits por assunto.
2. **Fase 1:** fechar as pendências de segurança (itens F1.x da seção 6).
3. **Fase 6:** cérebro da Nora, aprovação exata, reconciliação, tokens, economia, qualidade, Conhecimento/web, Gmail e inventário de modelos (seção 6, itens F6.x, com o detalhamento abaixo).
4. **Fase 7:** retenção e cota, exportar/excluir, subprocessadores, logs e auditoria, backup e restauração (itens F7.x).
5. **Verificação completa:** backend e frontend, mais conferência no navegador em claro, escuro e 375 px.
6. **Publicação:**
   - `git push -u origin feat/fase1-seguranca-voz`;
   - abrir PR para a `main` com descrição, testes e riscos;
   - esperar o CI (`.github/workflows/shard-homologacao.yml`) passar.
   - **Merge e deploy na homologação só com autorização do usuário.**
   - Antes do deploy, conferir as variáveis novas na Shard: `NORA_TTS_PROVIDER`, `ELEVENLABS_API_KEY`, `NORIUM_DOCUMENT_CACHE*`, `BRAVE_SEARCH_API_KEY` e as variáveis do cérebro.
7. **Depois, em PRs próprios:** Fases 0, 2, 3, 4, 5 e 8 (itens da seção 6). Começar pelos de maior risco: regressão visual (F0.3/F4.4), linha de base de desempenho (F0.2), CSS que cresceu (F5a.4) e paginação (F5b.3).

### 5.1 Detalhamento técnico — Fase 6

- **6.1 Corrigir e ativar o cérebro**
  - Bug: `app/modules/system/router.py:101-104` importa `repository` de `brain/repository.py`, mas a função está em `brain/runtime.py:12`. Com o cérebro ligado, o readiness quebra.
  - Alinhar os modelos padrão de `brain/planner.py:75` com `.env.example:106-107`, sem inventar ids.
  - Rodar o executor `python -m app.modules.nora.brain.worker` contra o `norium_brain` local.
  - Criar `scripts/nora_brain_smoke.py` com os passos 2 a 5 do `docs/operations/nora-brain-runbook.md`:
    - health `driver: postgresql`;
    - job `queued→running→completed`;
    - nenhum efeito antes da aprovação exata;
    - reinício do executor leva a `unknown`, sem segundo efeito.
  - Documentar a topologia na Shard (container único, limite de RAM).
- **6.2 Aprovação exata em tudo que sai do sistema**
  - Pedidos compostos (`nora/orchestrator.py:290-318`) e `request_sensitive_approval` (`nora/router.py:285`, que hoje reexecuta o agente sobre o texto original) passam a ter uma aprovação exata por operação: digest com `approval_digest` e `_enforce_approval_binding` (`operations/service.py:364-433`), `expiresAt` de 24 h e idempotência.
  - O WhatsApp legado (`nora_whatsapp_execute`) ganha digest. Editar o texto recalcula o digest.
  - `mailbox_start` muda de política C para D.
- **6.3 Reconciliação dos envios**
  - E-mail do cérebro (`brain/tools.py` `send_email`):
    - enviar o cabeçalho `X-Norium-Email-Key=operationId`;
    - criar o `reconcile`, que busca em Enviados por esse cabeçalho, com fallback em `reconcile_email_send` (`operations/service.py:1032`).
  - WhatsApp:
    - gravar um recibo por `operationId` antes e depois do envio, no estilo de `brain/task_bridge.py`;
    - conferir com o eco `fromMe`;
    - sem prova, manter `unknown`, com caminho manual na tela.
- **6.4 Especialistas por palavra-chave → ferramentas do cérebro**
  - Criar as ferramentas abaixo, com contrato tipado, permissão, isolamento de tenant e teste de usuário sem permissão:
    - financeiro: criar, alterar e excluir (política R);
    - tarefas compartilhadas e projetos;
    - agenda: editar e cancelar;
    - automações: criar e executar (R);
    - chat da equipe: enviar (R);
    - brainstorm: criar;
    - busca no Conhecimento.
  - `/natural` usa o cérebro quando ele estiver ativo. O caminho atual continua como reserva.
  - Unificar a memória (`save_nora_memory` ↔ `nora_preferences`).
- **6.5 Tokens**
  - Medidor único: `brain/budget.py` e o planner registram no `services/ai_costs.py` (`Meter`). Hoje o uso do cérebro não aparece no ledger.
  - Franquia de tokens por plano em `app/shared/plan_catalog.py`. O `noraCalls` existe, mas não é aplicado: passar a aplicar e levar a franquia aos limites do `ai_costs` e aos tetos do `Budget` (hoje fixos em 1M/200k).
  - Alertas em 80% e 95% como notificação do sistema.
  - Trabalhos pausados por orçamento são retomados na virada do ciclo (hoje ficam pausados para sempre).
  - Tarifas padrão para os modelos em uso (`default_rate`, `ai_costs.py:166`; hoje `gpt-*` sem tarifa gera 402).
  - Seções "Consumo da Nora" e "Consumo por pessoa" em Configurações, como no mockup.
- **6.6 Economia de tokens**
  - Modelo rápido para conversar e classificar; modelo avançado só para documentos (`services/nora.py`).
  - `builtin_provider` (`intelligence/service.py:780`) passa a refletir o provedor ativo.
  - Cache curto de respostas idênticas por tenant.
  - Resumo da conversa feito por IA no lugar do corte de texto (`nora/context.py:151`).
- **6.7 Qualidade:** bateria pt-BR versionada em `norium-back-end/tests/eval/`, com negações, ambiguidades e pedidos compostos. Roda por comando manual contra o modelo real (Groq). Meta: 90% ou mais de acerto.
- **6.8 Conhecimento e web**
  - Embeddings OpenAI guardados no PostgreSQL, com a busca atual (`search_knowledge`, `intelligence/service.py:498`) como alternativa.
  - Normalização de acentos e citação da fonte.
  - Pesquisa web pela Brave no lugar do RSS do Bing (`nora/router.py:164-174`), cobrada do usuário certo.
  - Teste de isolamento entre empresas.
- **6.9 Gmail sem a tela aberta:** worker leve com sincronização incremental por `historyId`, com intervalo adaptativo. Hoje só sincroniza pela tela aberta, a cada 120 e 300 s.
- **6.10 Inventário de modelos e provedores** em `docs/AI_GOVERNANCE.md`.

### 5.2 Detalhamento técnico — Fase 7

- **7.1 Retenção e cota**
  - Prazos configuráveis por variável de ambiente (0 = desligado), aplicados por `run_data_lifecycle_maintenance` (`privacy/router.py:278`) a:
    - conversas da Nora;
    - conversas e mídias do WhatsApp em cache;
    - uploads órfãos;
    - `norium_system_logs` e o JSONL local.
  - Anexos de `team_chat_uploads/`, `finance_uploads/` e `task_uploads/` passam a contar na cota do workspace. Hoje são pastas planas, fora do usuário. Os caminhos antigos precisam continuar legíveis.
  - Rota de uso de armazenamento por workspace e aviso quando passar de 80%.
  - Evitar o `rglob` completo a cada gravação (`files.py:22`).
- **7.2 Exportar e excluir conta**
  - Cobrir o que hoje falta:
    - os três diretórios de upload acima;
    - os SQLite locais `ai_costs.sqlite3` e `automation_events.sqlite3`;
    - o log do sistema;
    - `nora_tombstones`;
    - o `adminAudit`.
  - Revogar o token do Google na exclusão (`POST https://oauth2.googleapis.com/revoke`, com timeout, sem falhar a exclusão).
  - Corrigir `_purge_due_workspace_directories` (`privacy/router.py:262`), que apaga direto no banco e não limpa o `document_cache`.
  - Teste que enumera todos os armazenamentos por usuário e falha se algum ficar de fora da exportação ou da exclusão.
  - Teste de ponta a ponta.
- **7.3 Subprocessadores e base legal**
  - `docs/lgpd/subprocessadores.md`, registro de tratamento (ROPA) e tabela de retenção.
  - Provedores a listar: Groq, OpenAI, Gemini, ElevenLabs, Edge TTS, Google Gmail/Agenda, W-API, SMTP, LiveKit/TURN, ShardCloud, PostgreSQL gerenciado, Brave Search e OpenAI embeddings.
  - Atualizar `norium-front-end/src/components/public/LegalPage.tsx`, que hoje cita "Microsoft Azure".
  - Encarregado e CNPJ: "a definir pelo responsável". Não inventar.
- **7.4 Logs e auditoria**
  - `app/core/log_masking.py`: `logging.Filter` que mascara CPF, telefone BR e e-mail, reaproveitando `core/ai_guardrails.minimize_for_ai`. Instalar no bootstrap.
  - `record_system_log` (`services/system_logs.py:73`) sanitiza mensagem, caminho e metadados.
  - `POST /api/operacao/auditoria` (`operations/router.py:101`) deixa de aceitar registro forjado pelo cliente.
  - Trilha completa e paginada na Governança.
- **7.5 Backup e restauração**
  - `scripts/backup_restore_drill.py`:
    - backup do PostgreSQL (`norium_documents`, `norium_blobs`, tabelas da Nora) e da pasta de dados num pacote criptografado, reaproveitando `infra/azure/backup_archive.py`;
    - restauração em banco isolado e verificação;
    - tempo medido de cada etapa.
  - Atualizar `docs/operations/backup-and-restore.md` e `release-rollback.md` para Shard + PostgreSQL.
  - Registro de exclusões a reaplicar depois de uma restauração.

## 6. Itens do plano de ação — status e o que falta (auditoria)


### Fase 0

#### F0.1 — README.md completo · ❌ Não feito

O README.md da raiz continua só com o título e a palavra "Pendente". Nenhum commit desta branch alterou o arquivo. Não há instruções de como rodar o projeto, nem lista de variáveis de ambiente, nem usuário de teste.

**O que falta:**
- Trocar o 'Pendente' do README.md da raiz por uma visão geral do projeto (back-end FastAPI em norium-back-end, front-end React/Vite em norium-front-end).
- Explicar como rodar localmente: pré-requisitos (versões de Python e Node, banco), instalação das dependências, migrations, comando para subir o back-end (uvicorn) e o front-end (npm run dev), e portas.
- Listar as variáveis de ambiente necessárias do back-end e do front-end, dizendo quais são obrigatórias, e indicar os arquivos .env.example. Nunca colocar valores reais.
- Documentar o usuário de teste: como criá-lo pelo seed ou script com dados fictícios, e as credenciais de teste vindas do próprio seed, sem dados reais.
- Opcional: trocar o README de template do norium-front-end por instruções próprias e criar um README no norium-back-end, ou apontar para o README da raiz.
- Registrar a mudança em uma linha no CHANGELOG.md.
- Os vários documentos soltos na raiz (DEPLOY_*.md, CONTEXT.md, SECURITY.md, CHECKLIST_DE_LANCAMENTO.md) não são citados em nenhum lugar. O novo README deveria apontar para eles, em vez de repetir o conteúdo.

_Observação:_ Este item não foi tratado nesta branch, que cuidou da Fase 1 (segurança e voz) e do layout. Não existe documento de setup em docs/ que substitua o README.

#### F0.2 — Relatório de linha de base com números · ❌ Não feito

Não existe relatório de linha de base com números para nenhuma das quatro medições pedidas: tempo para abrir o Painel, tamanho do pacote JS inicial, tempo de resposta das rotas mais usadas e tokens por pedido à Nora. O código já tem ferramentas que poderiam gerar esses números, mas ninguém mediu nem registrou os resultados em docs/, output/ ou docs/handoffs.

**O que falta:**
- Medir e registrar o tempo para abrir o Painel, por exemplo carregamento até a tela pronta, em produção ou homologação ou em ambiente local definido, informando o método.
- Registrar o tamanho do pacote JS inicial (bytes brutos e gzip/brotli dos chunks carregados na primeira tela), não só o aprovado/reprovado do check-bundle-budget.
- Levantar o tempo de resposta (p50/p95) das rotas mais usadas, usando as métricas de record_request ou o Server-Timing.
- Calcular os tokens consumidos por pedido à Nora (média e p95 de entrada e saída) a partir do registro de custos de IA.
- Consolidar tudo num relatório versionado em docs/, como docs/operations/AAAA-MM-DD-linha-de-base.md, com data, ambiente, método e números, para comparar com as fases seguintes.
- Registrar a entrega no CHANGELOG.md e no handoff.
- Os arquivos fase5-perf.json e perf-ws.json em output/pos-correcao também são só execuções de testes, não medições de desempenho. O primeiro auditor não os citou, e eles não mudam a conclusão.

_Observação:_ O texto do item F0.2 não existe no repositório. O plano versionado (docs/plans/2026-10-08-plano-expansao-nora.md) define outra Fase 0. Os commits de desempenho desta branch (2f2842f, c65e65b, 6a1dadc, b030eab) foram feitos sem números de antes, então hoje não dá para mostrar o ganho com dados. Não houve decisão registrada do usuário dispensando ou alterando este item.

#### F0.3 — Regressão visual automática · ❌ Não feito

Não existe teste de regressão visual no repositório. Nenhum teste compara capturas de tela com imagens de referência (sem toHaveScreenshot, toMatchSnapshot ou pixelmatch), não há pasta de imagens de referência e nenhum commit da branch trata disso.

**O que falta:**
- Escolher e instalar a ferramenta, por exemplo @playwright/test com toHaveScreenshot, ou o Playwright em Python já usado no projeto mais uma comparação de pixels, e adicionar um script como "test:visual" no package.json.
- Criar um ambiente de teste estável para as telas principais: dados fictícios com respostas de API simuladas (como faz o test_tasks_layout.py), fonte local, animações desligadas e data e hora fixas.
- Capturar e versionar as imagens de referência das telas atuais (menu, topo, Nora, Tarefas, Agenda, WhatsApp, Comercial, Financeiro, Configurações etc.) em desktop (1440px) e celular (390px), nos temas claro e escuro.
- Fazer o teste falhar quando a diferença passar de um limite definido e gerar a imagem de diferença como artefato.
- Incluir a regressão visual no CI (.github/workflows/shard-homologacao.yml) e documentar como atualizar as referências quando uma mudança visual for aprovada.
- Registrar no CHANGELOG.md e no handoff.
- Antes de capturar as imagens de referência, deixar a renderização igual em todas as execuções: a fonte Inter local (@fontsource-variable/inter) carregada antes da captura e um navegador e sistema fixos no CI, para o teste não falhar à toa.
- Definir em qual momento as referências são capturadas: depois dos commits de layout desta branch (e2afa52, c4e0007, b030eab), porque as telas atuais mudaram nela.

_Observação:_ O texto de F0.3 não aparece em nenhum documento do repositório. A \"Fase 0\" de docs/plans/2026-10-08-plano-expansao-nora.md:106 trata de outro assunto (matriz de ferramentas da Nora), então o item foi avaliado só pelo critério informado. Nenhuma decisão registrada do usuário muda ou dispensa este item. Isso pesa porque a branch já mudou bastante o visual (commits 7bb73b0, e2afa52, 892b77b, c4e0007, b030eab) sem uma referência visual automática, então hoje não há como provar por teste que essas mudanças não quebraram telas. Nenhum teste foi executado, porque a verificação é só de leitura.

#### F0.4 — Ambiente local sobe com um comando · ❌ Não feito

O item não está cumprido. Não existe um único comando versionado que suba backend, frontend e banco juntos. Hoje é preciso subir cada parte manualmente: o Postgres num container Docker criado à mão, o backend com uvicorn e o frontend com `npm run dev`.

**O que falta:**
- Criar um `docker-compose.yml` versionado com três serviços: Postgres 16 (bancos `norium` e `norium_brain`, com volume e healthcheck), backend (uvicorn com reload) e frontend (Vite), ligados por variáveis de ambiente.
- Alternativa: um script único versionado (por exemplo `scripts/dev.ps1` e `scripts/dev.sh`, ou um alvo `make dev`) que suba o banco, o backend e o frontend com um só comando.
- Incluir um `.env.example` de desenvolvimento local com `NORIUM_DATABASE_URL` e `NORA_BRAIN_DATABASE_URL` apontando para o Postgres local, e um seed com dados fictícios.
- Documentar o comando no `README.md` da raiz, que hoje só diz "Pendente", e registrar a mudança no `CHANGELOG.md`.
- Testar em máquina limpa que um só comando deixa o backend, o frontend e o banco acessíveis.
- Os arquivos .env.example do backend e do frontend existem, mas nenhum deles traz uma configuração de desenvolvimento ligada a um Postgres que o próprio repositório cria

_Observação:_ Nenhum commit desta branch (`origin/main..HEAD`) trata deste item, e o CHANGELOG não menciona ambiente local de um comando. A única referência é a nota do handoff sobre o Postgres em Docker criado manualmente. O `.claude/launch.json` serve só ao preview desta sessão: não está versionado, depende da pasta temporária da sessão e não inclui o banco. Não encontrei decisão do usuário que mude o escopo deste item.

### Fase 1

#### F1.1 — Exclusão/alteração financeira só com aprovação exata · 🟡 Parcial

O núcleo está pronto. Pela Nora, excluir lançamento, excluir gasto programado e alterar lançamento não mexem mais nos dados direto: geram uma aprovação presa por digest ao id do item e a uma foto do estado dele, e título parecido vira lista de opções. Ainda faltam três coisas: a frase do plano "apaga o lançamento X" nem é reconhecida como pedido de exclusão (nada é apagado, mas também não sai prévia), a execução aceita aprovação forjada pela rota genérica, sem digest e com dono de outro tenant, e a busca do item compara o título como trecho de texto, não como palavra inteira.

**O que falta:**
- Reconhecer as formas verbais usadas na prática (apaga, apague, exclua, exclui, remova, deleta, altera, muda, edita, corrige) em _is_delete_*_intent e _is_update_lancamento_intent (router.py:1103-1118). Hoje a frase do plano, 'apaga o lançamento X', cai em consulta e não gera prévia de aprovação.
- Adicionar teste com a frase literal do plano ('apaga o lançamento X'), cobrindo que não apaga e que gera aprovação. Faltam também testes de exclusão de gasto programado e do caminho completo pela Nora (nora/router.py e orchestrator).
- Em execute_approved_action ou execute_finance_exact: exigir action nora_finance_exact com digest presente e conferir que payload.ownerId é igual a tenant_id(user) de quem aprova. Hoje uma aprovação criada via POST /aprovacoes com financeExact e ownerId de outro tenant, sem digest, seria executada.
- Em _find_exact_target, casar o título por palavra inteira em vez de substring: hoje o item 'Gas' é escolhido como alvo exato de 'excluir gasto programado academia' quando não existe o item 'academia'.
- Para títulos idênticos duplicados, a lista de opções mostra só título e valor e pede 'o nome exato'. Não há como desambiguar pelo texto (falta mostrar data, vencimento ou um identificador curto).
- Rodar tests/unit/test_finance_agent_approval.py (não executado nesta verificação por restrição de RAM).
- Incluir as formas verbais (apaga/apague/exclua/exclui/remova/deleta; altera/altere/muda/edita/corrige) nas detecções do finance (router.py:1103-1118), por exemplo usando regex com \b como em tasks/router.py:1055.
- Em execute_approved_action (service.py:597-603): exigir digest presente e action nora_finance_exact e conferir que ownerId é o tenant de quem aprova.
- _find_exact_target (router.py:1068): casar o título por palavra inteira (\b) em vez de substring.
- Criar um teste de regressão com a frase literal 'apaga o lançamento X' e outro para a aprovação forjada com ownerId de outro tenant; nenhum teste foi executado nesta revisão.

_Observação:_ O handoff (docs/handoffs/2026-10-10-fase1-seguranca-voz.md, linha 12) e o CHANGELOG.md (linha 10) registram o item como entregue, sem desvio de plano. A garantia principal vale: nenhum caminho da Nora apaga ou altera direto; o único que executa é o aprovado, preso a id e snapshot. A frase do teste do plano não apaga nada, mas porque não é entendida como pedido de exclusão (cai em consulta), não porque passou pela aprovação. Fora do escopo direto: o orquestrador usa require_user_id(user) (orchestrator.py:256), enquanto a rota REST e o chat da Nora usam tenant_id(user); para membro de equipe, a etapa financeira do orquestrador atua no financeiro do próprio usuário, não no do tenant. Com autonomia confirm_all, pedidos como 'altere...' geram primeiro uma aprovação genérica e, depois de aprovada, a aprovação exata: aprovação dupla, mas segura.

#### F1.2 — Fechar envio direto de WhatsApp · 🟡 Parcial

Metade do item foi feita: o envio sem permissão de chat ou de WhatsApp agora devolve 403, e o envio também exige WhatsApp conectado. A outra metade não foi feita: o envio continua saindo direto, sem passar pela Central de aprovação, e ainda vale apenas o "autorizado: true" que o navegador manda.

**O que falta:**
- Fazer o envio do rascunho passar pela Central de aprovação. A rota /agentes/mensagens/enviar deveria criar uma aprovação com conversationId, messageText e instanceId exatos, usando o mesmo fluxo de operations/service.py:637-688, em vez de chamar agent_manager.execute_message direto.
- Parar de aceitar o 'autorizado' vindo do navegador como prova suficiente: hoje o Nora.tsx:2176 manda 'autorizado: true' fixo, e a rota (router.py:2159) e o agent_manager.py:113 confiam só nele.
- Opcional: em agent_manager.execute_message, exigir uma aprovação registrada no servidor (por exemplo, id ou digest da aprovação) em vez de um booleano.
- Testes de regressão provando que o envio só acontece depois de aprovado na Central e que um pedido com autorizado=true e sem aprovação não envia nada.
- Se o desvio for mantido, ele precisa de aceite formal do responsável no plano. O handoff registra a decisão, mas o critério 'envio passa pela Central de aprovação' continua não cumprido.
- Os testes não cobrem o caso em que só falta a permissão de chat (chat=False com integracao_whatsapp=True), embora o código já devolva 403 nesse caso.
- O CHANGELOG ou o plano precisam do aceite formal do responsável para o desvio. Hoje só o handoff registra a decisão.

_Observação:_ O handoff (linha 21) registra um desvio decidido para não remover funções: o envio direto continua, agora com permissões chat+integracao_whatsapp, autorizado=true, conexão ativa e limite de 1200 caracteres. Isso cumpre a parte do 403 do critério, mas contradiz a parte "envio passa pela Central de aprovação". Ela foi trocada conscientemente, não cumprida. Por isso fica PARCIAL e não FEITO. Se o responsável aceitar formalmente o desvio, o item pode ser reclassificado como "cumprido com desvio aprovado". Mesmo assim, o risco original continua: qualquer cliente autenticado com essas duas permissões pode chamar a rota com autorizado=true e qualquer texto, sem revisão no servidor. Também continua sem conferência no servidor de que o conversa_id pertence a uma conversa já existente da conta. Nada foi executado (análise só de leitura, sem rodar testes).

#### F1.3 — Rejeitar papel 'system' enviado pelo cliente · 🟡 Parcial

O item foi cumprido só em /chat e /natural. Em /chat a mensagem "system" do cliente vira mensagem de usuário com um prefixo, e em /natural ela é descartada. A rota /natural/stream não recebeu filtro nenhum, então um "system" enviado pelo cliente ainda chega ao modelo como instrução de sistema. Nenhum payload com role "system" é recusado.

**O que falta:**
- Filtrar ou recusar role "system" em /natural/stream (router.py:1776), igual ao /natural, antes de restore_natural_context.
- Criar um teste de regressão para /natural/stream: um payload com role "system" não pode chegar a perguntar_nora_stream como "system".
- Opcional, para cumprir o critério ao pé da letra: recusar "system" no schema das rotas /natural e /natural/stream (MessageItem só com user/assistant, retorno 422), mantendo a conversão só no /chat por causa da tela de E-mails, ou migrar E-mails para outro campo (ex.: "guidance").
- Defesa em profundidade em services/nora.py (_build_payload_messages): não aceitar "system" vindo de mensagens de cliente, ou separar o resumo do servidor por um campo próprio.
- Registrar no handoff que /natural/stream ficou de fora e atualizar o CHANGELOG.md quando corrigir.
- Filtrar "system" em /natural/stream (router.py:1792) antes de restore_natural_context, como já é feito em /natural (router.py:1285).
- Criar um teste de regressão para /natural/stream: um "system" enviado pelo cliente não pode chegar a perguntar_nora_stream com role "system", nem sem conversation_id nem sem resumo salvo.
- Decidir e registrar no handoff o desvio entre "recusar" e "converter/descartar". Opção: tirar "system" do MessageItem nas rotas /natural e /natural/stream (retornando 422) e manter a conversão só em /chat.
- Defesa em profundidade em services/nora.py:149-152: não repassar "system" de mensagens de histórico, ou passar o resumo do servidor por um parâmetro separado.
- Atualizar o CHANGELOG.md e o handoff quando corrigir.

_Observação:_ O usuário decidiu não recusar o "system" no /chat, porque a tela de E-mails depende dele, e converter em orientação comum. Isso tira o poder de sobrescrever o prompt naquela rota. Sobra o risco normal de qualquer mensagem do usuário (prompt injection), o que é aceitável. Mas o risco não foi eliminado no sistema todo: /natural/stream, usada pelo chat principal da Nora, segue aceitando "system" do cliente e repassando ao provedor. Na Responses API da OpenAI esse texto vai junto em "instructions". Por isso o item fica PARCIAL. A correção é pontual: uma linha de filtro na rota mais um teste.

#### F1.4 — Mascarar dados pessoais em toda chamada de IA · 🟡 Parcial

Os dois caminhos principais de texto para a IA já passam pela função de mascaramento minimize_for_ai: o gateway complete_with_provider, que cobre provedores extras, o planejador do navegador, automações e e-mail, e o perguntar_nora, que cobre a pesquisa web, os agentes, o e-mail e o comercial. Faltam três coisas: o cérebro da Nora (planner) não mascara cartão, a voz (ElevenLabs/Edge) e a transcrição (Groq Whisper) não passam por mascaramento, e a regex de CPF deixa passar formatos comuns como 529982247-25.

**O que falta:**
- Fazer o cérebro da Nora (brain/planner.py sanitize, também usado em workspace_tools.py:58/67/111) aplicar minimize_for_ai às strings, para cobrir cartão, chave PEM, JWT e password, e incluir um teste. Hoje só fica protegido porque NORA_BRAIN_ALLOW_MODEL_CALLS está desligado.
- Aplicar minimize_for_ai ao texto da voz (/voz: abrir_audio_elevenlabs_stream e gerar_audio_edge_tts_stream) antes de enviar à ElevenLabs ou ao Edge, ou registrar a decisão de que TTS fica fora do escopo.
- Decidir e registrar no handoff o tratamento da transcrição (/transcrever envia áudio bruto à Groq Whisper): aceite de risco, aviso ao usuário ou provedor alternativo, já que o áudio não pode ser mascarado.
- Ampliar a regex de CPF para pegar '000000000-00' e '000 000 000 00' sem confundir com celular (por exemplo, exigir dígito verificador válido quando houver separador parcial) e testar esses formatos.
- Ampliar os padrões de segredo: 'Bearer <token>', 'token='/'secret=' genéricos, 'senha 123' sem separador, chaves AWS (AKIA...) e Google (AIza...).
- Criar um teste de regressão que confirme o mascaramento no corpo HTTP do caminho perguntar_nora (Groq e OpenAI Responses), como já existe para complete_with_provider.
- Corrigir o CHANGELOG.md:14 ('em toda chamada de IA') ou registrar no handoff as exceções (TTS, STT e brain), para a documentação não afirmar uma cobertura que o código não tem.

_Observação:_ O commit 4e764e1 cobriu complete_with_provider e trocou a regex, preservando celulares com DDI, telefones fixos e 11 dígitos sem DV válido. Essa escolha evita mascarar números de WhatsApp, mas deixa passar formatos de CPF que o padrão antigo cobria. O mascaramento em perguntar_nora já existia no main, então a pesquisa web, o e-mail, os agentes e o comercial já estavam cobertos. Desvio do handoff que afeta só indiretamente: provedores de IA próprios continuam liberados por padrão, mas passam pelo gateway, então são mascarados. Efeito colateral sem impacto de privacidade: minimize_for_ai(system_prompt) corta o prompt de sistema em 24.000 caracteres (hoje o NORA_SYSTEM_PROMPT tem cerca de 9.000). Nenhum teste foi executado (só leitura).

#### F1.5 — Mascaramento não confunde telefone com CPF · 🟡 Parcial

A correção foi feita no mascaramento central de IA (ai_guardrails), que agora preserva celular de 11 dígitos e mascara CPF. Mas existe um segundo mascarador, em nora/brain/planner.py, que não foi corrigido e continua trocando um celular de 11 dígitos por "[CPF REMOVIDO]". Ele é usado na análise de caixa de e-mail, que está ativa, e no cérebro da Nora.

**O que falta:**
- Corrigir sanitize() em norium-back-end/app/modules/nora/brain/planner.py:38: trocar a regex pelo minimize_for_ai ou pelas mesmas regras de ai_guardrails (CPF formatado, ou 11 dígitos com dígito verificador válido), para que celular de 11 dígitos não seja mais mascarado na análise de e-mail nem no cérebro da Nora.
- Criar um teste de regressão para sanitize() do planner ou para mail/productivity: o celular 11987654321 fica preservado e o CPF 52998224725 ou 529.982.247-25 é mascarado.
- Risco residual a registrar: um celular de 11 dígitos que por acaso feche o dígito verificador de CPF (cerca de 1 em 100) ainda será mascarado. É uma limitação da heurística e não há teste nem documentação sobre isso.
- Lacuna menor: CPF escrito com espaços ou só com hífens (ex.: 529 982 247 25) deixou de ser mascarado, porque a regex nova só aceita o formato 000.000.000-00 ou os 11 dígitos seguidos.
- Corrigir sanitize() em norium-back-end/app/modules/nora/brain/planner.py:38 para que siga as mesmas regras de minimize_for_ai (CPF formatado, ou 11 dígitos com dígito verificador válido).
- Criar um teste de regressão para sanitize() do planner: o celular 11987654321 fica preservado e o CPF 52998224725 ou 529.982.247-25 é mascarado.
- Registrar o risco residual: um celular de 11 dígitos que por acaso feche o dígito verificador de CPF continua sendo mascarado.

_Observação:_ O CHANGELOG.md:14 e o handoff (linha 16) tratam o item como resolvido, mas citam só ai_guardrails.py e intelligence/service.py. O mascarador paralelo do planner não foi revisto. Só leitura: não editei nenhum arquivo. Testes executados: apenas tests.unit.test_ai_guardrails (5 OK) e uma checagem manual das duas regex com python -c. Nenhum teste de mail/productivity nem do planner foi executado.

#### F1.6 — Remover usuário fixo lucas123 · 🟡 Parcial

Nas rotas HTTP, o item está cumprido: a identidade vem só do token e, sem usuário, a resposta é 401. Não achei nenhum caminho que hoje grave dados na conta lucas123. Mas o 'lucas123' continua como valor padrão em cerca de 20 funções e classes de serviço. Em calendar_service e gmail_service, o `_safe_user_id` ainda cai em 'lucas123' quando o id vem vazio. Ou seja, a proteção depende de cada chamada passar o usuário; não é fechada em todas as camadas.

**O que falta:**
- Trocar o padrão `user_id: str = "lucas123"` por parâmetro obrigatório (sem padrão) nas funções de serviço: conversation_store.py (38, 60, 70, 75, 243, 268, 291, 316, 325, 340), task_store.py (170, 198, 262, 369), finance_store.py (34, 48), GmailService.__init__ (gmail_service.py:90), CalendarService.__init__ (calendar_service.py:65), EmailAgent.handle (email_agent.py:34), agenda_agent.handle (agenda_agent.py:34) e buscar_historico_whats (nora/router.py:574). Assim, uma chamada futura sem usuário quebra em vez de gravar na conta lucas123.
- Fazer `_safe_user_id` falhar fechado quando o id vier vazio, em vez de cair em 'lucas123': calendar_service.py:836 (usado no state do OAuth em :108) e gmail_service.py:1154.
- Opcional, para limpar o contrato: tirar ou neutralizar o padrão 'lucas123' dos parâmetros de query e campos de payload ignorados nas rotas de tarefas, financeiro, e-mail, agenda e Nora. Isso altera o contrato da API e a openapi-baseline.json, então é mudança estrutural e precisa de confirmação.
- Fora do 'lucas123', mas ligado a 'nenhum dado cai em tenant errado': ainda há padrões que mandam dados para um espaço compartilhado quando falta o id. São eles: intelligence/service.py:40 e browser_runtime.py:603,718,739,761,791 ('anonymous'), message_templates/router.py:51 ('primary') e core/tenant.py:90 (`safe_tenant_id` → 'anonymous'). Hoje ficam protegidos pelo `current_user`, mas não falham fechado.
- Ampliar test_identity_required.py para detectar `= "lucas123"` em assinaturas de serviço e o `or "lucas123"` de `_safe_user_id`, e incluir um teste de rota HTTP sem token esperando 401. Testes não executados nesta verificação.
- Há fallbacks legados especiais quando `user_id == "lucas123"`: calendar_service.py:442, 768-775 e 795-804 (lê o perfil_db.json legado e os arquivos globais TOKEN_PATH e OAUTH_STATE_PATH), gmail_service.py:1080 e 1117, conversation_store.py:43, inbox/router.py:187 e profile/router.py:125-156. O nome 'lucas123' segue ligado a dados globais legados. Se alguma conta real tiver esse id, ela herda tokens e conversas de arquivos fora do tenant. Para fechar por completo, esses dados precisam ser migrados para o tenant correto e esses ramos removidos (isso exige confirmação, porque mexe com dados).
- O teste estático de test_identity_required.py:37 só procura `get("id") or "lucas123"` e `str(user_id or "lucas123")`. Ele não pega `self.user_id or "lucas123"` nem os padrões `= "lucas123"` nas assinaturas, então hoje não protege contra regressão.

_Observação:_ Classifiquei como PARCIAL. Para requisições HTTP o critério de comportamento está atendido: sem token, 401 em `current_user`; id vazio, 401 em `require_user_id`; e não achei chamada que leve dados a lucas123. Porém o 'lucas123' segue como valor padrão nas assinaturas da camada de serviço e no `_safe_user_id` do OAuth do Google Agenda. A segurança depende de cada chamada passar o usuário, então não é fechada em todas as camadas, como pede 'remover como padrão'. O handoff registra como desvio intencional só os valores padrão de formulário e a compatibilidade legada: esses usos estão de fato inertes como identidade e são aceitáveis. Os padrões nas funções de serviço não aparecem no handoff. Não fiz push, deploy, edição nem rodei testes.

#### F1.7 — Memória de equipe só por administrador · 🟡 Parcial

A parte principal está feita. Membro comum não consegue mais gravar memória da equipe, nem pela tela (a API responde 403) nem pelo chat (o pedido vira memória pessoal com aviso). As memórias entram no contexto da IA marcadas como dados. Falta um ponto: membro comum ainda consegue apagar memória da equipe, e a marcação como dado tem pontos fracos.

**O que falta:**
- Restringir a exclusão de memória com scope='team' a quem gerencia a equipe: aplicar can_write_team_memory em remove_nora_memory (service.py:155-174) e devolver 403 na rota DELETE (router.py:267-274). Incluir o teste 'membro não apaga memória da equipe'.
- Proteger o delimitador em message_with_memory (nora/router.py:455): remover ou escapar '<<preferencias>>' e '<</preferencias>>' dentro dos valores, para uma memória não conseguir fechar o bloco e sair da área marcada como dado.
- Opcional, para reforçar: citar no system prompt da Nora que o bloco <<preferencias>> é dado e não instrução. Hoje o aviso só aparece na mensagem do usuário.
- Teste do caminho do chat: membro diz 'lembre que ... para a equipe' e a memória é salva como pessoal, com o aviso (nora/router.py:1371-1393). Hoje não há teste para isso.
- Frontend: esconder ou desabilitar 'Compartilhar com a equipe' e a lixeira das memórias da equipe para quem não gerencia a equipe, e mostrar o 'detail' do 403 em vez do JSON cru. Isso só acrescenta controle, sem remover tela, de acordo com a regra do handoff.
- Aplicar can_write_team_memory em remove_nora_memory para memória de equipe e devolver 403 na rota DELETE /memoria-nora/{id}, com teste de regressão 'membro não apaga memória da equipe'.
- Escapar ou remover '<<preferencias>>' e '<</preferencias>>' dos valores das memórias em message_with_memory (nora/router.py:455).
- Teste do caminho do chat em que o membro pede 'para a equipe' e a memória é salva como pessoal, com aviso.
- Frontend: esconder ou desabilitar o compartilhamento com a equipe e a exclusão para quem não é gestor, e mostrar o detail do 403 em vez do JSON cru.

_Observação:_ Mudança de critério: o plano diz "só por administrador", mas a implementação (commit 75f78d1, handoff linha 17 "Memória de equipe só por gestores") libera quem gerencia a equipe: dono (role owner), admin do sistema ou membro com a permissão 'equipe' delegada. Não há desvio formal disso registrado na seção "Desvios do plano" do handoff; vale confirmar com o usuário se "gestor" atende. O bloqueio de gravação, que é o critério de aceite explícito, está cumprido no backend. O item fica PARCIAL por dois motivos: a exclusão de memória da equipe continua aberta a qualquer membro, e a marcação "dado, não instrução" é só textual, sem escapar o delimitador. Nada foi executado (sem testes, só leitura). A branch não foi publicada.

#### F1.8 — Provedores de IA por política do tenant · ❌ Não feito

O gateway complete_with_provider não consulta nenhuma política de provedores aprovados do tenant: ele usa qualquer provedor cadastrado ou embutido que tenha credencial. Por decisão registrada no handoff, o item ficou pendente da escolha de política do administrador. Nesta branch o gateway ganhou só o mascaramento LGPD, que pertence a outro item.

**O que falta:**
- Decisão do administrador ou responsável sobre a política: quais subprocessadores ficam aprovados e se os provedores próprios já cadastrados continuam funcionando, por exemplo aprovando automaticamente os existentes.
- Guardar a política por tenant, por exemplo uma lista de providers ou provider kinds aprovados nas modelPolicies ou em um campo próprio, com endpoint restrito a administrador.
- Em complete_with_provider, antes de qualquer chamada externa e também no modo 'auto', recusar (403/409) o provedor fora da lista aprovada e o provedor com enabled=false.
- Fazer route_model excluir os provedores não aprovados do roteamento automático e do fallback.
- Restringir o cadastro e a alteração de provedores e baseUrl (router.py:394-401) a administrador, ou deixar cada provedor novo pendente de aprovação.
- Teste unitário provando que provedor não aprovado é bloqueado e que nenhuma requisição HTTP sai, no modo explícito e no automático.
- Registrar a mudança no CHANGELOG.md e atualizar o desvio no handoff.
- O caminho explícito de complete_with_provider (service.py:964-976) não verifica provider.enabled, então um provedor desativado ainda pode ser chamado pelo model_id enviado pelo cliente.
- test_provider (service.py:874-903) também faz chamada externa a provedor sem checar política; ele deve seguir a mesma allowlist.

_Observação:_ O desvio no handoff (linha 23) foi decidido para não remover uma função em uso, conforme a regra permanente de não esconder funcionalidades. Por isso o item está conscientemente pendente de decisão de política, e não esquecido. Hoje existe só um filtro de privacidade (dataPolicy) em route_model, usado pelo modo 'auto' com privacy 'any'. Ele não equivale a uma lista de subprocessadores aprovados e não vale para o provider_id escolhido pelo cliente. Verificação feita só por leitura de código e git diff, sem rodar testes.

#### F1.9 — Fase 1 publicada · ❌ Não feito

A Fase 1 não foi publicada. A branch existe só nesta máquina: não foi enviada ao GitHub, não entrou na main e não foi para homologação nem para produção. Também não há registro de que todos os testes passaram nem de uma revisão de segurança formal.

**O que falta:**
- Rodar a suíte completa de testes do backend (pytest) e do frontend (npm test e build) e deixar o resultado registrado, com tudo passando.
- Fazer e registrar a revisão de segurança da Fase 1. Ela deve cobrir aprovação exata no financeiro, permissões no envio de WhatsApp, mensagens 'system' do navegador, mascaramento LGPD, memória de equipe e o fim do fallback lucas123.
- Decidir como publicar a Fase 1 separada do layout. O critério diz "independente do layout", mas os commits de layout e de desempenho (de 7bb73b0 em diante) estão misturados na mesma branch, depois de fd834b1. Uma saída é publicar só até fd834b1 ou separar em outra branch.
- Com autorização, enviar a branch ao GitHub e abrir um PR para a main, para a esteira shard-homologacao.yml validar e gerar o pacote.
- Com autorização, configurar as variáveis na Shard (NORA_TTS_PROVIDER, ELEVENLABS_API_KEY e, se quiser, ELEVENLABS_MODEL_ID) e publicar em homologação.
- Validar em homologação: acesso externo, HTTPS e o fluxo de voz e de aprovações.
- Publicar em produção depois que a homologação for validada, com autorização a cada ação, plano de reversão e registro no CHANGELOG.md com número de versão.
- Os desvios registrados no handoff (envio direto em /agentes/mensagens/enviar, mensagens 'system' aceitas como orientação comum, provedores de IA próprios sem bloqueio, digest das aprovações de WhatsApp adiado) precisam ser avaliados e aceitos explicitamente na revisão de segurança antes de publicar.
- Na linha da tabela do OperationsDashboard.tsx, a coluna de testes diz apenas 'suíte frontend', sem teste específico para o envio do expectedDigest. É preciso confirmar essa cobertura antes de publicar.

_Observação:_ Segui a regra de não usar a rede para publicar: o `git ls-remote` não foi concluído porque não há credenciais no terminal. Por isso a conclusão vem das referências remotas já gravadas nesta máquina (origin/*) e do documento de passagem, que diz \"Sem push nem deploy\". Ponto de atenção: depois da Fase 1, a branch recebeu commits de layout e de desempenho, que são da Fase 2. Hoje, publicar a branch inteira publicaria também o layout, o que contraria o critério de publicar a Fase 1 \"independente do layout\". Não houve mudança de decisão do usuário sobre este item.

### Fase 2

#### F2.1 — Camada única de cores e fim do tema vidro/fundo animado · 🟡 Parcial

No tema padrão, o fundo animado e o vidro foram só desligados por sobreposição de CSS. O código continua no index.css e o tema personalizado ainda usa os dois. Em vez de uma camada única de cores, agora há três: a antiga (index.css, interface-theme.css e theme.ts), a --norium-* (tokens.css) e a --nx-* (ui-v2.css).

**O que falta:**
- Criar uma única camada de cerca de 24 tokens (claro e escuro) em styles/interface-theme.css e fazer --nx-*, --norium-* e as variáveis antigas (--surface, --background, --text, --border, --primary) apontarem para ela, ou ser substituídas por ela.
- Remover de fato do index.css o bloco do tema vidro (linhas 16-98) e o fundo animado (body, body::before e body::after nas linhas 110-150 e os @keyframes nas linhas 152-186), em vez de apenas sobrepor com tokens.css:67-76.
- Decidir o que fazer com o tema personalizado (utils/theme.ts:181-226), que hoje recria o vidro e o fundo em gradiente. Opção: passar a mudar só a cor de destaque e as cores sólidas, preservando a função, como exige a regra do handoff.
- Ligar --nx-primary e os demais tokens ao tema personalizado, porque hoje as telas novas ignoram a cor escolhida pela pessoa.
- Trocar as cores fixas restantes por tokens: cerca de 1.990 literais em CSS e TS, mais 706 classes Tailwind de paleta fixa, a começar por index.css, teamCall.css, noraWorkspace.css, teamChat.css e interface-theme.css.
- Registrar no CHANGELOG.md e no handoff a conclusão do item F2.1 ou o desvio decidido. Hoje não há registro.
- Testes de regressão visual ou de unidade cobrindo os temas padrão e personalizado não foram encontrados.

_Observação:_ O handoff (docs/handoffs/2026-10-10-fase1-seguranca-voz.md:6) traz a regra permanente "Nenhuma tela ou funcionalidade pode ser removida, escondida ou mascarada". O tema personalizado depende do vidro e do fundo em gradiente, o que provavelmente explica por que os dois foram só desligados no tema padrão. Não há, porém, desvio registrado para o F2.1 nem no handoff nem no CHANGELOG. A linha 17 do CHANGELOG ("base visual com tokens") e o commit 7bb73b0 falam em "camada única de tokens", mas o código tem três camadas paralelas. As linhas de index.css citadas no plano (13-86 e 105-180) correspondem hoje a 16-98 e 110-194, e o conteúdo é o mesmo do origin/main. Verificação só por leitura e git, sem build nem teste visual.

#### F2.2 — Fonte Inter, escala tipográfica e raios · 🟡 Parcial

A fonte Inter é carregada localmente e há tokens para a escala 12/13/14/16/20/24/32 e para os raios 8/12px. Mesmo assim, o critério não está cumprido: os tokens quase não são usados, continuam existindo centenas de tamanhos de fonte abaixo de 12px, muitos raios fogem de 8/12px e algumas telas pedem a família "Inter", que não é o nome que o pacote registra.

**O que falta:**
- Trocar 'Inter' por var(--norium-font) (ou incluir "Inter Variable" antes) em conversas.css:17 e 303, trabalho-comum.css:208 e teamCall.css:7, para essas telas usarem de fato a Inter carregada.
- Eliminar os tamanhos de fonte abaixo de 12px: 294 declarações CSS, 66 classes text-[10px]/text-[11px] e 3 fontSize inline, levando cada um ao piso de 12px.
- Aplicar a escala 12/13/14/16/20/24/32 nos estilos, usando os tokens --norium-text-*. Hoje há valores fora da escala como 12.5, 13.5, 15 e 26px (ui-v2.css), e os tokens de texto não são usados.
- Padronizar os raios em 8/12px: rever os 72 border-radius acima de 12px no CSS e as 64 classes rounded-2xl/3xl nos TSX. Opcionalmente, redefinir --radius-* no @theme do Tailwind. Decidir também se o token de 6px fica.
- Testar visualmente as telas afetadas (claro e escuro, desktop e celular) depois do ajuste.
- Os tokens --norium-radius-sm (6px) e --norium-radius-full (999px) ficam fora do critério 8/12px; é preciso decidir se continuam.

_Observação:_ Não achei o plano da Fase 2 nem uma decisão registrada sobre F2.2 no handoff ou no CHANGELOG. O CHANGELOG só cita "base visual com tokens, fonte Inter local". As contagens são de regex (font-size em px abaixo de 12 e text-[9-11px]); valores em rem/em foram 7 ocorrências em index.css. Nada foi executado nem alterado.

#### F2.3 — Componentes únicos · 🟡 Parcial

Botão, Card, Badge, Abas, Campo e Tabela existem só como classes CSS nx-* em ui-v2.css. Não viraram componentes React únicos, e nada foi montado sobre o shadcn: não há components/ui nem dependência Radix no projeto. Também não existe classe nem componente único para Diálogo e Menu. Convivem dois sistemas de botão (Button.tsx e nx-btn) e dezenas de diálogos e menus feitos à mão.

**O que falta:**
- Instalar de fato os componentes shadcn (Radix) indicados no components.json e criar src/components/ui, além de ajustar o alias @/lib/utils ou apontá-lo para utils/cn.
- Criar componentes React únicos para Botão, Card, Badge, Diálogo, Abas, Campo, Tabela e Menu, com a aparência nx-*/tokens aplicada sobre o shadcn.
- Unificar o botão: hoje convivem shared/Button.tsx (63 arquivos) e a classe nx-btn (48 arquivos, 269 usos), e 11 arquivos usam os dois.
- Criar um Diálogo único (com foco preso, Esc e aria) e trocar os cerca de 33 arquivos com role="dialog" feito à mão; ConfirmDialog e AppDialogProvider não são shadcn.
- Criar um Menu único (DropdownMenu) para os 5 menus feitos à mão.
- Padronizar Abas e Tabela: 2 dos 4 arquivos com role="tablist" não usam nx-tabs, e 8 dos 19 arquivos com <table> não usam nx-table.
- Registrar no CHANGELOG.md a entrega dos componentes únicos (hoje nada cita F2.3 ou componentes únicos).
- Os aliases do components.json (@/lib/utils, @/components/ui) não têm arquivo correspondente; antes de rodar o CLI do shadcn é preciso conferir o alias @ no tsconfig e no vite.config.

_Observação:_ Os commits de layout desta branch (7bb73b0, e2afa52, c4e0007, b030eab) aplicaram o visual do PDF só com classes CSS nx-*, seguindo a regra do handoff de "só aparência, sem remover funções". Não há registro de decisão do usuário que troque o shadcn por classes CSS; se essa troca foi intencional, ela precisa ser registrada como desvio no handoff. Mesmo nesse caso, Diálogo e Menu continuam sem padrão único. Verificação feita só por leitura do código; nenhum build ou teste foi executado.

#### F2.4 — Lint que barra cor fixa, !important e fonte arbitrária · ❌ Não feito

Nenhuma regra automática barra cor fixa, !important ou tamanho de fonte arbitrário. O único lint do frontend é o oxlint, que só tem duas regras de React, e não existe stylelint, script nem teste que faça essa checagem. Pelo contrário: o CSS novo desta branch (styles/screens/*.css) acrescentou dezenas de !important, cores fixas e font-size em px.

**O que falta:**
- Adotar um lint de CSS (por exemplo stylelint, com color-no-hex, declaration-no-important e uma regra que só aceite font-size por var(--token)) ou um script próprio em norium-front-end/scripts.
- Cobrir também as classes do Tailwind nos .tsx (text-[Npx], bg-[#hex], cores fixas em style={{}}), que o oxlint atual não verifica.
- Aplicar a regra só a código novo: baseline com as ocorrências atuais, exceções por arquivo ou checagem só do diff contra origin/main, para não travar o legado (1.355 !important).
- Ligar a checagem ao 'npm run lint' (ou a um script 'lint:css') e à etapa da CI em .github/workflows/shard-homologacao.yml, para que bloqueie de fato.
- Registrar a regra no CHANGELOG.md e documentar as exceções permitidas (por exemplo tokens.css, que define as cores).
- Definir onde ficam as exceções permitidas (por exemplo tokens.css, que define as cores) e registrar a decisão no handoff docs/handoffs/2026-10-10-fase1-seguranca-voz.md, já que esse item não aparece lá como desvio.

_Observação:_ Nem o handoff docs/handoffs/2026-10-10-fase1-seguranca-voz.md nem o CHANGELOG.md citam lint de estilo. O handoff só diz "Fase 2 (base visual) em seguida", e não há decisão do usuário que mude este item. A branch criou tokens (src/styles/tokens.css), mas nenhuma regra automática obriga a usá-los. Não rodei o lint nem testes, só verifiquei por leitura (Grep, Read, git diff).

#### F2.5 — Personalização só na cor de destaque · ❌ Não feito

A personalização de tema continua completa: o usuário Enterprise/admin ainda escolhe 16 cores, entre elas o fundo, os gradientes, os painéis, as bordas, os textos e os estados. O applyNoriumTheme também continua trocando o fundo e os gradientes do app inteiro. O utils/theme.ts não foi alterado nesta branch.

**O que falta:**
- Reduzir o applyCustomTheme (utils/theme.ts) para aplicar só a cor de destaque (primary e derivadas: --primary, --primary-strong/deep, --on-primary, --theme-soft, --theme-text). Deixar de gravar --app-background, --app-overlay, --background, --screen-background, --surface, --border, os gradientes do dashboard, --motion-stream, os textos e os status.
- Ligar a cor de destaque personalizada aos tokens do novo layout (--nx-primary, --nx-primary-soft, --nx-primary-text em ui-v2.css), além do --norium-accent.
- Remover ou neutralizar as regras de index.css (1566-1602 e seguintes) que, com data-norium-custom-theme, forçam --theme-gradient e --screen-background no fundo das telas. Manter o fundo sólido/animação desligada também com tema personalizado (tokens.css 67-76).
- Na tela de Configurações (SettingsDashboard.tsx 48-83 e 297-364), trocar os 16 seletores por um único seletor 'Cor de destaque' por tema (claro/escuro).
- Definir o que fazer com os campos antigos salvos em tema_personalizado (backend router.py 32-73 e frontend defaultThemeCustomization): ignorar na aplicação ou restringir/migrar o esquema. Mudança de contrato da API: exige plano e confirmação conforme as diretrizes.
- Registrar a mudança no CHANGELOG.md e validar visualmente nos temas claro e escuro, com e sem personalização.
- A personalização avançada sobreviveu ao redesenho do SettingsDashboard.tsx no commit b030eab. O redesenho podia ter reduzido os seletores a um só e não reduziu.
- --theme-gradient e --theme-border também saem de gradientStart/Middle/End e de border, e não da cor de destaque. Precisam ser derivados de primary ou deixar de ser sobrescritos.

_Observação:_ Não achei decisão do usuário sobre o F2.5 no CHANGELOG.md, no handoff (docs/handoffs/2026-10-10-fase1-seguranca-voz.md) nem em docs/. O único avanço relacionado é o mapeamento --norium-accent -> --primary em tokens.css:58-60. Ele não restringe nada; só faz parte das telas antigas seguir a cor primária. Por isso o status é NAO_FEITO, não PARCIAL.

### Fase 3

#### F3.1 — Menu lateral reorganizado · ✅ Feito

O item está cumprido. O menu lateral tem grupos recolhíveis e telas separadas. Inteligência virou um item único com abas internas. Notificações abrem pelo sino e Perfil abre pelo avatar e como seção de Configurações. Comparei com a origin/main e nenhuma tela ficou sem acesso.

_Observação:_ O plano mudou por decisão do usuário: Inteligência como item único com abas, Perfil dentro de Configurações e nenhuma tela pode sumir. O código segue essa versão, e o CHANGELOG.md registra a mudança nas linhas 23 e 25.

Para confirmar que nenhuma tela sumiu, comparei com o git diff da origin/main:
- As 23 telas do menu antigo continuam no novo.
- Perfil saiu do rodapé do menu, mas segue acessível pelo avatar e pelo menu de seções de Configurações.
- Notificações já não ficavam no menu na origin/main. O sino e o 'Editar perfil' do avatar já existiam lá.

Ressalvas:
- Nenhum teste automatizado garante que toda tela de PRIMARY_TABS esteja no menu. Fiz essa conferência manualmente.
- NoriumApp.tsx:384 ainda passa ao menu um contador de 'Notificações', mas o menu não tem esse item. O contador não tem efeito e não causa erro.
- Não rodei testes nem build, pela regra de somente leitura e pouca RAM.

#### F3.2 — Topo com busca única que pergunta à Nora e um sino só · 🟡 Parcial

O item está parcial. O topo já tem a busca com Ctrl K e o menu do avatar. Mas a busca não manda a pergunta para a Nora, o chat da equipe continua num ícone separado do sino e não existe "novidades" dentro do sino.

**O que falta:**
- Fazer a busca mandar o texto para a Nora: quando não houver resultado (ou numa opção fixa "Perguntar à Nora: <texto>"), chamar onOpenNora(query). O Enter também precisa fazer isso quando nenhum atalho combina.
- Juntar notificações, chat da equipe e novidades num sino só, com um contador somado. Hoje o chat da equipe tem ícone e contador próprios (Header.tsx:340-347), e isso precisa sair.
- Criar a fonte de "novidades" e mostrá-la dentro do sino. Hoje esse recurso não existe; o ReleaseBadge só mostra a versão.
- Adicionar testes no Header.test.tsx: digitar sem resultado e confirmar que onOpenNora recebe o texto; confirmar que só existe um ícone de sino com o contador somado.
- Registrar a mudança no CHANGELOG.md. Hoje só há linhas genéricas sobre o topo (linhas 23 e 25).
- Avisar o usuário quando a busca por dados der erro, em vez de mostrar só "Nenhum dado operacional corresponde à busca". Não confirmei isso no código e não é critério do F3.2.

_Observação:_ Nenhuma decisão registrada no handoff 2026-10-10 ou no CHANGELOG muda o F3.2. Os commits e2afa52 e b030eab só trocaram o texto do campo para \"Buscar ou pedir algo à Nora…\" e incluíram o caminho da tela. O texto promete uma função que o código não tem. O botão separado \"Nora\" no topo (Header.tsx:349-365) não conta como ícone de notificação, mas também não substitui a busca enviando a pergunta. Nenhum teste foi executado (só leitura, por limitação de memória da máquina).

#### F3.3 — Nora em um só lugar (painel encaixado) · 🟡 Parcial

Só existe a parte que já estava pronta na main: o botão "Nora" no topo, e o botão flutuante não aparece na tela. O principal do item não foi feito: a Nora ainda abre por cima da tela, com fundo escurecido, e não como painel encaixado à direita que empurra o conteúdo. Os atalhos repetidos para abrir a Nora também continuam. Nenhum commit desta branch mexeu nisso.

**O que falta:**
- Transformar a Nora (modo drawer) em painel encaixado à direita: tirar a classe "fixed", o z-index de sobreposição e a camada escura, e colocar o painel dentro do layout (ao lado de .norium-workspace ou como coluna dela).
- Fazer a área de trabalho encolher quando a Nora estiver aberta (por exemplo, uma classe de estado no app-shell com grid ou flex reservando a largura do painel), com comportamento definido no celular (lá pode continuar sobreposto).
- Revisar o botão de expandir/minimizar (nora-drawer-expanded, que usa inset de 12px) para combinar com o painel encaixado.
- Apagar FloatingNoraButton.tsx, que é código morto. Pela regra da organização, apagar código precisa de autorização.
- Tirar ou unificar os atalhos que só abrem a Nora sem contexto (Hero.tsx:53, AutomationsDashboard.tsx:1646 e outros) e manter apenas os que mandam um pedido com contexto, se o usuário decidir assim.
- Testes e build do novo comportamento (Header.test e um teste do layout com a Nora aberta) e uma linha no CHANGELOG.md.
- Nenhum teste ou registro no CHANGELOG.md/handoff documenta a decisão sobre o painel encaixado da Nora; a mudança não aparece como desvio aprovado em docs/handoffs/2026-10-10-fase1-seguranca-voz.md.

_Observação:_ Não achei este item da Fase 3 no CHANGELOG.md nem no handoff docs/handoffs/2026-10-10-fase1-seguranca-voz.md, que só fala das Fases 1, 2 e 6. Nos commits da branch (origin/main..HEAD), Nora.tsx só mudou para incluir o token no envio de áudio para transcrição, o retrato no estado vazio e a troca de posição das sugestões rápidas. Nada mudou no posicionamento do painel. As partes que conferem com o item (botão no topo e nenhum botão flutuante na tela) já estavam na origin/main. Na prática, o essencial do F3.3 não foi começado. A análise foi só por leitura do código: não rodei testes nem subi o app.

#### F3.4 — Rotas antigas preservadas com teste · 🟡 Parcial

As rotas foram mantidas: o tabs.ts não mudou nesta branch, e cada link antigo ou opaco continua levando à mesma chave de tela, que ainda é montada no AppPanels. O teste de rotas antigas, porém, já existia antes da branch e confere só algumas rotas. Ele não cobre as telas que a Fase 3 reagrupou (Inteligência e Perfil dentro de Configurações).

**O que falta:**
- Teste das rotas antigas das telas reagrupadas pela Fase 3. Para /app/perfil, /app/configuracoes, /app/conhecimento, /app/marketplace, /app/ia-modelos, /app/navegador e /app/notificacoes, e para as rotas opacas correspondentes, verificar que tabFromPath e normalizeNoriumTabPath devolvem a mesma tela.
- Teste abrangente que percorra todas as entradas de TAB_ROUTES e LEGACY_TAB_ROUTES e garanta que cada rota resolve para uma chave com painel em AppPanels/panelModules, para evitar que uma tela seja removida sem quebrar o teste.
- Opcional: teste de AppPanels mostrando que activeTab='Perfil' e activeTab='Conhecimento' ainda renderizam o painel próprio, e não só o destaque no menu.
- Os testes existentes não foram executados nesta verificação (restrição de RAM).
- Nenhum teste de AppPanels com PanelTabs/allowedTabs garante que uma rota antiga de tela de Inteligência sem permissão continua tratada como antes, nem que a barra PanelTabs não esconde o painel.
- Testes não executados nesta verificação (restrição de RAM).

_Observação:_ O critério de manter as rotas está atendido no comportamento: a branch não mexeu no roteamento e a regra de não remover telas foi seguida. O item fica PARCIAL porque o critério pede um teste de rotas antigas, e o único que existe é anterior à branch, cobre poucas rotas e nenhuma das telas que mudaram de lugar no menu. Risco menor: navigationGroups.ts:39-50 tem um mapa de aliases (ALIASES) duplicado e diferente do TAB_ALIASES de tabs.ts:77-90 (faltam Pendencias e Pendências). Isso afeta só o breadcrumb e o destaque do menu, não a rota.

#### F3.5 — Celular: barra inferior com 5 atalhos · 🟡 Parcial

O menu em gaveta no celular existe: no app principal e no painel Admin, a barra lateral abre por cima da tela com fundo escurecido. Já a barra inferior com 5 atalhos não existe no app principal. A única barra inferior no celular é a navegação interna do WhatsApp, que só aparece dentro dessa tela.

**O que falta:**
- Criar no app principal (NoriumApp/layout) uma barra de navegação inferior fixa, visível só no celular (até 900px), com 5 atalhos. Exemplo: Painel, Nora, Comunicação/WhatsApp, Agenda e Menu, sendo que Menu abre a gaveta.
- Respeitar allowedTabs e as permissões na barra, mostrar o item ativo (aria-current) e os contadores de não lidas, como já faz a Sidebar.
- Ajustar o espaço inferior do conteúdo (padding-bottom e safe-area-inset-bottom) para a barra não cobrir o compositor do chat da Nora, do WhatsApp e do chat da equipe. Resolver o conflito com o rail inferior do WhatsApp (index.css:8115-8153), para não ficarem duas barras empilhadas.
- Esconder a barra no desktop (acima de 900px) e quando a gaveta ou os modais em tela cheia estiverem abertos.
- Criar testes do componente (renderização no celular, os 5 atalhos, navegação e abertura da gaveta) e validar no navegador em 375px.
- Registrar a mudança no CHANGELOG.md. Não há registro de F3.5 no CHANGELOG nem no handoff.
- A gaveta no celular não foi criada nem testada nesta fase. Faltam testes de componente que cubram abrir e fechar a gaveta em 375px.
- Confirmar com o usuário quais são os 5 atalhos antes de implementar, para não transformar a sugestão do auditor (Painel, Nora, WhatsApp, Agenda, Menu) em escopo aprovado.

_Observação:_ Não achei este plano da Fase 3 com o item F3.5 nos docs do repositório. O docs/plans/2026-10-08-plano-expansao-nora.md tem uma "Fase 3", mas ela trata de campanhas de e-mail. Também não há nenhuma decisão registrada do usuário que dispense a barra inferior. A gaveta já existia antes desta branch (commit 32446e4). Nos commits de layout desta branch, Sidebar.tsx mudou (159 linhas), mas nenhuma barra inferior foi criada. Resultado: das duas partes do critério, só a gaveta está atendida.

#### F3.6 — Navegação por teclado e todas as telas alcançáveis · 🟡 Parcial

Todas as telas podem ser abertas pelo menu lateral ou por caminhos de apoio (abas internas, sino, Configurações, Mais), e os itens são botões nativos com foco visível. Faltam três coisas: testes automatizados de teclado, um teste que confira se toda tela aparece no menu, e navegação por teclado completa na busca do topo, no menu do perfil e no menu lateral do celular. Os testes de rotas antigas já existiam antes desta branch e cobrem só alguns exemplos.

**O que falta:**
- Teste automatizado de teclado no menu lateral e no topo: Tab até os itens, Enter/Espaço navega, Enter abre e fecha grupos, Escape fecha busca e menu do perfil, e o link para pular ao conteúdo.
- Teste que confira se cada tela de TAB_ROUTES/PRIMARY_TABS pode ser aberta pelo menu (NAVIGATION_GROUPS, mais Configurações/Ajuda e as abas internas), para nenhuma tela ficar sem acesso.
- Busca do topo (Header.tsx:251-321): navegação por setas ou Tab nos resultados, sem a lista fechar no blur, para os resultados além do primeiro e os 'Dados encontrados' poderem ser abertos pelo teclado.
- Menu do perfil (Header.tsx:367-437): mover o foco ao abrir, aceitar setas (é role=menu) e devolver o foco ao botão ao fechar com Escape.
- Menu lateral no celular (Sidebar.tsx:112-124): fechar com Escape e mover o foco para dentro ao abrir.
- Teste de rotas antigas mais completo: todas as entradas de LEGACY_TAB_ROUTES e os apelidos (Inbox, Gastos, Resumo, Automacoes, Configuracoes, Notificacoes), conferindo também que o item certo do menu fica marcado.
- Pequenos ajustes: 'Pular para o conteúdo' com acento e tabIndex=-1 no <main id="norium-main">. Avaliar um item de Notificações no menu lateral, porque NoriumApp.tsx:384 já envia o contador de Notificações, mas o menu não o mostra.
- Confirmar no navegador o foco ao abrir e fechar o menu lateral no modo recolhido (não verificado nesta revisão).

_Observação:_ Somente leitura: nenhum teste foi executado. A regra do handoff ('nenhuma tela pode ser removida ou escondida') foi respeitada, e o CHANGELOG (linhas 17, 23 e 25) registra o menu reorganizado sem remover telas. Pelo código, nenhuma tela ficou sem acesso: Notificações abre pelo sino e por Mais, Perfil por Configurações e pelo menu do perfil. Porém isso não é garantido por teste, e a navegação por teclado não está completa nos menus suspensos e na busca. Os testes de rotas antigas são anteriores a esta branch.

### Fase 4

#### F4.1 — Telas no novo layout (ondas A–F) · 🟡 Parcial

O novo layout chegou ao menu, ao topo e à maioria das telas internas, com tema claro e escuro. Ficaram de fora: Login e cadastro (Onda A), a página pública de agendamento (Onda C), o painel Admin e o painel lateral da Nora. A Onda F (consumo de tokens da Nora) também não foi refeita, e não há prova de que a parte responsiva e os estados vazio, carregando e erro foram conferidos em todas as telas.

**O que falta:**
- Onda A: refazer Login, cadastro e escolha de plano (AuthScreen.tsx e AccountEmailAction.tsx) no novo layout, com tema claro além do escuro forçado.
- Onda C: refazer a página pública de agendamento (PublicSchedulingPage.tsx) com tokens, tema claro e escuro e estados vazio, carregando e erro no novo padrão. Fazer o mesmo nas páginas públicas PublicAccess.tsx e LegalPage.tsx.
- Refazer o painel Admin (AdminDashboard.tsx, área financeira do admin, ManualEmailSender e SystemEmailSettings) no novo layout.
- Onda F: refazer as telas de consumo da Nora em tokens (AiCostsDashboard e as partes de uso de tokens em IntelligenceHubDashboard e ModelsDashboardV2).
- Refazer o painel lateral da Nora (layout/Nora.tsx e FloatingNoraButton) no novo layout.
- Conferir e registrar, tela por tela, que a parte responsiva (celular e tablet) e os estados vazio, carregando e erro seguem o padrão. Não há registro dessa conferência visual.
- Os estados de carregando e erro da página pública de agendamento (PublicSchedulingPage.tsx:146-147) usam cores fixas e não seguem o padrão novo de estados vazio, carregando e erro.

_Observação:_ Por decisão do usuário (registrada na memória e no CHANGELOG.md:23), a Inteligência ficou em um único item com abas e o Perfil passou para dentro de Configurações; isso não é falta. Nenhuma tela foi removida, como pede o handoff. Nesta verificação não rodei build, testes nem conferência visual.

#### F4.2 — Quebrar componentes gigantes · ❌ Não feito

Nenhum dos quatro componentes foi dividido. Três deles ficaram maiores que antes e o AutomationsDashboard só encolheu um pouco por causa da reescrita de layout, sem ganhar arquivos novos.

**O que falta:**
- Dividir o ChatCentral.tsx (2.140 linhas) em subcomponentes e hooks.
- Dividir o TasksDashboard.tsx (2.048 linhas). Por exemplo: quadro, lista, filtros, modal e hooks de dados.
- Dividir o CommercialDashboard.tsx (2.227 linhas).
- Dividir o AutomationsDashboard.tsx (1.939 linhas).
- Manter os testes que já existem passando depois da divisão e registrar a mudança no CHANGELOG.md.
- Os quatro componentes continuam com cerca de 2.000 linhas cada. Os commits de layout desta branch (c4e0007, b030eab) ainda aumentaram três deles, então quebrar esses arquivos ficou mais caro.

_Observação:_ Contei as linhas com wc -l nesta branch e comparei com git show origin/main. Os subcomponentes que já existem nas pastas (SidebarEsquerda, PainelDireito, CommercialEditor, AutomationFlowPreview etc.) vieram de antes desta branch. Não rodei testes.

#### F4.3 — Botões soltos trocados pelo componente único · ❌ Não feito

Os botões soltos não foram trocados pelo componente único. Pelo contrário: as linhas com `<button` cru subiram de 602 (origin/main) para 875 nesta branch. Os arquivos que importam o componente `shared/Button` caíram de 92 para 64.

**O que falta:**
- Decidir qual é o padrão oficial: o componente React `shared/Button` ou a classe CSS `nx-btn`. Hoje os dois convivem, e o layout novo foi feito com nx-btn em <button cru.
- Migrar os cerca de 875 <button crus para o componente escolhido, começando pelas telas com mais ocorrências: TasksDashboard, AutomationsDashboard, FinanceDashboard, TeamCallOverlay, BrainstormDashboard e AreaCentralChat.
- Se o padrão for nx-btn, incorporar a classe e suas variantes (is-primary, is-danger) ao `Button.tsx` e centralizar o CSS, que hoje está espalhado em emails.css, TasksDashboard.css, clients.css etc.
- Registrar a mudança no CHANGELOG.md e validar com build e verificação visual.
- Reverter a regressão desta branch: 248 usos de `<Button` foram trocados por `<button` cru nos commits de layout, então além de migrar o legado é preciso restaurar ou adaptar esses usos.
- Incorporar o estilo nx-btn (variantes is-primary, is-danger) ao shared/Button.tsx para o layout novo não exigir botão cru.

_Observação:_ As contagens vêm de `git grep -c` por linha, e um botão com várias linhas conta uma vez. Por isso a base de 602 difere do número 643 do plano, que deve ter usado outro critério. Mesmo assim a tendência é inequívoca: o refactor de layout desta branch criou mais botões soltos (estilizados com nx-btn) em vez de usar o componente único.

#### F4.4 — Regressão visual comparando com o mockup · ❌ Não feito

Não existe regressão visual automatizada nem registro de comparação com o mockup. A branch alterou o layout em vários commits, mas não acrescentou nenhum teste visual nem capturas de referência.

**O que falta:**
- Adotar uma ferramenta de regressão visual, por exemplo Playwright com toHaveScreenshot.
- Gerar capturas de referência das telas a partir do mockup aprovado (tema claro e escuro, desktop e celular).
- Criar testes que comparem cada tela alterada nas ondas (menu, topo, telas, Configurações) com essas referências.
- Incluir esses testes no CI ou no checklist de cada onda.
- Registrar o resultado da comparação no handoff ou no CHANGELOG a cada onda.
- Mesmo uma conferência manual precisaria de registro versionado por onda (capturas ou checklist no handoff), e isso também não existe.

_Observação:_ Nenhum teste foi executado: a verificação foi só de leitura. Se houve comparação visual manual com o PDF ou mockup, ela não está registrada em nenhum arquivo do repositório.

#### F4.5 — Telas de consumo da Nora em tokens · 🟡 Parcial

Já existe uma tela de consumo de IA por usuário, com tokens e custo. Mas ela está no Painel Administrativo, aparece como "Custos por usuário", mostra os valores em dólar e já estava na main antes desta branch. Em Configurações não há a seção "Consumo da Nora" nem a "Consumo por pessoa" que o plano pede.

**O que falta:**
- Criar em Configurações a seção 'Consumo da Nora', com o consumo em tokens do usuário ou do workspace: período, total, entrada/saída e saldo do ciclo.
- Criar a tela 'Consumo por pessoa' em Configurações, para o gestor da empresa ou workspace, em tokens e filtrada pelo tenant, separada do painel do admin do sistema.
- Criar no backend um endpoint fora de /api/auth/admin, com autorização e tenant: um para o próprio consumo e outro para o consumo por pessoa do workspace.
- Mostrar os números em tokens, e não só em dólar, como pede o item.
- Escrever testes do front e do back para as telas e rotas novas, e registrar a mudança no CHANGELOG.md.
- Confirmar se o critério de 'em tokens' vale também para o limite e o orçamento por ciclo, que hoje são em custo (ai_costs.py:325, erro 402 'orçamento de IA').
- Definir quem vê 'Consumo por pessoa' (gestor do workspace ou só admin) antes de implementar, porque isso afeta o isolamento de tenant.

_Observação:_ Não encontrei no handoff nem no CHANGELOG uma decisão do usuário que mude este item. O AiCostsDashboard, que já existia na main, cobre a parte de dados (tokens por usuário e por modelo), mas só para o admin do sistema e com foco em custo em USD. Ele pode ser a base para as telas novas. Nada foi feito nesta branch para o F4.5: os commits da branch mexeram em Configurações só no layout.

### Fase 5

#### F5a.1 — Carregar cada módulo só quando aberto · ✅ Feito

Cada módulo de tela é carregado sob demanda: o AppPanels usa React.lazy para todos os painéis e só monta o módulo quando a aba está ativa. O panelModules.ts traz os loaders dinâmicos e faz pré-carregamento quando o usuário passa o mouse no menu, respeitando o modo de economia de dados e conexões 2G.

_Observação:_ Pelo histórico do git, panelModules.ts e o lazy() do AppPanels já vinham da main (commits 56ece8e, ab5bbe5 e ae63957). Esta branch só ajustou AppPanels.tsx, nos commits e2afa52 e b030eab. Não rodei o build, então não conferi a separação real dos chunks, mas os imports dinâmicos estão corretos no código.

#### F5a.2 — Listas longas virtualizadas · ❌ Não feito

Nenhuma lista do frontend é virtualizada: não há biblioteca de virtualização no package.json nem implementação própria (janela visível ou overscan). As telas usam só paginação ou "carregar mais", o que limita quanto é renderizado, mas não é virtualização.

**O que falta:**
- Escolher e adicionar uma biblioteca de virtualização (por exemplo @tanstack/react-virtual ou virtua). É dependência nova e exige plano aprovado.
- Virtualizar a lista de conversas e o histórico de mensagens do chat (ChatCentral).
- Virtualizar a lista de e-mails (MailMessageList).
- Virtualizar ou manter paginada, com decisão registrada, a tabela de lançamentos (FinanceDataTable).
- Virtualizar a lista de clientes (ClientsDashboard) no lugar do "carregar mais", que acumula itens no DOM.
- Escrever testes e medir o desempenho com listas grandes, além de registrar no CHANGELOG.md.
- Não existe decisão registrada (handoff ou CHANGELOG) que dispense ou adie o item F5a.2. Se a paginação for considerada suficiente, é preciso registrar essa decisão explicitamente.

_Observação:_ A paginação e o \"carregar mais\" já reduzem o custo de renderização e podem bastar se o usuário aceitar isso como desvio. Hoje esse desvio não está registrado no handoff, então pelo critério do plano o item não está feito.

#### F5a.3 — Cache de consultas com atualização em segundo plano · ❌ Não feito

O frontend não tem cache de consultas com atualização em segundo plano. Não usa react-query nem SWR, e core/api não tem cache próprio. Há só dois caches locais com prazo de validade, sem atualização em segundo plano, e eles já existiam antes desta branch.

**O que falta:**
- Criar uma camada de cache de consultas (react-query/SWR ou uma própria em core/api) que mostre o dado guardado na hora e atualize em segundo plano (stale-while-revalidate).
- Separar o cache por usuário e por espaço da empresa e limpá-lo ao sair ou trocar de espaço (como requestScope faz em analysis.ts).
- Invalidar o cache depois de criar, editar ou apagar dados e aplicar nas telas principais.
- Escrever testes da camada de cache e registrar a mudança no CHANGELOG.md.
- Usar como referência o padrão já existente em features/mail (mailboxCache.ts com chave por usuário e workspaceScope, e useMailbox.ts que mostra o cache e atualiza em silêncio) ou trocar por uma camada única, para não manter duas abordagens.
- Definir o comportamento com a aba oculta e ao reconectar (atualizar quando a janela volta ao foco), alinhado ao document.hidden que esta branch adicionou em useMailbox.ts.

_Observação:_ O CHANGELOG cita cache só no backend (documentos do PostgreSQL) e o cache de mídia do navegador, nada que atenda este item. Instalar react-query ou SWR seria nova dependência, uma mudança estrutural que pelas diretrizes precisa de plano e confirmação antes.

#### F5a.4 — Reduzir CSS e !important · ❌ Não feito

O CSS não foi reduzido, cresceu. Os números do plano batem com a origin/main: 12.649 linhas no total de src/**/*.css e 1.273 !important. Nesta branch o total foi para 19.214 linhas e 1.453 !important. O index.css continua com 8.673 linhas e 879 !important, os mesmos valores da main.

**O que falta:**
- Migrar as telas para a base da Fase 2 (tokens, ui-v2, layout-v2, screens) e remover do index.css as regras legadas que ficaram duplicadas ou sem uso.
- Eliminar a maior parte dos !important. Os maiores focos são index.css (879), noraWorkspace.css (160), teamChat.css (69) e workspace.css (59).
- Definir uma meta numérica para "a base da Fase 2", por exemplo um limite de linhas e de !important, e medir no fim.
- Registrar a redução no CHANGELOG.md.
- Remover os arquivos CSS legados que deixaram de ser importados depois da migração para a base da Fase 2. Hoje eles ainda entram na contagem.

_Observação:_ A pista do plano (\"conte linhas de index.css\") não confere: as 12.649 linhas são o total de CSS da main, não só do index.css. O trabalho de layout desta branch acrescentou CSS novo por cima do legado, por isso os dois indicadores pioraram (mais 6.565 linhas e mais 180 !important). Não foram executados build nem testes, a verificação foi só leitura.

#### F5b.1 — Estado da Nora e operação no PostgreSQL · 🟡 Parcial

O código já sabe gravar o estado da Nora e a operação no PostgreSQL, e existem ferramentas de migração e backup. Mas tudo isso já estava na main, nada foi feito nesta branch. O sistema continua caindo para JSON/SQLite quando o banco não está configurado, o esquema é criado direto no código e não por migrations versionadas, e o PostgreSQL ainda não está ligado na homologação (Shard).

**O que falta:**
- Provisionar o PostgreSQL na Shard (homologação e depois produção) e definir NORIUM_DATABASE_URL, NORIUM_POSTGRES_REQUIRED=1 e NORA_BRAIN_DATABASE_URL com TLS verify-full.
- Rodar a migração dos dados atuais (JSON/SQLite) com o importador, de forma reconciliada, ajustando para a Shard o migrate_to_postgres.py, que hoje está em infra/azure.
- Trocar o CREATE TABLE IF NOT EXISTS espalhado pelo código (postgres_store, events, brain/repository, scheduling, ai_costs, wapi_binding) por migrations versionadas com reversão (down), como pedem o plano e a política.
- Escrever o backup e o plano de reversão para o ambiente Shard: os documentos atuais tratam do Azure arquivado.
- Impedir o fallback silencioso para JSON/SQLite em homologação e produção, exigindo NORIUM_POSTGRES_REQUIRED=1 no deploy, para não ficar presa a uma réplica única.
- Registrar a mudança no CHANGELOG.md e no handoff.
- Testes de regressão que garantam falha fechada quando NORIUM_POSTGRES_REQUIRED=1 e o banco estiver ausente, no perfil de deploy da Shard.
- Conferir se o document_cache.py novo (c65e65b) mantém a consistência com várias réplicas: um cache em memória por processo pode servir dado antigo quando houver mais de uma réplica.

_Observação:_ Pelo handoff, o usuário adiou a ativação do PostgreSQL da Nora na Shard para a Fase 6. A base de código para PostgreSQL já existe na main, de trabalho anterior (handoff 2026-09-22-codex-postgresql-recovery.md, na era Azure). O que falta é a parte operacional e as migrations versionadas. Não executei nenhum teste, só leitura.

#### F5b.2 — Fila para trabalhos longos sem a tela aberta · 🟡 Parcial

Existe uma fila durável no servidor (executor da Nora e worker de automações) que roda sem a tela aberta. Mas os dois casos citados no critério, leitura da caixa de e-mail e campanhas, só avançam quando o navegador chama /advance a cada 1 segundo. Fechando a tela, o trabalho para. Nenhum commit desta branch mexeu nisso.

**O que falta:**
- Colocar os trabalhos de leitura de caixa e de campanha (mail/productivity.py) numa fila do servidor: um worker ou o executor nora_jobs chamando advance() sem depender do polling do NoraMailWork.tsx.
- Guardar os trabalhos de e-mail numa fila transacional (hoje ficam em read_user_db/JSON por usuário), com lease e lock que valham entre réplicas.
- Na campanha, implementar limite diário, backoff para quota/429 e retomada automática pelo worker, como pede o plano 2026-10-08 (linhas 88 e 120).
- Notificar o usuário quando o trabalho terminar ou pausar, já que ele pode não estar com a tela aberta.
- Testes que provem que o trabalho avança sem o frontend e para quando a permissão é revogada; depois validar em homologação com o worker ligado.
- Fazer o executor nora_jobs ou um worker chamar advance() de mail/productivity.py, para que leitura de caixa e campanha avancem sem a tela aberta.
- Testes que provem que esses trabalhos avançam sem o frontend.

_Observação:_ A infraestrutura de fila do executor da Nora (nora_jobs + worker em container separado) veio de main, não desta branch. A branch só otimizou o tempo de espera do worker de automações (commit 6a1dadc). Nada foi publicado em homologação nem em produção, então o worker separado também não foi validado em execução.

#### F5b.3 — Índices e paginação nas rotas lentas · ❌ Não feito

Esta branch não cria índices nem paginação nas rotas de listas. As rotas de tarefas, financeiro e clientes continuam devolvendo tudo de uma vez. Também não achei nenhuma medição da Fase 0 que diga quais rotas são as mais lentas. O ganho de desempenho da branch veio de cache de documentos e de menos escrita de log, não de índices ou paginação.

**O que falta:**
- Registrar a medição da Fase 0 (latência por rota) e apontar as rotas mais lentas.
- Criar índices no Postgres para as consultas dessas rotas, por exemplo índices de expressão JSONB, índice por prefixo de store_key ou tabelas próprias. Fazer isso por migration versionada, como pede a política.
- Colocar paginação (limit com offset ou cursor) nas rotas de listas de tarefas, financeiro, clientes e sincronização, e ajustar o frontend para carregar por páginas.
- Medir de novo depois da mudança, provar o ganho e registrar no CHANGELOG.md.
- Os limits que já existem em operations/router.py vieram de antes da branch e não contam como entrega deste item.

_Observação:_ Como os dados ficam em documentos JSONB inteiros por chave, criar índices só funciona se parte dos dados sair para tabelas próprias ou se forem criados índices de expressão. Isso é mudança estrutural e precisa de plano aprovado. Verifiquei só por leitura do código e do git diff; não rodei nenhum teste.

#### F5b.4 — Monitoramento de erros e lentidão com alerta · 🟡 Parcial

Erros e lentidão já são medidos e registrados: há métricas em memória com p95 e taxa de erro, e as requisições lentas ou com erro vão para system_logs, que o painel admin mostra. Mas nada dispara alerta: não existe Sentry, nem limite que avise alguém por e-mail ou notificação quando há erro ou lentidão.

**O que falta:**
- Integração com um serviço de captura de erros (Sentry ou outro equivalente), com DSN em variável de ambiente, no backend e no frontend (ErrorBoundary e window.onerror). Hoje não há nenhuma referência a Sentry nas dependências nem no código.
- Alerta ativo: definir limites, por exemplo taxa de 5xx ou p95 acima de X ms numa janela de tempo, e enviar aviso por e-mail, WhatsApp ou notificação a um responsável, com proteção contra alertas repetidos.
- Tarefa periódica ou verificação que avalie diagnostics_snapshot/system_logs com base nesses limites. As métricas em memória se perdem a cada reinício e não são compartilhadas entre réplicas.
- Verificação externa de disponibilidade (uptime/healthcheck) com alerta.
- Testes cobrindo o disparo do alerta e uma entrada no CHANGELOG.md.
- As regras de alerta em infra/azure/team-call-alerts.yml cobrem só as chamadas da equipe, não foram instaladas e não há Prometheus nem Alertmanager configurado para recebê-las. Seria preciso estender as regras para 5xx e p95 da API em geral e instalar o coletor junto com a entrega dos alertas.

_Observação:_ Nenhum commit desta branch tratou de alertas. A única mudança ligada ao tema (6a1dadc) diminuiu a gravação de logs e manteve o registro de erros e de requisições lentas (>= 1500 ms). Pelo checklist de operações, o responsável confirmou que não há serviço de monitoramento externo contratado, então o alerta externo pode depender de uma decisão ou de uma contratação. Ainda assim, um alerta interno por SMTP (que já está configurado) poderia ser feito sem custo novo.

#### F5b.5 — Metas de desempenho medidas · ❌ Não feito

Nenhuma das três metas (painel abaixo de 1,5 s, pacote JS inicial 50% menor que a linha de base, p95 abaixo de 300 ms nas rotas principais) tem linha de base, medição automática ou relatório nesta branch. Os commits de perf da branch são otimizações pontuais, sem comprovar números. O que existe de medição já estava na main e não confere essas metas.

**O que falta:**
- Medir e registrar a linha de base: tempo de carregamento do painel e tamanho do pacote JS inicial (entrada mais os blocos carregados de início).
- Script automático (por exemplo Lighthouse CI ou Playwright) que meça a abertura do painel e falhe se passar de 1,5 s.
- Checagem do pacote JS inicial contra a linha de base, exigindo redução de pelo menos 50%.
- Teste de carga ou de latência das rotas principais, com p95 menor que 300 ms (por exemplo k6 ou locust), integrado ao CI ou à homologação.
- Relatório com os resultados medidos antes e depois.
- A carga das chamadas da equipe (docs/testing/team-call-quality-gates.md) mede só a sinalização das chamadas, com limites de 750 ms. Ela não serve como prova do p95 abaixo de 300 ms nas rotas principais da API.

_Observação:_ Os commits de perf da branch (2f2842f, c65e65b, 6a1dadc, b030eab) podem melhorar o desempenho, mas não comprovam as metas. Não rodei build nem testes, conforme a regra de somente leitura.

#### F5b.6 — Economia de internet e RAM na Shard (pedido do usuário) · 🟡 Parcial

Parte dos itens levantados foi feita nos commits c65e65b, 2f2842f, 6a1dadc e b030eab: cache de documentos por usuário, menos log por requisição, Cache-Control das mídias, worker de automações acordado sob demanda, consultas automáticas do front menos frequentes, imagens em WebP e reconciliação da chamada a cada 25 s quando ociosa. Continuam sem mudança a Agenda, o _storage_usage a cada gravação, os workers de e-mail, lembretes e gravações, o GZip em binários, os mapas sem limite, os imports preguiçosos e a reconexão do CallSession.

**O que falta:**
- Agenda: reduzir max_results (hoje 2500), usar syncToken incremental e guardar em cache o build do serviço Google.
- Trocar o _storage_usage a cada gravação (soma tudo no PostgreSQL) por um contador ou cache de uso.
- Workers de e-mail (15 s), lembretes (60 s) e gravações (60 s): acordar sob demanda ou com espera crescente, como já foi feito nas automações.
- GZip: não comprimir binários e mídias (imagem, áudio, vídeo, PDF), por tipo de conteúdo ou por rota.
- Endpoints de sync que devolvem a lista inteira: mudar para resposta incremental ou paginada. Nenhuma mudança encontrada.
- Polling do WhatsApp no backend: nenhuma mudança encontrada (só o front ficou menos frequente).
- Limitar ou limpar os mapas sem limite: locks do WhatsApp (conversation_store.py:20), cache de foto e status_conexoes (chat/router.py:173).
- Imports preguiçosos dos módulos pesados para reduzir RAM: nenhuma mudança encontrada.
- Reconexão do CallSession (team-chat) com espera crescente: só o useWebSockets genérico foi ajustado.
- Validar em homologação a economia real de internet e RAM na Shard. Nada desta branch foi publicado ainda.
- CallSession.tsx:431-434: a reconexão usa espera fixa RECONNECT_DELAY_MS, sem espera crescente, o que confirma a pendência com evidência concreta.
- Sem medição antes e depois (RAM e tráfego) que mostre o ganho real na Shard.

_Observação:_ Verificação só por leitura, via git diff origin/main..HEAD e grep. Nenhum teste foi executado. O CHANGELOG (linhas 18 a 26) registra só os itens feitos. O handoff não registra desvio nem adiamento dos itens que faltam.

### Fase 6

#### F6.1 — Cérebro da Nora ativo com ferramentas · 🟡 Parcial

O cérebro da Nora já existe no código, com ferramentas para tarefas, clientes, financeiro, agendamento, e-mail, WhatsApp, agenda e preferências. Mas o chat principal ainda escolhe o especialista por palavra-chave e roteamento semântico, e o cérebro continua desligado. Também não foi ativado em homologação nem passou por teste de fumaça. Nenhum commit desta branch mexe no cérebro.

**O que falta:**
- Ligar o /natural (e o /natural/stream) ao cérebro: criar um trabalho no cérebro e usar as ferramentas de brain/tools.py, em vez de chamar os handlers por palavra-chave do router.py e do orchestrator.py.
- Criar ferramentas para os domínios que ainda não têm: automações, equipe/chat da equipe, comercial completo e brainstorm.
- Provisionar o PostgreSQL de homologação com banco e usuário exclusivos e TLS verify-full, e configurar NORA_BRAIN_DATABASE_URL.
- Gerar NORA_BRAIN_INTERNAL_SECRET (32 caracteres ou mais) e subir o executor (python -m app.modules.nora.brain.worker), com NORA_BRAIN_EXECUTOR_ENABLED=1 e NORA_BRAIN_ALLOW_MODEL_CALLS=1.
- Fazer o teste de fumaça do runbook em homologação: health com driver postgresql, trabalho sintético queued -> running -> completed, aprovação exata e reinício com reconciliação. Registrar o resultado.
- Verificar se mail/productivity.py e system/router.py usam o cérebro só para saúde e estado; esse uso não conta como migração dos especialistas.
- O /natural/stream também precisa passar pelas ferramentas do cérebro, e não apenas o /natural.

_Observação:_ A estrutura do cérebro já estava no repositório antes desta branch (commits b2cf917, 0cc5379, d366900). Nenhum commit em origin/main..HEAD toca em modules/nora/brain. A pasta é norium-back-end/app/modules/nora/brain, não nora/brain. A ativação em homologação também depende de push, deploy e acesso ao ambiente, que exigem autorização do responsável e ainda não foram feitos.

#### F6.2 — Aprovação exata em tudo que sai do sistema · 🟡 Parcial

O e-mail já tem aprovação exata com digest e reconciliação, mas isso já existia em origin/main e não foi feito nesta branch. Os pedidos compostos continuam com uma única aprovação para o plano inteiro, sem digest, e cada etapa ainda é executada a partir do texto. O WhatsApp não tem digest nem reconciliação; o digest foi adiado de propósito, como registrado no handoff.

**O que falta:**
- Pedidos compostos: gerar uma aprovação exata (com digest) para cada operação, com a operação estruturada (tipo, alvo, valores), em vez de uma aprovação única que reexecuta o texto de cada etapa pelos agentes.
- Enviar a etapa de e-mail dos pedidos compostos pelo fluxo de e-mail exato (create_exact_email_approval) em vez de EmailAgent().handle(instruction).
- WhatsApp: digest na aprovação (já adiado por decisão registrada), idempotencyKey e registro de tentativa de envio.
- WhatsApp: tratar resultado incerto (executionUncertain) e criar um reconcile_whatsapp_send equivalente ao reconcile_email_send, exposto na rota de reconciliação.
- Testes de regressão que cubram aprovação por operação nos pedidos compostos e a reconciliação do WhatsApp.
- Registrar no handoff ou no BACKLOG.md que a aprovação por operação nos pedidos compostos ficou pendente. Hoje, só o adiamento do digest de WhatsApp está registrado.
- Teste de regressão que garanta a recusa de pedidos compostos com WhatsApp (router.py:1479-1493).

_Observação:_ O usuário decidiu adiar o digest do WhatsApp para não bloquear a edição do texto no Controle (regra de não remover funções). Essa decisão muda parte do item, mas não explica a falta de reconciliação do WhatsApp nem a aprovação por texto nos pedidos compostos. Nenhum commit desta branch implementa o F6.2. As mudanças em orchestrator.py e operations/service.py são de identidade, financeiro exato e memória de equipe.

#### F6.3 — Medidor único de tokens e franquias · ❌ Não feito

Continuam existindo dois medidores de IA separados e sem ligação entre si: ai_costs.py, com limite por pessoa em dólar e tokens, e nora/brain/budget.py, com contas de tenant e usuário em outra tabela. Não há franquia por plano nem alertas de IA em 80% e 95%. Só a pausa de trabalhos longos existe, e apenas no brain.

**O que falta:**
- Juntar brain/budget.py e services/ai_costs.py em um único medidor, com uma só tabela e uma só regra de reserva e liquidação.
- Criar franquia de tokens por plano contratado, vinculada ao tenant, no lugar dos tetos fixos de 1M e 200k no código.
- Ligar o limite por pessoa à franquia do tenant no mesmo medidor.
- Criar alertas de consumo de IA em 80% e 95%, com notificação ao administrador e ao usuário e sem repetição.
- Aplicar a pausa de trabalhos longos usando o medidor unificado, incluindo a franquia do plano.
- Escrever testes cobrindo franquia, limite por pessoa, alertas e pausa.
- Não encontrei testes de regressão para a pausa por orçamento ligada a um medidor unificado.
- A tela de custos de IA (ai_costs_router) não mostra franquia por tenant nem por plano.

_Observação:_ O caminho da pista estava errado: o arquivo real é norium-back-end/app/modules/nora/brain/budget.py. Nem o handoff nem o CHANGELOG registram uma decisão do usuário que mude este item.

#### F6.4 — Economia de tokens · 🟡 Parcial

Já existe resumo progressivo da conversa, e só o fluxo "brain" escolhe o modelo pela categoria da tarefa. O chat principal da Nora usa um único modelo para tudo e não há cache de respostas. Nenhum desses trechos foi alterado nesta branch.

**O que falta:**
- Escolher o modelo por tarefa em NoraIAService (services/nora.py): modelo rápido para conversa e classificação, modelo avançado só para documentos e pesquisa. Hoje o padrão OpenAI é gpt-6-astra para tudo.
- Criar um cache de respostas (por tenant e usuário, com validade curta e chave pelo hash do prompt mascarado) para perguntas repetidas ou determinísticas. Ou, no mínimo, aproveitar o cache de prompt do provedor (prompt_cache_key e prefixo de system estável).
- Opcional: um resumo progressivo de verdade, gerado pelo modelo rápido. O atual só junta trechos cortados em 220 caracteres e não sintetiza.
- Testes que comprovem a escolha de modelo por tarefa e o acerto e a validade do cache.
- Registro no CHANGELOG.md quando for implementado.
- Os fallbacks do OpenAI (gpt-6-sol) entram só em caso de falha. Isso não é escolha de modelo por tarefa.
- No brain, a chamada ao modelo depende de NORA_BRAIN_ALLOW_MODEL_CALLS=1. Sem essa variável, a escolha de modelo por perfil não vale na prática.
- Não há teste que comprove a escolha de modelo ou o cache.

_Observação:_ O resumo da conversa e a escolha de modelo no brain já existiam antes desta branch: o git diff origin/main..HEAD não mostra alterações em context.py, planner.py nem nora.py para este item. O CHANGELOG e o handoff não falam de F6.4. No modelo do chat principal, o system prompt muda a cada chamada por incluir a data, o que atrapalha o cache de prompt do provedor (prefixo estável).

#### F6.5 — Bateria de qualidade em pt-BR · ❌ Não feito

Não encontrei nenhuma bateria de frases em pt-BR rodando contra o modelo real nem medição de acerto mínimo de 90%. Só há testes unitários pontuais, com o modelo simulado (mock), que cobrem alguns casos de negação e intenção.

**O que falta:**
- Montar um conjunto versionado de frases reais em pt-BR (ex.: JSONL), com negações, ambiguidades e pedidos compostos, cada uma com a intenção e a ação esperadas, usando só dados fictícios.
- Criar um script ou runner que envie essas frases ao classificador e ao modelo real (classificar_intencao_com_nora / conversar_com_nora_natural) e calcule a taxa de acerto.
- Fazer o script falhar quando o acerto ficar abaixo de 90% e gerar um relatório por categoria.
- Rodar a bateria a cada mudança (etapa no CI ou gatilho manual com a chave em segredo), com controle de custo.
- Registrar a bateria no CHANGELOG.md e no handoff.
- Definir quem roda a bateria (CI com segredo ou gatilho manual) e o limite de custo, sem expor dados reais (LGPD: só frases fictícias).
- Avaliar também a rota de voz (ElevenLabs/Nora em tempo real), se ela usar outro caminho de classificação de intenção.

_Observação:_ Não há registro de decisão do usuário que dispense ou mude este item: CHANGELOG.md e docs/handoffs/2026-10-10-fase1-seguranca-voz.md não falam em F6.5 nem em bateria de avaliação. Os testes existentes ajudam na regressão determinística, mas não cumprem o critério de rodar contra o modelo real com acerto mínimo de 90%.

#### F6.6 — Conhecimento com busca semântica e pesquisa web por API · ❌ Não feito

A busca do Conhecimento ainda é por palavras-chave, sem embeddings nem busca por significado. A pesquisa web da Nora continua usando o RSS do Bing. O único ponto já atendido é o teste de isolamento entre usuários na busca do Conhecimento, e esse teste é anterior ao item.

**O que falta:**
- Implementar busca por significado no Conhecimento: embeddings dos trechos (por exemplo pgvector ou um índice vetorial por empresa) e consulta por similaridade, mantendo a citação da fonte (título, URL e trecho).
- Trocar o RSS do Bing em research_web (nora/router.py:174) por uma API de busca web oficial, com a chave em variável de ambiente e tratamento de erro e cota.
- Criar teste de isolamento entre empresas para a nova busca semântica, garantindo que vetores e resultados de uma empresa nunca apareçam para outra.
- Criar teste da pesquisa web via API (com mock) e registrar a mudança no CHANGELOG.md.
- O teste de isolamento atual compara dois usuários, não duas empresas. É preciso um teste com duas empresas diferentes que cubra tanto a busca quanto o índice vetorial.
- Definir o que acontece quando a API de embeddings ou de busca web estiver fora do ar ou sem chave (voltar para a busca por palavras-chave ou mostrar um erro claro), e cobrir isso com teste.
- Mascarar dados pessoais (LGPD) no texto enviado ao serviço de embeddings, como já é feito nas outras chamadas de IA (commit 4e764e1).

_Observação:_ Não encontrei nenhuma decisão do usuário que mude este item. A citação da fonte e o isolamento por usuário já existiam antes desta branch.

#### F6.7 — Gmail sincronizado sem a tela aberta · ❌ Não feito

O Gmail ainda só é sincronizado quando o navegador chama a rota de sincronização, de 5 em 5 minutos e só com a aba visível. Não há worker no servidor, nem push/watch do Gmail, nem sincronização incremental por historyId.

**O que falta:**
- Criar um worker no servidor, iniciado no lifespan, que sincronize o Gmail de cada usuário conectado sem depender do navegador. Precisa respeitar tenant e ter lease/limite de frequência.
- Adotar sincronização incremental: guardar o historyId por usuário e usar history.list, com fallback para sincronização completa quando o historyId expirar.
- Opcional, mas é a forma recomendada: usar Gmail push (users.watch + Pub/Sub) com rota de webhook autenticada e renovação do watch antes de 7 dias.
- Escrever testes do worker e da sincronização incremental, e registrar a mudança no CHANGELOG.md.
- Definir o que fazer com a sincronização pelo front quando existir o worker no servidor (remover ou manter como reforço), para não sincronizar duas vezes.

_Observação:_ Nenhum commit da branch (git log origin/main..HEAD) mexe na sincronização do Gmail. Também não encontrei, no CHANGELOG nem no handoff, decisão do usuário que mude este item.

#### F6.8 — Inventário de modelos de IA · ❌ Não feito

Os modelos gpt-6-astra e gpt-6-sol continuam como padrão no código, e ninguém registrou se eles existem. Também não há inventário de modelos em docs/AI_GOVERNANCE.md. O documento só diz que o inventário deve ser mantido.

**O que falta:**
- Confirmar com o provedor (lista de modelos da API da OpenAI ou da Groq) se gpt-6-astra e gpt-6-sol existem. Se não existirem, trocar os padrões em nora.py:57-58 e planner.py:75 por modelos válidos.
- Criar em docs/AI_GOVERNANCE.md o inventário dos modelos: nome, provedor, variável de ambiente, finalidade, responsável, dados enviados, retenção, subprocessador e como desligar. Entram os modelos de OpenAI e Groq (gpt-6-*, gpt-oss-20b, qwen3.6-27b, compound-mini), o ElevenLabs eleven_flash_v2_5 e a voz Edge.
- Registrar a mudança no CHANGELOG.md.
- O docs/ai-costs.md já confirma gpt-oss-20b e qwen3.6-27b (em 10/09/2026). Isso serve de fonte para o inventário, mas não o substitui.
- Gemini 3.7 Flash aparece em docs/ai-costs.md e também deve entrar no inventário, se for usado.

_Observação:_ Nenhum commit, CHANGELOG ou handoff da branch fala de inventário ou de checar se os modelos gpt-6-* existem. Também não encontrei nenhuma decisão do usuário que mude este item.

### Fase 7

#### F7.1 — Cota e retenção de armazenamento · 🟡 Parcial

A cota de armazenamento está pronta: há limite global e por workspace, conferido no momento da gravação tanto no PostgreSQL quanto no disco local. Prazo de retenção, porém, só existe para gravações de reunião (24h). Uploads e conversas têm apenas limite de quantidade, sem prazo de validade.

**O que falta:**
- Definir prazo de retenção, configurável, para uploads: anexos do chat da equipe, arquivos da Nora e mídia do chat/WhatsApp. Também falta a rotina que apaga o que venceu.
- Definir prazo de retenção por tempo para conversas: conversas da Nora, mensagens do chat da equipe e do chat/WhatsApp. Hoje só existe corte por quantidade.
- Quando o corte por quantidade remove mensagens antigas do chat da equipe, apagar também os anexos delas, que hoje podem ficar órfãos no armazenamento.
- Registrar os prazos de retenção em docs/CHANGELOG e criar testes que cubram essa expiração.
- Não encontrei prazo de retenção para a mídia do WhatsApp (whatsapp/integration.py só faz o streaming da mídia).
- Não há teste automatizado que cubra a expiração das gravações por TEAM_RECORDING_RETENTION_HOURS fora do app de teste do navegador (tests/team_call_browser_app.py:42).

_Observação:_ O CHANGELOG e o handoff da fase 1 não citam o F7.1. A cota veio do commit fa349ce, que já está em main e não é exclusivo desta branch. Não rodei nenhum teste; esta análise foi só leitura do código.

#### F7.2 — Exportar meus dados e excluir conta (inclui Nora) · 🟡 Parcial

"Exportar meus dados" e "Excluir minha conta" já existem no backend e na tela de Configurações, e o código inclui as tabelas da Nora no PostgreSQL. Mas não há nenhum teste de ponta a ponta, e os testes que existem não verificam dados da Nora. Esta branch também não mexeu nesse código.

**O que falta:**
- Teste de ponta a ponta (HTTP com login, ou E2E pela tela) para Exportar meus dados e Excluir minha conta.
- Teste que crie dados da Nora (jobs, eventos, preferências, orçamento e histórico de conversas) e confira que eles aparecem no ZIP e somem depois da exclusão.
- Teste no caminho PostgreSQL (_postgres_relational_export e _purge_postgres_relational), que hoje não tem nenhum teste.
- Garantir que exportação e exclusão usem o mesmo banco da Nora (NORA_BRAIN_DATABASE_URL) ou travar a configuração para os dois serem iguais. No SQLite local os dados da Nora ficam de fora.
- Avaliar nora_tombstones e nora_internal_nonces, que não entram nem na exportação nem na exclusão (provavelmente sem dado pessoal, mas falta confirmar).
- Registrar a validação em homologação, que não foi feita (nada publicado).
- Não existe teste nenhum para _postgres_relational_export nem para _purge_postgres_relational. Também não há garantia de que _table_exists resolva o schema certo quando a Nora usa outro banco ou outro schema.
- Confirmar se o histórico de conversas da Nora e os resultados de jobs no repositório do cérebro (SQLite local) entram na exportação. Hoje não entram.

_Observação:_ Nenhum commit da branch feat/fase1-seguranca-voz alterou privacy/router.py, e o CHANGELOG e o handoff não falam deste item. O que existe veio de antes. Não rodei nenhum teste, por causa da regra de só leitura e pouca RAM.

#### F7.3 — Inventário de subprocessadores e base legal · ❌ Não feito

Não existe no repositório nenhum inventário de subprocessadores (provedores de IA, W-API, e-mail) nem um registro de base legal por finalidade. Os documentos só dizem que esse inventário deve existir ou que ainda está pendente. Nenhum commit desta branch tratou do tema.

**O que falta:**
- Criar um documento de inventário (por exemplo docs/privacidade/subprocessadores.md) com cada subprocessador: provedores de IA (modelos usados e ElevenLabs para voz), W-API (WhatsApp), provedores de e-mail (Gmail/OAuth e SMTP) e hospedagem/infraestrutura. Para cada um: dados enviados, finalidade, país ou transferência internacional, retenção, contrato ou DPA, responsável e como desligar.
- Registrar a base legal LGPD (art. 7º e art. 11) para cada finalidade de tratamento, como atendimento por WhatsApp, IA/Nora, e-mail, chamadas e financeiro.
- Indicar se o Norium atua como controlador ou operador em cada finalidade e fazer a validação jurídica do documento.
- Fazer referência ao inventário em docs/AI_GOVERNANCE.md e registrar a mudança no CHANGELOG.md.
- Usar LegalPage.tsx:14-16 (política de privacidade pública) como ponto de partida e mantê-la coerente com o inventário: hoje cita apenas categorias genéricas e não nomeia W-API, ElevenLabs nem os provedores de IA.
- Nomear, no inventário, os provedores reais de e-mail (SMTP ou serviço transacional) e de infraestrutura (Azure), com região de hospedagem.
- Ligar cada base legal do inventário à seção 'Finalidades e bases' da política pública, para que fique explícito por finalidade e não de forma genérica.

_Observação:_ Nos arquivos de handoff e no CHANGELOG não há nenhuma decisão do usuário que tenha mudado este item. A pista 'docs/ LGPD, privacidade' leva apenas a políticas genéricas e a pendências, não a um inventário.

#### F7.4 — Trilha de auditoria e mascaramento em logs · 🟡 Parcial

A trilha de auditoria aparece na tela de Governança, com um link para a auditoria completa no Controle. Falta um mascaramento geral de CPF, telefone e e-mail nos logs. Hoje só existem mascaramentos pontuais: do segredo do webhook no log de acesso, dos telefones no diagnóstico do webhook do WhatsApp e do CPF e cartão no texto enviado à IA, que não é log.

**O que falta:**
- Criar um filtro global de logging (logging.Filter no logger raiz ou nos handlers, registrado no bootstrap) que mascare CPF, telefone e e-mail nas mensagens e nos argumentos.
- Aplicar o mesmo mascaramento em system_logs.record_system_log, nos campos message e metadata, antes de gravar em Postgres ou no JSONL.
- Decidir se a auditoria (tela e CSV exportado) deve mostrar o e-mail mascarado, conforme a regra LGPD da organização.
- Criar testes unitários do mascaramento de CPF, telefone e e-mail em logs.
- O filtro geral dos logs pode reaproveitar ou estender _redact_sensitive (operations/router.py:58), que hoje só cobre chaves de credenciais e só é aplicado ao backup.
- Corrigir a docstring do módulo system_logs.py, que promete um registro 'sanitizado' que não acontece.

_Observação:_ O handoff 2026-10-10-fase1-seguranca-voz.md registra só o mascaramento LGPD no gateway de IA (ai_guardrails), não o mascaramento em logs. Não encontrei decisão do usuário que dispense a parte de logs. A parte de trilha de auditoria visível em Governança está cumprida.

#### F7.5 — Backup e restauração testados · 🟡 Parcial

Já existe ferramenta de backup e restauração do volume de dados, com criptografia, verificação por hash e teste automatizado com dados fictícios. Também há runbooks de backup e de rollback. Faltam três coisas: um ensaio real de restauração com o tempo registrado, a restauração do PostgreSQL comprovada e um plano de reversão para cada entrega. Os documentos marcam esses itens como pendentes.

**O que falta:**
- Executar um ensaio de restauração com tempo medido e registrar o resultado (duração, hash, contagens, revisão) em um handoff ou documento de operações.
- Fazer e testar backup e restauração do PostgreSQL (pg_dump/pg_restore ou ponto no tempo do provedor) em ambiente isolado. Não há script versionado de pg_dump no repositório.
- Ensaiar o rollback de imagem com o RTO medido; o item do CHECKLIST_DE_LANCAMENTO.md continua Pendente.
- Criar plano de reversão por entrega: um modelo ou uma seção obrigatória em cada handoff ou PR, com passos de reversão de código e dados. Hoje só existe a caixa genérica em .github/pull_request_template.md:13.
- Registrar no CHANGELOG.md; hoje não há nenhuma linha sobre backup ou restauração.
- Os registros de restauração do PostgreSQL em cópia isolada (handoffs de 07/10 e 08/10) não trazem duração, hashes nem contagens. É preciso formalizá-los como ensaio com tempo medido.
- O CHECKLIST_DE_LANCAMENTO.md:12-13 (backup com RPO/RTO aprovados e restauração integral em homologação) também continua Pendente, além da linha 16.

_Observação:_ Nenhum commit desta branch (origin/main..HEAD) mexe em backup ou rollback. Tudo o que há é anterior à branch. O workflow shard-homologacao.yml não tem etapa de backup nem de restauração. Não encontrei nenhuma decisão do usuário mudando este item.

### Fase 8

#### F8.1 — Testes de ponta a ponta dos fluxos principais · ❌ Não feito

Não existe teste de ponta a ponta da jornada login → painel → Nora → aprovação → envio. Os testes de navegador com Playwright que existem cobrem só chamadas de equipe e o layout de tarefas. A aprovação da Nora é testada apenas em testes unitários do backend.

**O que falta:**
- Configurar uma ferramenta de E2E (Playwright, por exemplo) com um backend de teste e dados fictícios.
- Criar um teste da jornada login → painel.
- Criar um teste de conversa com a Nora que gere uma ação pendente de aprovação.
- Criar um teste de aprovação (e de rejeição) dessa ação pela interface.
- Criar um teste que confirme o envio (e-mail ou WhatsApp com provedor simulado) e o registro do resultado.
- Rodar o E2E na CI ou no gate de homologação com duas contas e verificar o isolamento entre tenants, guardando o log da execução.
- Registrar a entrega no CHANGELOG.md.
- Os testes de navegador existentes são scripts Python com Playwright soltos, sem runner nem config. Eles não poderiam servir de base para o E2E sem antes ganhar estrutura de execução (fixtures de backend e banco de teste).

_Observação:_ Não achei no CHANGELOG nem no handoff da fase 1 nenhuma decisão do usuário que dispense ou mude este item. Os testes de navegador existentes (chamadas de equipe e layout de tarefas) não cumprem o critério.

#### F8.2 — Liberação gradual com chave para o layout antigo · ❌ Não feito

Não existe chave (feature flag) para voltar ao layout antigo. O layout novo foi aplicado direto nos componentes e nos estilos, que são carregados sempre. Também não houve liberação em produção.

**O que falta:**
- Criar a chave de layout, por variável de ambiente ou configuração por empresa/usuário, para alternar entre o layout novo e o antigo.
- Manter os estilos e a estrutura antigos acessíveis por essa chave. Hoje o layout foi sobrescrito: só dá para voltar revertendo os commits ou a imagem.
- Liberar de forma gradual em produção (por coorte, empresa ou percentual), com a opção de voltar valendo por 2 semanas e data marcada para remover a chave.
- Registrar o procedimento no CHANGELOG/runbook e fazer a validação em homologação antes, porque nada desta branch foi publicado.
- Registrar no handoff se o usuário decidiu abrir mão da chave. Hoje não há desvio registrado para F8.2.
- Definir como voltar ao layout antigo durante as 2 semanas (por exemplo, a tag ou imagem anterior para reverter), caso a chave não seja implementada.

_Observação:_ Não há decisão do usuário registrada que dispense este item. A única volta possível hoje é o rollback de imagem ou de commits, que não equivale a uma chave de layout antigo durante 2 semanas.

#### F8.3 — Homologação, produção, DNS/HTTPS e versão · ❌ Não feito

Nada desta branch foi publicado: não houve validação com usuários-chave em homologação, nem conferência de acesso externo, DNS e HTTPS. O CHANGELOG foi atualizado, mas ainda na seção "[Não publicado]" e sem número de versão.

**O que falta:**
- Fazer push e deploy em homologação, com autorização do responsável, depois de build e testes passarem.
- Validar com usuários-chave em homologação e registrar o resultado no handoff.
- Publicar em produção somente depois da validação em homologação.
- Conferir o acesso externo, o DNS e o HTTPS da URL publicada e registrar a conferência.
- Definir a versão (MAJOR.MINOR.PATCH), trocar "[Não publicado]" no CHANGELOG pela versão com data dd/mm/aaaa e atualizar a versão no package.json ou na fonte de versão do sistema.
- Criar a tag git da versão publicada.
- Registrar no handoff ou no PR o plano de reversão e a conferência depois do deploy, como pede a política.

_Observação:_ O item é operacional (publicação e validação), não de código. Só a parte do CHANGELOG está adiantada.

## 7. Verificação e entrega

- Rodar a suíte completa do backend e do frontend depois de cada fase. Nenhum teste existente pode ser enfraquecido ou apagado.
- Rodar `scripts/nora_brain_smoke.py` e `scripts/backup_restore_drill.py` no ambiente local.
- Conferir no navegador (`http://localhost:5173`, conta de teste local) nos temas claro e escuro e em 375 px:
  - login;
  - Painel;
  - Nora (aprovação exata e reconciliação);
  - Configurações > Consumo da Nora;
  - Privacidade e dados;
  - Governança.
- Atualizar o `CHANGELOG.md`, criar o handoff `docs/handoffs/AAAA-MM-DD-codex-fase6-fase7.md` e registrar o que ficar de fora no `BACKLOG.md`.
- Relatório final para o usuário, curto e em português:
  - o que foi feito por item, com commit e teste;
  - o que não foi feito e por quê;
  - o resultado de cada suíte;
  - o que precisa de autorização (push, merge, deploy, variáveis na Shard).
