---
status: proposed
date: 2026-09-05
decision_owner: pending
---

# ADR 0002 — SFU para chamadas de equipe atrás de `MediaTransport`

Propomos usar **LiveKit Cloud** como primeiro SFU de produção, preservando uma saída para **LiveKit self-hosted** e isolando ambos atrás de `MediaTransport`. A proposta reduz o trabalho inicial de mídia, gravação e observabilidade sem transferir ao fornecedor a autoridade sobre chamada, equipe ou participante; ela permanece **aguardando decisão do responsável** e não autoriza a etapa 8B, contratação, provisionamento ou deploy.

A pesquisa factual que sustenta esta comparação, com fontes oficiais e lacunas separadas de inferências, está em [Pesquisa de opções SFU](../research/team-call-sfu-options.md).

## Contexto

O transporte atual é WebRTC mesh. Cada participante publica mídia diretamente para os demais, de modo que o custo de upload e a quantidade de conexões crescem com o tamanho da chamada. TURN resolve alcançabilidade em redes restritivas, mas não muda essa topologia.

Durante a coexistência, o mesh permanece disponível com limite configurável por `TEAM_CALL_MESH_MAX_PARTICIPANTS`. O default conservador é **6 participantes**; esse número foi escolhido durante a implementação porque o valor do requisito chegou truncado e, portanto, **não representa ainda um limite de produto aprovado**. A configuração é validada na inicialização e exige inteiro maior ou igual a 2.

A admissão ocorre no servidor sob a serialização do `CallCoordinator`. Acima do limite, `CALL_ACCEPT` é recusado atomicamente antes de registrar o participante ou encaminhar sinalização aos peers, com status `409`, código estável `call_capacity_reached` e mensagem que informa a capacidade e orienta aguardar uma vaga. Outra aba de um participante já admitido não consome vaga adicional; uma sessão desconectada ainda dentro da tolerância de 8 segundos continua ocupando sua vaga. No cliente atual, entretanto, a mídia local é capturada **antes** da confirmação de `CALL_ACCEPT` e suas tracks são limpas quando chega a recusa. Não existe preflight de capacidade nesta etapa; isso permanece um risco de privacidade/consumo a eliminar, caso o responsável aprove a etapa 8B.

Os limites de domínio são:

- **`CallCoordinator`**: fonte de verdade para existência e estado da chamada, associação entre equipe, participante, cliente e conexão, anfitrião, autorização, revogação e eventos de negócio.
- **`CallSession`**: proprietária única, no navegador, do ciclo da chamada, socket global, dispositivos/captura local, chat, gravação e limpeza coordenada.
- **`MediaTransport`**: módulo profundo, instanciado por chamada, que esconde peers ou sala, negociação, publicação/assinatura, streams remotos e telemetria específica do transporte. A implementação mesh foi extraída para esse limite; não se trata de uma fachada sobre o hook inteiro.
- **Sala do provedor**: projeção efêmera do `call_id`, nunca prova de autorização ou fonte de verdade do produto.

```text
UI (drawer/overlay)
        |
        v
CallSession ---- snapshot e comandos estáveis
        |
        +-- captura/dispositivos/chat/gravação/socket
        |
        v   seleção imutável armazenada pelo servidor
MediaTransport (uma instância por chamada) --------------+
        |                                         |
        +--> MeshMediaTransport (transição)       +--> LiveKitMediaTransport (proposto)
                                                        |
WebSocket NOrium <--> CallCoordinator                   +--> sinalização e mídia LiveKit
        |                                                    (Cloud ou self-hosted)
        +--> autorização, presença, revogação,
             anfitrião, auditoria e política de gravação
```

## Decisão proposta

Se este ADR for aceito:

1. Chamadas elegíveis para SFU usarão LiveKit Cloud, com região escolhida por política do backend. LiveKit self-hosted será a rota de saída arquitetural, não um compromisso operacional imediato.
2. O backend autenticará o usuário e revalidará equipe, chamada ativa e participante antes de emitir um JWT curto, restrito à sala e às permissões necessárias. Chaves de API nunca serão entregues ao bundle ou persistidas no cliente. O modelo oficial usa [tokens com grants](https://docs.livekit.io/frontends/reference/tokens-grants/) e possui um [exemplo de endpoint de autenticação para FastAPI](https://docs.livekit.io/frontends/build/authentication/endpoint/).
3. O `CallCoordinator` continuará determinando quem pode entrar, publicar, gravar, expulsar ou encerrar. Eventos e webhooks do provedor serão entradas não confiáveis, validadas e aplicadas de forma idempotente; o backend não aceitará `room`, `participant` ou `track` fornecido pelo cliente como prova de acesso.
4. O transporte será escolhido pelo servidor na criação da chamada, persistido como parte dela e ficará imutável até seu encerramento. O cliente seleciona o adapter a partir desse valor, sem aceitar override local. Não haverá troca mesh↔SFU no meio da chamada nem fallback silencioso que burle o limite de capacidade.
5. Para cada chamada, `CallSession` cria exatamente um transporte e consome somente snapshot e comandos normalizados. A interface não inclui chat, gravação, toque, dispositivos ou o socket global: essas responsabilidades permanecem na sessão. Tipos como `Room`, `RemoteParticipant` e `LocalTrack`, IDs do fornecedor e callbacks do SDK não poderão chegar ao drawer, overlay ou regras de domínio.
6. `MeshMediaTransport` e `LiveKitMediaTransport` poderão coexistir durante a migração. A seleção por chamada permitirá rollout e rollback de chamadas novas sem interromper chamadas já estabelecidas.
7. A política transacional de gravação, consentimento, quotas, auditoria, retenção e exclusão continuará pertencendo ao NOrium. LiveKit Egress será apenas um adapter de execução e eventos; E2EE e gravação não serão habilitadas juntas até existir uma decisão explícita sobre distribuição da chave ao gravador.
8. Telemetria normalizada poderá registrar tempos, estados, bitrate e categorias de caminho, mas não IPs, candidatos ICE, SDP completo, credenciais ou conteúdo de mídia.

## Opções consideradas

### Visão operacional e de segurança

| Opção | Hospedagem | Autenticação | Regiões e latência | Privacidade |
| --- | --- | --- | --- | --- |
| **LiveKit Cloud** | Serviço gerenciado e malha SFU global. | JWT curto com grants, emitido pelo backend; revogação gerenciada no Cloud. | Edge mais próximo; o grupo `sa` fica no Brasil. Pinning regional exige Scale e desabilita o failover global automático. Consulte [regiões](https://docs.livekit.io/deploy/admin/regions/endpoints/) e [pinning](https://docs.livekit.io/deploy/admin/regions/region-pinning/). | [E2EE](https://docs.livekit.io/transport/encryption/) documentada para mídia e data channel, com chaves sob responsabilidade da aplicação. Sinalização continua visível ao serviço; gravação exige decisão sobre acesso do gravador à chave. |
| **LiveKit self-hosted** | Servidor aberto Apache-2.0, operado pelo NOrium. Egress, Ingress, TURN, Redis e topologia multi-região são responsabilidades separadas. Consulte [self-hosting](https://docs.livekit.io/transport/self-hosting/) e [modo distribuído](https://docs.livekit.io/transport/self-hosting/distributed/). | Mesmos JWTs/grants, mas revogar permissões não invalida um token antigo; TTL curto e recusa de reemissão são obrigatórios. | Exatamente as regiões implantadas pelo operador; alta disponibilidade multi-região exige roteamento geográfico, Redis e capacidade operacional. | Maior custódia da infraestrutura e suporte a E2EE, mas também responsabilidade integral por hardening, logs, backups, incidentes e suboperadores. |
| **Cloudflare Realtime SFU** | Serviço global gerenciado de baixo nível, baseado em sessões e tracks, sem modelo pronto de sala/presença. | App Secret fica no backend; autenticação, autorização de publish/subscribe e proteção de IDs ficam integralmente no NOrium. Consulte a [API de conexão](https://developers.cloudflare.com/realtime/sfu/https-api/). | Anycast e backbone global; a documentação consultada não oferece pinning ou residência no Brasil equivalentes às alternativas. Consulte [topologia](https://developers.cloudflare.com/realtime/sfu/calls-vs-sfus/). | Mantém o modelo de negócio fora do fornecedor, mas não foi encontrada garantia específica de E2EE contra o SFU nem de residência regional. Essas lacunas exigem validação técnica e contratual. |
| **mediasoup v3** | Biblioteca SFU autogerenciada em Node.js/Rust com workers; sinalização, TURN, balanceamento e failover são construídos pelo produto. | Não fornece autenticação nem sinalização; todos os comandos, IDs e permissões seriam desenhados e protegidos pelo NOrium. Consulte [comunicação cliente-servidor](https://mediasoup.org/documentation/v3/communication-between-client-and-server/). | Totalmente determinada pelos hosts implantados. Escala exige distribuição de routers/workers e coordenação entre hosts. Consulte [scalability](https://mediasoup.org/documentation/v3/scalability/). | Máxima custódia e controle, porém E2EE completa contra o SFU não é uma capacidade pronta da API principal; segurança e operação ficam inteiramente com a equipe. |
| **Daily** | Plataforma gerenciada com REST, SDK web, hooks React e UI opcional. | Meeting token curto pode restringir sala, validade, owner e envio/recebimento. Consulte [meeting tokens](https://docs.daily.co/reference/rest-api/meeting-tokens/create-meeting-token). | Seleção automática ou `geo`; a lista inclui `sa-east-1` em São Paulo. Consulte [criação de sala](https://docs.daily.co/reference/rest-api/rooms/create-room). | O fornecedor declara E2EE disponível e controles de segurança; a interação entre E2EE e gravação precisa ser comprovada. Não existe uma edição autohospedada equivalente documentada. |

### Capacidades de produto, operação e custo

| Opção | Gravação e screen share | Observabilidade | Modelo de custo | Integração e lock-in |
| --- | --- | --- | --- | --- |
| **LiveKit Cloud** | Screen share nativo; [Egress](https://docs.livekit.io/reference/other/egress/api/) grava sala, participante ou track e admite múltiplos destinos. | Dashboard; [Analytics API](https://docs.livekit.io/deploy/admin/analytics-api/) no Scale oferece métricas de sessão e qualidade. | Plano, minutos de conexão, downstream e Egress. Na consulta de 4–5/09/2026, Ship começava em US$ 50/mês e Scale em US$ 500/mês; preços precisam ser revalidados em [LiveKit pricing](https://livekit.com/pricing) antes de contratar. | Melhor encaixe com `call_id`, participante e grants. Lock-in moderado no protocolo/SDK, mitigado pelo servidor aberto e pelo adapter; malha, analytics e revogação do Cloud não migram automaticamente ao self-host. |
| **LiveKit self-hosted** | Mesmas primitivas, mas Egress é um serviço adicional a operar. Screen share permanece no SDK. | Prometheus e instrumentação própria; sem o dashboard/Analytics Cloud. Consulte [deployment](https://docs.livekit.io/transport/self-hosting/deployment/). | Sem licença do servidor; custo real inclui hosts SFU, rede, TURN, Redis, Egress, armazenamento, observabilidade, upgrades e plantão. | Boa portabilidade de SDK/protocolo a partir do Cloud, com grande aumento do ônus operacional. |
| **Cloudflare Realtime SFU** | Screen share é uma track. Gravação exige pipeline próprio; o [adapter WebSocket](https://developers.cloudflare.com/realtime/sfu/media-transport-adapters/websocket-adapter/) está em beta e não equivale à composição A/V atual. | Há uso por app/sessão/track, mas QoE de produto precisa ser instrumentada pelo NOrium. | US$ 0,05/GB de saída e primeiros 1.000 GB/mês gratuitos na consulta; validar em [pricing](https://developers.cloudflare.com/realtime/sfu/pricing/). | Pouco acoplamento ao modelo de sala, mas alto trabalho de sinalização, presença, reconexão, gravação e QoE; API de sessões/tracks continua proprietária. |
| **mediasoup v3** | Screen share é produtor de mídia. Gravação/transcoding exige PlainTransport e FFmpeg/GStreamer. | Stats RTC, logs e uso por worker, todos agregados e operados pelo NOrium. Consulte [RTC statistics](https://mediasoup.org/documentation/v3/mediasoup/rtc-statistics/). | Licença ISC sem tarifa; infraestrutura, desenvolvimento de plataforma de mídia e operação 24×7 dominam o custo. | Menor lock-in comercial e maior lock-in no código próprio. Exige sidecar/serviço Node.js ou Rust ao lado do FastAPI e reconciliação de dois ciclos de vida. |
| **Daily** | Screen share e permissões integrados; gravação cloud, áudio, local e raw tracks, inclusive [bucket S3 do cliente](https://docs.daily.co/guides/products/live-streaming-recording/storing-recordings-in-a-custom-s3-bucket). | Logs, métricas, reuniões e webhooks; retenção e Advanced Insights variam por plano. | Participant-minutes e gravação. Na consulta, havia 10.000 participant-minutes gratuitos e depois tarifas por modalidade; revalidar em [Daily pricing](https://www.daily.co/pricing/video-sdk/). | Integração rápida e rica, porém maior dependência das APIs e sem saída self-host equivalente. `MediaTransport` contém o acoplamento da UI, mas não elimina tokens, webhooks e gravação proprietários. |

Os preços usam unidades incompatíveis. Uma comparação financeira válida precisa aplicar o mesmo mix de áudio, vídeo, screen share, bitrate, regiões, chamadas simultâneas, retenção e gravação às tarifas vigentes. “Sem licença” não significa “sem custo”: capacidade ociosa, tráfego, segurança, observabilidade e resposta a incidentes precisam entrar no total.

## Por que LiveKit Cloud é a recomendação

- É a menor distância entre a arquitetura atual e um SFU com sala, participante, permissões, screen share, gravação e observabilidade já documentados.
- `Room` pode ser uma projeção de `call_id`; grants curtos se encaixam no backend FastAPI sem expor segredo ao navegador.
- O grupo brasileiro permite validar latência relevante ao público do NOrium, sem confundir disponibilidade de região com garantia de residência ou desempenho medido.
- Cloud e self-host compartilham a família de SDKs e o protocolo, oferecendo uma saída mais realista que a disponível no Daily.
- `MediaTransport` limita o acoplamento e permite manter o mesh enquanto o rollout é validado.

Essa recomendação não é automática. Cloudflare pode vencer se custo por tráfego e preservação do WebRTC bruto dominarem e a equipe aceitar construir gravação e QoE. Daily pode vencer se time-to-market justificar maior lock-in. LiveKit self-host ou mediasoup só devem prevalecer agora se soberania for requisito não negociável e houver capacidade explícita para operar uma plataforma de mídia.

## Evidência do protótipo descartável

O protótipo vive exclusivamente na branch descartável `codex/team-call-sfu-prototype`, commit `1a1c23c9a8a25213fa47a888cfd43822d30351fc`. A partir de `prototypes/team-call-livekit-sfu`, um único comando reproduz a matriz e regrava os dados brutos:

```powershell
npm run prototype
```

A execução de 2026-09-05 usou `livekit-server` self-hosted v1.13.6, com o arquivo oficial validado por SHA-256, `livekit-client` 2.22.2, `livekit-server-sdk` 2.18.0, `playwright-core` 1.63.0, Chrome headless e Node.js 24.18.0. O host tinha Windows 10.0.26200, Intel Core Ultra 7 265KF, 20 processadores lógicos e aproximadamente 31,7 GiB de RAM. Cada participante possuía token de aplicação, JWT LiveKit de 90 segundos, `BrowserContext`, página e sessão independentes.

| Participantes | Conexão p50 | Primeira mídia remota p50 | CPU SFU (100% = 1 core) | Pico RAM SFU | Upload médio por cliente | Estabilidade por 20 s |
| ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 2 | 634 ms | 941 ms | 2,9% | 95,6 MiB | 244,9 Kbit/s | estável |
| 4 | 190 ms | 427 ms | 5,8% | 124,5 MiB | 244,9 Kbit/s | estável |
| 6 | 196 ms | 478 ms | 8,9% | 171,3 MiB | 248,9 Kbit/s | estável |

“Conexão” mede o início de `MediaTransport.join` até `Room.connect`; “primeira mídia remota” vai do início do ingresso até todas as tracks esperadas estarem inscritas. CPU é o delta de tempo de CPU do processo LiveKit dividido pelo tempo de parede; RAM é o pico de working set. Upload é o delta de `outbound-rtp.bytesSent` durante o intervalo estável. A carga usou áudio sintético e vídeo 320×180 a 10 fps, sem simulcast. Não houve erro de página, falha de estado/conexão, desconexão inesperada nem participante com upload zero nos três degraus; ao final, cada cliente observava todos os demais e duas tracks por participante remoto.

Como medida auxiliar, `Performance.TaskDuration` dos renderers foi, em média, 2,07%, 0,63% e 0,88% nos cenários de 2, 4 e 6 participantes; o maior heap JavaScript por cliente foi aproximadamente 4,3, 5,5 e 5,8 MiB. Esses valores **não** representam o working set completo do Chrome.

Com duas sessões, a primeira publicou uma track sintética com source `screen_share`; a segunda a recebeu em **96 ms** e observou sua remoção em **42 ms** após `stopScreenShare`. O endpoint de token recusou autenticação ausente com `401` e associação divergente de equipe/chamada/participante/cliente com `403`; o token válido era restrito à sala, curto e não expôs API secret ao navegador.

### O que esta evidência prova — e o que não prova

Ela prova uma fatia vertical local: contrato estreito de `MediaTransport`, autenticação ligada ao domínio, publicação/assinatura de áudio e câmera, screen share e limpeza, além de estabilidade curta em 2/4/6 sessões independentes. Também confirma a propriedade topológica esperada: o uplink de um cliente deixa de se multiplicar pela quantidade de peers remotos, embora uma publicação possa conter várias tracks e camadas de áudio, câmera, tela e simulcast.

Ela **não** prova LiveKit Cloud. Servidor e navegador rodaram na mesma máquina, em loopback, sem RTT, perda, jitter, NAT ou TURN; portanto os tempos são apenas um piso local. Os participantes tinham contextos isolados, mas compartilhavam o processo de Chrome headless. A mídia sintética era pequena e constante; não houve simulcast, gravação/Egress, rede corporativa, edge brasileiro, região fixa, autoscaling, indisponibilidade de provedor, chamada longa ou renovação de token. Reconexão, revogação em andamento, SLA, residência, custo real e equivalência da gravação continuam para validação condicionada à 8B.

O primeiro cenário inclui aquecimento de servidor, SDK e navegador; os seguintes reutilizam processos quentes. A diferença entre as linhas não deve ser interpretada como curva de escala. Limiares de aceite de latência, custo e capacidade ainda dependem do volume e do SLO do produto; este ADR não inventa esses valores.

## Consequências e riscos

### Consequências positivas

- O uplink deixa de ser multiplicado pela quantidade de peers remotos. Isso não significa literalmente “um upload”: o cliente pode publicar áudio, câmera, tela e múltiplas camadas de simulcast, conforme a política de qualidade.
- Negociação, simulcast, adaptação de qualidade e recuperação passam a usar uma implementação especializada.
- A aplicação preserva seu modelo de domínio e pode trocar adapters sem reescrever drawer e overlay.
- A existência de uma edição self-hosted reduz o risco de saída em relação a um fornecedor apenas hospedado.

### Custos e riscos aceitos se a proposta for aprovada

- O default mesh de 6 participantes é uma escolha conservadora de engenharia causada por um requisito truncado, não uma decisão de produto. Elevá-lo sem medir uplink/CPU de clientes reais ou tratá-lo como promessa pública seria incorreto.
- A recusa de capacidade é atômica no servidor, mas o cliente atual adquire mídia antes do ACK de admissão e só então encerra as tracks ao receber `call_capacity_reached`. Uma futura autorização/preflight pode evitar essa captura transitória, desde que seu desenho preserve idempotência e não crie uma reserva abandonada.
- Haverá dois planos de controle a reconciliar: negócio/presença no NOrium e mídia no LiveKit. Webhooks atrasados, duplicados ou fora de ordem não podem ressuscitar chamada nem participante.
- O backend precisará gerir segredo, TTL, grants, rotação, webhooks e indisponibilidade do provedor. Falha do SFU deve produzir mensagem útil, sem fallback que viole autorização ou capacidade.
- O host atualmente materializa a chamada de negócio em `CALL_INVITE`, enquanto um adapter SFU pode precisar de token antes de abrir a sala. A etapa 8B deve introduzir uma reserva/autorização idempotente e curta antes do ingresso, sem criar chamadas fantasmas; o protótipo não altera nem valida essa ordem no produto.
- O custo varia com minutos, downstream, resolução, assinaturas e Egress; sem dados de uso não existe estimativa confiável.
- Pinning brasileiro e Analytics API dependem do plano Scale. Fixar `sa` reduz opções automáticas de failover e o grupo brasileiro documentado possui uma localização.
- A saída self-hosted preserva SDK/protocolo, mas perde serviços gerenciados e exige Redis, TURN/TLS, balanceamento, Egress, métricas, atualizações e plantão.
- E2EE entra em tensão com gravação: um Egress que interpreta mídia precisa receber a chave ou a política deve escolher outra forma de gravação. Consentimento e indicador nunca podem ser contornados pelo adapter.
- O SDK pode contaminar o produto se seus tipos ou IDs ultrapassarem `MediaTransport`; revisão automatizada e testes de contrato precisam impedir esse vazamento.
- O protótipo local produziu números deliberadamente limitados por loopback. Ele não comprova LiveKit Cloud nem TURN/TLS; validação em região real, redes corporativas e CGNAT continua necessária antes de qualquer rollout. O bloqueio externo já registrado para o teste relay-only permanece independente desta recomendação.

## Plano de migração condicionado à aprovação

### Etapa 8A — concluir e parar

1. Manter o limite determinístico do mesh e o erro acessível acima da capacidade.
2. Manter `MediaTransport` como limite profundo e testável por chamada, com o adapter mesh compatível e a seleção persistida pelo servidor.
3. Preservar o default conservador de 6 somente enquanto o responsável não confirmar o limite público do mesh.
4. Manter anexadas as medições reais da fatia vertical descartável e suas limitações.
5. Submeter este ADR, as implicações de privacidade e o modelo preliminar de custo ao responsável.

### Etapa 8B — somente depois de `status: accepted`

1. Implementar o provider backend para token curto e reconciliação de webhooks, mantendo `CallCoordinator` como autoridade.
2. Implementar `LiveKitMediaTransport` contra o contrato normalizado, incluindo montagem/desmontagem, reconexão, múltiplas abas, revogação, mute, câmera e screen share.
3. Fixar o transporte no registro da chamada e selecionar o SFU somente para uma coorte interna. Não espelhar mídia real simultaneamente para mesh e SFU.
4. Validar edge/região brasileira, redes restritivas, observabilidade sanitizada, carga, degradação do provedor e rollback de chamadas novas.
5. Integrar Egress ao coordenador de gravação somente após decidir E2EE, custódia, consentimento, quotas, retenção e resposta a falhas.
6. Expandir gradualmente por equipe e tamanho da chamada com métricas/SLO aprovados. Manter mesh apenas para chamadas dentro de seu limite e como rollback explícito para chamadas novas.
7. Remover negociação mesh somente quando não houver chamadas ou clientes compatíveis dependentes, a gravação tiver equivalência comprovada e o plano de saída tiver sido exercitado.

O rollback troca a política de seleção apenas para chamadas ainda não criadas. Uma chamada ativa nunca migra de transporte no meio da sessão; ela termina no adapter que recebeu ao nascer.

## Questões que o responsável precisa decidir

1. Mídia em Cloud gerenciado é aceitável? Existe obrigação de residência no Brasil ou apenas objetivo de latência?
2. E2EE contra o operador do SFU é obrigatória? Em caso afirmativo, gravação será desabilitada, feita no cliente ou executada por participante gravador autorizado a receber a chave?
3. Qual prioridade domina a decisão: prazo, custo variável, soberania ou flexibilidade de protocolo?
4. Quais são o volume esperado, chamadas simultâneas, participant-minutes, bitrate, screen share e gravações?
5. O plano Scale é aceitável para pinning e Analytics, ou essas capacidades precisam ser substituídas pela telemetria do NOrium?
6. Quais SLOs e limiares mínimos tornam as medições do protótipo aceitáveis?

## Ponto de parada

Este ADR permanece **Proposto — aguardando decisão do responsável**. A pesquisa, o limite de coexistência, a fronteira de transporte e as medições locais encerram a etapa 8A; elas não autorizam adoção. Até aprovação explícita (`status: accepted`), ficam fora de escopo: criar conta ou recurso LiveKit Cloud, inserir segredo de produção, alterar o transporte padrão, migrar gravações, provisionar infraestrutura, iniciar a etapa 8B ou fazer deploy.
