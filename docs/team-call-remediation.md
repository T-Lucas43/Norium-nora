# Linha de base para correção das chamadas de equipe

## Escopo e referência Git

Este documento descreve a implementação existente sem alterar o comportamento do produto e sem executar deploy.

- Worktree: `C:\NOrium\deploy-worktrees\team-call-remediation-baseline`.
- Branch isolada: `codex/team-call-remediation-baseline`.
- Base inicialmente preparada: `fe6967620700c92132253b1e4136dfda8b3fd418`.
- Base sincronizada de `origin/main` em 2026-09-04: `fb671c3` (`feat: completar experiencia de reunioes e corrigir layout do chat`). A atualização também incorporou `4b4b974` (`feat: melhorar audio e controles individuais das chamadas`).
- Atualidade reconfirmada durante a etapa TURN em 2026-09-04: `origin/main` havia avançado para `131aebf` (`fix: harden Nora web result parsing`). Os seis commits novos foram integrados no worktree isolado pelo merge `eaa381c`; `origin/main` é ancestral do resultado e não houve conflito. As mudanças remotas eram de Nora/Studio, além de configuração e composição adjacentes, sem alteração dos módulos de chamada.
- Atualidade reconfirmada ao fechar a etapa 8A em 2026-09-05: `origin/main` avançou nove commits até `25e395c` (`build: retain dependency cache when stamping release identity`). A comparação desde `131aebf` não mostrou alteração nos caminhos de chamadas; o último avanço alterou somente `Dockerfile.azure`, as integrações ocorreram sem conflito e `origin/main@25e395c` é ancestral do resultado final.
- Evidência de presença em `origin/main`: `git ls-tree -r --name-only origin/main` contém o router, `useTeamCall.ts`, `TeamCallOverlay.tsx`, `ParticipantAudio.tsx`, `meetingRecording.ts`, os testes de ciclo de vida e colaboração e o harness de navegador. A implementação deste documento foi reaplicada sobre essa base e os conflitos nos caminhos de chamada foram resolvidos preservando os dois conjuntos de comportamento.

## Arquitetura atual

### Visão geral

```text
NoriumApp
    |
    +-- CallSessionProvider (uma instância autenticada)
    |       |
    |       +-- único /api/team-chat/ws + reconexão
    |       +-- estados idle/ringing/joining/connected/reconnecting/ending/failed
    |       +-- runtime WebRTC, mídia, peers, participantes, tela, gravação e limpeza
    |       +-- snapshot + commands --------------------> TeamChatDrawer / TeamCallOverlay
    |       +-- eventos não CALL -----------------------> chat / presença / notificações
    |
    v
/api/team-chat/ws (router FastAPI)
    |
    v
CallCoordinator
    +-- TeamCallAuthorizer
    +-- JsonCallStateStore + relógio por equipe
    +-- PresenceManager / publicação
    |
    +-- SDP/ICE direcionado ----------------------------> RTCPeerConnection P2P
    +-- HTTP de gravação -------------------------------> JSON + team_chat_uploads
```

A mídia não passa pelo backend: o frontend mantém uma conexão WebRTC por participante remoto, enquanto o backend autentica, persiste o ciclo de vida da chamada e encaminha sinalização SDP/ICE. Isso forma uma malha P2P, não uma arquitetura SFU/MCU (`norium-front-end/src/components/team-chat/useTeamCall.ts:223`, `:892-1008`). Desde a extração, o router adapta apenas HTTP/WebSocket; o ciclo de vida e as regras ficam atrás da interface do `CallCoordinator` (`norium-back-end/app/modules/team/call_coordinator.py:285-622`).

### Frontend da chamada

- `NoriumApp` monta exatamente um `CallSessionProvider` para a sessão autenticada, tanto no modo aplicação quanto no administrativo. Convites abrem o drawer por callback React; `pendingTeamCall` e os eventos DOM `norium:team-call*` foram removidos (`norium-front-end/src/app/NoriumApp.tsx:285-318`).
- `CallSession` é o limite público. Seu snapshot contém a fase explícita, chamada ativa/recebida, participantes, streams, dispositivos, tela, gravação e qualidade; seus comandos pequenos cobrem iniciar/entrar/rejeitar, mídia, tela, gravação, reação e saída. A máquina de estados pura e o bloqueio de provider aninhado tornam transições e instância única verificáveis (`norium-front-end/src/components/team-chat/CallSession.tsx:23-67`, `:83-147`, `:157-389`).
- A sessão abre e reconecta o único socket de equipe, encaminha internamente somente `CALL_*` ao runtime e publica os demais eventos para assinantes. Presença/`CONNECTED` são retidos e repetidos a drawers montados depois da conexão (`CallSession.tsx:170-272`, `:359-389`).
- `useWebSockets` não cria mais socket de equipe: recebe os eventos publicados pela sessão apenas para notificações, badges e alertas de desktop (`norium-front-end/src/hooks/useWebSockets.ts:217-342`). O socket restante nesse hook é exclusivamente o da Central de Atividades.
- `TeamChatDrawer` consome `{ snapshot, commands }`, assina mensagens/presença não relacionadas ao protocolo de chamada e não conhece `CALL_*`, `sendSocketEvent`, `RTCPeerConnection` ou criação de WebSocket (`norium-front-end/src/components/team-chat/TeamChatDrawer.tsx:554-690`).
- `TeamCallOverlay` recebe `snapshot` e `commands` em props separadas; apresenta convite, sala, participantes, câmera/microfone, seleção de dispositivos, tela, reações, chat e gravação sem controlar sinalização (`norium-front-end/src/components/team-chat/TeamCallOverlay.tsx:10-22`, `:122-205`).
- `useTeamCallRuntime` ficou como detalhe interno da sessão para preservar a implementação validada de WebRTC, heartbeat, gravação e limpeza durante esta extração. Nenhum componente de produção o instancia diretamente (`CallSession.tsx`; `useTeamCall.ts`). Todo participante envia heartbeat imediatamente ao abrir/reabrir o socket e depois a cada 10 segundos. Fechamento `4401`/`4403` é terminal: a sessão não reconecta e fecha imediatamente peers, mídia, tela e gravação.
- A política HTTP permite câmera e microfone na própria origem; CSP permite mídia `blob:` e conexões HTTPS/WSS (`norium-back-end/app/bootstrap.py:293-305`).

### Backend de sinalização e estado

- O router real é `app.modules.team.router`, montado sob `/api/team-chat`; `app.routers.team_chat_router` é uma fachada de compatibilidade (`norium-back-end/app/modules/team/router.py:1-40`, `norium-back-end/app/routers/team_chat_router.py:1-3`, `norium-back-end/app/bootstrap.py:316-342`). Os endpoints e o handler WebSocket agora apenas constroem `CallActor`, chamam `active_calls_for`, `end_call` ou `handle_event` e convertem `CallError` em `HTTPException` (`router.py:610-676`, `:1338-1345`).
- `CallCoordinator` é o módulo profundo do ciclo de vida: criação/encerramento, entrada/saída, anfitrião, heartbeat, expiração, idempotência e roteamento direcionado ficam em uma única implementação (`norium-back-end/app/modules/team/call_coordinator.py:285-622`). Sua interface pública é `snapshot`, `active_calls_for`, `broadcast_state`, `end_call` e `handle_event` (`:376-454`).
- `TeamCallAuthorizer` concentra seleção de participantes por equipe/direta/subequipe, elegibilidade atual e as regras de participante/anfitrião. Ações privilegiadas revalidam o diretório antes de encerrar ou expulsar; a reconciliação remove também quem saiu da equipe ou subequipe. O router fornece somente o adapter de diretório que lê membros ativos e subequipes.
- `PresenceManager` guarda conexões, usuário e um `connectionId` único por socket em memória do processo. Publicações comuns revalidam conta/equipe e fecham com `4403` quando o acesso mudou. `CALL_SIGNAL` não relê arquivos/diretório a cada ICE: usa a associação já autorizada em memória, limitada pela reconciliação periódica de 5 segundos.
- O estado durável continua no JSON por equipe para compatibilidade. `JsonCallStateStore` carrega/substitui apenas `activeCalls` e `endedCallIds` e anexa mensagens sob o lock legado, preservando os demais campos (`norium-back-end/app/modules/team/call_adapters.py:14-55`). O coordenador mantém um runtime e um lock por equipe (`call_coordinator.py:143-149`, `:304-312`).
- `CALL_INVITE` reserva no máximo uma chamada ativa por thread e cria `participantSessions[userId] = {clientId, connectionId, lastHeartbeatAt, disconnectedAt}`. `CALL_ACCEPT` transfere explicitamente a sessão para a nova aba; heartbeat do mesmo cliente pode reatar em um novo socket mesmo se competir com o fechamento antigo. `CALL_LEAVE`, `CALL_KICK` e `CALL_END` são idempotentes. `CALL_SIGNAL`, reações e eventos de tela usam apenas o runtime carregado. Testes provam que sinais ICE consecutivos não carregam/salvam o estado nem leem o diretório no fan-out.
- `DELETE /calls/{call_id}` delega a `end_call`, que é idempotente, exige o anfitrião quando a chamada existe, registra o ID encerrado por um dia e publica `CALL_END`, mensagem e novo snapshot (`call_coordinator.py:387-433`, `router.py:668-675`).

### Ciclo de vida endurecido

- Associação ativa: uma chamada possui participantes autorizados; cada participante presente possui exatamente uma sessão ativa, identificada por `clientId` (instância da `CallSession`) e `connectionId` (socket do servidor). Uma segunda aba substitui a primeira e `CALL_SESSION` manda a aba antiga encerrar sua mídia.
- Queda de transporte: `connection_closed` marca a sessão, mas concede 8 segundos para o mesmo cliente reaparecer em outro socket. Ao fim da tolerância, uma tarefa do servidor chama `reconcile`; membro ausente gera `CALL_LEAVE`, e anfitrião ausente encerra com `host_disconnected`.
- Heartbeat: todos enviam a cada 10 segundos. Um membro sem heartbeat por 30 segundos é removido com `heartbeat_expired`. O anfitrião possui lease próprio de 35 segundos; isso encerra chamadas de abas suspensas mesmo quando o socket TCP ainda parece aberto.
- Revogação: o loop WebSocket reconcilia a cada 5 segundos. Membro removido recebe `CALL_KICK` quando ainda alcançável; conta inativa ou movida tem o socket fechado com `4403`. Se o anfitrião perde acesso, a chamada termina com `host_access_revoked`. Portanto revogação é observada em até 5 segundos, além apenas da latência da leitura do diretório.
- Eventos atrasados: toda mutação exige o `clientId` ativo e, exceto o heartbeat de reconexão do mesmo cliente, o `connectionId` ativo. Sinais de aba ou sessão substituída recebem `CALL_SESSION` e não são roteados.

