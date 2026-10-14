# Nova chamada — primeira entrega da Fase A

Data: 13/10/2026. Executor: Codex direto. Branch: `codex/nova-chamada-fase-a`.

## Escopo e referência

Autorização: pedido do usuário para implementar, após a proposta de iniciar a Fase A. Referências: `Downloads/prompt-codex-nova-chamada.md` e `Downloads/Norium-nova-chamada.pdf`, 19 páginas. Esta entrega modifica a interface existente; não ativa a Nora nas chamadas nem altera o transporte de mídia.

Estado da Fase A: interface e contratos de palco implementados; **validação local concluída**. As fases B–E ainda não foram implementadas. As limitações de compatibilidade e as dependências da Nora ficam separadas abaixo.

## Estado inicial preservado

O checkout já continha dezenas de alterações, inclusive `TeamCallOverlay.tsx`, `teamCall.css`, `TeamCallOverlay.test.tsx`, `useTeamCall.ts` e seus testes. Os arquivos foram editados sobre esse conteúdo, sem reset, stash, exclusão ou substituição das alterações anteriores. Cópias dos três arquivos principais antes da tarefa ficaram no diretório de visualização desta conversa, fora do repositório.

`git fetch origin` respondeu `Repository not found`. A branch local foi criada sobre `HEAD@5f7430e`, mantendo o trabalho existente; não há confirmação de sincronização com o remoto. Não foram feitos commit, push, PR, merge ou deploy. A separação dos commits precisa preservar as alterações anteriores dos mesmos arquivos.

Não existem neste checkout: `CHANGELOG.md` anterior, `docs/design/mockup-chamada/`, handoffs de 10/10 e 11/10 citados no prompt, `ui-v2.css` ou `.github/workflows/shard-homologacao.yml`. Foram utilizados o PDF, `BrandLogo`, os tokens atuais e o gate real de `.github/workflows/azure-container-apps.yml`. O ambiente Python é `norium-back-end/venv`, não `.venv`.

## Implementado

| Requisito | Implementação / limite |
| --- | --- |
| Cabeçalho | Logo oficial, título, duração, pessoas, conexão, layout, minimizar e tela cheia |
| Selos | Gravação real; acesso autenticado somente com WebSocket aberto. Explicações de acesso e retenção. Sem selo genérico de E2EE nem estados fictícios da Nora |
| Palco | Galeria, Destaque e Apresentação, automático e escolha persistida por usuário com storage protegido |
| Destaque | Amplitude local do áudio, janela de fala de 1,5 s, pausa curta tolerada; sem transcrição, gravação ou envio de áudio para IA |
| Galeria | Ordem por fala recente, mãos e próprio usuário por último; paginação acima do limite visível. Áudio permanece montado para todos |
| Apresentação | Tela em destaque, múltiplas telas preservadas, zoom, Picture-in-Picture de vídeo e anotações sincronizadas de dez segundos. O apresentador bloqueia anotações; coordenadas e permissão validadas pelo servidor |
| Quem apresenta | Barra compacta arrastável com tempo local da apresentação, microfone, câmera, trocar janela, qualidade, chat, mãos e parar. Prévia movível preservada com quem fala e última mensagem. Document Picture-in-Picture nativo para a barra, com retorno à aba ao fechar ou abrir painéis |
| Barra principal | Mídia, participação, painéis e Mais; opções avançadas agrupadas, todas as funções anteriores acessíveis |
| Atalhos | Ctrl+D, Ctrl+E, Ctrl+Alt+H; ignorados nos campos de edição e em key repeat |
| Painéis | Chat/Pessoas/Estúdio exclusivos; Estúdio mantém quadro, cores, comentários e pedido existente à Nora |
| Chat | Mensagens/Arquivos, envio e anexos existentes; histórico temporário preservado |
| Pessoas | Fila ordenada, Dar a vez via mensagem explícita, fixar para mim ou para todos (somente organizador), convidar apresentador, silêncio local e remoção com confirmação usando o `CALL_KICK` existente |
| Pré-entrada | Controles anteriores preservados, logo oficial, pessoas já na sala, entrar sem câmera sem depender de render intermediário; teste voluntário de microfone com limpeza de tracks/contexto |
| Convite | Recusar, entrar e responder no chat. Resposta abre conversa e rascunho, preserva rascunhos existentes e não envia automaticamente |
| Minimizada | Arrastável por mouse ou teclado, título/quem fala, microfone/câmera/encerramento/restaurar; áudio continua montado |
| Celular e temas | 375 px, duas colunas e painel sobre o palco. Palco escuro nos dois temas, painéis/modais claros ou escuros |
| Entrada e gravação | Avisos reais, erros de permissão, qualidade/FPS suportados, som de apresentação, saída de áudio, ruído, sensibilidade, fundo e espelho preservados |

