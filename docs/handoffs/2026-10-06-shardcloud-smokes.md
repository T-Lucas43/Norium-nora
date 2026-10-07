# Smokes do Norium publicado no ShardCloud — 05 e 06/10/2026

## Estado do aceite

**Não aceito como deploy concluído.** Há evidência funcional de vários fluxos, mas o contrato de readiness está incompleto e outros gates permanecem sem prova. Esta rodada executou testes na publicação existente; não fez merge, upload, restart, migração, alteração direta no PostgreSQL ou rollback.

- Endereço testado: `https://norium.shardweb.app`.
- Contas exclusivas de teste: **Codex-Nando** e **Codex-Nando 2**, confirmadas na mesma equipe, com dois membros ativos.
- Horários abaixo em America/Sao_Paulo.
- SHA da publicação existente: **não comprovado**. O usuário dispensou a investigação da imagem nesta conversa; isso não comprova que o código local está publicado.
- Fonte usada para investigar comportamento: PR #41, SHA `b9c97cac28694aaa4ffd8585d7400b675978616f`. Conclusões sobre código são condicionais à versão publicada.
- O checkout `C:\NOrium` contém alterações preexistentes. Foram preservadas; este arquivo registra o estado da tarefa e não autoriza commit delas.
- Senhas, tokens, cookies, links de confirmação, e-mails de teste e logs brutos não fazem parte desta evidência.

## Evidência por gate