### WebSocket e autenticação

- O frontend obtém `POST /api/auth/websocket-ticket` antes de abrir o socket e coloca o ticket na query string (`norium-front-end/src/core/api/client.ts:165-172`).
- O ticket fica em memória, expira e é consumido uma única vez; a resolução revalida usuário ativo e `sessionVersion` (`norium-back-end/app/modules/auth/router.py:695-722`, `:918-923`).
- O endpoint `/api/team-chat/ws` fecha com `4401` quando ticket/permissão falha, envia `CONNECTED` e `CALLS_STATE` na conexão e executa a reconciliação do servidor a cada 5 segundos. Cada conexão recebe um ID próprio, propagado somente no `CallActor`; respostas diretas retornadas pela interface são escritas no socket.
- Eventos aceitos: `CALL_INVITE`, `CALL_ACCEPT`, `CALL_REJECT`, `CALL_SIGNAL`, `CALL_REACTION`, `CALL_SCREEN_STARTED`, `CALL_SCREEN_STOPPED`, `CALL_LEAVE`, `CALL_KICK`, `CALL_END` e `CALL_HEARTBEAT`; mensagens acima de 120 kB são rejeitadas.
- `CALL_SIGNAL` só é encaminhado a um usuário com sessão ativa em `participantSessions`, diferente do emissor, e exige sinal em objeto JSON. O coordenador já validou cliente e conexão antes do fan-out.

### WebRTC

- `webrtc-adapter` normaliza diferenças entre navegadores (`norium-front-end/src/components/team-chat/useTeamCall.ts:1-4`).
- Cada peer usa `bundlePolicy: "max-bundle"`, pool ICE 4, canal de áudio `sendrecv` e um transceiver de vídeo reservado mesmo com a câmera inicialmente desligada (`norium-front-end/src/components/team-chat/useTeamCall.ts:892-925`).
- Ofertas, respostas e candidatos ICE são enviados como `CALL_SIGNAL`; candidatos recebidos antes do SDP remoto são enfileirados. Cada par escolhe papel `polite`/`impolite` de forma determinística pela ordenação dos IDs de usuário. O estado por peer registra `makingOffer`, `ignoreOffer`, `isSettingRemoteAnswerPending` e uma revisão que invalida operações assíncronas atrasadas.
- Em colisão de ofertas, o peer impolite ignora a oferta conflitante e seus candidatos; o peer polite cancela a tentativa local, faz rollback quando o signaling state exige, aplica a oferta remota e responde. Call ID, revisão e identidade atual do peer impedem que uma negociação antiga publique ou aplique SDP depois da limpeza.
- Em falha a implementação chama `restartIce()` e renegocia; desconexão atualiza o estado visual para reconexão (`norium-front-end/src/components/team-chat/useTeamCall.ts:980-1004`).
- A limpeza é determinística: handlers do peer são removidos antes de `close()`, mapas de senders/candidatos/negociação são esvaziados, tracks remotas perdem callbacks e todas as tracks locais/tela são paradas.
- A configuração ICE deixou de vir do build Vite. A `CallSession` obtém STUN + TURN/TLS por `GET /api/team-chat/calls/ice-servers`, conserva usuário/senha apenas em memória e entrega o array diretamente ao runtime. Ausência do serviço mantém somente STUN público e produz aviso acessível; nenhuma credencial permanente pode ser injetada no bundle.
- A sessão renova as credenciais em `refreshAfter`. Peers já ativos recebem `setConfiguration`, `restartIce` e renegociação pelo handler existente. A telemetria guarda somente estado ICE, tipo de candidato selecionado (`host`, `srflx`, `prflx`, `relay`) e protocolo permitido; IP, endereço, porta, candidato completo e SDP não entram no snapshot nem em logs.
- Tela usa `getDisplayMedia`, perfis 720p/1080p/1440p e 15/30/60 FPS, com ajuste de bitrate no sender (`norium-front-end/src/components/team-chat/useTeamCall.ts:87-114`, `:1395-1445`).

### Gravação

- A gravação ocorre no navegador do organizador. `AudioContext` mistura as faixas locais e remotas; quando há vídeo, um canvas 1280x720 compõe tela/câmeras e produz uma faixa a 24 FPS (`norium-front-end/src/components/team-chat/useTeamCall.ts:634-740`).
- Antes de iniciar qualquer captura, a `CallSession` exige confirmação explícita de que áudio, vídeo e tela podem ser capturados e de que todos serão avisados. Durante toda a captura, o overlay mostra `REC`, duração e “Todos foram avisados”. O host também vê bytes enviados, pendentes, percentual da fila, retentativa ou finalização.
- `MediaRecorder` escolhe WebM/MP4 suportado e emite um bloco a cada 5 segundos. Cada bloco recebe UUID estável, passa por no máximo três tentativas e entra em uma fila serial. A sessão pausa o recorder ao atingir 24 MB ou três chunks pendentes e o retoma depois da drenagem; sair/encerrar espera concluir ou abortar a gravação antes de finalizar a chamada.
- API preservada: `POST /recordings/start`, `PUT /recordings/{id}/chunks`, `POST /recordings/{id}/complete` e `DELETE /recordings/{id}`. O router apenas converte payload/headers e erros. `clientId`, IDs de operação e `X-Recording-Chunk-Id` ligam cada requisição à chamada, ao participante e ao cliente.
- `RecordingCoordinator` é o único dono da política de servidor: chamada ativa, anfitrião, associação do uploader, exclusividade por chamada, idempotência, quotas, duração, frequência, finalização e eventos. Seus adapters separam JSON, arquivos locais, `CallCoordinator`, publicação/auditoria e relógio (`recording_coordinator.py`; `recording_adapters.py`).
- O arquivo nasce como `*.part`. A conclusão move para o nome final dentro da transação de estado e compensa a movimentação se o commit falhar; qualquer falha/aborto remove parcial e final, marca estado terminal e publica `CALL_RECORDING_STOPPED`. A conclusão publica mensagem, disponibilidade e parada exatamente uma vez.
- A manutenção começa e termina com a aplicação. A cada intervalo configurável, revalida chamada/acesso, encerra capturas que perderam vínculo ou duração, exclui concluídas vencidas e varre `.part` órfãos. Retenção não depende mais de listar mensagens ou baixar anexos.

#### Limite arquitetural após o endurecimento

```text
CallSession (única proprietária da captura)
    |
    +-- consentimento + indicador + progresso
    +-- MediaRecorder -> fila limitada -> retentativa/backpressure
    |
    v
router HTTP (adapter fino)
    |
    v
RecordingCoordinator
    +-- CallCoordinatorRecordingAccess -> chamada/host/participante/cliente
    +-- JsonRecordingStore             -> estado + mensagem transacional
    +-- LocalRecordingFiles            -> append por offset/move/delete/orphans
    +-- CallbackRecordingEvents        -> WebSocket + auditoria sem conteúdo
    +-- RecordingClock/Limits          -> duração, quotas, frequência, retenção
```

Limites configuráveis no servidor: `TEAM_RECORDING_MAX_CHUNK_BYTES`, `TEAM_RECORDING_MAX_TOTAL_BYTES`, `TEAM_RECORDING_MAX_DURATION_SECONDS`, `TEAM_RECORDING_MAX_CONCURRENT_PER_TEAM`, `TEAM_RECORDING_MAX_TEAM_BYTES`, `TEAM_RECORDING_REQUEST_LIMIT`, `TEAM_RECORDING_REQUEST_WINDOW_SECONDS`, `TEAM_RECORDING_RETENTION_HOURS`, `TEAM_RECORDING_MAINTENANCE_INTERVAL_SECONDS` e `TEAM_RECORDING_ORPHAN_GRACE_SECONDS`. Os defaults mantêm 16 MB por chunk, 512 MB por gravação, 6 horas e retenção de 24 horas; adicionam duas gravações simultâneas, 2 GB por equipe, 60 requisições/minuto e manutenção a cada 60 segundos.

#### Fluxo anterior ao endurecimento de gravação

Este é o retrato do fluxo encontrado antes da implementação da política de gravação desta etapa:

1. O host aciona o botão exposto pela UI. O cliente compõe áudio/vídeo antes de obter autorização do servidor e envia `POST /recordings/start` com `callId`, escopo e MIME declarados pelo navegador.
2. O endpoint valida apenas permissão geral de chat, MIME e participação na conversa. Ele não consulta a chamada ativa nem exige `hostUserId`; portanto um ID arbitrário e uma conversa válida podem criar um registro.
3. A exclusividade procura `(callId, createdBy, status=recording)`. Dois usuários podem abrir gravações simultâneas da mesma chamada. Não há limite por equipe, processo ou frequência.
4. O cliente produz chunks de cinco segundos e os serializa em uma Promise. Cada `PUT /chunks` acumula o corpo inteiro em memória, limita 16 MB e anexa ao `.part` sob o lock global; não há chave idempotente, backpressure explícito ou retentativa limitada.
5. O limite total fixo é 512 MB. Não existem limites configuráveis de duração, simultaneidade ou consumo agregado da equipe.
6. `POST /complete` move o `.part` para o nome final, depois altera JSON e mensagem no mesmo bloco lógico, sem estado `finalizing` ou compensação se a persistência falhar. Repetir a operação retorna conflito.
7. `DELETE /recordings/{id}` autoriza somente `createdBy`, remove o `.part` e marca aborto; não publica parada e também não é idempotente depois do primeiro aborto.
8. A limpeza de gravação ativa ocorre somente ao ler um store podado e usa seis horas fixas. A retenção de arquivos concluídos também depende de uma leitura posterior; arquivos `.part` sem registro não são descobertos.
9. Auditoria existe apenas na conclusão. Início, aborto, falha, expiração e exclusão não são registrados. O evento de início contém somente metadados, mas não há evento simétrico de parada em falha.

As seams escolhidas para a correção são uma interface única de política/ciclo de gravação no backend, com adapters de store, arquivo, publicação, relógio e auditoria, e a interface pública da `CallSession` no frontend. Router e overlay permanecem adapters finos.

## Testes existentes relacionados

### Backend

- `norium-back-end/tests/unit/test_call_coordinator.py`: interface do coordenador com adapters em memória; além da linha de base, cobre desconexão sem `leave`, retorno dentro da tolerância, corrida reconexão/fechamento, host suspenso, expiração de heartbeat de membro, duas abas, eventos antigos, `leave`/`kick` idempotentes e revogação de membro/anfitrião.
- `norium-back-end/tests/test_team_call_lifecycle.py`: concorrência por thread, encerramento idempotente, eventos atrasados, privacidade direta, rejeição/ingresso tardio, bloqueio de aba antiga, heartbeat/expiração, snapshot de reconexão e revogação atravessando os adapters reais de JSON/diretório/publicação.
- `norium-back-end/tests/test_team_collaboration.py`: fan-out de `CALL_END`, gravação em blocos/expiração e replay/poda de chamada ativa, além de chat/subequipes relacionados (`:100-128`, `:276-353`).
- `norium-back-end/tests/unit/test_access_control.py:110-119`: ticket WebSocket curto e de uso único.
- `norium-back-end/tests/team_call_browser_app.py` é um servidor/harness local com dois usuários; não integra a suíte de `unittest`.

