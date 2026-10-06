# Correções dos smokes ShardCloud — 06/10/2026

## Estado

Preparado para revisão humana. **Não publicado; deploy não aceito.** Nenhum merge, push, upload, restart, migração ou alteração de dados de produção foi executado.

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

## Validação local

- Regressões novas foram executadas na base antes dos respectivos fixes: envio geral indevido, atribuição sem acesso, ausência de `ready`, prejoin silencioso e Financeiro silencioso falharam como esperado.
- Layout reproduzido no componente real, CSS real e shell correspondente, com APIs sintéticas: a 766 × 930, `.tasks-workspace` tinha altura **0** antes do fix. Depois: **826 px** em 766 × 930 e 390 × 930; **818 px** em 1440 × 930. Nova tarefa abre o modal nos três tamanhos, sem erro JS.
- Backend: **120 testes, zero falhas/erros/skips** no runner oficial `scripts/run_backend_audit_tests.py --label shardcloud-smoke-fixes`, em cópia temporária sem dotenv, credenciais ou sockets externos. Inclui acesso, tarefas, automações, Nora, Central, e-mail, readiness e `test_json_repository`, `test_store_loading`, `test_persistence_fail_closed`.
- Regressão de privacidade inclui proprietário, colaborador, membro sem acesso e outra equipe; envio real pelos gerenciadores locais de transporte, leitura posterior, revogação, troca de equipe, IDs de projeto iguais, criação/atualização/exclusão, automação e replay de checkpoint legado, resumo/Nora, comentário/anexo, atribuição e e-mail pendente.
- Frontend: **47 testes pertinentes** em TasksDashboard, FinanceDashboard, CallSession e TeamCallOverlay.
- Dependências instaladas em diretório próprio do worktree com `npm.cmd ci --offline --no-audit --no-fund`, usando o lockfile da base; nenhum pacote/dependência adicionado.
- `npm.cmd run build`: compilação e orçamento do bundle aprovados.
- Bandit: scan dos arquivos backend alterados, severidade/confiança altas, sem achados nesse nível. Não equivale a pentest ou auditoria completa.
- Oxlint: zero erros; um aviso preexistente de dependência `columns` em `TasksDashboard.useMemo`, fora da correção.
- `git diff --check`: aprovado.
- Registros sintéticos do runner em `output/pos-correcao/shardcloud-smoke-fixes.json` e `.log`, fora do commit. Sem logs de produção.

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

- Revisão humana de autorização, exclusão e fila; decisão sobre remediação histórica e sobre recuperação das atividades legítimas ocultas por falta de referência.
- Gates de `DEPLOY_SHARDCLOUD.md`: SHA/imagem imutável, backup, dados PostgreSQL reais, APIs autenticadas, tickets/protocolo WebSocket, TURN, mídia real, sons, foto e logs sanitizados continuam pendentes. Testes locais com PostgreSQL simulado não substituem prova de produção nem a integração contra banco real.
- A escolha de projeto `default` ainda é ambígua na API existente quando há múltiplos projetos acessíveis com esse ID. A atividade fica vinculada ao dono efetivamente resolvido por taskId; não foi feita migração dos IDs. Próximo smoke deve usar projeto sintético com ID único.
- Nenhum cancelamento da reunião residual implementado nesta tarefa (fora das quatro correções solicitadas).
- Próximo passo: revisar os commits/diff, aprovar código crítico e plano histórico, depois planejar publicação separada conforme procedimento obrigatório. Não considerar este handoff um aceite de deploy.
