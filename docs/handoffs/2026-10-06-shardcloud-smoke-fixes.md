# CorreÃ§Ãµes dos smokes ShardCloud â€” 06/10/2026

## Estado

CÃ³digo aprovado pelo usuÃ¡rio em 06/10/2026 (mensagem: "codigo aprovado. prossiga"). **PublicaÃ§Ã£o em preparaÃ§Ã£o; deploy nÃ£o aceito.** Branch enviada para revisÃ£o/integraÃ§Ã£o; nenhum upload, restart, migraÃ§Ã£o ou remediaÃ§Ã£o histÃ³rica executado atÃ© este registro.

- Base consultada com `git fetch origin main`: `56ece8e102144a4ad9777d374f471a7199824dff`.
- Branch: `codex/shardcloud-smoke-fixes-2026-10-06`.
- Worktree: `C:\Users\N4N\.codex-2\worktrees\shardcloud-smoke-fixes\NOrium`.
- Checkout original `C:\NOrium` preservado, incluindo alteraÃ§Ãµes preexistentes e imagens do incidente em `.tmp-tests/shardcloud-smoke-2026-10-06/`.
- [RelatÃ³rio original](2026-10-06-shardcloud-smokes.md) preservado nesta branch com uma referÃªncia adicional a este handoff. SHA de produÃ§Ã£o permanece **nÃ£o comprovado**; nÃ£o presumir que PR #41 ou esta base estejam publicados.
- Finalidade: impedir exposiÃ§Ã£o de atividades de projetos privados e corrigir quatro falhas observadas de interface/contrato. Dados de testes exclusivamente sintÃ©ticos; nenhum segredo, chat real ou log bruto de produÃ§Ã£o usado nos testes.
- CÃ³digo crÃ­tico de autorizaÃ§Ã£o e retenÃ§Ã£o precisa de revisÃ£o humana qualificada conforme `docs/AI_GOVERNANCE.md`. Estas mudanÃ§as nÃ£o sÃ£o aprovaÃ§Ã£o independente de seguranÃ§a.

## MudanÃ§as revisÃ¡veis

1. Atividades carregam referÃªncias `{ownerId, projectId}` verificÃ¡veis pelo servidor. ID de projeto sozinho Ã© insuficiente: `default` se repete entre contas.
2. AtualizaÃ§Ã£o/exclusÃ£o, criaÃ§Ã£o por automaÃ§Ã£o, aviso automÃ¡tico subsequente, comentÃ¡rios/anexos e aÃ§Ãµes da Nora usam autorizaÃ§Ã£o de projeto. ExclusÃ£o captura a referÃªncia antes de remover o card. ResponsÃ¡vel nÃ£o Ã© fonte de permissÃ£o: API e store rejeitam atribuiÃ§Ã£o explÃ­cita sem acesso; seletor oferece apenas proprietÃ¡rio/colaboradores.
3. Mensagens de atividades seguem apenas para membros ativos da mesma equipe com acesso ao projeto. HistÃ³rico, prÃ©via/contagem de threads, recibos, reaÃ§Ãµes, anexos e Central respeitam a mesma visibilidade. Novas leituras revalidam revogaÃ§Ã£o, exclusÃ£o do projeto, revogaÃ§Ã£o do mÃ³dulo Tarefas e mudanÃ§a de equipe. A leitura em lote usa um snapshot de autorizaÃ§Ã£o por consulta, sem cache entre consultas.
4. Atividades antigas identificÃ¡veis pelos metadados, sem referÃªncia inequÃ­voca ficam ocultas das leituras, inclusive do proprietÃ¡rio. **Continuam armazenadas**. Persistir um novo evento usa leitura sem filtro de acesso para nÃ£o descartar silenciosamente a evidÃªncia anterior. Limites normais de retenÃ§Ã£o existentes (chat 2000/eventos 1000) continuam exigindo exportaÃ§Ã£o forense antes de qualquer release/remediaÃ§Ã£o.
5. Contexto da Nora no chat geral exclui atividades de tarefas restritas. Resumo automÃ¡tico de tarefas do time usa apenas projetos acessÃ­veis a todos os destinatÃ¡rios e mantÃ©m as referÃªncias para revalidar leituras posteriores.
6. E-mails novos derivados de atividades verificam acesso ao enfileirar e antes de enviar, no workspace correto. NÃ£o Ã© possÃ­vel retirar conteÃºdo jÃ¡ entregue a clientes/e-mails.
7. Readiness passa a incluir `ready=true` no sucesso e `detail.ready=false` no erro 503, mantendo `checks.persistence`. Teste HTTP cobre sucesso com driver PostgreSQL simulado.
8. Tarefas recebe altura definida no painel atÃ© 900 px, evitando o filho flexÃ­vel de altura zero. Em navegador real, quadro e abertura de Nova tarefa passam a 766, 390 e 1440 px.
9. PreparaÃ§Ã£o de chamada mostra aviso de falha para retorno falso/exceÃ§Ã£o e para rejeiÃ§Ãµes recebidas por sinalizaÃ§Ã£o; mantÃ©m opÃ§Ãµes, permite nova tentativa e cancelamento. A causa da falha original do convite nÃ£o foi comprovada; esta correÃ§Ã£o trata o silÃªncio, nÃ£o comprova mÃ­dia/conectividade real.
10. Financeiro mostra validaÃ§Ã£o acessÃ­vel para zero, negativo, valor invÃ¡lido ou nÃ£o finito em criaÃ§Ã£o, gasto programado e ediÃ§Ã£o. Nenhuma transaÃ§Ã£o Ã© enviada nessas condiÃ§Ãµes.
11. Healthcheck do container usa a mesma porta configurada em `PORT` e o mesmo fallback 80 do Uvicorn. Antes a sonda consultava sempre 8000, apesar de o painel poder injetar 80. Teste executa o comando Python real do Dockerfile com HTTP simulado em 80, 8000, 8080, vazio e ausÃªncia da variÃ¡vel; falha HTTP continua produzindo erro.

