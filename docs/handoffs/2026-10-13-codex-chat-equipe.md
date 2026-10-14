# Novo Chat da equipe — execução individual

## Autorização e base

O usuário pediu em 13/10/2026 implementar o prompt e as referências claras e
escuras do novo Chat da equipe antes da publicação conjunta. Codex individual,
sem agentes/Muse. Publicação/deploy aguardam a consolidação com fases 6/7,
anexos de e-mail e o trabalho do outro chat sobre chamadas.

Branch `codex/novo-chat-equipe`, worktree gerenciada `novo-chat-equipe`, base
local `32ed8d9` da consolidação das fases. O checkout principal da nova chamada
e a worktree das fases/e-mail permanecem preservados. `git fetch origin`
retornou Repository not found; nenhuma referência remota nova foi presumida.
Os HTML/JS de referência existem em Downloads/norium-mockup-chat-equipe-fonte.

## Critérios e sequência

1. Inventário das funções/controles e linha de base frontend/backend do chat,
   excluindo testes de chamada. Preservar WebSocket, ACL, anexos, leitura,
   reuniões, gaveta e minhas mensagens à direita.
2. A: três colunas, conversas organizadas, contexto, compositor e mensagens,
   claro/escuro/375px. Nenhum botão de recurso não implementado.
3. B: respostas em fio com campo aditivo distinto do threadId histórico da
   conversa, ACL/notificação de participantes, fixadas e cartões de recursos
   resolvidos pelo servidor com as permissões de cada leitor.
4. C: tarefa vinculada à mensagem, lembrete, envio interno agendado durável,
   enquete, comandos e busca servidor, notificações e foco.
5. D: presença contextual com expiração, pausa, contexto autorizado e eventos.
6. E: Nora com contexto minimizado, medição e cérebro, fontes/permissões,
   resumo sob demanda, áudio e preparação de envio externo exato. Ata de chamada
   só será integrada se o contrato do outro chat estiver disponível.
7. Gates por fase: testes completos adequados, TypeScript/lint/build, navegador
   com três contas sintéticas, temas e celular; documentar limites reais.

## Limites

Não copiar dados fictícios do mockup para a aplicação. Nenhuma chamada externa
real, envio, exclusão física, worker na Shard, push ou deploy nesta execução.
Não editar transporte/overlay da chamada, que pertencem ao outro chat.
Não inventar prova de 5.000 mensagens, latência ou estabilidade de 30 minutos.
Registrar no fechamento o que foi medido e o que permaneceu pendente.

## Estado

PDFs têm 17 páginas cada; versões renderizadas/texto extraído estão em
output/chat-equipe-20261013/references no checkout principal. O bloqueio anterior
da revisão automática por limite de uso foi resolvido ao retomar. Os arquivos
cuja aplicação tinha falhado foram criados nesta execução.

### Evidência local até 13/10/2026

- Linha de base: 110 testes frontend do diretório team-chat, incluindo chamadas;
  backend selecionado: 31 testes, sem falhas. Nenhum teste existente alterado.
- Inventário/regressão da tela antiga: 5/5 testes aprovados após a nova estrutura.
- Backend A/B: 43/43 aprovados; recibo output/pos-correcao/chat-equipe-ab-20261013.json.
- Backend C/D: 55/55 aprovados, sem falhas/erros/skip, com dados sintéticos e
  sockets externos negados; recibo output/pos-correcao/chat-equipe-cd-20261013.json.
- TypeScript passou após a integração de produtividade, antes das alterações
  mais recentes de status, modelos compartilhados e perfil do membro.
- Estes são gates locais parciais; não substituem suíte completa, navegador,
  PostgreSQL real, ensaio de desempenho ou a revisão humana antes de promoção.

### Implementação presente, ainda em conclusão

- A: navegação de 280 px, contexto 340 px, gaveta 440 px, temas nx, compositor
  formatado, ações, citação, edição e tombstone com confirmação; paginação 50.
- B: replyThreadId aditivo distinto do threadId da conversa, herança da
  visibilidade restrita, notificações de participantes, fixadas, cartões
  projetados por leitor, tarefas e busca servidor/contexto.
- C: tarefa com origem, enquete/voto, encaminhamento interno, modelos com
  atalhos/canal equipe, agendamento/lembrete e preferências de notificação.