### Frontend

- `norium-front-end/src/components/team-chat/CallSession.test.tsx`: transições explícitas, dois consumidores compartilhando uma instância, desmontagem/fechamento, reconexão com um timer, heartbeat ao reconectar, revogação terminal e recusa de segundo proprietário.
- `norium-front-end/src/components/team-chat/useTeamCall.test.tsx`: testes do runtime interno para mídia, dispositivos, chamadas, eventos atrasados, corrida de permissão, câmera/tela, colisão de ofertas com rollback e limpeza imediata após revogação.
- `norium-front-end/src/components/team-chat/TeamCallOverlay.test.tsx`: UI unificada, permissão/câmeras, prévia de tela e tela cheia remota (`:6-226`).
- `norium-front-end/src/components/team-chat/TeamActiveCallCard.test.tsx`: ingresso em reunião já ativa.
- Os demais testes de `src/components/team-chat` cobrem anexos, recibos de leitura, agendamento, presença e cards de reunião; eles também entram na linha de base para detectar regressões no contêiner que integra a chamada.
- `norium-front-end/src/hooks/useWebSockets.test.tsx`: ciclo de notificações e convite/encerramento no mesmo lote sem depender de socket ou `CustomEvent` próprio.
- `norium-front-end/tests/browser/calls.tsx` reutiliza `CallSessionProvider`, overlay e peers reais com mídia sintética, mas `vitest.config.ts:12` inclui apenas testes sob `src/`; portanto esse harness é manual e não roda em `npm test`.

## Fluxo de deploy histórico na Azure

Esta seção registra o fluxo Azure descontinuado. Para preparar, publicar ou validar o Norium hoje, siga [DEPLOY_SHARDCLOUD.md](../DEPLOY_SHARDCLOUD.md).

O fluxo principal versionado na época era Azure Container Apps:

1. Em push/PR para `main`, o job `validate` usa Python 3.14 e Node 24, executa toda a suíte backend, lint/test/build frontend e verificações de dependências (`.github/workflows/azure-container-apps.yml:3-80`).
2. Fora de PR, o workflow cria uma imagem imutável e `latest` no GHCR usando `Dockerfile.azure` (`.github/workflows/azure-container-apps.yml:82-120`).
3. `Dockerfile.azure` compila o React, copia o `dist` para a imagem FastAPI, instala o Chromium e serve SPA/API/WebSocket no mesmo domínio (`Dockerfile.azure:1-49`).
4. O job de deploy autentica na Azure via OIDC, atualiza a imagem imutável e força uma única réplica (`min-replicas=1`, `max-replicas=1`), depois verifica imagem, `/health` e `/health/browser` (`.github/workflows/azure-container-apps.yml:122-223`).
5. O volume Azure Files é montado em `/app/data`, onde ficam JSON e gravações (`infra/azure/main.bicep:129-162`, `:194-195`).
6. O deploy inicial/manual `infra/azure/deploy.ps1` também executa `infra/azure/smoke_test.py`, que autentica, obtém ticket e valida `CONNECTED`/`ACK` do WebSocket (`infra/azure/deploy.ps1:262-276`, `infra/azure/smoke_test.py:24-73`). Não executar esse fluxo durante esta remediação.

Railway mantém frontend e backend em serviços separados e exige volume persistente no backend (`DEPLOY_RAILWAY.md:8-74`). Vercel é documentado apenas com armazenamento temporário e WebSockets/JSON em memória, inadequados para produção sem migração para banco, object storage e pub/sub (`DEPLOY_VERCEL.md:54-65`).

## Riscos já confirmados

1. **A aplicação está pronta para TURN, mas este ambiente não possui o serviço externo.** O frontend não aceita mais configuração TURN no build. O backend valida e usa segredo apenas em runtime, porém `TEAM_CALL_TURN_URLS` e `TEAM_CALL_TURN_SHARED_SECRET` não estão configurados neste worktree/host. Assim, chamadas comuns mantêm fallback STUN, enquanto o gate relay-only termina objetivamente como bloqueado até existir um TURN/TLS real acessível.
2. **Consentimento continua sendo uma garantia de cliente.** A captura só começa depois da confirmação explícita e todos recebem indicador/evento, mas o servidor não consegue provar que um navegador modificado mostrou o aviso. A proteção de servidor limita quem pode gravar, qual chamada e cliente podem enviar e por quanto tempo; conformidade que exija prova de consentimento persistida demandará um protocolo próprio e decisão jurídica/produtiva.
3. **Retenção é periódica, não um relógio de exclusão em tempo real.** A exclusão ocorre sem leitura do usuário, no startup e a cada 60 segundos por default. Uma indisponibilidade do processo posterga a tarefa até o próximo startup; portanto o prazo observável é retenção mais o intervalo/indisponibilidade, embora o download continue condicionado ao registro e à visibilidade.
4. **Estado e fan-out dependem de uma única réplica.** Tickets WebSocket, presença/conexões, o runtime do `CallCoordinator`, o contador de frequência de gravação e o scheduler são memória local; o estado durável continua em JSON no volume. O controle atual da Azure fixa uma réplica e evita divergência, mas a matriz de segurança já registra que escala horizontal exige banco transacional, rate limit compartilhado, eleição de tarefa e pub/sub (`auth/router.py:695-715`, `call_coordinator.py`, `recording_coordinator.py`, workflow `:171-193`, `docs/SECURITY_CONTROLS.md:17`).
5. **Portabilidade da gravação depende do filesystem.** Azure fornece volume persistente e Railway exige que ele seja configurado; no Vercel `/tmp` pode desaparecer entre invocações. O backend não abstrai gravações em object storage (`team/router.py:30-31`, `:1270-1296`, `DEPLOY_AZURE.md:7-10`, `DEPLOY_RAILWAY.md:19-41`, `DEPLOY_VERCEL.md:54-65`).
6. **Não há teste automatizado navegador-a-navegador no gate.** Os testes React mockam APIs de mídia/RTC, o backend mocka sockets/manager, e o harness de browser está fora do include do Vitest. O smoke local valida somente abertura e `ACK`, não negociação SDP/ICE nem fluxo de áudio/vídeo/gravação (`vitest.config.ts:9-12`, `tests/browser/calls.tsx`, `team_call_browser_app.py:1-39`, `infra/azure/smoke_test.py:55-60`). O workflow CI pós-deploy atual nem chama esse smoke autenticado: verifica `/health` e `/health/browser` (`azure-container-apps.yml:209-223`).
7. **O runtime WebRTC interno continua grande.** A UI e o transporte já estão isolados pela seam de `CallSession`, porém negociação, captura, gravação e recuperação continuam coesas em `useTeamCallRuntime`. Próximas mudanças devem decompor esse detalhe por adapters da sessão, sem voltar a expor protocolo aos componentes.
8. **Reconciliação e tolerância ainda são locais ao processo.** O timer pós-desconexão, os leases e as associações de conexão vivem no runtime do `CallCoordinator`. A implantação atual limita Azure a uma réplica; antes de escalar horizontalmente, esses leases precisam migrar para storage transacional e o fan-out para pub/sub.

## Componentes previstos para as próximas etapas

### Componentes alterados nesta etapa de gravação

- `norium-back-end/app/modules/team/recording_coordinator.py`: política, quotas, idempotência, transação compensada, auditoria e manutenção.
- `norium-back-end/app/modules/team/recording_adapters.py`: adapters para JSON, `CallCoordinator` e publicação.
- `norium-back-end/app/modules/team/call_coordinator.py`: consulta autorizada de contexto de gravação da chamada ativa.
- `norium-back-end/app/modules/team/router.py`: wiring e adaptação HTTP; regras antigas de gravação e limpeza preguiçosa removidas.
- `norium-back-end/app/bootstrap.py` e `.env.example`: ciclo periódico, headers CORS e configuração dos limites.
- `norium-front-end/src/components/team-chat/useTeamCall.ts`: consentimento, IDs idempotentes, fila, progresso, retentativa, backpressure e encerramento ordenado; continua detalhe privado da sessão.
- `norium-front-end/src/components/team-chat/CallSession.tsx`: snapshot público do progresso de gravação.
- `norium-front-end/src/components/team-chat/TeamCallOverlay.tsx`: aviso/indicador persistente e progresso, sem conhecer protocolo.
- `norium-back-end/tests/unit/test_recording_coordinator.py`, `tests/test_team_collaboration.py`, `useTeamCall.test.tsx` e `TeamCallOverlay.test.tsx`: cobertura de política e interface.

O novo limite arquitetural foi implementado sem alteração deliberada do comportamento visível além das proteções e avisos solicitados. As próximas correções devem atravessar a seam do coordenador:

- `norium-back-end/app/modules/team/call_coordinator.py`: regras e resultados observáveis da chamada.
- `norium-back-end/app/modules/team/call_adapters.py`: troca futura de JSON/publicação/diretório por infraestrutura persistente ou distribuída.
- `norium-back-end/app/modules/team/router.py`: somente alterações de contrato HTTP/WebSocket e wiring dos adapters; regras novas não devem voltar para o router.
- `norium-front-end/src/components/team-chat/CallSession.tsx`: única seam para fase, transporte, comandos e composição dos adapters do runtime.
- `norium-front-end/src/components/team-chat/useTeamCall.ts`: detalhe interno para configuração ICE, negociação/recuperação e lifecycle de gravação; não deve voltar a ser consumido pela UI.
- `norium-front-end/src/components/team-chat/TeamCallOverlay.tsx`: somente controles/consentimento e mensagens de falha derivados de snapshot/comandos.
- `norium-front-end/src/components/team-chat/TeamChatDrawer.tsx` e `src/hooks/useWebSockets.ts`: somente chat/presença e apresentação de notificações; não devem abrir sockets nem interpretar protocolo de chamada.
- Testes backend `test_team_call_lifecycle.py`/`test_team_collaboration.py` e frontend `CallSession.test.tsx`/`useTeamCall.test.tsx`/`TeamCallOverlay.test.tsx`/`useWebSockets.test.tsx`.
- Harness `norium-front-end/tests/browser/calls.tsx` e `norium-back-end/tests/team_call_browser_app.py`, ou um teste E2E automatizado equivalente.
- Secret manager/configuração de runtime do backend para provisionar `TEAM_CALL_TURN_URLS` e `TEAM_CALL_TURN_SHARED_SECRET`; nenhum segredo TURN deve ser passado ao build do frontend ou ao `Dockerfile`.
- Persistência/object storage e pub/sub somente se a próxima etapa ampliar o escopo para múltiplas réplicas; isso não deve ser introduzido incidentalmente.

