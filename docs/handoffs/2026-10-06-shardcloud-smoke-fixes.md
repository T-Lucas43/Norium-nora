# Correções dos smokes ShardCloud — 06/10/2026

## Estado

Código aprovado pelo usuário em 06/10/2026 (mensagem: "codigo aprovado. prossiga"). **Integração em preparação; publicação não executada e deploy não aceito.** Branch enviada para revisão/integração; nenhum upload, restart, migração ou remediação histórica executado até este registro.

- Base consultada com `git fetch origin main`: `56ece8e102144a4ad9777d374f471a7199824dff`.
- Branch: `codex/shardcloud-smoke-fixes-2026-10-06`.
- Worktree: `C:\Users\N4N\.codex-2\worktrees\shardcloud-smoke-fixes\NOrium`.
- Checkout original `C:\NOrium` preservado, incluindo alterações preexistentes e imagens do incidente em `.tmp-tests/shardcloud-smoke-2026-10-06/`.
- [Relatório original](2026-10-06-shardcloud-smokes.md) preservado nesta branch com uma referência adicional a este handoff. SHA de produção permanece **não comprovado**; não presumir que PR #41 ou esta base estejam publicados.
- Finalidade: impedir exposição de atividades de projetos privados e corrigir quatro falhas observadas de interface/contrato. Dados de testes exclusivamente sintéticos; nenhum segredo, chat real ou log bruto de produção usado nos testes.
- Código crítico de autorização e retenção precisa de revisão humana qualificada conforme `docs/AI_GOVERNANCE.md`. Estas mudanças não são aprovação independente de segurança.

## Mudanças revisáveis

1. Atividades carregam referências `{ownerId, projectId}` verificáveis pelo servidor. ID de projeto sozinho é insuficiente: `default` se repete entre contas.
2. Atualização/exclusão, criação por automação, aviso automático subsequente, comentários/anexos e ações da Nora usam autorização de projeto. Exclusão captura a referência antes de remover o card. Responsável não é fonte de permissão: API e store rejeitam atribuição explícita sem acesso; seletor oferece apenas proprietário/colaboradores.
3. Mensagens de atividades seguem apenas para membros ativos da mesma equipe com acesso ao projeto. Histórico, prévia/contagem de threads, recibos, reações, anexos e Central respeitam a mesma visibilidade. Novas leituras revalidam revogação, exclusão do projeto, revogação do módulo Tarefas e mudança de equipe. A leitura em lote usa um snapshot de autorização por consulta, sem cache entre consultas.
4. Atividades antigas identificáveis pelos metadados, sem referência inequívoca ficam ocultas das leituras, inclusive do proprietário. **Continuam armazenadas**. Persistir um novo evento usa leitura sem filtro de acesso para não descartar silenciosamente a evidência anterior. Limites normais de retenção existentes (chat 2000/eventos 1000) continuam exigindo exportação forense antes de qualquer release/remediação.
5. Contexto da Nora no chat geral exclui atividades de tarefas restritas. Resumo automático de tarefas do time usa apenas projetos acessíveis a todos os destinatários e mantém as referências para revalidar leituras posteriores.
6. E-mails novos derivados de atividades verificam acesso ao enfileirar e antes de enviar, no workspace correto. Não é possível retirar conteúdo já entregue a clientes/e-mails.
7. Readiness passa a incluir `ready=true` no sucesso e `detail.ready=false` no erro 503, mantendo `checks.persistence`. Teste HTTP cobre sucesso com driver PostgreSQL simulado.
8. Tarefas recebe altura definida no painel até 900 px, evitando o filho flexível de altura zero. Em navegador real, quadro e abertura de Nova tarefa passam a 766, 390 e 1440 px.
9. Preparação de chamada mostra aviso de falha para retorno falso/exceção e para rejeições recebidas por sinalização; mantém opções, permite nova tentativa e cancelamento. A causa da falha original do convite não foi comprovada; esta correção trata o silêncio, não comprova mídia/conectividade real.
10. Financeiro mostra validação acessível para zero, negativo, valor inválido ou não finito em criação, gasto programado e edição. Nenhuma transação é enviada nessas condições.
11. Healthcheck do container usa a mesma porta configurada em `PORT` e o mesmo fallback 80 do Uvicorn. Antes a sonda consultava sempre 8000, apesar de o painel poder injetar 80. Teste executa o comando Python real do Dockerfile com HTTP simulado em 80, 8000, 8080, vazio e ausência da variável; falha HTTP continua produzindo erro.

## Validação local