## ValidaÃ§Ã£o local

- RegressÃµes novas foram executadas na base antes dos respectivos fixes: envio geral indevido, atribuiÃ§Ã£o sem acesso, ausÃªncia de `ready`, prejoin silencioso e Financeiro silencioso falharam como esperado.
- Layout reproduzido no componente real, CSS real e shell correspondente, com APIs sintÃ©ticas: a 766 Ã— 930, `.tasks-workspace` tinha altura **0** antes do fix. Depois: **826 px** em 766 Ã— 930 e 390 Ã— 930; **818 px** em 1440 Ã— 930. Nova tarefa abre o modal nos trÃªs tamanhos, sem erro JS.
- Backend: **141 testes, zero falhas/erros/skips** no runner oficial `scripts/run_backend_audit_tests.py --label shardcloud-review`, em cÃ³pia temporÃ¡ria sem dotenv, credenciais ou sockets externos. Inclui acesso, tarefas, automaÃ§Ãµes, Nora, Central, e-mail, readiness e `test_json_repository`, `test_store_loading`, `test_persistence_fail_closed`, alÃ©m de `tests.test_team_collaboration` e da sonda do container.
- RegressÃ£o de privacidade inclui proprietÃ¡rio, colaborador, membro sem acesso e outra equipe; envio real pelos gerenciadores locais de transporte, leitura posterior, revogaÃ§Ã£o, troca de equipe, IDs de projeto iguais, criaÃ§Ã£o/atualizaÃ§Ã£o/exclusÃ£o, automaÃ§Ã£o e replay de checkpoint legado, resumo/Nora, comentÃ¡rio/anexo, atribuiÃ§Ã£o e e-mail pendente.
- Frontend: **47 testes pertinentes** em TasksDashboard, FinanceDashboard, CallSession e TeamCallOverlay.
- DependÃªncias instaladas em diretÃ³rio prÃ³prio do worktree com `npm.cmd ci --offline --no-audit --no-fund`, usando o lockfile da base; nenhum pacote/dependÃªncia adicionado.
- `npm.cmd run build`: compilaÃ§Ã£o e orÃ§amento do bundle aprovados.
- Bandit: scan dos arquivos backend alterados, severidade/confianÃ§a altas, sem achados nesse nÃ­vel. NÃ£o equivale a pentest ou auditoria completa.
- Oxlint: zero erros; um aviso preexistente de dependÃªncia `columns` em `TasksDashboard.useMemo`, fora da correÃ§Ã£o.
- `git diff --check`: aprovado.
- Registros sintÃ©ticos do runner em `output/pos-correcao/shardcloud-review.json` e `.log`, fora do commit. Sem logs de produÃ§Ã£o.