## Linha de base executada

Execução realizada em 2026-09-03 no worktree isolado, sem deploy. Os três gates solicitados passaram.

| Área | Diretório | Comando executado | Exit code | Resultado/duração | Evidência ou falha preexistente |
| --- | --- | --- | ---: | --- | --- |
| Ambiente | raiz | `git status --short --branch`; `git rev-parse HEAD origin/main` | 0 | branch `codex/team-call-remediation-baseline`; `HEAD == origin/main == fe6967620700c92132253b1e4136dfda8b3fd418` | Aviso local de leitura de `C:\Users\N4N\.config\git\ignore`; não afeta o repositório |
| Backend — equipe/chamadas | `norium-back-end` | `.\.venv\Scripts\python.exe -m unittest tests.test_team_call_lifecycle tests.test_team_collaboration tests.unit.test_team_nora_mentions tests.unit.test_access_control.AccessControlTests.test_websocket_ticket_is_short_lived_and_single_use` | 0 | 23 testes, `OK`, 0,587 s | Nenhuma falha |
| Frontend — equipe/chamadas/socket | `norium-front-end` | `npm test -- src/components/team-chat src/hooks/useWebSockets.test.tsx` | 0 | 9 arquivos, 29 testes, todos aprovados, 3,30 s | Nenhuma falha |
| Frontend — build de produção | `norium-front-end` | `npm run build` | 0 | build aprovado; 1.698 módulos transformados; 1,28 s | Nenhuma falha |

### Reprodutibilidade

- Runtime usado: Python 3.12.13, Node.js 24.18.0 e npm 11.16.0.
- Backend: a partir de `norium-back-end`, criar o ambiente com `C:\Users\N4N\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe -m venv .venv` e instalar com `.\.venv\Scripts\python.exe -m pip install -r requirements.txt`. A instalação terminou com exit code 0. Como a maior parte de `requirements.txt` não fixa versões, a reprodução futura depende do índice de pacotes disponível; esta é uma limitação já existente da linha de base.
- Frontend: a partir de `norium-front-end`, executar `npm ci --no-audit --no-fund`; o lockfile instalou 325 pacotes e o comando terminou com exit code 0. No sandbox Codex foi necessário permitir acesso ao cache npm do usuário; a primeira tentativa sem esse acesso falhou com `EPERM`, uma restrição do ambiente, não uma falha do produto.
- `node_modules`, `.venv` e `dist` são ignorados pelo Git. Após os gates, `git status --short` no worktree mostra somente `?? docs/team-call-remediation.md`.
- Não houve falha preexistente nos testes ou no build executados. Nenhum fluxo de deploy foi chamado.

## Verificação após a extração do coordenador

Execução realizada no mesmo worktree em 2026-09-03, sem deploy:

| Área | Comando | Resultado |
| --- | --- | --- |
| Coordenador + regressão de equipe/chamadas | `.\.venv\Scripts\python.exe -m unittest tests.unit.test_call_coordinator tests.test_team_call_lifecycle tests.test_team_collaboration tests.unit.test_team_nora_mentions tests.unit.test_access_control.AccessControlTests.test_websocket_ticket_is_short_lived_and_single_use` | 31 testes aprovados em 0,499 s |
| Backend completo | `.\.venv\Scripts\python.exe -m unittest discover -s tests -p "test*.py"` | 417 testes aprovados em 17,170 s |
| Frontend completo | `npm test` | 64 arquivos e 420 testes aprovados em 10,50 s |
| Build de produção | `npm run build` | aprovado; 1.698 módulos transformados |

Os logs da suíte backend contêm avisos esperados de cenários negativos (OAuth recusado, storage indisponível, resposta W-API e JSON inválido); o processo terminou com exit code 0. O build e os testes frontend também terminaram com exit code 0.

## Verificação após a extração da sessão frontend

Execução realizada no mesmo worktree em 2026-09-03, sem deploy:

| Área | Comando | Resultado |
| --- | --- | --- |
| Sessão + chamadas + overlay + notificações | `npm test -- --run src/components/team-chat/CallSession.test.tsx src/components/team-chat/useTeamCall.test.tsx src/components/team-chat/TeamCallOverlay.test.tsx src/hooks/useWebSockets.test.tsx` | 4 arquivos e 24 testes aprovados |
| Frontend completo | `npm test -- --run` | 65 arquivos e 425 testes aprovados em 8,69 s |
| Backend completo | `.\.venv\Scripts\python.exe -m unittest discover -s tests -p "test*.py"` | 417 testes aprovados em 18,125 s |
| Build de produção | `npm run build` | aprovado; 1.700 módulos transformados |
| Análise estática | `npm run lint` | exit code 0; nenhum aviso em chamadas de equipe; 14 avisos preexistentes em componentes fora do escopo |
| Auditoria de propriedade | busca por `/api/team-chat/ws`, `norium:team-call`, `handleSocketEvent`, `sendSocketEvent` e APIs WebRTC fora da sessão/runtime | um socket de equipe em `CallSession`; nenhum evento DOM de chamada; nenhum protocolo/WebRTC no drawer ou overlay |

Os avisos do backend são os mesmos cenários negativos já registrados na linha de base. Não houve falha preexistente ou nova nesta etapa, e nenhum comando de deploy foi executado.

## Verificação após o endurecimento do ciclo de vida

Execução realizada no mesmo worktree em 2026-09-03, sem deploy:

| Área | Comando | Resultado |
| --- | --- | --- |
| Backend completo | `.\.venv\Scripts\python.exe -m unittest discover -s tests` | 429 testes aprovados em 18,026 s |
| Frontend focado — sessão/chamada/overlay/socket | `npm test -- --run src/components/team-chat/useTeamCall.test.tsx src/components/team-chat/CallSession.test.tsx src/components/team-chat/TeamCallOverlay.test.tsx src/hooks/useWebSockets.test.tsx` | 4 arquivos e 26 testes aprovados |
| Frontend completo | `npm test -- --run` | 65 arquivos e 427 testes aprovados |
| Build de produção | `npm run build` | aprovado pelo TypeScript e Vite; 1.700 módulos transformados |
| Análise estática | `npm run lint` | exit code 0; nenhum aviso no escopo; os mesmos 14 avisos preexistentes fora de chamadas |

Os novos testes reproduzem desconexão sem `leave`, queda/retorno concorrente, lease de host suspenso, revogação em runtime e nos adapters reais, duas abas, idempotência, eventos de sessão antiga, fan-out ICE sem leitura de diretório e colisão de ofertas com rollback. A suíte backend continua emitindo apenas os avisos esperados de cenários negativos já descritos; o build continua alertando sobre chunk geral acima de 500 kB. Nenhuma dessas mensagens é falha de chamadas e nenhum deploy foi executado.

## Verificação após o endurecimento da gravação

Execução realizada no mesmo worktree em 2026-09-04, sem deploy:

| Área | Comando | Resultado |
| --- | --- | --- |
| Política de gravação | `.\.venv\Scripts\python.exe -m unittest tests.unit.test_recording_coordinator` | 16 testes aprovados; autorização, chamada arbitrária, cliente, quota de chunk/total/equipe, simultaneidade, frequência, duração, concorrência, conflito/replay idempotente, aborto, falha de commit, revogação, retenção e órfãos |
| Backend focado — equipe/chamadas | `.\.venv\Scripts\python.exe -m unittest tests.unit.test_recording_coordinator tests.unit.test_call_coordinator tests.test_team_call_lifecycle tests.test_team_collaboration` | 54 testes aprovados após integrar os novos casos |
| Backend completo | `.\.venv\Scripts\python.exe -m unittest discover -s tests -p "test*.py"` | 445 testes aprovados em 16,338 s |
| Frontend focado — sessão/chamada/overlay | `npm test -- --run src/components/team-chat/useTeamCall.test.tsx src/components/team-chat/CallSession.test.tsx src/components/team-chat/TeamCallOverlay.test.tsx` | 3 arquivos e 23 testes aprovados; inclui consentimento recusado, retentativa/backpressure e indicador/progresso |
| Frontend completo | `npm test -- --run` | 65 arquivos e 428 testes aprovados em 8,89 s |
| Build de produção | `npm run build` | TypeScript e Vite aprovados; 1.700 módulos transformados |
| Análise estática | `npm run lint` | exit code 0; nenhum aviso no escopo; os mesmos 14 avisos preexistentes fora de chamadas |
| Integridade do diff | `git diff --check` | aprovado; apenas avisos locais de normalização LF/CRLF |

A primeira execução backend completa desta etapa revelou quatro erros iguais no wiring novo de startup (`FastAPI.add_event_handler` não existe na versão instalada). O wiring foi corrigido para `app.router.add_event_handler`; os 11 testes de OpenAPI/headers/webhook afetados passaram isoladamente e a repetição completa final terminou com 445/445. Não é falha preexistente nem permanece aberta.

Mensagens não fatais preexistentes: aviso de depreciação do `pypdf`, logs intencionais de testes negativos de OAuth/storage/W-API/JSON, 14 avisos do lint em módulos fora do escopo e aviso do Vite para chunks gerais acima de 500 kB. Nenhum arquivo `.part` permaneceu nos cenários de falha, aborto, expiração, revogação, retenção ou commit interrompido cobertos. Nenhum comando de deploy foi executado.

## Verificação após sincronização com `origin/main`

Execução realizada em 2026-09-04 após atualizar a base de `fe69676` para `fb671c3`, sem deploy. O stash `codex-team-call-remediation-before-origin-sync` foi mantido como cópia de segurança durante a resolução. Os recursos novos da base — chat efêmero da reunião, mãos levantadas, estado de câmera/tela, troca de compartilhamento, áudio e fixação por participante — foram incorporados ao snapshot/comandos da `CallSession`; drawer e overlay continuam sem possuir socket ou regras de protocolo.

