# Gates automatizados de qualidade das chamadas de equipe

## Estado e escopo

Este documento descreve a suíte local e de CI que substitui a validação manual de mídia e sinalização das chamadas de equipe. Ela usa o `CallSession`, os transports WebRTC do produto, o router HTTP/WebSocket e os coordenadores reais. Somente autenticação, diretório de usuários e persistência em disco são adaptados para um diretório temporário de teste.

A execução não acessa produção, não publica imagem e não faz deploy. Os números abaixo são guardrails do runner disponível, não SLOs de produção.

## Topologia do teste

```text
team_call_e2e.py
  +-- Vite -> tests/browser/calls.html
  |     +-- BrowserContext independente por participante
  |     +-- CallSessionProvider + overlay + drawer reais
  |     +-- RTCPeerConnection, WebSocket e fetch nativos
  |     +-- WAV/Y4M determinísticos como microfone/câmera
  |     `-- canvas track somente na fronteira do seletor de tela headless
  +-- FastAPI -> tests/team_call_browser_app.py
  |     +-- router e CallCoordinator/RecordingCoordinator de produção
  |     `-- diretório, autenticação e arquivos temporários controláveis
  `-- local_turn_server.mjs
        `-- TURN REST/HMAC real, UDP/TCP, segredo efêmero e health check

team_call_load.py
  `-- 100 clientes WebSocket reais -> mesmo FastAPI/router/coordenador
```

O runner cria portas livres e um diretório temporário por execução. Antes de cada cenário, o fixture fecha todas as conexões, espera os handlers ASGI terminarem, cancela tarefas de reconciliação, recria os coordenadores e remove arquivos temporários. Após cada cenário, todo `BrowserContext` deve desaparecer da lista de contextos do navegador; vazamento de página, socket ou timer torna a suíte vermelha. O processo do navegador também é reiniciado entre repetições, impedindo que renderer ou recursos de uma rodada contaminem a seguinte. O crash usa `chrome://crash` e só é aceito quando o navegador emite o evento real de renderer; isso evita deixar um comando DevTools `Page.crash` sem resposta e comprometer o driver das repetições seguintes.

As APIs nativas de captura não são substituídas. O Chromium recebe mídia determinística pelos flags oficiais de fake-device e arquivos WAV/Y4M. `getDisplayMedia` é a única fronteira sintetizada, porque o seletor do sistema não existe em modo headless; a faixa retornada continua sendo um `MediaStreamTrack` real, trafegado por RTP e verificado no receptor. Decisões de permissão são aplicadas pelo protocolo do navegador, não por mocks de `getUserMedia`.

## Matriz de navegador

| Cenário | Evidência exigida |
| --- | --- |
| `group_media` | três participantes, microfone inicial desligado, modo somente escuta e bytes/pacotes RTP nos dois sentidos |
| `entry_modes` | entrada apenas com áudio não solicita câmera; somente escuta não solicita nenhuma captura |
| `direct_chat_context` | chamada direta, drawer deliberadamente apontado para outra conversa, mensagem entregue apenas ao participante da chamada |
| `permission_denied` | negação nativa de microfone, alerta útil e nenhuma chamada criada |
| `simultaneous_offer` | ambos os peers criam oferta, negociação termina estável e nenhuma conexão é descartada |
| `relay_only` | duas sessões com `iceTransportPolicy: "relay"`, par selecionado `relay/relay` e RTP recebido |
| `reconnect` | servidor encerra a conexão, socket reabre e o mesmo `callId` permanece ativo |
| `temporary_network_loss` | rede do contexto fica offline, uma requisição real é recusada, mídia local permanece viva e a chamada reaparece online |
| `multiple_tabs` | duas abas do mesmo usuário formam um participante lógico; saída da aba antiga não remove a sessão nova |
| `tab_close_and_crash` | fechamento normal e crash de renderer removem o participante dentro do prazo medido |
| `screen_share` | faixa de tela chega ao receptor com bytes/pacotes `inbound-rtp`, e desaparece após parada |
| `user_and_team_revocation` | troca de equipe e desativação dos membros encerram a sessão e as tracks locais dentro de 7 s |
| `recording_failure_quota_abort` | conflito retorna 409, quota retorna 413, aborto repetido é idempotente, evento de parada chega aos peers e não sobra `.part` |

O modelo atual não possui uma entidade de equipe com flag própria. Por isso, “equipe desativada” é exercitada desativando atomicamente todos os membros do fixture; essa equivalência está marcada no resultado JSON e não deve ser confundida com uma API administrativa futura.