- Regressões novas foram executadas na base antes dos respectivos fixes: envio geral indevido, atribuição sem acesso, ausência de `ready`, prejoin silencioso e Financeiro silencioso falharam como esperado.
- Layout reproduzido no componente real, CSS real e shell correspondente, com APIs sintéticas: a 766 × 930, `.tasks-workspace` tinha altura **0** antes do fix. Depois: **826 px** em 766 × 930 e 390 × 930; **818 px** em 1440 × 930. Nova tarefa abre o modal nos três tamanhos, sem erro JS.
- Backend: **141 testes, zero falhas/erros/skips** no runner oficial `scripts/run_backend_audit_tests.py --label shardcloud-review`, em cópia temporária sem dotenv, credenciais ou sockets externos. Inclui acesso, tarefas, automações, Nora, Central, e-mail, readiness e `test_json_repository`, `test_store_loading`, `test_persistence_fail_closed`, além de `tests.test_team_collaboration` e da sonda do container.
- Regressão de privacidade inclui proprietário, colaborador, membro sem acesso e outra equipe; envio real pelos gerenciadores locais de transporte, leitura posterior, revogação, troca de equipe, IDs de projeto iguais, criação/atualização/exclusão, automação e replay de checkpoint legado, resumo/Nora, comentário/anexo, atribuição e e-mail pendente.
- Frontend: **47 testes pertinentes** em TasksDashboard, FinanceDashboard, CallSession e TeamCallOverlay.
- Dependências instaladas em diretório próprio do worktree com `npm.cmd ci --offline --no-audit --no-fund`, usando o lockfile da base; nenhum pacote/dependência adicionado.
- `npm.cmd run build`: compilação e orçamento do bundle aprovados.
- Bandit: scan dos arquivos backend alterados, severidade/confiança altas, sem achados nesse nível. Não equivale a pentest ou auditoria completa.
- Oxlint: zero erros; um aviso preexistente de dependência `columns` em `TasksDashboard.useMemo`, fora da correção.
- `git diff --check`: aprovado.
- Registros sintéticos do runner em `output/pos-correcao/shardcloud-review.json` e `.log`, fora do commit. Sem logs de produção.

Reexecução do layout: iniciar Vite em `127.0.0.1:5178` e executar `tests/browser/test_tasks_layout.py` no frontend com Python Playwright. Nesta máquina foi usado `NORIUM_TEST_BROWSER_CHANNEL=msedge` (headless). A fixture não conecta contas ou APIs reais.

## Remediação histórica — plano para revisão humana, não executado

Antes de aprovar qualquer remediação em produção:

1. Comprovar SHA/imagem e fazer backup verificável do PostgreSQL, fila e registros envolvidos. Preservar a evidência sintética do incidente, com horários e hashes, em arquivo restrito à investigação; não depender da retenção normal do chat.
2. Operador autorizado inventaria mensagens/eventos por IDs, ações, destinatários, workspace e ausência de referências; não enviar títulos/corpos/dumps/logs brutos a IA. Incluir mensagens `task_updated`, `task_deleted`, `task_deleted_by_nora`, `automation_task_created`, avisos genéricos de automação e resumos antigos da Nora. Estes últimos podem não ter metadados suficientes para identificação automática.
3. Revisar também e-mails antigos pendentes: jobs legados não carregam referência ao projeto e não podem ser classificados/revalidados retroativamente apenas pelo `kind`. Preparar lista exata de IDs e decisão humana antes de cancelar/quarentenar qualquer item; não apagar fila inteira.
4. Revisar por mensagem a referência autoritativa. Tarefas já excluídas e IDs `default` são ambíguos: não inferir dono por título/nome do projeto, responsável ou proprietário da equipe. Sem evidência suficiente, manter o acesso bloqueado e o original preservado.
5. Aprovar manifest explícito com ID, hash do original, referência comprovada, destinatários, ação proposta (quarentena/redação/reclassificação), backup e reversão. Realizar dry-run contra cópia restaurada; comparar contagens/hashes e testar os quatro perfis antes de alterar produção.
6. Só executar após revisão humana. A correção local não apaga mensagens antigas, não reescreve histórico em produção e não remove a evidência do incidente.

## Pendências e riscos