ReexecuÃ§Ã£o do layout: iniciar Vite em `127.0.0.1:5178` e executar `tests/browser/test_tasks_layout.py` no frontend com Python Playwright. Nesta mÃ¡quina foi usado `NORIUM_TEST_BROWSER_CHANNEL=msedge` (headless). A fixture nÃ£o conecta contas ou APIs reais.

## RemediaÃ§Ã£o histÃ³rica â€” plano para revisÃ£o humana, nÃ£o executado

Antes de aprovar qualquer remediaÃ§Ã£o em produÃ§Ã£o:

1. Comprovar SHA/imagem e fazer backup verificÃ¡vel do PostgreSQL, fila e registros envolvidos. Preservar a evidÃªncia sintÃ©tica do incidente, com horÃ¡rios e hashes, em arquivo restrito Ã  investigaÃ§Ã£o; nÃ£o depender da retenÃ§Ã£o normal do chat.
2. Operador autorizado inventaria mensagens/eventos por IDs, aÃ§Ãµes, destinatÃ¡rios, workspace e ausÃªncia de referÃªncias; nÃ£o enviar tÃ­tulos/corpos/dumps/logs brutos a IA. Incluir mensagens `task_updated`, `task_deleted`, `task_deleted_by_nora`, `automation_task_created`, avisos genÃ©ricos de automaÃ§Ã£o e resumos antigos da Nora. Estes Ãºltimos podem nÃ£o ter metadados suficientes para identificaÃ§Ã£o automÃ¡tica.
3. Revisar tambÃ©m e-mails antigos pendentes: jobs legados nÃ£o carregam referÃªncia ao projeto e nÃ£o podem ser classificados/revalidados retroativamente apenas pelo `kind`. Preparar lista exata de IDs e decisÃ£o humana antes de cancelar/quarentenar qualquer item; nÃ£o apagar fila inteira.
4. Revisar por mensagem a referÃªncia autoritativa. Tarefas jÃ¡ excluÃ­das e IDs `default` sÃ£o ambÃ­guos: nÃ£o inferir dono por tÃ­tulo/nome do projeto, responsÃ¡vel ou proprietÃ¡rio da equipe. Sem evidÃªncia suficiente, manter o acesso bloqueado e o original preservado.
5. Aprovar manifest explÃ­cito com ID, hash do original, referÃªncia comprovada, destinatÃ¡rios, aÃ§Ã£o proposta (quarentena/redaÃ§Ã£o/reclassificaÃ§Ã£o), backup e reversÃ£o. Realizar dry-run contra cÃ³pia restaurada; comparar contagens/hashes e testar os quatro perfis antes de alterar produÃ§Ã£o.
6. SÃ³ executar apÃ³s revisÃ£o humana. A correÃ§Ã£o local nÃ£o apaga mensagens antigas, nÃ£o reescreve histÃ³rico em produÃ§Ã£o e nÃ£o remove a evidÃªncia do incidente.

## PendÃªncias e riscos

- AprovaÃ§Ã£o do cÃ³digo registrada pelo usuÃ¡rio. DecisÃ£o sobre remediaÃ§Ã£o histÃ³rica, fila legada e recuperaÃ§Ã£o das atividades legÃ­timas ocultas por falta de referÃªncia continua separada e pendente.
- Gates de `DEPLOY_SHARDCLOUD.md`: SHA/imagem imutÃ¡vel, backup, dados PostgreSQL reais, APIs autenticadas, tickets/protocolo WebSocket, TURN, mÃ­dia real, sons, foto e logs sanitizados continuam pendentes. Testes locais com PostgreSQL simulado nÃ£o substituem prova de produÃ§Ã£o nem a integraÃ§Ã£o contra banco real.
- A escolha de projeto `default` ainda Ã© ambÃ­gua na API existente quando hÃ¡ mÃºltiplos projetos acessÃ­veis com esse ID. A atividade fica vinculada ao dono efetivamente resolvido por taskId; nÃ£o foi feita migraÃ§Ã£o dos IDs. PrÃ³ximo smoke deve usar projeto sintÃ©tico com ID Ãºnico.
- Nenhum cancelamento da reuniÃ£o residual implementado nesta tarefa (fora das quatro correÃ§Ãµes solicitadas).
- PrÃ³ximo passo: revisar os commits/diff, aprovar cÃ³digo crÃ­tico e plano histÃ³rico, depois planejar publicaÃ§Ã£o separada conforme procedimento obrigatÃ³rio. NÃ£o considerar este handoff um aceite de deploy.


