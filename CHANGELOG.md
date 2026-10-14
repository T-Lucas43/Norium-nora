# Changelog

## Candidato de homologação — 14/10/2026

- Consolida fases 6–7, novo Chat com Nora sob demanda e anexos na prévia de e-mail.
- Integra o novo layout das chamadas e otimização de vídeo mantendo controles de
  áudio e a escolha de assistir à transmissão.
- Nora dentro das chamadas permanece parcial e desligada por padrão. Estado,
  pendências, revisão técnica e evidências no handoff de consolidação de 14/10.

Formato: uma linha por mudança relevante. Versionamento `MAJOR.MINOR.PATCH`.

## [Não publicado] — novo Chat da equipe, 13/10/2026

- feat(chat): estrutura de conversas, gaveta de 440 px, contexto único de 340 px, temas nx, compositor formatado, citação, edição e exclusão confirmada; mensagens próprias à direita e avatares preservados.
- feat(chat): fios com replyThreadId aditivo, participantes notificados, fixadas, busca e contexto por permissão; cartões resolvidos para cada leitor e eventos restritos aos leitores do recurso.
- feat(chat): tarefa com origem, enquete/voto ao vivo, encaminhamento interno, modelos com canal equipe e atalhos; foco/status, notificações por conversa e presença limitada com pausa, expiração e contexto autorizado.
- perf(chat): páginas de 50 mensagens, janela limitada para históricos longos, catálogo de arquivos paginado e miniaturas autenticadas; fila interna opt-in com identidade fixa e estado gravado junto à mensagem.
- fix(privacidade): exportação e exclusão do membro incluem preferências, envios agendados, lembretes e votos; preservam dados dos demais membros.
- fix(admin): edição exclusiva do limite de chamadas preserva o valor administrativo existente; a franquia operacional continua em tokens.
- feat(chat): Nora contextual sob demanda, até 12 mensagens minimizadas por acesso, fontes, respostas privadas quando necessário e comandos com revisão; resumo de mensagens não lidas e controle da Nora por subequipe.
- feat(chat): transcrição de áudio selecionado com política Groq, DLP e medição por tentativa; preparação de e-mail/WhatsApp para cliente acessível com aprovação exata, sem envio automático.
- fix(chat): contadores públicos dos fios não incluem respostas privadas; histórico paginado preservado ao publicar respostas e reuniões; imagens externas do texto não carregam automaticamente.
- fix(storage): normalização do prefixo estendido Windows após resolução do caminho, mantendo a rejeição de arquivos fora da raiz e a quota concorrente.
- docs(chat): autorizações contextuais e de áudio recebidas em 13/10/2026; ensaio sintético e gates locais registrados no handoff. Publicação e deploy conjunto seguem pendentes.

## [Não publicado] — painel administrativo, 12/10/2026

- feat(admin): casca de 232/56 px, temas claro/escuro, menu móvel, contas em tabela/gaveta, custos/tarifas e limites/reset em overlays acessíveis.
- feat(admin): financeiro com dez abas sublinhadas, cartões/tabelas, modais de registro/importação com foco e Escape e todos os campos/ações/exportações preservados.
- feat(admin): e-mails em Envios/Modelos/Remetente, acompanhamento em tabela e compositor com Nora em modal; nenhum envio automático.
- docs(admin): sugestões Nova no BACKLOG, diferenças de dados documentadas e evidências de contratos, 875 testes, build e conferência PC/375 px nos dois temas.

## [Não publicado] — recuperação de carregamento, 12/10/2026

- fix(carregamento): service worker devolve Response também sem rede/cache, preserva uma geração pública anterior e não apaga caches pessoais ou intercepta API/recursos privados.
- fix(interface): página de entrada e falhas React/import exibem mensagem com logo oficial e tentativa explícita de carregar novamente, em vez de tela vazia; sem mudar autenticação ou reexecutar ações.
- docs(operacao): recuperação do proxy HTTPS existente após colisão de reserva IP interna com a API; mesmo contêiner, portas, segurança, certificados e volumes preservados, PostgreSQL/HTTPS conferidos.