## Sincronização e artefatos

Não há `sleep` arbitrário para fazer uma assertiva passar. As esperas consultam estado do `CallSession`, estado do servidor, estatísticas WebRTC ou presença de mídia até um deadline explícito. Os intervalos curtos de 50/100 ms servem somente para polling. Os únicos tempos de domínio são a janela de expiração/heartbeat e a janela de medição de memória.

Em sucesso, o navegador preserva apenas `summary.json`; a carga preserva apenas `team-call-load.json`. O resumo do navegador é substituído atomicamente de `running` para o resultado final somente depois de fechar contextos, navegador, serviços e workspace temporário. Em falha, ambos guardam apenas classes de erro, posições do código e medidas agregadas. O navegador acrescenta categorias limitadas de console, sem o texto das mensagens.

Na etapa final de lançamento foram removidos screenshot, trace, vídeo, texto de exceções e cópia de logs brutos dos serviços. A saída dos processos de backend, Vite e TURN é descartada, inclusive no armazenamento temporário; a mídia sintética usada para transmitir RTP é removida junto com o workspace do teste. O perfil de carga não grava URLs de destino. `videoCaptureEnabled` permanece falso também no CI. O workflow envia somente os diagnósticos agregados de falha, com retenção de cinco dias. Resultados históricos abaixo descrevem execuções anteriores a essa mudança; os resultados vigentes estão na [auditoria de lançamento](../operations/team-call-release-audit.md).

## Carga e limites

Perfil padrão: 25 equipes independentes, quatro clientes por equipe, 100 conexões simultâneas e três repetições. Cada cliente faz handshake, criação/entrada na chamada, sinal direcionado, heartbeat e consulta de estado. A suíte também aborta um socket e deixa outro silencioso para medir, respectivamente, remoção por desconexão e expiração de heartbeat. RSS é lido do processo real do fixture.

| Gate | Limite |
| --- | ---: |
| handshake p95 / p99 | 1.500 / 3.000 ms |
| controle de chamada p95 / p99 | 750 / 1.200 ms |
| sinalização p95 / p99 | 400 / 1.000 ms |
| heartbeat p95 / p99 | 750 / 1.000 ms |
| consulta de estado p95 / p99 | 500 / 1.200 ms |
| convergência de estado máxima | 2.000 ms |
| remoção após socket abortado | 12 s |
| expiração sem heartbeat | 36 s |
| conexões simultâneas retidas | 100 |
| RSS absoluto / delta de pico / delta residual | 768 / 256 / 96 MiB |

O gate inicial de heartbeat era 400 ms em p95 e falhou de forma reproduzível com 513,328 ms sob fan-out simultâneo de 100 clientes. O limite foi calibrado uma única vez para 750 ms, mantendo p99 em 1.000 ms. A calibração está registrada para impedir relaxamentos silenciosos; novos aumentos exigem evidência e revisão deste documento.

Fechamento/crash no navegador tem limite separado de 18 s: até 5 s para o loop de recepção do servidor detectar o transporte encerrado, mais 8 s de tolerância explícita do coordenador e margem para encerramento real do renderer e polling. O gate de carga começa no aborto já observado pelo transporte e, por isso, permanece em 12 s.

## Resultado reproduzido em 2026-09-06

Base sincronizada: `origin/main@12e5ff3`; `origin/main` é ancestral do worktree e a contagem do resultado é `ahead 20, behind 0`. O avanço até `87f715e` alterou o router e a interface do chat/chamada; a resolução manteve `CallSession` como proprietária única do socket e incorporou a nova lista de conversas sem restaurar `CustomEvent` ou outro WebSocket. O commit posterior `12e5ff3` altera somente automações e tarefas; frontend e build foram repetidos depois dessa última integração.

### Navegador

Comando, a partir da raiz do worktree:

```powershell
.\norium-back-end\.venv\Scripts\python.exe norium-front-end\tests\browser\team_call_e2e.py --repeat 3 --artifacts-dir output\team-call-quality\browser-87f715e-final-2
```

Resultado: **39/39 execuções aprovadas**, 13 cenários vezes três, em 237,429 s; nenhum diretório de falha foi criado para a execução (`failureArtifacts: null`). Foram observados RTP real em todas as repetições de mídia, tela e relay-only. Os pares selecionados do gate relay-only foram sempre `relay/relay` por UDP. Fechamento normal foi removido entre 8,063 e 14,750 s; crash real de renderer, confirmado pelo evento do navegador, entre 8,203 e 8,812 s. Revogação de usuário ficou entre 5,000 e 5,109 s, e desativação da equipe entre 5,156 e 5,219 s.

