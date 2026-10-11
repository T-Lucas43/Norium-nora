# Changelog

Formato: uma linha por mudança relevante. Versionamento `MAJOR.MINOR.PATCH`.

## [Não publicado] — branch `feat/fase1-seguranca-voz`

- feat(nora): voz da Nora em tempo real pela ElevenLabs (voz Alice `Xb7hH8MSUJpSbSDYk0k2`, modelo `eleven_flash_v2_5`), com volta automática para a voz Edge se a ElevenLabs falhar.
- feat(nora): `/api/nora/voz` com limite próprio (120/min) para a fala por frases não ser cortada; voz definida só pelo servidor.
- fix(nora): transcrição de áudio passa a enviar a autenticação da sessão.
- fix(financeiro): excluir ou alterar lançamentos e gastos programados pela Nora exige aprovação vinculada ao item exato; títulos parecidos viram opções.
- fix(controle): aprovar no painel Controle envia a confirmação do conteúdo exato.
- fix(nora): envio do rascunho de WhatsApp exige permissão de chat e WhatsApp, conexão ativa e confirmação explícita.
- fix(nora): mensagens “system” vindas do navegador não substituem as regras da Nora.
- fix(lgpd): CPF, cartão e segredos mascarados em toda chamada de IA, sem confundir celular com CPF.
- fix(nora): memória da equipe gravada só por quem gerencia a equipe; memórias entram como dados, não como instruções.
- fix(seguranca): requisições sem usuário identificado falham em vez de usar a conta fixa `lucas123`.
- feat(layout): base visual com tokens, fonte Inter local, azul unificado, ícones mais leves e menu agrupado sem remover telas.
- perf: atualizações automáticas menos frequentes e pausadas com a aba oculta (WhatsApp, Agenda, E-mails, integrações, versão).
- perf: cache de documentos do PostgreSQL com fila por usuário (entra um, sai o usado há mais tempo), limite de memória e validade de 5 min.
