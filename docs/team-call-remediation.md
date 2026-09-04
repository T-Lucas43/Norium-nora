# Linha de base para correção das chamadas de equipe

## Escopo e referência Git

Este documento descreve a implementação existente sem alterar o comportamento do produto e sem executar deploy.

- Worktree: `C:\NOrium\deploy-worktrees\team-call-remediation-baseline`.
- Branch isolada: `codex/team-call-remediation-baseline`.
- Base inicialmente preparada: `fe6967620700c92132253b1e4136dfda8b3fd418`.
- Base sincronizada de `origin/main` em 2026-09-04: `fb671c3` (`feat: completar experiencia de reunioes e corrigir layout do chat`). A atualização também incorporou `4b4b974` (`feat: melhorar audio e controles individuais das chamadas`).
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
- `VITE_TEAM_CALL_ICE_SERVERS` aceita JSON de `RTCIceServer[]`. Sem valor válido, o bundle usa somente STUN público do Google e Cloudflare (`norium-front-end/src/components/team-chat/useTeamCall.ts:145-159`, `norium-front-end/.env.example:6-8`).
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

## Fluxo de deploy atual

O fluxo principal versionado é Azure Container Apps:

1. Em push/PR para `main`, o job `validate` usa Python 3.14 e Node 24, executa toda a suíte backend, lint/test/build frontend e verificações de dependências (`.github/workflows/azure-container-apps.yml:3-80`).
2. Fora de PR, o workflow cria uma imagem imutável e `latest` no GHCR usando `Dockerfile.azure` (`.github/workflows/azure-container-apps.yml:82-120`).
3. `Dockerfile.azure` compila o React, copia o `dist` para a imagem FastAPI, instala o Chromium e serve SPA/API/WebSocket no mesmo domínio (`Dockerfile.azure:1-49`).
4. O job de deploy autentica na Azure via OIDC, atualiza a imagem imutável e força uma única réplica (`min-replicas=1`, `max-replicas=1`), depois verifica imagem, `/health` e `/health/browser` (`.github/workflows/azure-container-apps.yml:122-223`).
5. O volume Azure Files é montado em `/app/data`, onde ficam JSON e gravações (`infra/azure/main.bicep:129-162`, `:194-195`).
6. O deploy inicial/manual `infra/azure/deploy.ps1` também executa `infra/azure/smoke_test.py`, que autentica, obtém ticket e valida `CONNECTED`/`ACK` do WebSocket (`infra/azure/deploy.ps1:262-276`, `infra/azure/smoke_test.py:24-73`). Não executar esse fluxo durante esta remediação.

Railway mantém frontend e backend em serviços separados e exige volume persistente no backend (`DEPLOY_RAILWAY.md:8-74`). Vercel é documentado apenas com armazenamento temporário e WebSockets/JSON em memória, inadequados para produção sem migração para banco, object storage e pub/sub (`DEPLOY_VERCEL.md:54-65`).

## Riscos já confirmados

1. **TURN não faz parte do artefato Azure atual.** O fallback do código contém apenas STUN, e o próprio `.env.example` registra que redes corporativas restritas exigem TURN. O build da imagem não declara `ARG`/`ENV` para `VITE_TEAM_CALL_ICE_SERVERS`, e o workflow não passa build arg; assim o bundle Azure produzido pelo fluxo versionado fica no fallback STUN (`useTeamCall.ts:145-159`, `.env.example:6-8`, `Dockerfile.azure:1-7`, workflow `:108-118`).
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
- `norium-front-end/.env.example`, `Dockerfile.azure` e `.github/workflows/azure-container-apps.yml` para injetar e validar configuração TURN no build, caso essa seja a remediação aprovada.
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