| Área | Comando | Resultado |
| --- | --- | --- |
| Backend focado pós-merge | `.\.venv\Scripts\python.exe -m unittest tests.unit.test_call_coordinator tests.unit.test_recording_coordinator tests.test_team_call_lifecycle` | 47 testes aprovados em 0,585 s |
| Frontend focado pós-merge | `npm test -- --run src/components/team-chat/CallSession.test.tsx src/components/team-chat/useTeamCall.test.tsx src/components/team-chat/TeamCallOverlay.test.tsx src/hooks/useWebSockets.test.tsx` | 4 arquivos e 27 testes aprovados |
| Backend completo pós-merge | `.\.venv\Scripts\python.exe -m unittest discover -s tests -p "test_*.py"` | 449 testes aprovados em 26,005 s |
| Frontend completo pós-merge | `npm test -- --run` | 65 arquivos e 428 testes aprovados em 18,55 s |
| Build de produção pós-merge | `npm run build` | TypeScript e Vite aprovados; aviso não fatal de chunks gerais acima de 500 kB |
| Análise estática pós-merge | `npm run lint` | exit code 0; nenhum aviso no escopo; 14 avisos preexistentes fora de chamadas |
| Integridade | `git diff --check`; busca por marcadores de conflito | aprovado; somente avisos locais LF/CRLF e nenhum marcador restante |

A primeira execução focada após o merge encontrou dois erros no chat efêmero porque `active_call_for` não havia sido mantido na lista de imports do router durante a resolução. O import foi restaurado e a suíte repetida passou 47/47; não permanece falha aberta. O `.venv` contém as dependências da aplicação e executa `unittest`, mas não inclui `pytest`; nenhuma instalação foi necessária porque a suíte do repositório usa `unittest`. Os logs detalhados dos gates ficaram em `norium-back-end/artifacts` e `norium-front-end/artifacts`, ambos ignorados pelo Git.

## Limite funcional de contexto, pré-entrada e reconexão

Esta etapa mantém o protocolo público e o backend inalterados. O limite frontend ficou assim:

```text
diálogo de membro / convite / chamada disponível
                    |
                    v
CallSession.commands.start|accept|join
                    |
                    +-- CallPrejoin (somente intenção e opções)
                    |       +-- microfone ligado/desligado/somente escuta
                    |       +-- dispositivo de microfone/câmera
                    |       +-- câmera e prévia opcionais
                    |
                    v
CallSession.commands.enter
                    |
                    v
useTeamCallRuntime (permissões, mídia, WebRTC e protocolo)
                    |
                    +-- active.thread ------------------+
                    +-- meetingMessages                 |
                                                       v
CallSession.snapshot.conversation ----------> TeamCallOverlay
                                               chat exclusivo da chamada
```

- `CallSession` passa a criar `snapshot.conversation` exclusivamente a partir da chamada ativa: `callId`, `active.thread`, participantes da chamada e mensagens efêmeras do runtime. O overlay não recebe nem consulta a conversa selecionada no drawer. O envio continua chamando `sendMeetingMessage`, que usa somente o `callId` ativo no endpoint `/calls/{callId}/messages`; assim trocar a seleção do drawer não pode redirecionar texto ou anexos da chamada.
- O clique de ligação no diálogo de membro entrega um `TeamCallThread` direto completo à sessão. A intenção fica em `entryTargetRef`, fora do snapshot público, até a confirmação na pré-entrada. O mesmo contexto é preservado ao entrar em uma chamada existente, inclusive quando o usuário atual é o anfitrião e `fromUserId` aponta para ele próprio.
- `CallPrejoin` é uma interface explícita da sessão. O overlay apresenta opções e dispositivos; apenas `commands.enter` inicia ou aceita a chamada. Falha de permissão retorna `false` do runtime, mantém a tela aberta e conserva os estados `microphonePermission`/`cameraPermission` para uma orientação acessível. Cancelar ou trocar para somente escuta interrompe qualquer prévia pendente e suas tracks.
- A aquisição de mídia é separada por intenção. Entrada com câmera desligada chama `getUserMedia` com `video: false`; modo somente escuta não chama `getUserMedia`; câmera só é solicitada ao ativar a opção e entrar ou ao pedir explicitamente a prévia. Entrada silenciada adquire apenas áudio e desabilita a track antes de publicar o convite/aceite.
- `CallSession` continua sendo a proprietária única do socket. Depois de uma queda, o próximo `CALLS_STATE` do servidor decide entre “chamada ainda ativa” e “chamada perdida”; o drawer não infere esse resultado localmente.
- O áudio de toque usa um único `AudioContext` reutilizável. A sessão tenta liberá-lo após a primeira interação de ponteiro ou teclado e também no gesto que abre a pré-entrada. Se o navegador ainda bloquear áudio, o convite mantém um alerta visual assertivo e o timer tenta novamente sem criar contexts, listeners ou timers duplicados.
- O listener de `pagehide` do runtime é montado uma única vez e lê a rotina de limpeza mais recente por referência. Isso evita que uma mudança de identidade do transporte execute a limpeza durante um render e impede registros duplicados.
- Pré-entrada e convite são diálogos com foco inicial, saída por `Escape`, nomes/descrições acessíveis e estados importantes em regiões `status`/`alert`. A pré-entrada também contém o foco por `Tab`; dentro da chamada há uma região persistente que anuncia microfone, câmera, compartilhamento e gravação.

### Componentes alterados nesta etapa

- `norium-front-end/src/components/team-chat/CallSession.tsx`: contexto direto da chamada, intenção de pré-entrada, comandos de entrada, preparação do áudio e reconciliação visual pós-reconexão.
- `norium-front-end/src/components/team-chat/useTeamCall.ts`: opções de entrada, aquisição seletiva, prévia, estados de permissão, áudio compatível com autoplay e listener único de desmontagem.
- `norium-front-end/src/components/team-chat/TeamCallOverlay.tsx`: pré-entrada acessível, fallback visual do toque, chat ligado a `snapshot.conversation` e indicadores persistentes.
- `norium-front-end/src/components/team-chat/teamCallTypes.ts`: adaptação dos comandos novos para a view existente.
- `CallSession.test.tsx`, `useTeamCall.test.tsx` e `TeamCallOverlay.test.tsx`: contexto direto/envio, dispositivo solicitado, entrada silenciada/somente escuta, falha de permissão, foco, autoplay e reconexão.

Riscos já registrados continuam válidos: TURN ainda depende de configuração externa e não existe um teste navegador-a-navegador no gate. As APIs de mídia reais também podem variar entre navegadores; por isso erro de permissão/dispositivo permanece observável na pré-entrada e o toque conserva fallback visual. Nenhum desses riscos exige ou autorizou alteração de deploy nesta etapa.

## Verificação após contexto direto e pré-entrada

Execução realizada em 2026-09-04 no mesmo worktree isolado, sobre o commit `4845f96`, sem deploy:

| Área | Comando | Resultado |
| --- | --- | --- |
| Frontend focado — sessão/chamada/overlay/socket | `npx vitest run src/components/team-chat/CallSession.test.tsx src/components/team-chat/useTeamCall.test.tsx src/components/team-chat/TeamCallOverlay.test.tsx src/hooks/useWebSockets.test.tsx --reporter=dot` | 4 arquivos e 40 testes aprovados |
| Frontend completo | `npm test -- --run` | 65 arquivos e 441 testes aprovados em 9,19 s |
| Backend completo, regressão | `.\.venv\Scripts\python.exe -m unittest discover -s tests -p "test_*.py"` | 449 testes aprovados em 21,518 s |
| TypeScript | `npx tsc -b --pretty false` | aprovado |
| Build de produção | `npm run build` | aprovado; 1.700 módulos transformados, build Vite em 1,25 s |
| Análise estática | `npm run lint` | exit code 0; nenhum aviso no escopo; os mesmos 14 avisos preexistentes fora de chamadas |

Os logs completos foram salvos em `norium-front-end/artifacts/team-call-ux-focused.log`, `team-call-ux-frontend-full.log`, `team-call-ux-production-build.log`, `team-call-ux-lint.log` e `norium-back-end/artifacts/team-call-ux-backend-full.log`; esses diretórios são ignorados pelo Git. As mensagens do backend são os mesmos cenários negativos intencionais já documentados. O build mantém o aviso preexistente de chunk geral acima de 500 kB. Não houve falha restante e nenhum fluxo de deploy foi executado.

## Conectividade STUN e TURN/TLS

### Novo limite arquitetural

```text
CallSession
    |
    +-- GET autenticado /calls/ice-servers -- renovação por refreshAfter
    |                                                |
    |                                                v
    |                                      TurnCredentialProvider
    |                                                |
    |                                      HmacTurnCredentialProvider
    |                                      (TURN REST/coturn compatível)
    |
    +-- credenciais somente em memória
    +-- snapshot público: disponibilidade/validade, sem usuário ou senha
    |
    v
useTeamCallRuntime
    +-- RTCPeerConnection({ iceServers, iceTransportPolicy })
    +-- renovação: setConfiguration -> restartIce -> negociação perfeita
    +-- telemetria: estado + categoria do caminho, sem IP/SDP/candidato
```

- `TurnCredentialProvider` é a seam de backend. O adapter inicial `HmacTurnCredentialProvider` implementa o formato TURN REST compatível com coturn: usuário efêmero com expiração Unix e credencial HMAC-SHA1 em Base64. O identificador de equipe/usuário não é enviado em claro; o sufixo é opaco.
- `GET /api/team-chat/calls/ice-servers` usa a autenticação já existente, exige permissão de equipe e conta ativa, associa a emissão a `teamId` + `userId` e devolve `iceServers`, `expiresAt` e `refreshAfter`. Respostas com credencial e respostas 503 têm `Cache-Control: no-store, private` e `Pragma: no-cache`. Diagnósticos internos do provedor não são repassados ao cliente.
- A validação roda em `create_app`, antes de construir a aplicação. Configuração parcial, URL com credencial embutida, ausência de `turns:`, segredo curto/com whitespace, TTL fora de 60–3600 segundos e margem inválida interrompem o startup. Quando TURN é opcional e todas as variáveis estão ausentes, o endpoint informa indisponibilidade de forma estável; com `TEAM_CALL_TURN_REQUIRED=true`, ausência também interrompe o startup.
- A `CallSession` é a única consumidora do endpoint. A credencial nunca aparece no snapshot ou em estado persistente. Falha inicial mantém STUN sem segredo; falha de renovação conserva a credencial ainda válida e marca estado degradado, depois volta a STUN quando expira. Renovação bem-sucedida atualiza também os peers de chamadas longas.
- O runtime coleta somente valores enumerados: estado ICE, tipos local/remoto e protocolo. O teste injeta endereço, porta, candidato e diagnóstico privado nos stats e prova que nenhum deles aparece em `iceTelemetry`. O overlay mostra aviso acessível quando TURN está degradado ou indisponível.
- `verify_turn_relay.py` inicializa fixture backend/frontend, abre dois contextos Chromium independentes, força `iceTransportPolicy: "relay"`, conecta duas `CallSession`s e consulta apenas as categorias do par ICE selecionado. O teste só aprova quando ambas as sessões possuem par real com candidato local `relay`; ausência de configuração termina com código 2 e estado `blocked`, não `skip` ou sucesso.

### Contrato de configuração do backend