- Aprovação do código registrada pelo usuário. Decisão sobre remediação histórica, fila legada e recuperação das atividades legítimas ocultas por falta de referência continua separada e pendente.
- Gates de `DEPLOY_SHARDCLOUD.md`: SHA/imagem imutável, backup, dados PostgreSQL reais, APIs autenticadas, tickets/protocolo WebSocket, TURN, mídia real, sons, foto e logs sanitizados continuam pendentes. Testes locais com PostgreSQL simulado não substituem prova de produção nem a integração contra banco real.
- A escolha de projeto `default` ainda é ambígua na API existente quando há múltiplos projetos acessíveis com esse ID. A atividade fica vinculada ao dono efetivamente resolvido por taskId; não foi feita migração dos IDs. Próximo smoke deve usar projeto sintético com ID único.
- Nenhum cancelamento da reunião residual implementado nesta tarefa (fora das quatro correções solicitadas).
- Próximo passo: revisar os commits/diff, aprovar código crítico e plano histórico, depois planejar publicação separada conforme procedimento obrigatório. Não considerar este handoff um aceite de deploy.


## Retomada: preparação da revisão humana

- Removida uma consulta redundante de autorização em `list_threads`, após o filtro já autorizado. Nova regressão reproduziu **41 leituras para 40 atividades** antes da correção; agora há **um snapshot por requisição**, e a requisição seguinte revalida revogação. Não foi introduzido cache entre requisições.
- Acrescentada regressão do cenário específico do incidente: projeto privado pertence a membro da equipe e o proprietário da equipe não ganha acesso implícito. Acrescentados testes explícitos de prévia/não lidas, recibos, reações e bloqueio de download antes de consultar o arquivo.
- A suíte final passou com **141 testes**. Os 47 testes frontend, build e navegador continuam referentes aos mesmos arquivos frontend; esta retomada não os alterou. Bandit foi repetido no backend alterado, sem achados de severidade/confiança altas; `git diff --check` passou.
- Preflight estático do `Dockerfile.shard`: caminhos do runtime/SPA/dados, worker único, dependências WebSocket fixadas, cópia de fontes e certificados conferidos. O bundle público de CA PostgreSQL foi carregado com sucesso, com duas autoridades. Isto não comprova TLS ou acesso ao banco remoto.
- A imagem não foi construída: Docker não está disponível nesta máquina. Python local é **3.12.10**, enquanto a imagem usa **3.14**; os testes locais não substituem o build e os smokes da imagem. Relatório sintético: `output/review/shardcloud-preflight-local.json`.
- `NORIUM_RELEASE_SHA` tem padrão vazio no Dockerfile. A preparação da release deverá fornecer o SHA integral aprovado e comprovar sua presença em `/health`; o padrão vazio não permite identificar a imagem. Nenhum ZIP de deploy foi gerado: o procedimento exige primeiro o commit validado e aprovado em `origin/main`.

### Decisões que a revisão humana precisa registrar

1. Aprovação por pessoa qualificada do controle de acesso, dos destinatários e da revalidação de e-mails; manter os quatro perfis e o caso do dono da equipe sem acesso como critérios de aceite.
2. Aceite da ocultação conservadora de atividades legadas e aprovação separada do inventário/plano histórico. Nenhuma exclusão de evidência ou limpeza de produção está incluída.
3. Após revisão e merge, comprovar SHA, construir imagem do snapshot exato, verificar sonda na porta efetiva e realizar todos os gates de `DEPLOY_SHARDCLOUD.md`, incluindo mídia/TURN e dados reais. Revisor não deve confundir estes testes locais com aceite da publicação.


## Aprovação e início da integração

- O usuário aprovou o código e solicitou prosseguir em 06/10/2026. A aprovação permite continuar a integração e a preparação; o pedido original de não publicar nesta tarefa continua vigente; não é aceite dos gates de produção nem aprovação para apagar/reclassificar mensagens antigas.
- `origin/main` conferido novamente e continua em `56ece8e102144a4ad9777d374f471a7199824dff`; quatro commits de código aprovados terminam em `d2d6b2dd552666d1ef9557a5d19aeaef40ddca70`.
- Branch enviada ao repositório remoto. GitHub informou transferência para `T-Lucas43/Norium-nora`; o checkout original e seu remote foram preservados.
- Antes da integração, `DEPLOY_AZURE_ENABLED` ainda estava `true`. A variável foi alterada para `false` e o valor reconsultado, evitando promoção para o ambiente abandonado. A validação do PR continua disponível; nenhum workflow manual de Azure foi disparado.
- Painel ShardCloud aberto sem sessão. Login deve ser feito diretamente pelo usuário, sem senha/token enviados ao chat. Confirmar documentos PostgreSQL essenciais, imagem anterior recuperável e configuração atual antes de qualquer troca.
- O ZIP só poderá ser gerado após o SHA esperado estar em `origin/main`, e o SHA deverá ser fornecido no build ou na configuração da release e comprovado em `/health`. Preservar `NORIUM_AUTH_SECRET` e todos os dados/configurações existentes.