| Gate | Resultado observado e limite |
| --- | --- |
| Liveness | Em 06/10, aproximadamente 09:21, `GET /health` retornou HTTP 200 e `{"status":"ok"}`. |
| Readiness e PostgreSQL | No mesmo período, `GET /health/ready` retornou HTTP 200, `status=ready`, `checks.persistence.status=ready`, `checks.persistence.driver=postgresql` e `schema=1`. **Não devolve o campo obrigatório `ready=true`. Gate formal reprovado.** |
| Login e equipe | Em 05/10 e 06/10, duas sessões com identidades distintas e dois membros ativos na mesma equipe. A sessão foi preservada durante recargas. Em 06/10, o usuário entrou diretamente nas duas contas. `/api/auth/me` não foi capturado diretamente. |
| Chat | Presença de dois usuários, entrega em tempo real, indicador de não lida na segunda conta, histórico após recarga e recibo de uma leitura observados. Mensagem sintética enviada em 05/10 às 23:38. |
| Protocolo WebSocket | O funcionamento da UI foi observado, mas não houve captura direta de ticket nem dos eventos `CONNECTED`, `PRESENCE` e `CALLS_STATE`. Não declarar esse gate diretamente comprovado. |
| Chamada | Início, convite único observado, ingresso pela prévia da reunião ativa, dois participantes com estado “áudio conectado”, recarga da segunda conta restaurando a chamada, saída da segunda conta e encerramento pelo organizador observados. Ambas entraram em modo somente escuta e com câmera desligada. |
| Limites da chamada | O ingresso inicial pelo convite permaneceu na preparação sem erro visível; depois foi possível entrar pela prévia da chamada ativa. O aviso **TURN indisponível** apareceu nas duas contas. Não houve captura/escuta de mídia, verificação direta de heartbeat, transmissão de tela, gravação ou confirmação dos sons. Sem foto configurada, a UI exibiu iniciais; a foto de perfil com câmera desligada não foi testada. |
| Documentos | Em 06/10, layout observado em **1440 × 900** e **390 × 844**, com conteúdo legível e sem overflow horizontal da página após a adaptação responsiva. Na tela estreita, as abas usam rolagem interna. Criado o rascunho sintético `SMOKE_DOCUMENTO_2026-10-06` com briefing fictício, sem vínculo com cliente; conteúdo editado manualmente com o marcador `SMOKE_DOCUMENTO_EDICAO_2026-10-06`, salvo como versão 2. Após recarga e reabertura, versão 2, estado Salvo e texto editado permaneceram. Compartilhado individualmente com Codex-Nando 2 como Ver; segunda conta abriu como “somente para visualização”, título desabilitado e nenhum contenteditable. Acesso revogado; recarga da segunda conta voltou a Total 0 / Compartilhados 0. Anexos, assinaturas e exportação não exercitados. |
| Clientes | Cliente sintético criado pela primeira conta, compartilhado com a segunda como **Ver**, visível como compartilhado e sem botão Editar. Acesso revogado, segunda conta recarregada com zero clientes. Registro excluído com autorização humana; primeira conta voltou a zero clientes. |
| Preferência de e-mail | “Outras atualizações de clientes” na primeira conta alterada de 1 para 0, salva e preservada após recarga; segunda conta continuou em 1. Primeira conta restaurada a 1, com confirmação de salvamento. |
| Tarefas | Tarefa sintética criada e atribuída à segunda conta no projeto pessoal padrão. A responsável inicialmente não viu a tarefa. Após compartilhar explicitamente o projeto, o projeto e a tarefa apareceram na segunda conta. Compartilhamento revogado e segunda conta voltou a zero projetos da equipe. Tarefa excluída com autorização humana; quadro do proprietário voltou a zero. **Em 06/10 às 09:47, excluir uma nova tarefa pessoal da segunda conta, cujo projeto nunca foi compartilhado, publicou título e nome do projeto no chat da equipe e na Central da primeira conta. Gate de isolamento reprovado.** |
| Menções | Menção à segunda conta selecionada pela UI, enviada em “Time todo”; prévia, mensagem e notificação específica chegaram à segunda conta, com recibo de leitura na primeira. Em 06/10 às 09:28 foi enviada `SMOKE_EMAIL_MENCAO_2026-10-06T12:28:46.413Z`. **O usuário confirmou recebimento do e-mail apenas por Codex-Nando 2.** |
| Reunião agendada | Reunião sintética criada em 05/10 às 23:58, para 06/10 às 00:15, com as duas contas convidadas. Aviso e cartão apareceram nas duas sessões. **As duas contas mostraram o lembrete “Reunião em 10 minutos”, registrado às 00:05.** E-mail do lembrete sem prova; a confirmação dos endereços ocorreu depois, e a fonte PR #41 não reenvia automaticamente o lembrete já marcado. |
| Financeiro | Criado em Codex-Nando o lançamento manual fictício `SMOKE_EMAIL_CONTA_PAGAR_2026-10-06`, tipo Saída, R$ 1,00, Pendente, vencimento 06/10/2026. Persistência e aviso de criação na Central observados. Nenhuma transferência ou pagamento executado. **Usuário confirmou que os avisos chegaram separados como deveriam: tarefa só a Codex-Nando 2 e conta a pagar só a Codex-Nando.** |
| Novos smokes de tarefa e cliente | Criada em Codex-Nando 2 a tarefa pessoal `SMOKE_EMAIL_TAREFA_2026-10-06`, pendente, responsável a própria conta, vencimento 06/10/2026. Criado em Codex-Nando o cliente `SMOKE_EMAIL_CLIENTE_2026-10-06`, compartilhado individualmente com Codex-Nando 2 como Ver; a segunda conta abriu a ficha com o rótulo Compartilhado por Codex-Nando e sem edição. Usuário inicialmente relatou recebimento do compartilhamento também pela primeira conta, mas esclareceu que o e-mail desta era **“lançamento financeiro criado”**. Com a correção, recebimento do compartilhamento pela segunda conta fica confirmado, sem evidência de duplicação na primeira. O fluxo não prevê aviso na Central, segundo a fonte PR #41. |
| Console | Em 05/10 e novamente em 06/10 após os smokes de e-mail, a leitura dos níveis error/warn nas duas sessões retornou zero ocorrências durante o intervalo observado. Isso não comprova logs de backend nem ausência de erros fora do intervalo. |
| Dados essenciais | A UI confirmou membros e vínculos. Não houve consulta aos documentos PostgreSQL essenciais, contagem de stores, verificação de backups, TLS do banco ou comparação dos dados antes/depois. |
| E-mail real / Google | Em 06/10, o usuário confirmou recebimento e conclusão dos links de confirmação das duas contas; ambas passaram a mostrar Confirmado na UI. A menção teve recebimento e isolamento confirmados. Gmail e Google Agenda não foram validados. |

## Achados que precisam de correção ou decisão de produto