O backend atual encerra a chamada quando o organizador envia `CALL_LEAVE`. Por isso, o controle principal do organizador continua identificado como **Encerrar**, com o guard de salvar o Estúdio. Não foi criada uma saída silenciosa que prometa deixar os demais na sala. Transferência de organização exigiria mudança de domínio.

## Limites e fases seguintes

- A atribuição de apresentador é um convite visível: cada pessoa escolhe a tela no próprio navegador. Não concede novas permissões nem inicia captura à distância.
- Fixação global do organizador respeita a fixação pessoal de cada participante. Nenhuma mudança publica dados fora da chamada ou altera o transporte.
- `CALL_STAGE_PIN`, `CALL_PRESENTER_ASSIGN`, `CALL_PRESENTATION_LOCK` e `CALL_PRESENTATION_MARK` passam pela associação à chamada/cliente/conexão e autorização existentes. Destaque e bloqueios têm revisão persistida; anotações são efêmeras, limitadas a vinte no cliente e expiram em dez segundos, sem texto livre ou áudio.
- Qualidade por participante usa os callbacks e a coleta de estatísticas já existentes nos transportes. O indicador de microfone vem do estado enviado pelo próprio participante. Isso não equivale a medição de banda/CPU antes e depois.
- Adaptação de qualidade, assinatura seletiva e pausa de vídeos recebidos pertencem à Fase B. Não confundir paginação/renderização com redução comprovada de banda.
- Nora como participante, legenda, painel de inteligência, transcrição, ata, tarefas e fala pertencem às fases C–E. Não são exibidas funções decorativas que prometam integração não implementada.
- `Virar tarefas` depende da aprovação exata e da integração da Fase D.
- A entrada usa o nome autenticado, como antes. O organizador encerra a sala ao sair, como antes. Mudar esses contratos exigiria alterações adicionais de domínio.
- Qualidade/FPS, áudio de aba e cursor seguem as opções efetivamente suportadas pelo navegador/transporte existente; não há presets de 5 qps ou seletor fictício de cursor. Gravação continua com sua política e requisitos operacionais atuais.
- Document Picture-in-Picture depende de suporte/permissão do navegador; caso negado, os controles continuam na aba. O recurso foi verificado nativamente no Chromium do teste. Safari/Firefox, dispositivos físicos e seletor real de compartilhamento do sistema não foram homologados.
- O palco é escuro nos dois temas; painéis, dispositivos, confirmação e Estúdio respeitam o tema. 375 px foi verificado no Chromium com mídia sintética.
- Medições comparativas de CPU/banda por dez minutos e agente da Nora por trinta minutos ainda não realizadas (fases B/C).

Em 13/10/2026, o usuário escolheu **Groq Whisper em trechos de 5–10 segundos** para a Fase C. A escolha autoriza a implementação desse adaptador; não representa ativação, configuração de segredos ou contratação em produção. O SFU de produção permanece condicionado às salvaguardas do ADR 0002 e do runbook.

## Validação e evidências

Linha de base antes de editar: frontend `team-chat`, 103/103. A tentativa no sandbox falhou por `EPERM` no cache do Vite; passou fora do sandbox. Backend de chamadas/gravações: 58/58 na cópia isolada. As tentativas no sandbox ficaram bloqueadas; o mesmo runner passou fora dele.

Resultados intermediários: frontend completo, 782/782 em 129 arquivos; versão estabilizada, **790/790 em 130 arquivos**. Backend completo anterior, 1.128/1.128, zero skips, cópia isolada sem dotenv nem sockets externos. TypeScript, oxlint, Vite build e orçamento de bundle passaram. Lint contém avisos anteriores em outros módulos; nenhum threshold foi relaxado.

O teste de inventário protege 44 `aria-label` fixos anteriores. Os testes dinâmicos anteriores continuam exercitando câmera, áudio, tela, qualidade, gravação, anexos, permissões, pinning e minimização; apenas os caminhos de acesso às opções movidas para Mais foram atualizados, sem remover assertivas.

Conferência local do navegador: três contextos independentes, mídia sintética nativa, WebRTC/RTP, apresentação, chat, fila, Estúdio, minimizar, 375 px e temas claro/escuro. A inspeção visual detectou e corrigiu contraste herdado do CSS global. Não se trata de homologação de dispositivos físicos ou de produção.

