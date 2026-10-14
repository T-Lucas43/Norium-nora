# Homologação: e-mails e agendamento público

## Pedido e escopo

Corrigir a abertura de e-mails e o link público informado pelo usuário; reestilizar a página pública de agendamento e publicar em homologação. GitHub continua como fonte e CI. Publicação pela Shard foi autorizada nesta conversa. O trabalho pendente das fases 6/7 fica preservado na branch `codex/fase6-fase7-20261011`.

## Evidência e causa

- Diagnóstico sanitizado na VPS: quatro falhas de abertura com `HttpError 403`, razão `rateLimitExceeded`; nenhum corpo, endereço, token ou ID de mensagem extraído.
- A restauração da sessão montava os efeitos do painel na URL pública e `navigateNoriumTab` substituía `/agendar/...` por `/app/...`.
- A sincronização paginava sem intervalo e aquecia outras sete pastas. Cada leitura em lote conta individualmente para a quota. A documentação atual do Google lista 20 unidades por `messages.get` e 6.000 por conta/minuto: https://developers.google.com/workspace/gmail/api/reference/quota.

## Implementação

- Dispatcher público não monta os hooks da sessão, perfil, WebSocket ou navegação do painel. Permissões das APIs permanecem as existentes.
- Calendário mensal, escolha de duração/profissional/serviço, horários, resumo e confirmação. Preserva campos personalizados, validação de CPF/celular, abort de consulta obsoleta e idempotência de reserva. Logo oficial e identidade Norium; cores personalizadas mantidas no tema claro; tema escuro ajusta superfícies e contraste.
- Gmail: lotes de até 20, orçamento em memória por conta de 4.000 unidades/minuto, pausa após quota e HTTP 429 sanitizado com Retry-After. Sem reenvio ou mudança de scopes. Limite local por processo; múltiplas réplicas e outros clientes Google podem consumir a quota compartilhada.
- Frontend busca todas as páginas progressivamente a cada 15s; recua 30/60s em 429, mantém progresso e interrompe ao sair. Demais pastas carregam quando abertas. Leitura descarta respostas obsoletas e mostra erro/repete sem renderizar snippet como corpo completo.
- `scripts/preview_public_scheduling.py`: fixture sintética local; sem Gmail, calendário, envio ou gravação de reservas.
- Textos editáveis em Agendamentos > Páginas: título/descrição existentes, chamada inicial, boas-vindas, orientação, identificação e mensagem complementar; campos vazios ocultam o trecho. Prévia ao vivo antes de gravar. Persistência no JSON validado da identidade existente, sem migração de tabela.
- Padrões usam serviço/agendamento. A duração única do serviço aparece como fixa; a escolha só existe quando o próprio cadastro tem múltiplas durações. Backend rejeita duração fora do cadastro. Nenhuma página real foi reconfigurada pelo agente.

## Verificação

- Backend final com personalização: 61 testes focados, sem falhas/erros; cópia descartável, dados fictícios, dotenv desabilitado, rede externa bloqueada pelo runner. Recibo `output/pos-correcao/hotfix-textos-servicos.json`.
- Frontend: suíte completa com 848 testes em 138 arquivos passou, incluindo resposta obsoleta, fechar leitor, limite Google, dispatcher público e reservas idempotentes.
- Build TypeScript/Vite e orçamento de bundle passaram.
- Conferência visual local: desktop 1280px e celular 390px; tema escuro/claro e confirmação com dados fictícios. Imagens em `output/homologacao-20261011/agendamento-*.png` no checkout principal. Deploy ainda não efetuado neste hotfix.
- Personalização e duração: 23 testes frontend focados passaram após ajustar duas asserções dos testes. Build TypeScript/Vite passou.
- Docker Desktop foi reiniciado e agora responde com versão 29.8.1. PostgreSQL local sintético dedicado pronto para as fases 6/7; seu ensaio separado não comprova abertura real de e-mail.
- Primeiro candidato do PR #55 (`733fd05`) passou nos cinco gates GitHub, run 38179726708. Personalização solicitada depois exige novo candidato e novos gates antes do deploy.

