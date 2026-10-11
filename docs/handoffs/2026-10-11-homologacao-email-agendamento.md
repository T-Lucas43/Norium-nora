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

## Verificação

- Backend: 58 testes focados, sem falhas/erros; cópia descartável, dados fictícios, dotenv desabilitado, rede externa bloqueada pelo runner. Recibo `output/pos-correcao/hotfix-gmail-scheduling-confirm.json`.
- Frontend: suíte completa com 848 testes em 138 arquivos passou, incluindo resposta obsoleta, fechar leitor, limite Google, dispatcher público e reservas idempotentes.
- Build TypeScript/Vite e orçamento de bundle passaram.
- Conferência visual local: desktop 1280px e celular 390px; tema escuro/claro e confirmação com dados fictícios. Imagens em `output/homologacao-20261011/agendamento-*.png` no checkout principal. Deploy ainda não efetuado neste hotfix.
- Docker Desktop local: motor WSL não inicializa (`0xc00000fd`). Os testes deste hotfix não dependem dele. Gate PostgreSQL será executado pelo CI.

## Publicação e aceite

Pendente: revisão do diff final, gates GitHub do candidato, imagem imutável, backup/restauração, promoção na Shard, release/ready/rota/assets e conferência do usuário no Gmail. Não declarar abertura real de e-mail corrigida apenas com health check. Não promover produção.