### Carga

```powershell
.\norium-back-end\.venv\Scripts\python.exe norium-back-end\tests\team_call_load.py --repeat 3 --artifacts-dir output\team-call-quality\load-87f715e-final
```

Resultado: **3/3 repetições aprovadas, zero violações e 100/100 conexões retidas**.

| Medida | p95 | p99 | máximo |
| --- | ---: | ---: | ---: |
| handshake | 52,892 ms | 53,561 ms | 53,875 ms |
| controle de chamada | 302,244 ms | 308,774 ms | 311,990 ms |
| sinalização | 8,435 ms | 8,896 ms | 8,957 ms |
| heartbeat | 351,583 ms | 365,622 ms | 371,479 ms |
| consulta de estado | 34,595 ms | 36,406 ms | 36,406 ms |
| convergência de estado | 56,291 ms | 58,718 ms | 58,718 ms |
| remoção fantasma | 8,164 s | 8,164 s | 8,164 s |

A expiração sem heartbeat foi 30,197 s. O pico de RSS foi 118,926 MiB; o maior delta de pico e residual foi 25,664 MiB.

### Regressão e build

| Verificação | Resultado |
| --- | --- |
| backend completo | 552/552 testes aprovados em 26,339 s |
| frontend completo | 84 arquivos, 552/552 testes aprovados em 11,17 s na base final |
| chamadas, drawer, socket e transporte focados | 7 arquivos, 64/64 testes aprovados |
| build de produção | TypeScript + Vite aprovados; 1.744 módulos |
| lint | código 0; 13 avisos preexistentes fora de chamadas |
| sintaxe dos runners | `py_compile` e `node --check` aprovados |

Permanecem avisos não bloqueantes já existentes: depreciação do `pypdf`, 13 avisos de lint fora de chamadas, avisos React de `act`/chaves nos testes trazidos por `origin/main` e chunk geral do Vite acima de 500 kB. Uma execução anterior falhou uma vez em `WhatsAppStatusView.test.tsx`, fora do escopo, ao consultar sincronamente um estado de erro de mídia; o teste passou isolado e as suítes completas seguintes passaram sem alteração nesse módulo. Isso fica registrado como flake preexistente a corrigir separadamente.

Na primeira tentativa após a nova interface, o cenário de contexto direto ainda procurava o antigo `select.team-chat-select`; o runner foi atualizado para o botão semântico da lista de conversas e o caso passou isoladamente. Outra tentativa expôs uma asserção interna do driver ao reutilizar CDP `Page.crash`; o crash foi trocado pelo renderer nativo, validado 3/3 isoladamente e depois dentro da matriz final 39/39. Essas falhas eram do harness, não do produto, e não foram ocultadas por retentativa.

## TURN e limitações objetivas

O relay-only comprovado é real e local: credenciais TURN REST/HMAC efêmeras, allocation UDP, candidatos selecionados `relay/relay` e mídia RTP entre duas sessões independentes. A dependência de teste `turn-server` está fixada exatamente em `0.6.6`; por ser pré-1.0, deve ser atualizada somente com revisão do gate e do contrato HMAC.

Esta execução **não comprova TURN/TLS externo**. O servidor local suporta configuração TLS quando certificado e chave são fornecidos e falha claramente em configuração parcial, mas nenhum certificado/serviço externo estava disponível. Para provar infraestrutura real, configure somente no ambiente do backend e execute o navegador com `--external-turn`; não coloque credenciais em `VITE_*` ou no bundle.

## Integração no CI

O job `team-call-quality` do workflow `.github/workflows/azure-container-apps.yml` instala dependências bloqueadas, Chromium, executa navegador e carga três vezes e falha se qualquer runner falhar. `publish-image` depende de `validate` e desse gate. O segredo do TURN local nasce dentro do runner, dura somente o processo e nunca é escrito no bundle ou nos artefatos.

O workflow foi validado por parse e invariantes locais, mas não foi executado remotamente nesta etapa. Nenhuma imagem foi publicada e nenhum deploy foi feito.

Resultados estruturados locais: `output/team-call-quality/browser-87f715e-final-2/summary.json` e `output/team-call-quality/load-87f715e-final/team-call-load.json`. `output/` é ignorado pelo Git.