## Retomada: preparaÃ§Ã£o da revisÃ£o humana

- Removida uma consulta redundante de autorizaÃ§Ã£o em `list_threads`, apÃ³s o filtro jÃ¡ autorizado. Nova regressÃ£o reproduziu **41 leituras para 40 atividades** antes da correÃ§Ã£o; agora hÃ¡ **um snapshot por requisiÃ§Ã£o**, e a requisiÃ§Ã£o seguinte revalida revogaÃ§Ã£o. NÃ£o foi introduzido cache entre requisiÃ§Ãµes.
- Acrescentada regressÃ£o do cenÃ¡rio especÃ­fico do incidente: projeto privado pertence a membro da equipe e o proprietÃ¡rio da equipe nÃ£o ganha acesso implÃ­cito. Acrescentados testes explÃ­citos de prÃ©via/nÃ£o lidas, recibos, reaÃ§Ãµes e bloqueio de download antes de consultar o arquivo.
- A suÃ­te final passou com **141 testes**. Os 47 testes frontend, build e navegador continuam referentes aos mesmos arquivos frontend; esta retomada nÃ£o os alterou. Bandit foi repetido no backend alterado, sem achados de severidade/confianÃ§a altas; `git diff --check` passou.
- Preflight estÃ¡tico do `Dockerfile.shard`: caminhos do runtime/SPA/dados, worker Ãºnico, dependÃªncias WebSocket fixadas, cÃ³pia de fontes e certificados conferidos. O bundle pÃºblico de CA PostgreSQL foi carregado com sucesso, com duas autoridades. Isto nÃ£o comprova TLS ou acesso ao banco remoto.
- A imagem nÃ£o foi construÃ­da: Docker nÃ£o estÃ¡ disponÃ­vel nesta mÃ¡quina. Python local Ã© **3.12.10**, enquanto a imagem usa **3.14**; os testes locais nÃ£o substituem o build e os smokes da imagem. RelatÃ³rio sintÃ©tico: `output/review/shardcloud-preflight-local.json`.
- `NORIUM_RELEASE_SHA` tem padrÃ£o vazio no Dockerfile. A preparaÃ§Ã£o da release deverÃ¡ fornecer o SHA integral aprovado e comprovar sua presenÃ§a em `/health`; o padrÃ£o vazio nÃ£o permite identificar a imagem. Nenhum ZIP de deploy foi gerado: o procedimento exige primeiro o commit validado e aprovado em `origin/main`.

### DecisÃµes que a revisÃ£o humana precisa registrar

1. AprovaÃ§Ã£o por pessoa qualificada do controle de acesso, dos destinatÃ¡rios e da revalidaÃ§Ã£o de e-mails; manter os quatro perfis e o caso do dono da equipe sem acesso como critÃ©rios de aceite.
2. Aceite da ocultaÃ§Ã£o conservadora de atividades legadas e aprovaÃ§Ã£o separada do inventÃ¡rio/plano histÃ³rico. Nenhuma exclusÃ£o de evidÃªncia ou limpeza de produÃ§Ã£o estÃ¡ incluÃ­da.
3. ApÃ³s revisÃ£o e merge, comprovar SHA, construir imagem do snapshot exato, verificar sonda na porta efetiva e realizar todos os gates de `DEPLOY_SHARDCLOUD.md`, incluindo mÃ­dia/TURN e dados reais. Revisor nÃ£o deve confundir estes testes locais com aceite da publicaÃ§Ã£o.


## AprovaÃ§Ã£o e inÃ­cio da integraÃ§Ã£o