## [Não publicado] — fases 6 e 7, revisão local de 12/10/2026

- fix(seguranca): verbos/alvos financeiros, digest por dono/workspace, WhatsApp preparado por operação exata, DLP central e provedores autorizados por tenant.
- feat(nora): ferramentas de negócio no executor durável, aprovações por operação, memória unificada e reconciliação de envios com ledger anterior ao provedor; tentativas inconclusivas permanecem unknown.
- feat(consumo): franquias de plano/pessoa/equipe, alertas 80/95, medição central, cache por workspace e resumo minimizado; interface de consumo integrada.
- feat(conhecimento): embeddings mascarados em PostgreSQL, citações/fallback lexical e Brave atribuído à pessoa; testes simulados enquanto as chaves não forem autorizadas.
- feat(gmail): sincronização incremental por historyId e IDs apenas, limites de leitura/checkpoint/backoff; worker opt-in, sem ativação em homologação.
- feat(privacidade): catálogo de exportação/exclusão, quotas, retenção opt-in, revogação Google, invalidação de caches e ledger de exclusões independente dos backups.
- fix(auditoria): logs minimizados e trilha produzida pelo servidor; cliente não pode forjar registros.
- docs(operacao): minutas LGPD/subprocessadores e procedimento Shard de backup/restauração/rollback, com reaplicação de exclusões em ensaio isolado.
- test(nora): Groq real 27/30 (90%) com argumentos validados; piloto HTTP autenticado + PostgreSQL + worker real sem efeitos externos. Regressão backend final 1.465 testes sem falhas.
- feat(interface): telas de acesso, consumo e privacidade; fases estruturais locais dependem da revisão humana exigida por docs/AI_GOVERNANCE.md antes de promoção/ativação.

## [Não publicado] — branch `feat/fase1-seguranca-voz`

- fix(agendamentos): rolagem pública no PC, prévia com a página real sem cobrir páginas cadastradas e logo própria com atualização do cache.
- feat(agendamentos): textos, cores, fontes, layout, cabeçalho/rodapé e rótulos editáveis; filtros de vencidos e marcação de serviço/reunião realizados ou ausência com histórico.
- fix(perfil): fotos e nomes em projetos, tarefas e Estúdio; redução suave da foto e fallback seguro por pessoa.

- fix(agendamentos): rota pública `/agendar/:slug` abre antes da sessão do painel e preserva links compartilhados, mesmo para quem já está conectado.
- feat(agendamentos): nova página pública com calendário mensal, horários, resumo da reserva, logo oficial, temas claro/escuro, campos acessíveis e layout para celular.
- feat(agendamentos): textos de boas-vindas e do serviço editáveis com prévia ao vivo; tempo fixo segue o cadastro do serviço, sem oferecer durações não cadastradas.
- fix(gmail): paginação progressiva com intervalo e recuo em limite do Google; lotes pequenos e teto de leituras por conta impedem repetição em massa; leitor exibe nova tentativa sem confundir resumo com corpo completo.

- ci(shard): transfere o arquivo original da imagem auditada em partes limitadas, com hashes e todos os gates conferidos; sem reconstrução ou acesso à VPS pelo workflow.
- ci(shard): opção separada para exportar a mesma imagem auditada ao painel Shard, sem iniciar deploy SSH; orientação atual do responsável é publicação manual pela Shard.
- fix(imagem): exclui o binário opcional Pebble herdado da base, sem uso pelo comando Uvicorn, após três HIGH de Go 1.26.7 no CI; mantém FFmpeg, Chrome, metadados e gates sem supressões.
- ci(shard): transporte de homologação pelo GitHub Actions, com dispatch explícito em main, todos os gates, mesma imagem auditada, verificação SSH estrita e recibo sanitizado; provisionamento do executor VPS e revisão técnica permanecem pendentes.
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
