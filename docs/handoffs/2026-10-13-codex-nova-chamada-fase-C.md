# Nova chamada — Fase C iniciada

Data: 13/10/2026. Estado: **implementação parcial local, sem aceite integral**. Provedor escolhido diretamente pelo usuário: **Groq Whisper em trechos de 5–10 segundos**. A escolha não configura produção nem contrata serviço. O usuário autorizou iniciar as novas fases; os anexos são referências e não concedem autorização para publicar ou ativar serviços.

## Entregue nesta continuidade

- `nora_call_state.py`: flag desligada por padrão; consentimento explícito por participante/sessão/revisão. Entrada, troca de sessão, retirada e pausa invalidam a autorização. Consentimento completo aparece como **Aguardando conexão**, sem simular Ouvindo.
- `nora_call_stt.py`: interface `SpeechToText`, Groq Whisper Turbo, WAV mono 16 kHz em memória, resposta/timestamps limitados, timeout, sem redirecionamento ou retentativa automática, erro genérico e minimização textual.
- `nora_call_agent.py`: VAD por energia, atribuição por fonte, trechos de 5–10 s, fila de quatro trechos/12 fontes, cancelamento e descarte ao invalidar consentimento, mascaramento na saída. `AgentCapacity` limita duas chamadas dentro de um supervisor; não é lock global entre processos independentes.
- `meeting_rtc.py`: adapter de sala já autorizada, somente microfone de identidades mapeadas pelo emissor; metadata do participante não prova identidade. Reamostragem mono 16 kHz e fila limitada no SDK. Vídeo e áudio de tela fora da transcrição.
- `call_coordinator.py`: `CALL_NORA_CONTROL`/`CALL_NORA_CONSENT` reutilizam equipe, cliente, conexão e organizador existentes. Flag/SFU/entitlement são exigidos; adapter operacional de plano permanece fechado. O teto da Nora não impede admissão humana.
- Frontend: `NoraCallPanel.tsx`, estado/comandos na sessão, aviso na pré-entrada, consentimento, retirada individual, pausa do organizador, avatar oficial e revisões de eventos. Painel ausente com a flag padrão desligada.
- `ai_speech_costs.py` e schema central `ai_costs.py`: segundos STT/caracteres TTS independentes de tokens, reserva antes do envio, limites por chamada/ciclo, tarifa preservada, tentativas incertas conservadoras. Groq cobra pelo menos **10 s por envio**, conforme [documentação oficial](https://console.groq.com/docs/speech-to-text). Ainda não há agregação desses custos na tela administrativa.

## Evidências já realizadas

- `output/pos-correcao/nova-chamada-c-core.json`: 47 testes aprovados sem falhas/erros/skips.
- `nova-chamada-c-controls-fixed.json`: 63 testes aprovados; corrigida expectativa de teste para resposta `CALL_SESSION` existente a participante removido.
- Frontend focado: 70 testes aprovados em quatro arquivos.
- Frontend completo: **803/803 testes em 135 arquivos**, `output/nova-chamada-qa/frontend-cde-completo.log`. TypeScript, oxlint `src`, build e limites de bundle aprovados; 19 avisos de lint em outros módulos, sem erros.
- Chromium: **51/51 execuções**, `output/team-call-quality/nova-chamada-cde-browser/summary.json`, zero falhas/transitórios. São chamadas existentes com flag Nora padrão desligada; `noraResponseShared` do roteiro Estúdio refere-se à função anterior, não à nova assistente de reunião.
- Backend completo inicial: **1.175/1.175**, `output/pos-correcao/nova-chamada-cde-backend-completo.json`. Código final: **1.176/1.176**, `nova-chamada-cde-backend-acceptance.json`, zero falhas/erros/skips, incluindo disponibilidade inicial e admissão humana acima do teto Nora.
- Carga de sinalização no código final: **3/3 rodadas com 100 conexões** aprovadas, `output/team-call-quality/nova-chamada-cde-load/team-call-load.json`. Controle p95/p99 **607,865/617,402 ms**, heartbeat **660,263/675,759 ms**, sinalização p95 **21,274 ms**, remoção de fantasmas máxima **8,133 s**, RSS pico **239,832 MiB**. Limites existentes mantidos; Nora desligada, sem capacidade de agentes reais comprovada.
- Scan local de fonte + build de chamadas: **128 arquivos, zero achados**, `team_call_frontend_security.py`. Complementa; não substitui Gitleaks/auditoria de dependências.
- `output/nova-chamada-cde-snapshot/manifest.json`: 26 fontes de código, 35 arquivos com documentação; patch incremental `phase-cde-code.patch` verificado sem aplicação/index. Base B, fallback A para fontes que não mudaram em B, HEAD para `ai_costs.py` limpo ao iniciar C. Docs operacionais preservam alterações anteriores e ficam somente no snapshot, fora do patch.
- `nova-chamada-ce-adapters.json`: seis testes aprovados com SDK substituído/MockTransport; não prova SDK nativo ou LiveKit real.
- `nova-chamada-de-core.json`: 16 testes de entendimento/voz/custos aprovados.
- Ensaio de memória **aprovado por 1.800,013 s reais**: `output/team-call-quality/nova-chamada-c-agent-soak-acceptance/measurement.json`. Duas fontes sintéticas, **270** requisições/reservas/liquidações/segmentos, fila máxima **2** (teto 4), faixa RSS após aquecimento **2,238 MiB**, faixa de alocações Python **423.416 bytes**, hashes dos três módulos medidos inalterados. STT/meter substituídos, sem áudio/texto bruto nos artefatos; não prova LiveKit/SDK nativo/provedores reais. Primeira execução interrompida para acrescentar mascaramento na saída, sem usá-la como evidência de 30 min.

## Pendências para aceite integral

1. Revisão especializada do perfil do agente, entitlement, revogação e retenção/exclusão conforme [governança](../AI_GOVERNANCE.md). Os pontos concretos estão no [parecer preparado](../security/reviews/2026-10-13-nora-em-reunioes.md).
2. Supervisor operacional, processo por sala, IPC/leases, limite global entre processos, desligamento pela chamada viva. O módulo atual é núcleo testável; `python -m ...nora_call_agent` ainda não inicia agente conectado.
3. Token mínimo do agente e SDK Python pinado/auditado/instalado. Emissor humano e requirements não foram alterados. `canSubscribe` não restringe fontes por JWT; seleção no adapter não é garantia criptográfica. Gates SFU anteriores continuam válidos.
4. Persistir/broadcast segmentos e legendas, associação à gravação, downloads, expurgo físico e exportação/exclusão filtrados. Nenhuma rota de upload de áudio ou persistência nova de transcrição foi montada.
5. Tarifas/tetos comerciais, visão administrativa e adapter de plano. Dados de teste não configuram cobrança real.
6. Integração e memória com SDK/LiveKit/Groq reais; o ensaio atual mede apenas a fila Python. Nenhum áudio de cliente foi enviado.

## Fontes e dependências verificadas

- `app/modules/team/call_coordinator.py`, `router.py`, `call_adapters.py`: admissão, sessão/cliente, equipe, organizador e ciclo de chamada existentes. Reutilizar essa fronteira; conteúdo da reunião não pode comandar ferramentas nem conceder permissões.
- `app/modules/team/sfu_tokens.py`: emissor atual autoriza mídia humana; não existe perfil de agente Nora nem prova de restrição por fonte de áudio. Não tratar um token humano existente como token mínimo do agente.
- `docs/adr/0002-team-call-sfu.md` e runbook: SFU de produção permanece bloqueado por revogação/encerramento, webhooks/reconciliação e provas do provedor. Implementação local não autoriza ativá-lo.
- `app/core/ai_guardrails.py`: usar `minimize_for_ai` antes da IA de entendimento e antes de difundir/persistir texto. A transcrição requer envio de áudio ao provedor aprovado; minimização textual não mascara palavras no áudio bruto. Consentimento deve explicar esse tratamento.
- `app/modules/team/recording_coordinator.py`: retenção configurável `TEAM_RECORDING_RETENTION_HOURS`, padrão 24 h. Transcrição deve ter o mesmo prazo, downloads recusados ao expirar e limpeza rastreável.
- `app/modules/privacy/router.py`: exportação cobre documentos por usuário/workspace, mas transcrição compartilhada de equipe precisa de filtragem explícita por participante, expiração e acesso atual. Exclusão de conta não pode apagar dados de outra pessoa indiscriminadamente.
- `docs/ai-costs.md`: o registro atual mede tokens; declara que voz e outros custos extras não estão incluídos. Medição de segundos STT/caracteres TTS precisa de unidade própria, reserva/limite e histórico idempotente. Não registrar STT como consumo gratuito nem inventar tokens do Whisper.

## Contrato a implementar

1. `SpeechToText`: adaptador Groq `whisper-large-v3-turbo`, POST multipart em [`/openai/v1/audio/transcriptions`](https://console.groq.com/docs/speech-to-text), WAV mono 16 kHz em memória, timeouts, limites de resposta/trecho e erros públicos genéricos. Credencial só no backend; não expor respostas brutas, áudio, texto ou segredos em logs.
2. Coordenador Nora: estado por chamada/equipe, consentimento por participante e revisão, ligar/pausar pelo organizador, retirada de consentimento, entrada tardia e pausa imediata. Sem consentimento completo, o agente não captura/envia áudio. Apenas avisar que a Nora está ativa não equivale a consentimento.
3. `nora_call_agent`: processo separado com assinatura seletiva de áudio por participante; VAD e reamostragem, filas limitadas/backpressure, no máximo duas chamadas por servidor por padrão. Sem captura de vídeo, sem áudio em disco, sem execução de ações. Encerrar ao terminar a chamada, perder autorização/consentimento ou ficar sem humanos.
4. Persistência: segmentos `{quem, início, fim, texto}` minimizados, associados à chamada/gravação. Reutilizar repositório com chave tenant/workspace e locks existentes. Limites de bytes/segmentos; exportação/exclusão e limpeza compatíveis com retenção.
5. UI: aviso na pré-entrada, consentimento, selo real, legenda opcional por pessoa, bloco Nora com estado real e pausa. Sem simular Nora ouvindo enquanto o agente não está autorizado e conectado. Nenhuma mudança de áudio humano ou remoção de controles atuais.
6. Flags: `NORA_CALL_ENABLED=0`, `NORA_CALL_MAX_CONCURRENT=2`, permissão/plano `nora_reunioes`; chave Groq somente por ambiente. Falta de configuração, custo ou permissão mantém o recurso fechado.

## Provas necessárias antes do aceite

- Duas fontes sintéticas de áudio produzem segmentos atribuídos aos participantes corretos.
- Sem consentimento, captura/transcrição não inicia; pausa/retirada e entrada tardia interrompem filas e chamadas ao provedor.
- Equipes, workspaces, chamadas e sessões antigas permanecem isolados; sem retransmissão de texto privado à sala.
- Concorrência e custo limitados antes do envio; reservas incertas não podem liberar reenvio duplicado.
- Mascaramento, expiração, exportação filtrada e exclusão no escopo correto, usando dados temporários.
- Agente estável em teste de memória de **30 minutos**, sem mídia/transcrição bruta nos artefatos.
- Suítes completas e gate de chamadas aprovados; revisão dos caminhos críticos conforme `docs/AI_GOVERNANCE.md`.

As fases D/E foram iniciadas em núcleos separados e têm handoffs próprios; não estão concluídas. Não houve envio, efeito sobre dados de clientes, provisionamento, contratação, configuração de segredos, push ou deploy.

## Continuidade aprovada — integrações locais

O usuário respondeu “eu aprovo” e pediu continuidade. Autorização registrada para executar as integrações locais; não representa revisão especializada concluída ou autorização para push/deploy/ativação. As seções anteriores preservam o histórico e seus resultados, com hashes e escopo próprios.

- `meeting_session.py`: transcrição volátil limitada a 2 MiB/2.000 segmentos, audiência registrada por segmento, leitura limitada aos 200 últimos autorizados, expiração pelo prazo da gravação e encerramento da chamada. Entrada tardia não concede acesso automático às falas anteriores. Não há armazenamento em disco, exportação ou exclusão permanente nova.
- `meeting_pipeline_bridge.py` e coordenador: entrega interna de texto mascarado via WebSocket aos participantes autorizados; consentimento/sessão/entitlement são revalidados imediatamente antes do provedor. Pausa e fim cancelam processamento. Não há rota de upload de áudio controlada pelo navegador.
- `meeting_router.py`: leitura autenticada da sessão e pergunta privada, permissões atuais consultadas antes/depois do modelo, fontes validadas e recibos limitados por audiência/usuário. Cache privado expira com a fonte. Respostas não são publicadas na sala.
- Painel Agora/Transcrição/Perguntar, fontes da resposta privada, legendas opcionais locais e layout de 375 px. “Ouvindo” depende da atividade interna válida; consentimento completo sozinho continua “Aguardando conexão”.
- Administração de custos: segundos/caracteres e reservas em painel próprio, fora das quotas de tokens. Tokens de perguntas privadas/entendimento usam o gateway existente e fontes opacas por chamada. Exportações PDF/CSV atuais continuam restritas ao relatório de tokens.
- `requirements-nora-call.lock.txt`: cinco dependências opcionais com 84 hashes de distribuição; LiveKit Python 1.1.19 instalado somente em `output/nora-call-sdk-env`. Instalação com hashes e auditoria local sem vulnerabilidades conhecidas nessas cinco dependências. Não alterado o ambiente ativo/container. Validação nativa offline de AudioSource/AudioStream, duas fontes mono 16 kHz; nenhuma sala ou provedor conectado.

Permanecem pendentes: perfil/token do agente, entitlement operacional, supervisor por sala e leases/limite global, persistência vinculada à gravação e fluxos de privacidade, gates SFU e homologação Groq/LiveKit reais. A aprovação de continuidade não substitui a revisão especializada exigida pela governança.

O ensaio `nova-chamada-c-bridge-soak/measurement.json` terminou 30 min, mas falhou pelo critério antigo de faixa RSS: 18,957 MiB, com queda observada de aproximadamente 39 para 21 MiB. O resultado permanece reprovado. O ensaio nativo inicial foi interrompido e não comprova 30 min. A medição foi corrigida para crescimento positivo da memória privada comprometida após aquecimento (<16 MiB), mantendo a faixa de alocações Python <2 MiB; RSS fica descritivo. A verificação curta passou. O novo ensaio completo e os gates finais devem ser consultados no registro de validação desta integração, sem reclassificar a execução anterior.

## Validação desta integração — encerrada em 14/10/2026

| Gate | Resultado observado |
| --- | --- |
| Backend isolado | 1.232 testes; zero falhas/erros/skips, `nova-chamada-cde-integration-acceptance.json` |
| Frontend completo | 807 testes/135 arquivos; quatro threads isoladas, `frontend-cde-integration-threads.log` |
| TypeScript/build/bundle | Aprovados, logs `*-cde-integration-final.log` |
| Lint | Zero erros; 19 avisos preexistentes, zero novos no painel Nora |
| Scan local de chamadas | 129 arquivos, zero achados, `security-cde-integration.log` |
| SDK opcional | Cinco dependências auditadas sem vulnerabilidades conhecidas; 84 hashes; validação nativa offline |
| Navegador | Repetição final aprovada: 54/54 execuções, zero falhas/transitórios; tentativas anteriores preservadas |
| Carga 3 × 100 conexões | Repetição aprovada; heartbeat p95 689,135 ms/p99 709,622 ms; tentativa anterior preservada |
| Memória nativa 30 min | Aprovada por 1.811,739 s; 180.878 frames/358 trechos, fila máxima 1, hashes inalterados |

A primeira repetição de frontend teve 719 testes executados aprovados, mas 11 erros ao iniciar workers e exit 1. A repetição com quatro processos ficou sem progresso e foi interrompida; não conta como aceite. O pool de threads executou a mesma suíte, sem relaxar assertivas/timeouts.

Navegador: `nova-chamada-cde-integration-browser/summary.json` teve 35 aprovações, timeout em `group_media` e falha de finalização. `nova-chamada-cde-integration-browser-final/summary.json` teve 17 aprovações, falha em `tab_close_and_crash` e finalização. Não são resultados verdes. Causa da influência de recursos concorrentes não foi comprovada; a próxima repetição será sequencial após o ensaio nativo.

Ensaio nativo aceito: `output/team-call-quality/nova-chamada-c-native-private-soak/measurement.json`, SDK 1.1.19, duas fontes locais, 358 requisições/liquidações/segmentos; sem sala ou provedor real. Crescimento privado após aquecimento **0 MiB**, faixa de alocações Python **880.703 bytes**. Máximos observados arredondados: RSS **57,79 MiB**, memória privada comprometida **396,28 MiB** neste Windows. Faixa RSS **25,922 MiB**, incluindo quedas; não tratada como crescimento. Resultado não comprova orçamento/capacidade Shard/Linux, publicação de áudio ou autorização de agente.

Carga aceita: `output/team-call-quality/nova-chamada-cde-integration-load-acceptance/team-call-load.json`, três rodadas/100 conexões mantidas, controle p95/p99 **600,136/603,450 ms**, heartbeat **689,135/709,622 ms**, sinalização p95 **44,446 ms**, remoção de fantasmas máxima **8,123 s**, RSS pico **239,430 MiB**. A tentativa anterior com heartbeat acima do limite permanece reprovada no artefato original. Não houve alteração de thresholds nem ativação de agente real. A repetição posterior isolada não prova, por si só, a causa da reprovação anterior.

Navegador aceito: `output/team-call-quality/nova-chamada-cde-integration-browser-acceptance/summary.json`, 18 cenários × três repetições, **54/54**, zero falhas/transitórios. RTP humano real; Nora usa texto sintético no fixture, sem agente RTC ou provedores reais. TURN UDP local validado; TURN TLS não foi comprovado. Nenhum critério foi relaxado. A instrumentação adicional registra somente categorias de falha de finalização.

Entrega local revisada e validada no escopo implementado. As fases C/D/E continuam parciais, com pendências operacionais listadas acima. Evidência consolidada em `output/nova-chamada-qa/validation-cde-integration.json`; patch incremental de 33 fontes e snapshot com 43 arquivos preservam alterações anteriores. Sem push/deploy ou ativação de serviços.