## Gates de integração — PR #46

- PR: https://github.com/T-Lucas43/Norium-nora/pull/46. CI inicial: execução `37546684429`, SHA `44d73f1bd10124b367bd0a7268d2f32f479b5d1f`.
- Job `postgres-persistence` passou com PostgreSQL 16 temporário e Python 3.14; prova de JSONB/BYTEA/tabelas/importação, não dos dados de produção.
- A suíte completa local executou 1139 testes e encontrou duas falhas. Ambas foram reproduzidas no snapshot original de `origin/main`, em worktree separado: contrato de status do Kanban e aba Modelos de mensagens sem guia da Nora. A versão de CI registrou ainda um erro sem relatório detalhado; não presumir que seja equivalente ao resultado local.
- Correção dos gates: registrar a ampliação já existente de status do Kanban, com testes de valores legados/default/etapas personalizadas/identificadores inválidos; adicionar guia real de Modelos de mensagens, incluindo limite de envio. Os 16 testes específicos passam.
- Workflow passa a preservar somente `.json` e `.log` do runner isolado de testes sintéticos para investigar falhas de runtime. Não preserva dumps, credenciais ou logs de produção.
- Pelo navegador, antes da publicação, `/health` continua sem `revision`, e `/health/ready` continua sem `ready`, com PostgreSQL. SHA publicado não comprovado. A consulta por CLI recebeu 403; isto não comprova indisponibilidade da aplicação, que respondeu pelo navegador.
- Hashes dos 14 arquivos locais de evidência sintética registrados em `output/release/incident-evidence-hashes.json`. Originais intactos. Provas de base e observações minimizadas estão em `output/release/`.
- Até os checks passarem, não integrar nem publicar. Login no painel e preflight dos dados de produção continuam pendentes.


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


## Gate de chamadas — alinhamento do smoke à interface

- Na execução `37547417524`, 41 cenários passaram; `simultaneous_offer` falhou na primeira repetição e passou nas duas seguintes (classificado como transitório pelo critério existente). `screen_share` falhou nas três repetições. Carga passou com 100 conexões retidas. Nenhum critério/timeout foi relaxado.
- A causa bloqueante do smoke de tela foi comprovada por inspeção da base: `origin/main` já exige **Assistir transmissão**, mas o teste aguardava um vídeo antes de o destinatário escolher assistir. O teste agora exige o botão, confirma ausência do vídeo antes da escolha, clica, comprova o vídeo/RTP e confirma sua remoção ao encerrar. Os dois controles equivalentes de parar transmissão são tratados explicitamente. Nenhum código de produto foi alterado nesta correção do smoke.
- Navegador local Edge headless com fake devices nativos, fixture FastAPI/WebSocket e TURN local: **screen_share e simultaneous_offer passaram nas três repetições**, seis cenários no total. Artefato agregado `output/release/call-gate-regression/summary.json`; mídia e logs brutos descartados conforme política existente. Não comprova TURN TLS nem mídia/sons reais de produção.
- CI do lockfile corrigido, execução `37548671244`, passou backend Python 3.14, SCA/Bandit e PostgreSQL 16; os demais checks ainda estavam em andamento. Execuções substituídas poderão ser canceladas exclusivamente para evitar testar um smoke já corrigido; nenhuma execução parcial será usada como aceite.
- A seção Deploy do painel confirma que a imagem personalizada controla a atualização; não oferece uma imagem identificável no runtime. O limite de rollback/documentos/backup continua pendente. Produção intacta.


## Impedir publicação automática no ambiente abandonado

- Conferência do workflow identificou que `DEPLOY_AZURE_ENABLED=false` originalmente bloqueava somente a promoção, mas deixava `publish-image` publicar `Dockerfile.azure` no GHCR em push para main, e `team-call-release` executar a preparação legada.
- Os dois jobs passam a respeitar a mesma variável de desativação. Com `false`, testes backend/frontend, SCA/SAST/secrets, PostgreSQL e qualidade de chamadas continuam obrigatórios; imagem/release/deploy Azure ficam desativados. Isto impede publicação automática durante a integração autorizada e não substitui nenhum gate de aceite ShardCloud.
- YAML interpretado e condições dos cinco jobs conferidas localmente. Variável remota reconsultada como `false`. Nenhuma credencial/secret alterada e nenhuma publicação disparada.