- O usuÃ¡rio aprovou o cÃ³digo e solicitou prosseguir em 06/10/2026. A autorizaÃ§Ã£o permite integrar e preparar a publicaÃ§Ã£o; nÃ£o Ã© aceite dos gates de produÃ§Ã£o nem aprovaÃ§Ã£o para apagar/reclassificar mensagens antigas.
- `origin/main` conferido novamente e continua em `56ece8e102144a4ad9777d374f471a7199824dff`; quatro commits de cÃ³digo aprovados terminam em `d2d6b2dd552666d1ef9557a5d19aeaef40ddca70`.
- Branch enviada ao repositÃ³rio remoto. GitHub informou transferÃªncia para `T-Lucas43/Norium-nora`; o checkout original e seu remote foram preservados.
- Antes da integraÃ§Ã£o, `DEPLOY_AZURE_ENABLED` ainda estava `true`. A variÃ¡vel foi alterada para `false` e o valor reconsultado, evitando promoÃ§Ã£o para o ambiente abandonado. A validaÃ§Ã£o do PR continua disponÃ­vel; nenhum workflow manual de Azure foi disparado.
- Painel ShardCloud aberto sem sessÃ£o. Login deve ser feito diretamente pelo usuÃ¡rio, sem senha/token enviados ao chat. Confirmar documentos PostgreSQL essenciais, imagem anterior recuperÃ¡vel e configuraÃ§Ã£o atual antes de qualquer troca.
- O ZIP sÃ³ poderÃ¡ ser gerado apÃ³s o SHA esperado estar em `origin/main`, e o SHA deverÃ¡ ser fornecido no build ou na configuraÃ§Ã£o da release e comprovado em `/health`. Preservar `NORIUM_AUTH_SECRET` e todos os dados/configuraÃ§Ãµes existentes.


## Gates de integraÃ§Ã£o â€” PR #46

- PR: https://github.com/T-Lucas43/Norium-nora/pull/46. CI inicial: execuÃ§Ã£o `37546684429`, SHA `44d73f1bd10124b367bd0a7268d2f32f479b5d1f`.
- Job `postgres-persistence` passou com PostgreSQL 16 temporÃ¡rio e Python 3.14; prova de JSONB/BYTEA/tabelas/importaÃ§Ã£o, nÃ£o dos dados de produÃ§Ã£o.
- A suÃ­te completa local executou 1139 testes e encontrou duas falhas. Ambas foram reproduzidas no snapshot original de `origin/main`, em worktree separado: contrato de status do Kanban e aba Modelos de mensagens sem guia da Nora. A versÃ£o de CI registrou ainda um erro sem relatÃ³rio detalhado; nÃ£o presumir que seja equivalente ao resultado local.
- CorreÃ§Ã£o dos gates: registrar a ampliaÃ§Ã£o jÃ¡ existente de status do Kanban, com testes de valores legados/default/etapas personalizadas/identificadores invÃ¡lidos; adicionar guia real de Modelos de mensagens, incluindo limite de envio. Os 16 testes especÃ­ficos passam.
- Workflow passa a preservar somente `.json` e `.log` do runner isolado de testes sintÃ©ticos para investigar falhas de runtime. NÃ£o preserva dumps, credenciais ou logs de produÃ§Ã£o.
- Pelo navegador, antes da publicaÃ§Ã£o, `/health` continua sem `revision`, e `/health/ready` continua sem `ready`, com PostgreSQL. SHA publicado nÃ£o comprovado. A consulta por CLI recebeu 403; isto nÃ£o comprova indisponibilidade da aplicaÃ§Ã£o, que respondeu pelo navegador.
- Hashes dos 14 arquivos locais de evidÃªncia sintÃ©tica registrados em `output/release/incident-evidence-hashes.json`. Originais intactos. Provas de base e observaÃ§Ãµes minimizadas estÃ£o em `output/release/`.
- AtÃ© os checks passarem, nÃ£o integrar nem publicar. Login no painel e preflight dos dados de produÃ§Ã£o continuam pendentes.


## Gate de dependências e nova validação