| Variável | Regra/default |
| --- | --- |
| `TEAM_CALL_TURN_REQUIRED` | `false`; use `true` onde conectividade restrita é requisito operacional |
| `TEAM_CALL_STUN_URLS` | CSV; default Google + Cloudflare |
| `TEAM_CALL_TURN_URLS` | CSV `turn:`/`turns:` sem credenciais embutidas; ao menos uma URL `turns:` obrigatória quando configurado |
| `TEAM_CALL_TURN_SHARED_SECRET` | segredo TURN REST, mínimo 32 caracteres ASCII sem whitespace; somente runtime backend |
| `TEAM_CALL_TURN_TTL_SECONDS` | default 600; permitido 60–3600 |
| `TEAM_CALL_TURN_REFRESH_MARGIN_SECONDS` | default 120; mínimo 15 e menor que o TTL |

`norium-front-end/.env.example` não contém mais `VITE_TEAM_CALL_ICE_SERVERS`. `Dockerfile.azure` e o workflow não recebem segredo TURN em build args. O provisionamento futuro deve colocar as variáveis acima no secret manager/ambiente do backend; ele não foi executado nesta etapa.

### Componentes alterados nesta etapa

- `norium-back-end/app/modules/team/turn_credentials.py`: provider, adapter HMAC, documento efêmero, validação e modo indisponível.
- `norium-back-end/app/modules/team/router.py`: adapter HTTP autenticado e não-cacheável.
- `norium-back-end/app/bootstrap.py` e `norium-back-end/.env.example`: validação de startup e contrato de runtime.
- `norium-front-end/src/components/team-chat/CallSession.tsx`: aquisição, validade, renovação, fallback e transporte da configuração apenas em memória.
- `norium-front-end/src/components/team-chat/useTeamCall.ts`: configuração por injeção, atualização de peers, relay policy e telemetria sanitizada.
- `norium-front-end/src/components/team-chat/TeamCallOverlay.tsx`: tratamento acessível de serviço degradado/indisponível.
- Testes unitários correspondentes e `norium-front-end/tests/browser/verify_turn_relay.py`; `calls.tsx` ganhou somente o modo explícito `relay=1` para o harness.

### Verificação após TURN efêmero

Execução realizada em 2026-09-04 no mesmo worktree, depois de integrar `origin/main@131aebf`, sem deploy:

| Área | Comando | Resultado |
| --- | --- | --- |
| Backend TURN focal | `.\.venv\Scripts\python.exe -m unittest tests.unit.test_turn_credentials` | 8 testes aprovados; emissão, TLS, configuração inválida/ausente, falha de startup, autenticação/autorização, 503 e headers sem cache |
| Backend chamadas focado | `.\.venv\Scripts\python.exe -m unittest tests.unit.test_turn_credentials tests.unit.test_call_coordinator tests.unit.test_recording_coordinator tests.test_team_call_lifecycle tests.test_team_collaboration` | 66 testes aprovados em 0,855 s |
| Backend completo | `.\.venv\Scripts\python.exe -m unittest discover -s tests -p "test_*.py"` | 475 testes aprovados em 15,477 s |
| Frontend sessão/runtime/overlay/socket | `npx vitest run src/components/team-chat/CallSession.test.tsx src/components/team-chat/useTeamCall.test.tsx src/components/team-chat/TeamCallOverlay.test.tsx src/hooks/useWebSockets.test.tsx --reporter=dot` | 4 arquivos e 44 testes aprovados |
| Frontend completo | `npm test -- --run` | 70 arquivos e 464 testes aprovados em 8,83 s |
| TypeScript | `npx tsc -b --pretty false` | aprovado |
| Build de produção | `npm run build` | aprovado; build Vite em 1,19 s |
| Análise estática | `npm run lint` | exit code 0; 14 avisos preexistentes fora de chamadas |
| Sintaxe do harness | `.\.venv\Scripts\python.exe -m py_compile ..\norium-front-end\tests\browser\verify_turn_relay.py tests\team_call_browser_app.py` | aprovado |
| Relay-only real | `.\.venv\Scripts\python.exe ..\norium-front-end\tests\browser\verify_turn_relay.py` | código 2, `blocked: external_turn_not_configured`; faltam `TEAM_CALL_TURN_URLS` e `TEAM_CALL_TURN_SHARED_SECRET` para infraestrutura real |

O único bloqueio restante para comprovar relay-only navegador-a-navegador é infraestrutura externa TURN/TLS acessível. Adapter, endpoint, renovação, telemetria, fixture e assertiva do par real estão implementados; o gate não foi falsificado. Os logs completos dos gates ficam em `norium-back-end/artifacts/team-call-turn-backend-full.log` e `norium-front-end/artifacts/team-call-turn-*.log`, ignorados pelo Git. Permanecem apenas avisos preexistentes: cenários negativos intencionais no backend, 14 avisos de lint fora do escopo e chunk geral acima de 500 kB no build. Nenhum deploy foi executado.

## Etapa 8A — limite mesh, fronteira de mídia e avaliação de SFU

Esta etapa prepara coexistência técnica e uma decisão informada, sem habilitar SFU no produto. O ADR permanece proposto e a implementação de produção da etapa 8B está bloqueada até escolha explícita do responsável.

### Limite determinístico do mesh

- `TEAM_CALL_MESH_MAX_PARTICIPANTS` define a capacidade por chamada mesh. A validação ocorre na inicialização e aceita somente inteiro maior ou igual a 2.
- O default conservador é **6**. Esse número foi escolhido durante a implementação porque a quantidade no pedido original chegou truncada; não é um limite público aprovado e precisa ser confirmado pelo responsável.
- O `CallCoordinator` verifica capacidade dentro do lock por equipe. A tentativa excedente recebe status `409`, código estável `call_capacity_reached` e mensagem útil com o limite; a recusa ocorre antes de admitir o participante ou encaminhar sinalização aos peers.
- Vagas contam participantes com sessão, não abas. Reentrada ou segunda aba do mesmo participante não consome vaga adicional; uma sessão desconectada dentro da tolerância de 8 segundos ainda ocupa a sua. `leave` idempotente libera a vaga exatamente uma vez.
- A chamada armazena `maxParticipants` e `mediaTransport`. O servidor preserva a seleção e ignora tentativas do cliente de sobrescrevê-la; chamadas legadas ou valor inválido usam `mesh`.
- O frontend mostra a falha de capacidade como alerta acessível e descartável. A recusa é atômica no servidor, porém a implementação atual captura mídia local antes do ACK de `CALL_ACCEPT` e só então limpa as tracks ao receber o erro. Portanto esta etapa **não** implementa nem afirma um preflight sem captura.

### Novo limite profundo de `MediaTransport`

```text
CallSession (uma por aplicação autenticada)
    +-- socket global / ciclo de chamada / reconexão
    +-- dispositivos e captura local
    +-- chat direto / gravação / toque / consentimento
    |
    +-- valor mediaTransport armazenado na chamada pelo servidor
            |
            v
      MediaTransportFactory
            |
            +-- MeshMediaTransport (produção durante a coexistência)
            |       +-- peers e negociação perfeita
            |       +-- publicação/recepção de tracks
            |       +-- streams remotos e ICE sanitizado
            |
            +-- LiveKitMediaTransport (somente protótipo descartável nesta etapa)
```

`MediaTransport` não envolve ou replica o contrato inteiro de `useTeamCallRuntime`. É uma porta estreita por chamada: `open` e `close` assíncronos, eventos de participante/sinal, atualização de mídia/ICE/perfil de tela e snapshot/assinatura. O snapshot contém somente estado/falha normalizados, streams remotos, qualidade de conexão e telemetria ICE sanitizada. Socket global, chat, gravação, toque, dispositivos e captura continuam sob `CallSession`.

`MeshMediaTransport` possui os peers, senders, candidatos pendentes, estado de negociação perfeita, streams remotos, recuperação, telemetria ICE e limpeza determinística que antes estavam concentrados no hook. Eventos de mídia carregam `clientId`: quando outra aba assume o mesmo participante, sinais e saídas atrasados da conexão anterior são descartados. A fábrica é resolvida pelo valor imutável da chamada; cada chamada recebe uma instância nova, fechada idempotentemente. O runtime solta suas referências antes do fechamento e continua a limpeza de tracks locais mesmo se o adapter falhar. Assim uma chamada mesh pode ser seguida por uma futura chamada SFU no mesmo provider/socket, mas uma chamada ativa nunca troca de transporte no meio da sessão. Um adapter indisponível falha de forma explícita, sem fallback silencioso.

Componentes alterados para essa fronteira:

- `norium-front-end/src/components/team-chat/media/MediaTransport.ts`: tipos, contrato profundo e resolução da fábrica.
- `norium-front-end/src/components/team-chat/media/MeshMediaTransport.ts`: implementação mesh extraída.
- `norium-front-end/src/components/team-chat/useTeamCall.ts`: conserva ciclo/captura/gravação e delega somente o motor de mídia.
- `norium-front-end/src/components/team-chat/CallSession.tsx`: fornece as fábricas e apresenta a capacidade/seleção originada pelo servidor.
- `norium-back-end/app/modules/team/call_configuration.py`, `call_coordinator.py`, `router.py`, `app/bootstrap.py` e `.env.example`: configuração, admissão atômica, persistência e erro estável.
- Testes de `MediaTransport`, `CallSession`, runtime, coordenador, configuração e WebSocket: instância por chamada, seleção server-side, sinalização/limpeza e corridas de capacidade.

### Pesquisa, ADR e recomendação

- A comparação factual de LiveKit Cloud/self-hosted, Cloudflare Realtime SFU, mediasoup v3 e Daily usa documentação oficial e está em `docs/research/team-call-sfu-options.md`.
- O ADR proposto, com hospedagem, autenticação, regiões/latência, gravação, screen share, observabilidade, custo, privacidade, lock-in e encaixe na arquitetura atual, está em `docs/adr/0002-team-call-sfu.md`.
- A recomendação é **LiveKit Cloud atrás de `MediaTransport`**, com LiveKit self-hosted como escape arquitetural. Cloudflare Realtime SFU é a alternativa se custo por tráfego e controle do WebRTC bruto dominarem e a equipe aceitar construir gravação e QoE. A recomendação não constitui contratação nem autorização de rollout.

### Protótipo descartável e medições

O protótipo está isolado na branch `codex/team-call-sfu-prototype`, commit `1a1c23c9a8a25213fa47a888cfd43822d30351fc`, em `prototypes/team-call-livekit-sfu`. Ele é reproduzido, nesse diretório, por:

```powershell
npm run prototype
```

A execução real usou LiveKit self-hosted v1.13.6 em loopback, `livekit-client` 2.22.2, Chrome headless, áudio sintético e vídeo 320×180 a 10 fps sem simulcast. Cada participante tinha token, contexto de navegador, página e sessão próprios; cada degrau ficou 20 segundos sob carga.