1. **Entrada pelo convite pode falhar sem mostrar o motivo.** A UI observada permaneceu na preparação. No código PR #41, `CallSession.tsx` mantém o prejoin quando `acceptIncoming()` retorna falso e a preparação não mostra o estado de falha. O ingresso pela prévia funcionou; a causa da primeira falha não foi comprovada.
2. **Atribuição de tarefa não garante acesso.** O seletor oferece membros da equipe, mas a atribuição não compartilha o projeto privado. O usuário pode tornar alguém responsável por uma tarefa que essa pessoa não consegue abrir. Preservar a privacidade do projeto e validar responsáveis contra quem já tem acesso é uma opção a revisar.
3. **Projetos padrão usam o mesmo identificador.** Na PR #41, cada usuário recebe projeto `default`; o resolvedor pode escolher o primeiro projeto acessível com esse ID. A UI mostrou dois cartões com o mesmo nome após o compartilhamento. Não foi observado vazamento ou alteração no projeto errado. Para próximos smokes, usar um projeto sintético novo com identificador próprio.
4. **Reunião agendada pelo chat não tem cancelamento visível.** O cartão oferece adicionar à agenda e abrir chamada. A fonte PR #41 não possui rota de cancelamento/exclusão de `scheduledMeetings`. O teste ficou como dado residual. A Agenda vazia era esperada, pois nenhum convidado clicou em “Adicionar à minha agenda”.
5. **Readiness não cumpre o procedimento.** Corrigir e publicar o contrato antes de comunicar aceite completo.
6. **Tarefas fica sem conteúdo em largura de 766 px.** O painel `.app-panel-tasks` ficou com 47 px, enquanto `.tasks-workspace` e seu conteúdo tiveram altura zero; a barra permaneceu, mas o quadro ficou invisível e Nova tarefa não respondeu ao clique. Em 1440 × 900, o quadro carregou e permitiu criar a nova tarefa. A fonte PR #41 combina layout geral com altura automática até 900 px e painel de Tarefas com `height:100%`, `min-height:0` e filho flexível com base zero; hipótese compatível com o colapso observado.
7. **Financeiro aceita valor zero no botão, mas não explica a recusa.** Com título preenchido e valor 0, Salvar ficou habilitado e não criou registro nem mostrou erro. A fonte PR #41 retorna silenciosamente quando o número é zero ou inválido, enquanto o botão verifica a string não vazia. O teste prosseguiu com valor fictício 1.
8. **Alta prioridade — atividade de tarefa privada exposta no chat da equipe.** A primeira conta recebeu a mensagem “Nora excluiu uma tarefa”, com título `SMOKE_EMAIL_TAREFA_2026-10-06` e projeto Operacao Norium, após a segunda conta excluir sua tarefa pessoal. O projeto da segunda conta não foi compartilhado. A notificação permaneceu na Central após navegação/recarregamento. **O histórico “Time todo” foi aberto na primeira conta e confirmou um cartão TAREFA EXCLUÍDA com título, projeto, status pendente, categoria, prioridade, vencimento 06/10/2026, responsável Codex-Nando 2 e contagens de anexos/comentários.** Na fonte PR #41, `tasks/router.py:430-464` chama `append_team_message_for_user` com título/projeto/estado; `team/router.py:677-711` grava em `threadId=team`, `scope=team` e transmite para os membros. O histórico aceita esse escopo para qualquer membro (`team/router.py:446-448`, `1200-1206`), sem aplicar o acesso ao projeto exigido por `task_store.py:700-701`. Atualizações de tarefa usam o mesmo caminho (`tasks/router.py:367-427`). **Não aceitar o deploy.** Corrigir o roteamento para alcançar somente quem tem acesso efetivo ao projeto; retestar evento ao vivo, histórico e Central com usuário sem acesso. O rótulo visual “E-mail” da Central não comprova envio: a fonte descarta `team_message_created` na entrega de correio. A mensagem sintética já persistida no chat permanece como evidência; nenhuma limpeza de histórico em produção foi feita.

## Limpeza e dados residuais