- D: contexto temporário com expiração e múltiplas abas, projeção por leitor,
  status/foco/pausa e linha do tempo limitada. Interface em integração.
- E: ainda pendente; Nora antiga preservada, integração nova não foi declarada
  pronta. Ata depende do contrato da chamada do outro chat.

### Limites da fila e validações restantes

NORIUM_TEAM_CHAT_QUEUE_ENABLED é opt-in, padrão 0. Nenhum worker foi ativado na
Shard. Mensagem e estado enviado são gravados no mesmo documento autoritativo,
com identidade determinística. Os testes atuais simulam reconstrução do estado
e não comprovam concorrência PostgreSQL entre processos. O desenho segue a
topologia existente de um único escritor; promoção exige validar essa topologia.

Restam: fechar interface D e Nora E, vincular presença às telas, privacidade dos
novos campos, navegação por link e listas longas, suíte completa/scans/build,
navegador com três contas sintéticas nos dois temas/375 px e desempenho medido.
Sem commit, push, merge, PR ou deploy do novo Chat da equipe até este registro.

## Retomada — validações de 13/10/2026

### Gates e correções reais

- Frontend completo: primeira execução 905 aprovados/2 falhas. Corrigidos o
  nome acessível do botão da enquete e a preservação do valor administrativo
  quando se edita somente chamadas. Nenhum teste antigo foi alterado.
- Repetição completa: **907/907 aprovados**,
  `output/chat-equipe-20261013/frontend-full-final.json` no checkout principal.
- Backend completo: primeira execução 1.546 testes/4 falhas. Os novos eventos
  de cartões eram difundidos fora do projeto. Corrigidos para fanout por leitor,
  sem broadcast e sem revelar sequer o identificador a quem não tem acesso.
- Repetição completa: **1.550/1.550 aprovados**, sem erros ou skip,
  `output/pos-correcao/chat-equipe-full-final-20261013.json` nesta worktree.
- Contratos posteriores: **106/106 backend** e **18/18 frontend** aprovados;
  schema de uploads agendados passou a validar formatos antes de executar.
  Indicadores dos fios e vínculo `/app/chat-equipe` receberam ajuste posterior,
  com validação focada adicional necessária antes de declarar candidato final.
- TypeScript aprovado; lint do chat sem erros e um aviso preexistente no teste
  MediaTransport. Build e orçamento passaram sem mudar limiares.
- Bandit `-ll`: zero achados/erros. Gitleaks não foi localizado; o scan completo
  de segredos e os gates do CI continuam obrigatórios antes de publicação.

### Navegador local com três contas fictícias

Harness em `output/chat-equipe-20261013/qa_backend.py` no checkout principal,
diretório/cadastros fictícios em memória, dados forçados para synthetic-data,
dotenv desativado e nenhuma chave de provedor. A aplicação usa endpoints reais,
persistência JSON isolada e o WebSocket real; o ensaio não certifica a autenticação
de produção, substituída por identidades de teste.

Conferidos: canal, direta A/B ausente para C, envio/leitura, fio e painel único,
enquete com voto atualizado em outra conta, busca, tarefa e cartão restrito para
não participante do projeto, mudança de status, gaveta e expansão na mesma
conversa. Corrigidos recorte do compositor e contraste encontrados no navegador.

Claro/escuro em desktop e viewport interno **375 × 812**, com scrollWidth=375.
O controle de viewport do navegador integrado manteve 1280 px; o ensaio móvel
foi feito em iframe de 375 px, usando DOM/screenshot do documento interno.

Envio agendado criado pelo formulário; duas execuções da fila fictícia retornaram
processed=1 e processed=0, com uma entrega. Nenhuma mensagem real foi enviada.

Histórico de 5.000 mensagens fictícias: cinco leituras de 50 mensagens entre
54,3 e 83,5 ms no backend JSON local; abertura aquecida no navegador em 783 ms.
Paginação carregou páginas anteriores; a janela caiu para 14 elementos após
ultrapassar 120 mensagens carregadas. Isso não comprova latência PostgreSQL/Shard,
concorrência entre processos nem estabilidade de memória de 30 minutos.

### Bloqueio da Nora contextual (E)