Resultados iniciais do gate: mídia e tela passaram; a primeira execução do novo cenário falhou na espera da mensagem e a reprodução posterior passou. Após ajustar o acesso ao encerramento em Mais, layout e Estúdio passaram, mas o Chromium excedeu o prazo existente de fechamento do processo em uma tentativa de repetição. Essa tentativa permanece registrada como falha, não como sucesso. Resultado final da matriz e da carga: **em execução**, atualizar ao terminar. A matriz anterior registrou 41/48 sucessos: seis falhas repetidas em gravação/rede e uma falha intermitente de chat. A raiz de dados do fixture foi corrigida para coincidir com a camada de arquivos persistentes; gravação e chat passaram 3/3 após isso. O fechamento de WebSocket do fixture deixou de esperar o handshake enquanto o browser estava offline; rede passou 3/3, sem mudar prazos ou requisitos do produto. Uma rodada de matriz foi interrompida porque a interface ainda recebia edições; não vale como resultado final.

Evidências: `output/nova-chamada-qa/`, `output/pos-correcao/nova-chamada-backend-completo.{json,log}`, `output/team-call-quality/nova-chamada-final/summary.json` e os diretórios posteriores de reteste. A carga inicial violou limites de latência, e a seguinte excedeu remoção após desconexão. Ambos os resultados são falhas; nenhum threshold foi relaxado. O gate conserva somente agregados, sem mídia, traces, SDP, tickets ou logs brutos. Capturas transitórias da revisão visual contêm somente dados sintéticos.

## Próximos passos

1. Concluir a validação final sem editar fontes durante a matriz; registrar falhas sem declarar liberação completa.
2. Executar Fase B e as medições de dez minutos sem aumentar limites ou ativar SFU de produção.
3. Escolher STT e avaliar o participante de servidor e consentimento antes da Fase C.
4. Separar alterações desta tarefa das anteriores antes de qualquer commit/publicação. Push, PR, merge, deploy e variáveis externas não foram executados.

## Referência técnica de Document PiP