- Chamada de teste encerrada e término confirmado para a segunda conta.
- Cliente sintético excluído com autorização; total final zero.
- Tarefa sintética excluída com autorização; quadro final zero.
- Compartilhamento temporário do projeto revogado; segunda conta com zero projetos da equipe.
- Preferência de e-mail original restaurada.
- Permanecem mensagens sintéticas, recibos e notificações de teste.
- Permanece a reunião **“SMOKE Norium Reunião 2026-10-06”**, marcada para **06/10 às 00:15**, apenas com as duas contas de teste. Não há remoção segura pela UI observada. Nenhuma manipulação direta do banco foi feita.
- O usuário autorizou explicitamente a exclusão definitiva dos quatro registros novos (tarefa, lançamento, cliente e documento). Todos foram removidos pela UI e o resultado foi conferido: cliente Total 0, documento Total 0, tarefa ausente/quadro vazio, Financeiro Lançamentos 0/Pendente R$ 0,00.
- Compartilhamentos temporários de documento e cliente revogados antes da exclusão; ausência na segunda conta confirmada. A mudança de acesso do documento avançou a versão para 3 enquanto compartilhado.
- Permanecem notificações/mensagens sintéticas de criação e exclusão, inclusive a evidência da exposição da tarefa pessoal ao chat da equipe.
- As duas abas foram marcadas para continuação; os tamanhos temporários de viewport foram restaurados, com ambas em 766 × 930. Novo acesso deve continuar por login direto do usuário, sem credenciais nas ferramentas.

## Evidência visual local

Arquivos locais, fora de um commit preparado:

- `.tmp-tests/shardcloud-smoke-2026-10-06/lembrete-conta-1.jpg`.
- `.tmp-tests/shardcloud-smoke-2026-10-06/lembrete-conta-2.jpg`.
- `.tmp-tests/shardcloud-smoke-2026-10-06/documentos-desktop.jpg`.
- `.tmp-tests/shardcloud-smoke-2026-10-06/documentos-estreito-completo.jpg`.
- `.tmp-tests/shardcloud-smoke-2026-10-06/tarefas-766px.jpg`.
- `.tmp-tests/shardcloud-smoke-2026-10-06/tarefas-desktop.jpg`.
- `.tmp-tests/shardcloud-smoke-2026-10-06/cliente-email-compartilhado.jpg`.
- `.tmp-tests/shardcloud-smoke-2026-10-06/documento-compartilhado-leitura.jpg`.
- `.tmp-tests/shardcloud-smoke-2026-10-06/financeiro-limpo.jpg`.
- `.tmp-tests/shardcloud-smoke-2026-10-06/tarefas-limpo.jpg`.
- `.tmp-tests/shardcloud-smoke-2026-10-06/documentos-limpo.jpg`.
- `.tmp-tests/shardcloud-smoke-2026-10-06/atividade-tarefa-pessoal-conta-1.jpg`.
- `.tmp-tests/shardcloud-smoke-2026-10-06/tarefa-pessoal-exposta-chat.jpg`.

## Próxima retomada

1. E-mails de tarefa, conta a pagar, compartilhamento de cliente e menção já conferidos pelo usuário, com os limites descritos acima.
2. Limpeza dos quatro registros concluída com autorização humana. A reunião residual não tem rota de cancelamento observada.
3. Priorizar a correção de confidencialidade das atividades de tarefas privadas; depois readiness, ingresso pelo convite, layout de Tarefas e validação do Financeiro. Mensagens antigas com dados sensíveis exigem revisão humana para remediação; não apagar histórico de produção automaticamente.
4. Preparar correções em branch controlada, com revisão humana apropriada, e usar um projeto sintético novo com identificador próprio nos próximos testes de tarefas. Não confundir o sucesso dos eventos de e-mail com aceite do isolamento em chat/notificações.
5. Completar provas de APIs/protocolo, mídia/som/foto, dados PostgreSQL e logs sanitizados de backend antes de aceite. A governança proíbe enviar logs de produção brutos para IA.

Nenhum teste desta rodada autoriza considerar a imagem PR #41 publicada ou concluir o deploy.


## Correções locais preparadas em 06/10/2026

Veja [handoff das correções](2026-10-06-shardcloud-smoke-fixes.md). A evidência acima continua válida para a publicação testada; os testes locais não comprovam o SHA publicado nem autorizam aceite ou remediação em produção.