**Resolvido em 13/10/2026:** o responsável respondeu “Sim, autorizo esse uso
contextual” à pergunta sobre 12 mensagens minimizadas/acessíveis, Groq/OpenAI
configurado/aprovado e nenhum anexo bruto. Também respondeu “Sim, autorizo a
transcrição sob demanda” para áudio selecionado ao Groq após clique do leitor.
O relato abaixo preserva o estado anterior à autorização.

A revisão automática rejeitou a criação de `brain/conversation.py` e
`team/chat_nora.py` por entender que o envio de conversas internas, inclusive
restritas, ao gateway externo não tinha autorização explícita do payload/destino.
Esses arquivos **não foram criados**. Foi enviada pergunta ao usuário, com:
pedido explícito, até 12 mensagens minimizadas acessíveis ao solicitante,
provedor já configurado/aprovado Groq ou OpenAI e nenhum anexo bruto.

Sem resposta, não repetir a ação rejeitada ou contornar o gate. A Nora geral
existente foi preservada. Faltam os recursos E: resumo contextual, fontes,
comandos `/nora`, transcrição e preparação de envio ao cliente com aprovação.
Ata depende também do contrato da chamada em desenvolvimento no outro chat.

Uma tentativa de gravar o diretório fictício do QA foi rejeitada por risco de
sobrescrita. Substituída pela alternativa segura de leitura do diretório em
memória; nenhuma gravação do cadastro de usuários foi executada.

### Entrega e promoção

As frentes A–D estão implementadas localmente e revisadas nos gates acima,
com validações operacionais remanescentes; o escopo total A–E não está concluído.
Continuam pendentes a Nora E, o ensaio PostgreSQL/30 min, o CI/scan de segredos,
revisão humana do código crítico e consolidação com a chamada/fases 6–7/anexos.
Publicação e deploy único pelo GitHub/Shard seguem aguardando essa consolidação.

## Fechamento local da retomada

- Commits: `f50a5a5` (contrato administrativo), `48b66b8` (backend),
  `963a6f1` (interface). Branch `codex/novo-chat-equipe`.
- Ajustes finais de origem/indicadores e exportação dos votos pessoais passaram
  **108/108 testes backend** em `chat-equipe-privacy-final-20261013.json`.
  TypeScript e **18/18 testes frontend** passaram após avatares dos fios,
  cabeçalho e controle de menção urgente.
- Suíte completa preservada: backend 1.550/1.550 e frontend 907/907. Os recibos
  completos antecedem os últimos ajustes pequenos, cobertos pelos testes focados
  acima; repetir o gate integral no candidato consolidado antes da promoção.
- Nenhum teste existente foi enfraquecido. Nenhum envio externo real foi feito.
- A revisão automática da Nora contextual permanece pendente de resposta humana;
  os arquivos rejeitados continuam ausentes. Não declarar a Fase E concluída.
- O ensaio móvel conferiu contraste nos dois temas e scrollWidth=375. A abertura
  aquecida de 783 ms usou JSON local e três identidades fictícias; não é prova da
  Shard. A gaveta preservou a conversa ao expandir e o foco refletiu nas demais
  contas do ensaio. A estabilidade de memória por 30 minutos não foi medida.
- Serviços e abas do QA devem ser encerrados no fechamento. Fontes/recibos ficam
  em output para retomada; não fazem parte da imagem de produção.
- Sem push, merge, PR, deploy, ativação de worker ou alteração de dados da Shard.

## Retomada autorizada — Fase E, 13/10/2026

### Implementação

- `nora/brain/conversation.py`: entrada de leitura com contratos/perfil do cérebro,
  minimização, gateway existente medido e rejeição de alegação de execução sem prova.
  Não ativa executor/worker nem disponibiliza ferramentas ao modelo.
- `team/chat_nora.py`: identidade/workspace e fontes revalidados antes/depois da IA;
  até 12 mensagens de 360 caracteres, sem URLs/bytes de anexos. Respostas na conversa
  ou fio; contexto restrito e consulta pelo menu respondem só ao solicitante.
- Fontes são IDs de mensagens autorizadas produzidos pelo servidor, com abertura
  no contexto. Busca de clientes/propostas/tarefas é local, com ACL por recurso,
  e não envia seus cadastros ao modelo.
- Resumo sob demanda com período 1–168 h e corte de leitura por snapshot. Nenhuma
  geração automática para todos. A configuração da subequipe permite desligar a Nora.