| Participantes | Conexão p50 | Primeira mídia remota p50 | CPU SFU (100% = 1 core) | Pico RAM SFU | Upload médio/cliente | Resultado |
| ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 2 | 634 ms | 941 ms | 2,9% | 95,6 MiB | 244,9 Kbit/s | estável |
| 4 | 190 ms | 427 ms | 5,8% | 124,5 MiB | 244,9 Kbit/s | estável |
| 6 | 196 ms | 478 ms | 8,9% | 171,3 MiB | 248,9 Kbit/s | estável |

Todos os participantes permaneceram conectados, receberam as tracks esperadas e produziram upload; não houve erro de página, falha de estado/conexão, desconexão inesperada nem participante com upload zero. Em duas sessões, uma track sintética `screen_share` foi recebida em 96 ms e removida no receptor em 42 ms. O endpoint de token temporário recusou credencial ausente com `401` e associação divergente entre equipe, chamada, participante e cliente com `403`.

O resultado confirma que, com SFU, o uplink não se multiplica pela quantidade de peers remotos. Isso não significa literalmente um único fluxo: microfone, câmera, tela e simulcast podem produzir várias tracks/camadas.

Limitações objetivas: servidor e navegadores rodaram na mesma máquina; loopback remove RTT, perda, jitter, NAT, TURN e distância regional. BrowserContexts e sessões eram independentes, mas compartilhavam o processo Chrome headless. CPU do renderer veio de `Performance.TaskDuration` e memória do cliente mede heap JavaScript, não o working set do Chrome. A mídia sintética é pequena e uniforme, e o primeiro degrau inclui aquecimento. Não foram comprovados LiveKit Cloud, edge brasileiro, SLA, residência, custo real, TURN/TLS, autoscaling, gravação/Egress, renovação longa, reconexão ou revogação durante mídia. O bloqueio externo do gate relay-only TURN continua registrado na seção anterior e não foi mascarado pelo protótipo local.

### Verificação da etapa 8A

Execução em 2026-09-05, no worktree isolado, sem deploy:

| Área | Comando | Resultado |
| --- | --- | --- |
| Backend focado — coordenador/configuração/WebSocket | `.\.venv\Scripts\python.exe -m unittest tests.unit.test_call_coordinator tests.unit.test_team_call_configuration tests.test_team_call_lifecycle -q` | 40 testes aprovados em 0,574 s (`OK`) |
| Backend completo | `.\.venv\Scripts\python.exe -m unittest discover -s tests -q` | 515 testes aprovados em 26,902 s (`OK`) |
| Frontend focado — runtime/sessão/transporte | `npm test -- --run src/components/team-chat/useTeamCall.test.tsx src/components/team-chat/CallSession.test.tsx src/components/team-chat/media/MediaTransport.test.ts` | 3 arquivos e 41 testes aprovados |
| Frontend completo | `npm test` | 76 arquivos e 502 testes aprovados |
| Build de produção | `npm run build` | aprovado; apenas o aviso preexistente de chunk geral acima de 500 kB |
| Análise estática | `npm run lint` | aprovado; 13 avisos preexistentes fora de chamadas |
| Protótipo local | `npm run prototype` na branch/commit descartável acima | matriz 2/4/6, autenticação negativa e screen share aprovadas; resultados reproduzíveis e limitações registradas |

A tabela registra a repetição final depois de integrar todo o código da aplicação de `origin/main@18df659`; o avanço seguinte até `25e395c` alterou somente o `Dockerfile.azure` e foi integrado depois dos gates, sem afetar seus insumos. Os únicos avisos permanecem os cenários negativos intencionais do backend, um aviso de depreciação do `pypdf`, os 13 avisos de lint fora do escopo e o aviso de tamanho de chunk do Vite. Nenhum teste falhou ao final e nenhum comando de deploy foi executado.

### Riscos confirmados e componentes condicionados à 8B

Além dos riscos históricos acima, permanecem confirmados:

1. O default 6 é provisório e precisa de decisão de produto; não deve ser elevado com base apenas no benchmark SFU local.
2. O servidor recusa capacidade antes da admissão, mas o cliente captura mídia antes do ACK. Um preflight futuro precisa evitar captura desnecessária sem criar reserva fantasma ou corrida de vagas.
3. Estado de negócio no NOrium e estado de mídia no provedor serão dois planos de controle. Webhooks atrasados, duplicados ou fora de ordem não podem ressuscitar chamada ou participante.
4. O protótipo self-hosted local não prova o serviço Cloud, região, rede restritiva, disponibilidade, residência, preço ou operação. TURN externo continua sendo bloqueio separado.
5. E2EE entra em tensão com gravação/Egress: um gravador que interpreta a mídia precisa receber chaves ou a política deve escolher outro fluxo, sempre preservando consentimento, quotas, auditoria e retenção.
6. A saída self-hosted compartilha SDK/protocolo, mas exige Redis, TURN/TLS, balanceamento, Egress, observabilidade, upgrades e plantão; não é fallback operacional gratuito.
7. O host hoje cria a chamada de negócio ao publicar `CALL_INVITE`. Um adapter SFU de produção que precise de token antes de abrir mídia exigirá, na 8B, reserva/autorização idempotente anterior ao ingresso; o protótipo não resolve essa ordem e nenhum `LiveKitMediaTransport` foi ligado ao produto nesta etapa.

Se — e somente se — o responsável aceitar o ADR, a etapa 8B poderá alterar:

- provider backend de JWT curto, escolha de região e reconciliação idempotente de webhooks;
- política server-side que seleciona `sfu` para chamadas novas/coorte interna;
- `LiveKitMediaTransport` de produção, mantendo tipos do SDK dentro do adapter;
- revogação, reconexão, múltiplas abas, indisponibilidade e rotação/renovação de token no plano SFU;
- telemetria sanitizada e SLOs em região/redes reais;
- adapter de Egress somente após decisão de E2EE, consentimento, custódia, retenção e custo;
- rollout e rollback apenas de chamadas novas, nunca migração de transporte no meio de uma chamada.

**Decisão:** o responsável aprovou o ADR em 2026-09-05. A etapa 8B pode avançar de forma incremental, mantendo configuração desabilitada por padrão. A aprovação não autoriza provisionar LiveKit Cloud, inserir segredo de produção, alterar o transporte padrão para todos, contratar serviço, migrar gravação ou fazer deploy.

## Etapa 8B.1 — integração LiveKit dormente

Esta fatia implementa o primeiro passo reversível autorizado pelo ADR. Ela adiciona o contrato de admissão, o emissor de credenciais efêmeras e o adapter de mídia de produção, mas mantém todas as chamadas reais em `mesh`. Não houve provisionamento, segredo real, seleção de coorte, migração de gravação ou deploy.

### Limite arquitetural implementado

```text
CALL_INVITE / CALL_ACCEPT
        |
        v
CallCoordinator — autoridade de chamada, participante, cliente e capacidade
        |
        +-- CALL_ACK { mediaTransport, joinedCount, maxParticipants }
        |                                      |
        |                                      v
        |                              CallSession / MediaTransport
        |                                  |              |
        |                                  |              +-- LiveKitMediaTransport
        |                                  +-- MeshMediaTransport       (default)
        |
        +-- media_context(callId, clientId, transport="sfu")
                         |
                         v
POST /calls/{callId}/media-token
        |
        v
SfuTokenProvider -> LiveKitTokenProvider -> URL WSS + JWT curto
```

- O servidor admite a operação antes de abrir o transporte ou pedir token ao provedor. O ACK é autoritativo e carrega o transporte e a capacidade persistidos na chamada. Timeout ou falha depois da admissão provoca compensação idempotente com `CALL_END` para o anfitrião ou `CALL_LEAVE` para o participante.
- `CallCoordinator.media_context` revalida equipe ativa, participante ativo, cliente exato e transporte esperado. Cada aba recebe um `mediaSessionId` opaco próprio; repetição da mesma admissão pelo mesmo cliente conserva o identificador, enquanto outra aba o substitui. Eventos antigos não podem obter token para a sessão nova.
- `POST /api/team-chat/calls/{callId}/media-token` exige a autenticação existente e o `clientId` admitido. Sucesso e erro de domínio usam `Cache-Control: no-store`; o provedor nunca é chamado para cliente obsoleto ou chamada não-SFU.
- `LiveKitTokenProvider` aceita apenas URL `wss:`, chave/segredo válidos e TTL entre 60 e 600 segundos. O JWT usa identidade derivada e opaca, restringe ingresso à sala da chamada e concede somente publicação de microfone, câmera, tela/áudio de tela e assinatura; não há grants administrativos nem segredo no frontend.
- `LiveKitMediaTransport` é o único arquivo da aplicação que importa `livekit-client`. Ele conecta após o token efêmero, publica somente tracks já capturadas pela `CallSession`, normaliza participantes pela metadata mínima `userId`, expõe reconexão/encerramento pelo contrato comum e não registra token, SDP, candidato ou IP.
- Fechar a sessão invalida a geração da abertura, aborta a requisição de token e desconecta uma sala que tenha concluído tardiamente. Para duas abas do mesmo usuário, a identidade mais nova substitui a antiga e uma desconexão atrasada não remove a mídia vigente.

### Contrato de configuração

| Variável | Regra/default |
| --- | --- |
| `TEAM_CALL_SFU_ENABLED` | `false`; apenas habilita a emissão configurada de tokens, não seleciona chamadas SFU |
| `TEAM_CALL_LIVEKIT_URL` | URL `wss:` do serviço; vazia quando desabilitado |
| `TEAM_CALL_LIVEKIT_API_KEY` | chave somente do backend; vazia quando desabilitado |
| `TEAM_CALL_LIVEKIT_API_SECRET` | segredo ASCII de pelo menos 32 caracteres, somente no runtime backend |
| `TEAM_CALL_SFU_TOKEN_TTL_SECONDS` | default 300; permitido 60–600 |

A validação ocorre em `create_app`. Configuração parcial ou insegura interrompe o startup quando o recurso é habilitado. O bundle contém apenas o SDK cliente; nenhuma chave permanente ou variável LiveKit é exposta por `VITE_*`.

### Componentes alterados nesta fatia

- `norium-back-end/app/modules/team/sfu_tokens.py`: porta do provedor, adapter LiveKit, JWT curto, grants mínimos e validação.
- `norium-back-end/app/modules/team/call_coordinator.py`: transporte/capacidade autoritativos no ACK e autorização ligada à sessão de mídia.
- `norium-back-end/app/modules/team/router.py`: endpoint fino, autenticação, resposta não-cacheável e composição do provider; a seleção SFU não está ligada.
- `norium-back-end/app/bootstrap.py` e `.env.example`: validação e contrato de configuração. A integração de `origin/main@3130c7f` preservou também o lifespan de e-mail e a manutenção periódica de gravações.
- `norium-front-end/src/components/team-chat/media/LiveKitMediaTransport.ts`: adapter e cliente HTTP estreitos, cancelamento e limpeza determinística.
- `MediaTransport.ts`, `CallSession.tsx` e `useTeamCall.ts`: registro dormente da fábrica e protocolo ACK-antes-de-transporte com compensação.
- Testes unitários correspondentes no backend e frontend.

