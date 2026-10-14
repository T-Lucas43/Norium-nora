# Nova chamada — Fase B: recepção seletiva de vídeo

Data: 13/10/2026. Executor: Codex direto. Branch local: `codex/nova-chamada-fase-a`. Estado: **implementação e validação local concluídas**, com oscilação anterior do gate de carga registrada abaixo. Sem push, PR, merge, deploy ou ativação de SFU.

## Implementação

- Manter `CallSession` como proprietária do ciclo de chamada; interface de interesse de vídeo na fronteira `MediaTransport`.
- `useCallVideoInterest.ts` calcula blocos visíveis com `IntersectionObserver`, `ResizeObserver` e descoberta de elementos por `MutationObserver`. Reage a layout/painel/paginação e visibilidade da aba, sem polling de rede. A aba oculta publica a pausa diretamente, porque navegadores suspendem frames de animação. O painel móvel que cobre o palco também pausa vídeo recebido.
- Tela compartilhada recebe prioridade alta; vídeos laterais podem usar camada baixa. Áudio permanece em todos os layouts, na paginação, ao minimizar e com aba oculta.
- `LiveKitMediaTransport.ts` mantém `adaptiveStream: true` e `dynacast: true`, usa `autoSubscribe: false`, assina áudio de microfone/tela continuamente e controla vídeo por publicação. Aplica `setSubscribed`, `setVideoQuality` e `setVideoDimensions` também a publicações tardias e reconexão. `remoteVideoBindings.ts` liga o elemento real ao SDK, sem expor tipos do fornecedor na UI. Blocos de presença persistem mesmo quando a última faixa de vídeo foi desassinada.
- `MeshMediaTransport.ts` mantém um canal de vídeo por peer. `CALL_VIDEO_INTEREST` usa a autorização existente de chamada/sessão, valida destino e tipos e só chega ao emissor correspondente; não é persistido. Pausa encodings sem retirar a faixa negociada, com fallback para `replaceTrack(null)` quando não há controle compatível. Não muda captura local, áudio, gravação, tokens nem o vídeo recebido por outra pessoa. Câmeras laterais: escala 2, até 250 kbit/s/15 FPS; apresentação: perfil existente do apresentador, escala 1. Mudança de qualidade respeita a pausa e a recuperação de tela ignora vídeo fora do interesse.
- Nenhuma migração/ativação de SFU em produção. Respeitar os bloqueios do ADR 0002 e do runbook.

## Evidências de validação

| Verificação | Resultado / artefato |
| --- | --- |
| Backend completo | **1.138/1.138**, zero skips, `output/pos-correcao/nova-chamada-b-backend-completo.json` |
| Frontend completo | **799/799** em 134 arquivos, `output/nova-chamada-qa/frontend-b-acceptance.log`; inclui presença sem faixa e exclusão de convidado não admitido |
| Transportes e observers | 25 testes de transporte/observer aprovados; teste adicional de aba oculta sem frames e painel móvel aprovado |
| Chromium completo | **51/51**, zero falhas/transitórias, `output/team-call-quality/nova-chamada-b-final/summary.json` |
| Confirmação das últimas mudanças | **2/2**, `video_interest` e `call_layout`, sem novas edições de fontes, `output/team-call-quality/nova-chamada-b-frozen-focus/summary.json` |
| TypeScript, lint, build/bundle | Aprovados; lint apenas em `src`, avisos preexistentes registrados; `build-b-acceptance.log`, `lint-b-acceptance.log` |
| Scan de frontend | **126 arquivos, zero achados**; inclui fontes da chamada e build completo, sem substituir auditoria de dependências |
| Carga final | **3/3**, 100 conexões, zero violações, `output/team-call-quality/nova-chamada-b-load-repeat/team-call-load.json` |

O cenário `video_interest` mede bytes RTP nativos com três participantes: vídeo recebido cai a zero ao minimizar/ocultar, áudio cresce, outro receptor mantém vídeo e o vídeo retorna. A fronteira `document.hidden` é sintética em headless; o teste do observer cobre também suspensão real de frames. Não equivale à homologação de dispositivo físico, Safari/Firefox ou TURN/TLS externo.