- `/nora resumir/tarefa/agendar/buscar`, menu “Pedir à Nora sobre isto”, formulários
  preenchidos para revisão. Horários consideram apenas reuniões acessíveis do Chat;
  a interface pede conferir a agenda dos convidados antes da confirmação.
- Envio ao cliente resolve cliente/contato acessível e cria a aprovação exata já
  existente de Gmail/WhatsApp. A preparação retorna `sent:false`. Nenhum envio real.
- Áudio: reaproveita `/api/nora/transcrever`, agora com política Groq, mascaramento,
  reserva/ledger por tentativa e saída medida via tokens verbose ou estimada/rotulada.
  Reserva 12 mil tokens; custos por duração não convertidos para USD por token.
  Texto visível só na sessão do solicitante; não é uma transcrição persistente.
- Imagens externas do Markdown contextual não carregam automaticamente. Fotos e
  anexos autenticados continuam usando seus componentes existentes.
- Histórico não é truncado em 2 mil linhas ao acrescentar resposta/reunião. Contador
  público de fio exclui respostas que os destinatários não podem ler.

### Evidência e reparos

- Testes focados iniciais: 57/57 backend e 17/17 frontend. Regressão após últimos
  ajustes: 58/58 backend, incluindo quota concorrente, diretório e privacidade.
- Primeiro gate completo: 1.576 backend, 0 falhas e 1 erro; 913 frontend, 912
  aprovados e 1 timeout. Recibos foram preservados, sem chamar esses gates de aprovados.
- Erro Windows: `Path.resolve()` retornou `\\?\C:` apenas em um lado da comparação
  durante criação concorrente. Normalização acontece após resolver symlinks; aceita
  a grafia drive/UNC equivalente e continua rejeitando caminhos externos/dispositivos.
  Novo teste mantém o orçamento e a negação fora da raiz. Gate focado passou.
- Teste de personalização do agendamento passou isolado em 3,88 s após encerrar o QA,
  com asserções e timeout inalterados. A suíte final usa um worker para reduzir disputa.
- Navegador: três contas fictícias, Nora no geral/direta, resposta privada ausente
  para terceiro, proposta de tarefa com confirmação, resumo/leitura por corte e
  áudio sintético com transcritor simulado. Não prova o provedor real/homologação.
- Ensaio móvel em iframe real de 375×812, scrollWidth=375. Header passou a quebrar
  linha para preservar os botões com o novo resumo. Capturas estão em
  `C:/Users/Tarcisio Lucas/norium/output/chat-equipe-20261013/nora-chat-*.jpg`.
- Fonte Inter teve bloqueio do allowlist do Vite de QA por node_modules compartilhado;
  a fonte declarada/artefato de build deve ser conferida no candidato de promoção.
- Abas e servidores do QA encerrados; a aba do outro chat foi preservada.

### Promoção

Faltam registrar o gate integral final/scan no candidato, revisão técnica humana,
ensaio PostgreSQL/30 min e consolidação com chamada/fases 6–7/anexos. A chamada
continua em desenvolvimento no outro chat; a ata usa o fallback de gravação existente.
Código local não significa fases 6–7 integralmente encerradas ou publicado na Shard.
Deploy único pelo GitHub/Shard segue aguardando o conjunto revisado.

## Recibos finais locais — 14/10/2026

- Gate completo repetido: backend 1.578/1.578 sem falhas/erros, recibo `output/pos-correcao/chat-nora-full-final-20261013.json`; frontend 915/915 em `output/chat-equipe-20261013/frontend-nora-full-final-20261013.json` no checkout principal.
- Após o gate completo, revalidação de participantes atuais de subequipe antes da publicação e recusa de alegação de execução sem prova foram cobertas por 27/27 testes em `chat-nora-final-acl-20261014.json`.
- TypeScript, build e orçamento dos bundles aprovados. Bandit: zero achados. Oxlint: zero erros, avisos preexistentes. Scanner de segredos com canário comprovado e resultado redigido.
- O outro chat terminou seu turno e está ocioso. Continuidade e consolidação assumidas nesta conversa por pedido direto do usuário; publicar pelo GitHub e promover no ShardCloud.
- A mudança consolidada precisa repetir os gates; estes recibos não comprovam a integração da chamada nem operação na Shard.
