# Changelog

Formato: uma linha por mudança relevante. Versionamento `MAJOR.MINOR.PATCH`.

## [Não publicado] — branch `feat/fase1-seguranca-voz`

- fix(financeiro): aprovações exatas conferem dono, empresa, conteúdo e permissão vigente antes de excluir ou alterar dados; rejeitam ausência de digest e prévia de outra conta.
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
- perf: log no banco só de alterações, erros e requisições lentas; mídias respeitam a validade definida pela rota e reaproveitam o cache do navegador.
- perf: trabalhador de automações dorme sem consultar o banco e acorda ao chegar um evento; consultas de tarefas em andamento pausam com a aba oculta.
- perf: imagens da Nora e dos provedores de IA em WebP (1,9 MB → 38 KB).
- feat(layout): menu e topo no padrão do layout aprovado; Inteligência em um item com abas internas e Perfil como aba de Configurações, sem remover telas.
- feat(layout): conteúdo de todas as telas no padrão do layout aprovado (claro e escuro), sem remover funções; Chat da equipe com minhas mensagens à direita; E-mails com leitura só ao abrir uma mensagem; Painel com colunas de altura fixa.
- feat(layout): Configurações com menu de seções e uma seção por vez; Perfil dentro de Configurações; avatares mostram iniciais quando a foto falha; busca do topo fora do preenchimento automático.
- perf: Chat da equipe sem chamada ativa reconcilia a cada 25 s (antes 5 s por aba); frontend local pré-processa as telas ao iniciar.
- feat(layout): telas de acesso (login, cadastro, recuperar senha, confirmar e-mail, escolha de modo e plano) no padrão do layout aprovado, com a logo oficial e sem mudar a autenticação.