### Bloqueio objetivo antes de ativar uma coorte

O `router` constrói o `CallCoordinator` sem `media_transport_for_team`; portanto o default continua `mesh`, mesmo com `TEAM_CALL_SFU_ENABLED=true`. Isso é intencional. Ainda não existe um plano administrativo que execute `RemoveParticipant`/encerramento de sala no LiveKit nem reconciliação de webhooks assinados, deduplicados e fora de ordem. Um JWT já emitido não é revogado apenas pela expiração ou pela recusa de reemissão.

Assim, esta fatia não afirma chamada Cloud, relay-only SFU, revogação imediata no provedor nem rollout. O único próximo marco é implementar uma porta de controle de mídia com remoção/encerramento server-side e webhooks verificados/deduplicados; somente depois disso uma coorte interna poderá selecionar `sfu`. Egress continua fora desse próximo marco.

### Verificação da etapa 8B.1

Execução em 2026-09-05, no worktree isolado e depois de integrar `origin/main@3130c7f`, sem deploy:

| Área | Comando | Resultado |
| --- | --- | --- |
| Backend focado — token/coordenador/configuração/ciclo | `.\.venv\Scripts\python.exe -m unittest tests.unit.test_sfu_tokens tests.unit.test_call_coordinator tests.unit.test_team_call_configuration tests.test_team_call_lifecycle -q` | 52 testes aprovados em 0,608 s |
| Integração do merge — e-mail | `.\.venv\Scripts\python.exe -m unittest tests.unit.test_system_email -q` | 18 testes aprovados em 1,188 s |
| Integração do merge — gravação | teste isolado `test_recording_is_uploaded_in_chunks_and_expires_after_24_hours` | aprovado; finalização pelo coordenador, notificação e retenção preservadas |
| Backend completo | `.\.venv\Scripts\python.exe -m unittest discover -s tests -q` | 545 testes aprovados em 27,018 s |
| Frontend focado final — adapters | `npm test -- --run src/components/team-chat/media/LiveKitMediaTransport.test.ts src/components/team-chat/media/MediaTransport.test.ts` | 2 arquivos e 16 testes aprovados |
| Frontend completo final | `npm test -- --run` | 79 arquivos e 523 testes aprovados em 9,72 s |
| Build de produção | `npm run build` | aprovado; TypeScript e Vite, 1.726 módulos transformados e build Vite em 1,37 s |
| Análise estática | `npm run lint` | exit code 0; 13 avisos preexistentes fora de chamadas |

A primeira tentativa do build detectou propriedades TypeScript declaradas no construtor, incompatíveis com `erasableSyntaxOnly`, e um fixture legado sem `clientId`. Ambos foram corrigidos mecanicamente; os 16 testes diretamente afetados, o build, o lint e a suíte frontend completa foram repetidos sobre o estado final e passaram. Permanece apenas o aviso preexistente de chunk geral acima de 500 kB. As mensagens do backend no log são cenários negativos intencionais dos testes, não falhas.

Logs completos: `norium-back-end/artifacts/team-call-8b-backend-full.log`, `norium-front-end/artifacts/team-call-8b-frontend-full.log`, `norium-front-end/artifacts/team-call-8b-production-build.log` e `norium-front-end/artifacts/team-call-8b-lint.log`; os diretórios de artefatos são ignorados pelo Git.

## Etapa 9 — mídia, sinalização e carga automatizadas

A validação manual foi substituída por gates reproduzíveis de navegador e carga. A especificação completa, matriz, comandos, thresholds e medições está em `docs/testing/team-call-quality-gates.md`.

### Limite arquitetural do teste

- `tests/browser/team_call_e2e.py` orquestra FastAPI, Vite, TURN local e Chromium em portas livres. Cada usuário recebe um `BrowserContext` independente; múltiplas abas compartilham contexto somente no cenário que exige isso.
- `tests/browser/calls.tsx` monta `CallSessionProvider`, overlay e drawer reais. Microfone/câmera usam `getUserMedia` nativo com WAV/Y4M determinísticos; apenas o seletor de tela headless é sintetizado, e a faixa resultante precisa atravessar RTP real.
- `tests/team_call_browser_app.py` adapta autenticação, diretório e disco para estado temporário, mas inclui o router, `CallCoordinator` e `RecordingCoordinator` de produção. Os endpoints `__test__` controlam reset/revogação/limites e nunca entram na aplicação publicada.
- `tests/team_call_load.py` abre 100 WebSockets reais, mede handshake, controle, sinal, heartbeat, estado, convergência, remoção de fantasmas e RSS.
- `tests/browser/local_turn_server.mjs` fornece TURN REST/HMAC efêmero para o gate `iceTransportPolicy: "relay"`; nenhuma credencial permanente entra no frontend.

Durante a repetição, o screen share revelou uma colisão entre duas operações SDP que podiam entrar em `setLocalDescription` simultaneamente. `MeshMediaTransport` agora serializa operações SDP por peer, preservando os papéis polite/impolite, rollback e revisão da sessão. O contrato público não mudou; o cenário de oferta simultânea, screen share e o teste unitário do transporte passaram depois da correção.

A integração de `origin/main@87f715e` trouxe uma nova lista de conversas e uma versão do drawer que voltava a abrir WebSocket próprio e ouvir `CustomEvent` do DOM. A resolução preserva a interface nova, mas encaminha chat, presença e atualização de threads pelo `useTeamSocketEvents` da `CallSession`; não há segundo socket nem restauração do canal DOM. Convites selecionam a conversa pelo mesmo adaptador e ligações iniciadas pela lista de membros fixam explicitamente o contexto direto.

### Linha de base final

Execução em 2026-09-06, no worktree `codex/team-call-remediation-baseline`, sem deploy. Commits remotos foram integrados até `origin/main@12e5ff3`; `origin/main` é ancestral do resultado (`ahead 20, behind 0`). O avanço até `87f715e` tocou router e interface de chat/chamada e foi incluído antes dos gates reais. O commit posterior `12e5ff3` alterou somente automações e tarefas; frontend e build foram repetidos sobre essa base final.

| Área | Comando | Resultado |
| --- | --- | --- |
| Navegador real | `.\norium-back-end\.venv\Scripts\python.exe norium-front-end\tests\browser\team_call_e2e.py --repeat 3 --artifacts-dir output\team-call-quality\browser-87f715e-final-2` | 39/39 aprovados em 237,429 s; 13 cenários × 3; relay/relay UDP, RTP e crash real comprovados; sem artefatos de falha |
| Carga | `.\norium-back-end\.venv\Scripts\python.exe norium-back-end\tests\team_call_load.py --repeat 3 --artifacts-dir output\team-call-quality\load-87f715e-final` | 3/3; 100/100 conexões; zero violações; remoção fantasma máxima 8,164 s; RSS pico 118,926 MiB |
| Backend completo | `.\.venv\Scripts\python.exe -m unittest discover -s tests -p 'test*.py'` | 552/552 aprovados em 26,339 s |
| Frontend completo | `npm test -- --run --reporter=dot` | 84 arquivos e 552/552 testes aprovados em 11,17 s |
| Chamadas focadas | `npm test -- --run src/components/team-chat/CallSession.test.tsx src/components/team-chat/useTeamCall.test.tsx src/components/team-chat/TeamCallOverlay.test.tsx src/components/team-chat/TeamActiveCallCard.test.tsx src/components/team-chat/TeamChatDrawer.test.tsx src/components/team-chat/media/MediaTransport.test.ts src/hooks/useWebSockets.test.tsx --reporter=dot` | 7 arquivos e 64/64 testes aprovados |
| Build de produção | `npm run build` | aprovado; TypeScript + Vite, 1.744 módulos |
| Análise estática | `npm run lint` | código 0; 13 avisos preexistentes fora de chamadas |
| Sintaxe | `py_compile` dos runners e `node --check` do TURN | aprovado |

O CI ganhou o job bloqueante `team-call-quality`; a publicação de imagem depende dele. Traces, screenshots, logs e vídeos são copiados/enviados somente em falha, sob `failures/<runId>/`. O resumo passa atomicamente de `running` ao resultado final apenas depois de fechar contextos, navegador, serviços e workspace temporário. O CI instala Chromium/FFmpeg e grava WebM; neste host, o fallback para Chrome do sistema registrou `videoCaptureEnabled: false` porque o encoder opcional do Playwright falhou com `spawn EPERM`, mantendo traces/screenshots/logs e isolamento integral.

### Riscos e bloqueios restantes

1. O gate relay-only prova TURN UDP local, não TURN/TLS externo, NAT corporativo, CGNAT, perda ou latência regional. A execução externa continua dependente de infraestrutura e certificado reais e deve usar `--external-turn`.
2. `turn-server@0.6.6` é dependência de teste pré-1.0, fixada exatamente e fora do bundle de produção.
3. Os thresholds são guardrails deste perfil de 100 conexões, não SLOs de produção. O p95 de heartbeat foi calibrado de 400 para 750 ms após uma falha reproduzível de 513,328 ms; novos relaxamentos exigem justificativa registrada.
4. O domínio atual não expõe uma flag autônoma de equipe desativada. O cenário desativa todos os membros e declara essa modelagem no resultado.
5. O workflow foi validado localmente, mas não executado no GitHub nesta etapa. Nenhuma imagem foi publicada e nenhum deploy foi realizado.
6. Uma suíte completa anterior falhou uma vez em `WhatsAppStatusView.test.tsx`, fora do escopo, ao não observar imediatamente um estado assíncrono de erro de mídia. O caso passou isolado e todas as suítes completas seguintes passaram sem mudança no módulo; fica registrado como flake preexistente.
7. A primeira tentativa do navegador após a nova lista de conversas usava o seletor removido, e outra tentativa encontrou uma asserção interna do Playwright ao deixar `Page.crash` pendente. O harness passou a usar o botão acessível atual e `chrome://crash`; o cenário crítico passou 3/3 isoladamente antes da matriz final 39/39.

Componentes desta etapa: workflow de CI, ignores de artefatos, fixture FastAPI, runner de carga, fixture React, runner de navegador, TURN local, dependência de teste bloqueada, serialização SDP do mesh, fechamento WebSocket idempotente após revogação e esta documentação. Não foram alterados contratos HTTP/WebSocket públicos.