- A execução CI `37547417524`, no commit `7a7bf1d4683c13308f99ec61dff68929966067d4`, passou os **1142 testes backend em Python 3.14.7**, sem erros, e a integração PostgreSQL 16. O erro extra da primeira execução não reapareceu. O scan seguinte bloqueou a integração por **13 vulnerabilidades em quatro dependências**; não foi feita exceção no scanner.
- Atualização mínima de pacotes existentes: `multidict 6.7.1 → 6.9.1`, `oauthlib 3.3.1 → 4.0.0`, `pypdf 6.16.1 → 6.19.0`, `urllib3 2.7.0 → 2.8.0`. `requirements.txt` e lockfile concordam para pypdf. Nenhuma nova dependência de aplicação foi adicionada.
- Fontes primárias verificadas: [multidict](https://github.com/aio-libs/multidict/security/advisories/GHSA-54p9-h82j-f925), [OAuthLib](https://github.com/oauthlib/oauthlib/security/advisories/GHSA-xpv3-w29h-x7cv), [release OAuthLib 4.0](https://github.com/oauthlib/oauthlib/releases/tag/v4.0.0), [pypdf 6.19](https://github.com/py-pdf/pypdf/releases/tag/6.19.0), [urllib3 2.8](https://github.com/urllib3/urllib3/releases/tag/2.8.0). O advisory OAuth menciona 3.3.2, mas essa versão não está publicada no registro PyPI; 4.0.0 é a versão corrigida disponível e reconhecida pelo audit. Suas mudanças incompatíveis documentadas afetam endpoints de servidor OAuth; Norium utiliza o cliente Google, sem alterar sua implementação.
- Um novo ambiente isolado em `output/release/dependency-venv/` instalou exatamente o lockfile. `pip check` passou; o ambiente original em `C:\NOrium` permaneceu intacto.
- Dois testes novos exercitam a pilha real Google/Requests/OAuthLib para Gmail e Agenda, com requisição HTTP preparada e resposta sintética: geração PKCE S256, preservação do verificador no retorno, troca do código e construção das credenciais; resposta sem access_token é rejeitada. Nenhuma conta ou chamada externa utilizada. Os testes existentes continuam cobrindo estado obrigatório/expiração/usuário correto.
- **121 testes afetados** (OAuth, PDF, Comercial e persistência) e **1144 testes backend completos** passaram, zero falhas/erros/skips, em Python 3.12.10 com as novas versões. Relatórios `output/pos-correcao/dependency-contract.*` e `dependency-full-backend.*`.
- Frontend completo: **129 arquivos / 787 testes** passaram. Lint passou com avisos preexistentes; `npm.cmd run build` e orçamento do bundle passaram. Relatórios locais em `output/release/frontend-*.log`.
- `pip-audit` do lockfile completo: **67 pacotes, zero vulnerabilidades conhecidas** no momento da consulta. Bandit completo do backend, severidade/confiança médias ou superiores conforme CI, passou; `git diff --check` passou. Relatórios em `output/release/backend-dependency-audit-fixed.json` e `backend-bandit-full.json`. Não equivale a auditoria independente nem elimina necessidade de review das atualizações.
- Os checks remotos do novo commit em Python 3.14, frontend, secrets e chamadas ainda precisam terminar antes do merge. O gate de chamadas da execução anterior estava em andamento; não considerar mídia comprovada por execução parcial.

## Preflight do painel — somente leitura

- Usuário realizou login diretamente no ShardCloud. O painel mostrou `norium-next` ligado ao domínio público `norium.shardweb.app`, e `norium` ligado a `norium-rollback-9881f62.shardweb.app`. Nomes de aplicações e descrição antiga não comprovam SHA da imagem em execução.
- Na área Imagens Docker, a lista estava vazia mesmo após Atualizar. O runtime de `norium-next` informou: "As informações da imagem personalizada não estão disponíveis." A imagem anterior recuperável e o mecanismo de substituição não foram comprovados; não criar imagem nova nem reiniciar enquanto o rollback estiver indefinido.
- Nenhum log bruto de produção, valor de credencial, dump ou conteúdo de banco foi enviado à IA. Dados PostgreSQL essenciais e backup verificável continuam pendentes. Nenhuma configuração, upload, restart, migração, limpeza histórica ou rollback foi executado no ShardCloud.
- A mensagem "codigo aprovado. prossiga" registra aprovação do código já apresentado. O pedido original de **não publicar nesta tarefa** permanece vigente; aprovação de código não é declaração de aceite de produção. As atualizações de dependências e os ajustes dos gates posteriores à aprovação estão separados e documentados para revisão.