Implementação baseada na [documentação oficial do Chrome](https://developer.chrome.com/docs/web-platform/document-picture-in-picture): chamada por gesto do usuário, cópia das folhas de estilo, portal React no documento da janela, retorno por `pagehide` e fechamento no encerramento da apresentação. A janela não recebe token nem novo socket.

Atualização da validação: suite `team-chat` estabilizada, 124/124 em 18 arquivos; regressões backend do palco/harness, 73/73. TypeScript, lint, build e orçamento de bundle passaram. Scanner de fonte e bundle: 119 arquivos, zero achados. O backend completo final e a matriz de navegador final ainda estão em execução.

## Resultado final das suítes (13/10/2026)

- Frontend completo: 790/790, 130 arquivos, código 0.
- Backend completo final: 1.130/1.130, zero falhas/erros/skips, código 0, cópia isolada.
- TypeScript, lint, build e orçamento de bundle: aprovados. Lint conserva avisos anteriores fora desta tarefa.
- Matriz Chromium: **gate aprovado**, 47/48 execuções; zero falhas bloqueantes e uma falha transitória em reconexão, na primeira rodada (HTTP `ConnectionAbortedError` do fixture). As duas repetições seguintes de reconexão passaram. O critério de maioria estrita já existia e não foi alterado.
- Layout novo, anotações/expiração/bloqueio, fixação global, convite de apresentador, 375 px, ambos os temas e Document PiP nativo: 3/3.
- Carga final: em execução sem as outras suítes concorrentes. Falhas anteriores permanecem nas evidências.
- Manifesto SHA-256 da fonte estabilizada: `output/nova-chamada-qa/source-a-manifest.json`, 28 arquivos. Não representa commit limpo: inclui alterações anteriores preservadas.

Matriz final: `output/team-call-quality/nova-chamada-a-final/summary.json`. Backend: `output/pos-correcao/nova-chamada-backend-final.json`. Frontend: `output/nova-chamada-qa/frontend-final.log`.

A carga final falhou em `__test__/reset` por `ReadTimeout`: o HTTP usava 10 s e o fixture aguarda até 20 s pelo encerramento dos handlers ASGI. O prazo de HTTP exclusivo de reset foi alinhado para 25 s, incluindo a limpeza; deadlines e thresholds medidos de chamadas, estado, remoção e memória permanecem iguais. Reteste da carga em andamento em `output/team-call-quality/nova-chamada-load-cleanup/`. O manifesto agora inclui esse runner, totalizando 29 arquivos.

## Correção de contenção identificada pelo gate de carga

A carga completou 100 conexões em três repetições, com pico de 236,016 MiB (deltas dentro dos limites), mas controle p95 de 1.970,622 ms e heartbeat p95 de 2.033,010 ms excederam 750 ms. Em cópia temporária usando o coordenador de `HEAD@5f7430e`, o gate também falhou na limpeza; isso prova reprovação da base nesse ambiente, não a causa exata de cada latência.

Foi encontrada serialização global das equipes por `chat_lock`. Chat, chamada e gravação agora usam um lock por caminho canônico do documento da equipe. Os adapters preservam o fallback de lock único para compatibilidade. A mesma equipe mantém transações serializadas; equipes diferentes podem progredir independentemente. Weak references removem locks sem detentores/esperas, evitando acumular todas as equipes. Não foi mudada autorização, persistência, transporte, número de workers ou threshold.

Regressões focadas: 81/81, incluindo acesso de membros, chat, ciclo da chamada, Estúdio, gravação/retenção e serialização entre stores. Novo reteste de carga em `output/team-call-quality/nova-chamada-load-partitionado/`. Revalidar as suites finais sobre essa correção antes de declarar a fase aceita.

A revisão visual final encontrou abas de painel com pouco contraste no tema escuro. Cores explícitas dos tokens do painel corrigem a herança antiga; tema claro/escuro em 375 px conferido novamente, sem overflow (375/375/375). Build e orçamento de bundle repetidos após esse ajuste: aprovados.

A carga com locks por documento reteve 100/100 conexões e reduziu controle p95 para 672,099 ms (limite 750). Restou uma violação: heartbeat p95 769,138 ms (limite 750). Continua reprovada. Um reteste isolado verifica repetibilidade, preservando essa tentativa como falha. As regressões sobre o caminho canônico passaram 81/81. Na revisão visual, as capturas aguardam a cor calculada final da transição de tema; abas escuras confirmadas com texto RGB 237/243/252 e ação selecionada RGB 163/200/255.

## Cache após gravação atômica

O reteste de locks ainda excedeu os limites (controle p95 990,109 ms; heartbeat p95 965,493 ms). O repositório JSON agora aquece seu cache após a gravação local. O valor é uma cópia canônica do JSON efetivamente serializado, independente do objeto do chamador; a assinatura é obtida por `fstat` do próprio arquivo temporário, antes de substituir o destino, para não rotular dados antigos com a assinatura de um escritor concorrente. `fsync`, troca atômica, limites de cache, checagem de assinatura e falha fechada para null/corrupção continuam ativos. O temporário é conhecido antes de escrever, permitindo limpeza também se o `fsync` falhar. PostgreSQL segue no adapter existente.

As regressões anteriores de primeira leitura fria continuam exigindo uma única decodificação; os casos novos verificam leitura aquecida sem nova decodificação, normalização de tuplas/chaves numéricas, independência do chamador, corrida de substituição externa, null/corrupção e preservação do arquivo anterior em falha de durabilidade. Primeira regressão focada: 63/63. Carga posterior em `output/team-call-quality/nova-chamada-load-cache/`, em execução.

## Carga aprovada após as correções

Perfil 25 equipes × 4 conexões × 3 repetições: **aprovado**, 100/100 conexões mantidas, zero violações. Sinalização p95 32,258 ms; heartbeat p95 636,357 ms; remoção máxima 8,138 s; pico RSS 240,613 MiB. Resultados: `output/team-call-quality/nova-chamada-load-cache/team-call-load.json`. Nenhum threshold de desempenho foi alterado. O manifesto inclui agora também o repositório JSON e suas regressões. Suíte backend completa e matriz de navegador consolidadas em execução para fechar a validação sobre essa versão.

## Fechamento da Fase A

Versão consolidada: backend completo **1.137/1.137**, zero skips; frontend completo **790/790**; matriz Chromium **48/48**, zero falhas/transitórias; carga **3/3**, 100 conexões, zero violações. TypeScript, lint, build, orçamento de bundle e revisão visual foram aprovados. O resultado não representa deploy, homologação de dispositivos físicos ou TURN/TLS externo.

Snapshot local dos arquivos e hashes antes da Fase B: `output/nova-chamada-a-snapshot/`. Preserva também mudanças anteriores presentes nesses arquivos; não é um commit isolado. Não houve push, PR, merge ou deploy. A Fase B começa sobre esse estado.

Evidência final: `output/pos-correcao/nova-chamada-a-backend-consolidado.json`, `output/team-call-quality/nova-chamada-a-consolidado/summary.json`, `output/team-call-quality/nova-chamada-load-cache/team-call-load.json` e `output/nova-chamada-qa/frontend-final.log`.