## Publicação e aceite

Publicação em PR #55: https://github.com/T-Lucas43/Norium-nora/pull/55. A tentativa anterior de mover main foi recusada pela revisão automática porque os gates e a revisão humana ainda estavam pendentes; nenhuma alternativa foi usada para contornar essa recusa. O usuário depois conferiu a prévia e pediu personalização, respeito ao tempo do serviço, deploy após finalizar as correções e trabalho em paralelo nas fases 6/7.

Pendente: revisão do diff final, novos gates GitHub do candidato completo, imagem imutável, backup/restauração, promoção na Shard, release/ready/rota/assets e conferência do usuário no Gmail. Não declarar abertura real de e-mail corrigida apenas com health check. Não promover produção.

### Concluído na Shard

- PR #55 integrado normalmente após os cinco gates do candidato `41fa4e6` (run 38182147207). Main e revisão publicada: `022ddfc3c1fd515ac1a9d445bf12a93991c8aa64`; árvore conferida `b15f1402a3efc5787afcae1e9cf4299f11fdd2d9`.
- Os cinco gates da main passaram no run 38182905652; 1.408 testes backend, 851 frontend em 138 arquivos e 48 de operação. Transporte run 38196037167, imagem artifact 11718414202.
- Mesmo ZIP de imagem, SHA-256 `eb4cc55cd3c7f33890edb745626d378a500117d41af4b1c5d80bec37ff3fbc2f`; 34 blobs, configuração completa e rootfs conferidos, sem reconstrução. ID CI `sha256:c1d953ae1a15f2746060487e9840904b3a4a08b92f4f53975b623468defc7a94`; Docker da VPS carregou `sha256:33f60c367c16510df48531cdb908e1ac83c77cf75fc5d8679cd8ddbdbe7b5ab1`. Diferença de serialização do config, não de camadas ou configuração semântica.
- Backup fresco e restauração isolada conferiram 38 tabelas e um arquivo de volume. Configuração, secrets, sessões, segurança, rede e volume preservados. Contêiner anterior `norium-api-prev-f6b455f-20261011` parado e preservado. Novo contêiner healthy, zero reinícios, HTTPS/ready PostgreSQL passaram.
- Uma primeira verificação do transporte recusou o Docker archive por não ter RepoTags. Operador corrigido para ler o ID emitido pelo Docker; aproveitou somente downloads com hash válido. Nenhuma alteração no contêiner ativo ocorreu nessa falha.
- Navegador conferiu `https://homologacao.norium-ai.com/agendar/ahhaaha`: URL permaneceu pública, duração fixa de 30 min, seleção do profissional e horários carregaram. Sem criar reserva. Usuário confirmou abertura completa de e-mail após Ctrl+F5. Login/painel/chat não foram rechecados neste hotfix.
- Recibo sanitizado `output/homologacao-20261011/shard-hotfix-deploy-receipt.json`, screenshot real `agendamento-homologacao-publicado.png`, no checkout principal.
- Cérebro/retenção e mudanças das fases 6/7 não fazem parte desta imagem. Não houve promoção à produção.

Publicação em PR #55: https://github.com/T-Lucas43/Norium-nora/pull/55. A tentativa anterior de mover main foi recusada pela revisão automática porque os gates e a revisão humana ainda estavam pendentes; nenhuma alternativa foi usada para contornar essa recusa. O usuário depois conferiu a prévia e pediu personalização, respeito ao tempo do serviço, deploy após finalizar as correções e trabalho em paralelo nas fases 6/7.

O deploy deste hotfix e seu aceite de e-mail foram concluídos. Fases 6/7 seguem em implementação local no handoff próprio, com execução individual por determinação posterior do usuário.