Carga aprovada: controle p95/p99 **621,319/632,889 ms**, heartbeat **667,842/691,939 ms**, sinal p95 **50,033 ms**, consulta de estado p95 **89,961 ms**, remoção máxima **8,126 s**, RSS pico **239,027 MiB**, delta **68,488 MiB**. Limites idênticos aos da Fase A e da tentativa anterior; nenhum relaxamento. A primeira tentativa `nova-chamada-b-load-final` falhou: controle p95 **1.358,200 ms** e heartbeat p95 **1.438,939 ms**, também acima dos respectivos p99. Não havia processos de fixture/benchmark/testes remanescentes. A repetição passou sem editar código nem limites, e a persistência JSON é idêntica ao snapshot A. Isso demonstra oscilação entre execuções locais; a causa não foi confirmada. Preservar ambos os artefatos e repetir em runner/infraestrutura representativos antes de declarar capacidade de produção.

Tentativas anteriores ficam preservadas: `nova-chamada-b-consolidado` falhou em apresentação após destaque; foi corrigida a pausa que retirava a faixa negociada. Uma retomada medida imediatamente após restaurar falhou em `nova-chamada-b-encoding`; o cenário passou a esperar crescimento RTP dentro do deadline de mídia já existente antes de medir a continuidade. Nenhum teste anterior nem limite de sinalização/carga foi reduzido. `frontend-b-consolidado.log` misturou o teste atualizado com módulo já carregado e falhou na pausa sem frames; a repetição com fontes estabilizadas é a evidência final, não essa tentativa.

## Medição de CPU e banda

Medição solicitada: três participantes durante dez minutos antes/depois. `scripts/measure_team_call_video.py` usa contadores RTP nativos e CPU dos processos do Chromium/fixture/Vite/TURN; 100% de CPU corresponde a um núcleo lógico. A cópia de fontes da interface A é restaurada de `output/nova-chamada-a-snapshot/`, mantendo backend/dependências iguais, sem credenciais ou alteração do checkout. Cada sessão tem 15 s de aquecimento e minimiza o receptor entre minutos 2 e 7, restaurando até o fim. Resultados e hashes vão para JSON agregado.

| Medida agregada, três participantes | Referência A | Fase B | Variação observada |
| --- | --- | --- | --- |
| Duração | 600,026 s | 600,320 s | mesmo perfil de dez minutos |
| Bytes RTP de vídeo recebidos | 12.285.097 | 9.628.851 | **−21,6%** |
| Bytes RTP de áudio recebidos | 14.580.486 | 14.587.857 | +0,05%, praticamente igual |
| CPU média, 100% = um núcleo lógico | 297,256% | 284,475% | **−4,3%**, observação local |
| Tempo CPU total dos processos | 1.783,612 s | 1.707,763 s | −4,25% |

Fontes inalteradas nas duas sessões (`sourceUnchanged: true`). Artefatos: `output/team-call-quality/nova-chamada-b-measurement-a/measurement.json`, `nova-chamada-b-measurement-b/measurement.json` e `nova-chamada-b-comparison.json`. No intervalo estável minimizado da B (16 intervalos de amostragem), o receptor recebeu **zero bytes de vídeo**, **1.953.234 bytes de áudio**, e os outros dois receptores receberam **3.104.631 bytes de vídeo**. Restaurar voltou ao perfil Galeria.

O ensaio curto do coletor não integra a comparação. Não atribuir à Fase B o resultado de carga de sinalização, nem garantir economia de CPU/banda em produção a partir de câmera sintética 160×120 ou uma única comparação local. Os bytes são contadores RTP recebidos, não uma medição de toda a rede nem da conta de tráfego da Shard. CPU soma os processos próprios do navegador e serviços; não representa CPU por pessoa, percentual de toda a máquina ou CPU da Shard. A diferença observada não prova significância estatística. SFU real, dispositivos físicos e agente Nora não foram medidos.

## Separação do trabalho anterior

`output/nova-chamada-b-snapshot/manifest.json` preserva hashes de 19 arquivos de código da Fase B. `phase-b-code.patch` contém apenas o incremento sobre o snapshot A e passou em `git apply --reverse --check --ignore-space-change` no checkout atual, sem aplicação ou alterações do índice. A documentação fica no workspace. O snapshot A já inclui alterações anteriores preservadas; esse patch evita incorporá-las ao incremento B. Não houve commit, push, PR, merge ou deploy; o fetch inicial continuou sem acesso ao remoto.

## Decisão já recebida para a Fase C

O usuário escolheu Groq Whisper em trechos de 5–10 segundos. A interface `SpeechToText` deve admitir adaptadores futuros; a captura do agente será somente áudio, com consentimento e flag desligada por padrão. A escolha não autoriza configurar segredos, contratar serviços ou ativar a integração em produção.

As fases C–E não foram implementadas nesta entrega. A escolha já recebida permanece válida para a próxima fase.
