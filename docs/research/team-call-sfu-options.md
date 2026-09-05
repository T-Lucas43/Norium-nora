# Pesquisa de opções SFU para chamadas de equipe

**Data da consulta:** 4–5 de setembro de 2026
**Escopo:** insumo factual para o ADR da próxima etapa; nenhuma decisão de produção é tomada neste documento.
**Fontes:** somente documentação, repositórios, preços e páginas de segurança mantidos pelos fornecedores/projetos avaliados.

## Como ler este documento

- **Fato oficial** reproduz uma capacidade, limite ou responsabilidade que a fonte primária declara.
- **Inferência para o NOrium** é uma conclusão de engenharia baseada nessa capacidade e na arquitetura observada no repositório; não é promessa do fornecedor.
- **Lacuna a validar** significa que a documentação oficial consultada não foi suficiente. Ausência de documentação não é tratada como prova de ausência da funcionalidade.

O contexto local usado para as inferências é o seguinte: o backend é FastAPI e já concentra identidade, associação à equipe e ciclo de vida em `CallCoordinator`; o frontend React possui uma `CallSession` que hoje controla um transporte WebRTC mesh; o chat e a gravação têm contratos próprios. Portanto, a alternativa de mídia deve permitir que autorização e estado de negócio continuem pertencendo ao NOrium e que mesh e SFU coexistam temporariamente atrás de `MediaTransport`.

## Resumo executivo

| Opção | Operação | Nível da API | Autenticação | Região relevante ao Brasil | Gravação | Observabilidade | Custo publicado | Portabilidade provável |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| LiveKit Cloud | Gerenciada | Sala/participante/faixa; SDKs de cliente e servidor | JWT com grants emitido pelo backend | Edge global; grupo `sa` no Brasil, com pinning no plano Scale | Egress nativo | Dashboard; Analytics API no Scale | Plano + minuto de conexão + downstream + egress | Alta entre Cloud e LiveKit self-host; média fora do protocolo LiveKit |
| LiveKit self-hosted | Autogerenciada | A mesma família de SDKs/protocolo | JWT com grants; revogação exige TTL curto na edição self-hosted | Somente onde o time implantar; multi-região exige Redis, roteamento e operação | Egress é serviço separado | Prometheus e instrumentação própria | Sem licença de software; infraestrutura e operação | Alta dentro do ecossistema LiveKit; servidor Apache-2.0 |
| Cloudflare Realtime SFU | Gerenciada | Sessão/faixa WebRTC, deliberadamente sem sala/presença | App ID/secret no backend; autorização é responsabilidade da aplicação | Anycast/global, centenas de cidades; sem pinning regional específico documentado para o SFU bruto | Pipeline próprio; adapter WebSocket ainda beta | Uso por app/sessão/faixa; QoE deve ser montada pela aplicação | US$ 0,05/GB de saída; primeiros 1.000 GB/mês gratuitos | Média: WebRTC bruto facilita coexistência, mas a API de sessões/faixas é proprietária |
| mediasoup v3 | Autogerenciada | Biblioteca SFU de baixo nível em Node.js/Rust + cliente JS | Não fornece sinalização nem autenticação | Somente onde o time implantar | Pipeline próprio via PlainTransport + FFmpeg/GStreamer | Stats, logs e resource usage; agregação própria | Licença ISC, sem tarifa de software; infraestrutura/operação | Alta no controle do produto, mas alto custo de construção e sidecar fora do FastAPI |
| Daily | Gerenciada | Sala/participante; SDK e componentes React | Meeting token JWT com sala, expiração e permissões | AWS `sa-east-1` em São Paulo e seleção `geo` | Cloud, áudio, local e raw tracks; S3 do cliente | Logs/métricas, reuniões e webhooks; Advanced Insights é adicional | 10 mil participant-minutes grátis; depois tarifa por participant-minute e por gravação | Média-baixa: integração rápida, porém APIs e plano de mídia são proprietários |

Essa tabela não transforma unidades de preço distintas em um ranking. Cloudflare cobra bytes enviados, LiveKit combina conexão e downstream, Daily cobra participant-minutes, e as opções autogerenciadas transferem a conta para infraestrutura, plantão e engenharia.

## 1. LiveKit Cloud e LiveKit self-hosted

### Fatos oficiais

#### Hospedagem e topologia

- O LiveKit pode ser usado como serviço gerenciado ou autohospedado. A comparação oficial descreve o self-host como um SFU *single-home*, gerenciado pelo cliente, e o Cloud como uma malha SFU global na qual cada usuário entra pelo edge mais próximo. O self-host oferece mídia, Egress, Ingress, E2EE e webhooks, mas Egress/Ingress são serviços separados que o cliente precisa implantar. [Self-hosting overview](https://docs.livekit.io/transport/self-hosting/)
- O modo distribuído self-hosted usa Redis como armazenamento compartilhado e barramento. Multi-região também requer DNS/load balancer sensível a geografia/latência e seleção de nós por região e carga. [Distributed multi-region](https://docs.livekit.io/transport/self-hosting/distributed/)
- O servidor e os SDKs principais são código aberto; o servidor declara licença Apache-2.0. [Repositório oficial do LiveKit Server](https://github.com/livekit/livekit)

#### Autenticação e autorização

- O frontend entra com um JWT gerado no backend; o segredo de API não deve ir ao cliente. A documentação fornece inclusive um exemplo de endpoint FastAPI e recomenda um token com TTL de dez minutos. [Endpoint token generation](https://docs.livekit.io/frontends/build/authentication/endpoint/)
- Grants permitem limitar sala, publicação, assinatura, dados, fontes publicáveis, administração e gravação. [Access tokens & grants](https://docs.livekit.io/frontends/reference/tokens-grants/)
- Há uma diferença operacional importante: LiveKit Cloud registra um corte de revogação quando permissões mudam ou o participante é removido; no self-host, remover/alterar permissões não invalida o JWT antigo e a própria documentação recomenda tokens de TTL curto e recusa do backend em reemitir acesso. [Access tokens & grants — revocation](https://docs.livekit.io/frontends/reference/tokens-grants/)

#### Regiões e latência

- Cloud conecta o usuário ao edge mais próximo por padrão. A lista oficial consultada contém o grupo de região `sa`, localizado no Brasil. Esse grupo tem uma localização e, por isso, não oferece redundância dentro da região. [Regions and endpoints](https://docs.livekit.io/deploy/admin/regions/endpoints/)
- Pinning restringe o tráfego a um grupo regional, desabilita failover automático para a região global mais próxima e está disponível no Scale ou superior. [Region pinning](https://docs.livekit.io/deploy/admin/regions/region-pinning/)
- A página de preços anuncia transporte mundial abaixo de 250 ms e alvo de 99,99% de disponibilidade; isso é uma declaração do fornecedor, não uma medição feita a partir do ambiente NOrium. [LiveKit pricing](https://livekit.com/pricing)

#### Gravação e screen share

- Egress grava uma sala, participante ou faixa e pode produzir MP4/WebM/OGG, HLS, RTMP/SRT, WebSocket ou arquivos em armazenamento do cliente, dependendo do modo. [Egress API](https://docs.livekit.io/reference/other/egress/api/) e [output options](https://docs.livekit.io/transport/media/ingress-egress/egress/outputs/)
- Participant Egress acompanha mute/unpublish automaticamente e pode incluir vídeo e áudio do compartilhamento de tela. [Participant and TrackComposite egress](https://docs.livekit.io/transport/media/ingress-egress/egress/participant/)
- Screen share é suportado nativamente pelos SDKs e publicado como faixa de vídeo; áudio de tela depende do suporte da plataforma/navegador. [Screen sharing](https://docs.livekit.io/transport/media/screenshare/)

#### Observabilidade

- LiveKit Cloud possui dashboard de sessões e métricas. A Analytics API, restrita ao Scale ou superior, expõe sessão, participantes, qualidade, bitrate, tempo de conexão, região, tipo de conexão e fontes publicadas. [Analytics API](https://docs.livekit.io/deploy/admin/analytics-api/)
- Self-host pode expor métricas Prometheus; a documentação de implantação mostra `prometheus_port` e recomenda hardware otimizado para CPU e rede de 10 Gbps ou mais em produção. [Deploying LiveKit](https://docs.livekit.io/transport/self-hosting/deployment/)

#### Custo

Valores observados em 4–5 de setembro de 2026; devem ser revalidados antes de contratar:

- Build custa US$ 0/mês e inclui 5.000 minutos WebRTC e 50 GB de downstream.
- Ship começa em US$ 50/mês, inclui 150.000 minutos e 250 GB; excedentes publicados são US$ 0,0005/minuto e US$ 0,12/GB.
- Scale começa em US$ 500/mês, inclui 1,5 milhão de minutos e 3 TB; excedentes publicados são US$ 0,0004/minuto e US$ 0,10/GB.
- Egress transcodificado e Track Egress têm franquias e tarifas próprias; no Ship, por exemplo, a página publica US$ 0,02/minuto de vídeo transcodificado e US$ 0,001/minuto por Track Egress depois da franquia.

Fonte única para os números: [LiveKit pricing](https://livekit.com/pricing). A documentação de faturamento esclarece que mídia é medida por tempo e transferência e que cada sessão WebRTC tem mínimo de dez segundos. [Cloud billing](https://docs.livekit.io/deploy/admin/billing/)

No self-host não há licença do servidor, mas a documentação torna explícitos os componentes que passam a ser custo do operador: nós SFU, Redis, TURN, balanceamento, TLS, Egress, armazenamento, métricas, capacidade de CPU/rede, atualizações e plantão.

#### Privacidade e lock-in

- LiveKit oferece E2EE para mídia e data channels tanto em Cloud quanto self-host, sem custo adicional. A aplicação é responsável por gerar e distribuir as chaves; sinalização e chamadas de API continuam apenas protegidas em trânsito e legíveis pelo servidor. [Encryption overview](https://docs.livekit.io/transport/encryption/)
- Com E2EE real, qualquer gravador/compositor que precise interpretar mídia precisa receber a chave como participante confiável ou a sala precisa usar outra política. A documentação oficial de E2EE prova que intermediários não conseguem ler conteúdo, mas não fecha no mesmo documento o desenho de consentimento/chaves para Egress; essa compatibilidade deve ser validada no protótipo e com o fornecedor.
- A licença aberta, os SDKs comuns e o protocolo compartilhado reduzem o lock-in entre LiveKit Cloud e self-host. Não eliminam o lock-in: malha global, revogação de token, analytics e operação gerenciada são capacidades do Cloud que não migram automaticamente para a edição self-hosted.

### Inferências para o NOrium

- É a menor distância arquitetural para uma fatia vertical segura: FastAPI pode continuar decidindo equipe, participante, função e revogação, emitindo um JWT restrito à sala; React pode implementar um adapter `LiveKitMediaTransport` sem entregar regras de negócio ao SDK.
- O conceito de `Room` mapeia naturalmente para `call_id`, e `Participant.identity` pode receber um identificador opaco de usuário/cliente. O `CallCoordinator` deve permanecer a fonte de verdade e reconciliar webhooks/eventos LiveKit, em vez de delegar associação à equipe ao provedor.
- A mesma interface cliente permite provar LiveKit Cloud primeiro e preservar uma saída self-hosted. Essa saída não é gratuita: seria preciso operar a pilha completa e reimplementar revogação forte com TTL curto e coordenação do NOrium.
- O SDK LiveKit substitui grande parte do código de negociação perfeita/ICE do mesh. Para coexistência, `CallSession` deve consumir somente o snapshot normalizado de `MediaTransport`; tipos `Room`, `RemoteParticipant` e `LocalTrack` não devem vazar para drawer/overlay.

### Lacunas a validar

- RTT real do edge brasileiro e comportamento entre participantes no Brasil e fora dele.
- Compatibilidade entre E2EE, gravação atual do produto, indicadores/consentimento e retenção.
- Semântica exata de revogação durante reconexões longas e múltiplas abas.
- Custo real com o mix de áudio, câmera, screen share, bitrate adaptativo e egress do NOrium.

## 2. Cloudflare Realtime SFU

### Fatos oficiais

#### Hospedagem, topologia e responsabilidades

- Realtime SFU é um serviço gerenciado que roda na rede global da Cloudflare em centenas de cidades. Cada cliente mantém uma sessão correspondente a um `RTCPeerConnection` com o datacenter anycast mais próximo; faixas publicadas ficam disponíveis globalmente no app. [Realtime SFU overview](https://developers.cloudflare.com/realtime/sfu/) e [Sessions and Tracks](https://developers.cloudflare.com/realtime/sfu/sessions-tracks/)
- A API é deliberadamente de baixo nível e não fornece SDK, sala, participante, presença ou papéis. O aplicativo decide quem publica/assina, armazena IDs de sessão/faixa e implementa sinalização e presença. [Introduction](https://developers.cloudflare.com/realtime/sfu/introduction/)
- Sessões têm até 50 chamadas de API por segundo; faixas são coletadas após 30 segundos sem pacotes; a documentação recomenda detecção e reconexão pela aplicação e informa uma janela de 30 segundos para reaproveitamento. [Limits, timeouts and quotas](https://developers.cloudflare.com/realtime/sfu/limits/)

#### Autenticação e autorização

- Criar um App produz App ID e App Secret para chamadas backend→Realtime. [Quickstart](https://developers.cloudflare.com/realtime/sfu/get-started/)
- O backend deve guardar o segredo, autenticar o usuário, autorizar publish/subscribe/control e proteger IDs de sessão/faixa contra uso cruzado. A própria documentação alerta que IDs expostos podem ser usados para fechar faixas alheias se o backend não autenticar corretamente. [Connection API](https://developers.cloudflare.com/realtime/sfu/https-api/)

#### Regiões e latência

- A Cloudflare descreve a solução como global, sem regiões dedicadas, usando anycast para o ponto mais próximo e backbone global para a mídia. [Realtime versus regular SFUs](https://developers.cloudflare.com/realtime/sfu/calls-vs-sfus/)
- A documentação do SFU bruto consultada não oferece um contrato equivalente ao pinning `sa` do LiveKit ou ao `geo=sa-east-1` do Daily. Portanto, não se deve prometer residência de mídia no Brasil sem confirmação contratual específica.

#### Gravação, screen share e observabilidade

- O SFU roteia qualquer `MediaStreamTrack`; a documentação de simulcast cita explicitamente câmeras e screen shares e permite seleção de camada por faixa. Captura, permissões e UX continuam no aplicativo. [Simulcast](https://developers.cloudflare.com/realtime/sfu/simulcast/)
- Para gravação, a documentação do SFU aponta Media Transport Adapters para enviar mídia a sistemas de processamento/armazenamento. O adapter WebSocket está em beta: áudio sai como PCM e vídeo como JPEG em aproximadamente 1 fps, adequado a áudio/arquivamento ou snapshots, não comprovado como substituto direto de uma gravação composta 30 fps. [Media Transport Adapters](https://developers.cloudflare.com/realtime/sfu/media-transport-adapters/) e [WebSocket adapter](https://developers.cloudflare.com/realtime/sfu/media-transport-adapters/websocket-adapter/)
- RealtimeKit, produto de reunião separado construído sobre o SFU, possui API de gravação; isso não deve ser atribuído automaticamente ao SFU bruto. [RealtimeKit recordings API](https://developers.cloudflare.com/api/resources/realtime_kit/subresources/recordings/)
- A documentação informa que uso pode ser consultado nos níveis App, Session e Track. Não foi encontrada, nas páginas oficiais do SFU consultadas, uma API de QoE comparável à Analytics API do LiveKit ou aos logs/métricas do Daily. ICE/DTLS, conexão, bitrate, packet loss e correlação com `call_id` teriam de ser coletados pelo NOrium, sujeitos à política de não registrar candidatos/IPs.

#### Custo

- O preço publicado é US$ 0,05 por GB enviado da Cloudflare para clientes, tanto no SFU quanto no TURN. O primeiro 1.000 GB agregado por mês é gratuito; upload do cliente para a Cloudflare não é cobrado; SFU+TURN no mesmo caminho não é cobrado duas vezes. [Realtime SFU pricing](https://developers.cloudflare.com/realtime/sfu/pricing/)
- Esse modelo pode ser econômico para uso inicial, mas o resultado depende diretamente de bitrate, quantidade de faixas assinadas, resolução de screen share e duração. Não é comparável diretamente a participant-minutes sem uma medição de bytes.

#### Privacidade e lock-in

- O serviço evita guardar o modelo de sala/presença do produto: ele conhece sessões e faixas; o estado de negócio permanece na aplicação. Isso reduz acoplamento semântico. [Realtime SFU overview](https://developers.cloudflare.com/realtime/sfu/)
- A documentação oficial consultada não declara E2EE de mídia específico para o SFU bruto nem uma garantia de residência regional. DTLS-SRTP de WebRTC não equivale, por si só, a E2EE contra o SFU. Essas duas propriedades são lacunas de contratação, não capacidades assumidas.
- Não há SDK cliente proprietário, e a Cloudflare afirma que o serviço pode coexistir com P2P. Ainda existe lock-in na API HTTPS de sessão/faixa, IDs e comportamento global do data plane. [Introduction](https://developers.cloudflare.com/realtime/sfu/introduction/)

### Inferências para o NOrium

- É a alternativa que mais reaproveita o `CallCoordinator`: equipe, chamada, presença, múltiplas abas, autorização e heartbeat já precisam continuar no backend. O adapter traduziria `call_id/participant/client/connection` em session IDs e track IDs Cloudflare.
- O frontend continuaria próximo de WebRTC nativo e poderia preservar captura, mute, screen share e telemetria atuais. Isso facilita um `MeshMediaTransport` e um `CloudflareMediaTransport` coexistirem.
- Em troca, a equipe continuaria responsável pelas partes mais difíceis do ciclo de vida: distribuição segura de IDs, subscribe/unsubscribe, recuperação dentro/fora da janela de 30 s, limpeza, autorização a cada mutação e um pipeline de gravação com qualidade de produto.
- É forte candidato se custo por GB e controle de protocolo pesarem mais que time-to-market; é fraco para a etapa atual se gravação pronta, E2EE comprovada e telemetria QoE forem requisitos de entrada.

### Lacunas a validar

- Residência de dados e caminhos reais no Brasil.
- E2EE contra o SFU, suporte oficial e impacto em gravação.
- API/retensão de métricas de qualidade além de contadores de uso.
- Forma suportada de gravação A/V composta e retenção sem depender do adapter beta.

## 3. mediasoup v3

### Fatos oficiais

#### Hospedagem, topologia e autenticação

- mediasoup é uma biblioteca SFU de baixo nível, não um serviço hospedado. O servidor é um módulo Node.js/Rust apoiado por subprocessos C++; o cliente web é `mediasoup-client`. A licença é ISC. [Repositório oficial](https://github.com/versatica/mediasoup) e [licença](https://github.com/versatica/mediasoup/blob/v3/LICENSE)
- Um Worker usa um core; um Router, frequentemente equivalente a uma sala, pertence a um Worker. A documentação orienta distribuir routers entre workers/hosts e usar `pipeToRouter` para topologias maiores; ela deixa a sinalização entre hosts para a aplicação. [Scalability](https://mediasoup.org/documentation/v3/scalability/)
- mediasoup não fornece protocolo de sinalização. WebSocket/HTTP, autenticação, chat, presença e toda troca de parâmetros são responsabilidade do aplicativo. [Communication between client and server](https://mediasoup.org/documentation/v3/communication-between-client-and-server/)

#### Regiões, gravação e screen share

- Não há rede gerenciada de regiões: localização, balanceamento, TURN, failover e residência são exatamente os ambientes implantados pelo operador.
- Para gravação/transcoding/streaming, a documentação orienta criar PlainTransport e conectar FFmpeg, GStreamer ou ferramenta equivalente. É uma primitiva, não um serviço transacional de gravação/retenção. [FFmpeg and GStreamer guidelines](https://mediasoup.org/documentation/v3/communication-between-client-and-server/)
- O SFU trata produtores genéricos de áudio/vídeo. O demo oficial prova screen share, simulcast/SVC, 4K opcional e `contentHint`, mas o produto precisa implementar captura, autorização, UX e testes. [mediasoup-demo](https://github.com/versatica/mediasoup-demo)

#### Observabilidade, custo e privacidade

- A API oferece `getStats()` em transports/producers/consumers, incluindo bytes, bitrate, packet loss, RTT e estados. Também oferece logs por categoria e resource usage por Worker. [RTC statistics](https://mediasoup.org/documentation/v3/mediasoup/rtc-statistics/) e [mediasoup API](https://mediasoup.org/documentation/v3/mediasoup/api/)
- Não há tarifa de software pela licença ISC. Custos abrangem hosts de mídia, egress de rede, TURN, balanceadores, observabilidade, orquestração, FFmpeg/GStreamer, armazenamento, desenvolvimento e operação 24×7.
- A custódia de mídia e metadados pode permanecer integralmente na infraestrutura escolhida. WebRtcTransport negocia ICE e DTLS/SRTP; E2EE contra o SFU não é uma capacidade geral documentada na API principal. O demo oficial possui `e2eKey`, explicitamente limitado a alguns codecs Opus/VP8, portanto não deve ser tratado como política de E2EE pronta. [mediasoup-demo](https://github.com/versatica/mediasoup-demo)

### Inferências para o NOrium

- É a opção com máximo controle e menor dependência comercial, mas maior desvio da stack atual. O processo SFU é Node.js ou Rust; o FastAPI teria de falar com um sidecar/serviço e coordenar duas fontes de estado, falhas e deploy.
- O `CallCoordinator` pode continuar como autoridade, porém seria necessário desenhar comandos e eventos internos para criar Router/Transport/Producer/Consumer, distribuir rooms por workers, recuperar crash de worker e impedir vazamento cruzado de IDs.
- A gravação segura construída na etapa anterior não migra sozinha: o pipeline precisaria ingerir RTP, compor/faixas, manter quotas/consentimento/auditoria/retention e reconciliar falhas de FFmpeg.
- Faz sentido se soberania, customização e volume justificarem uma equipe de mídia/infra. Não é a melhor primeira fatia vertical para obter evidência rapidamente no time atual.

### Lacunas a validar

- Dimensionamento real por core com codecs, simulcast e resolução do NOrium; o número de “~500 consumers” na página oficial é aproximado e dependente de host.
- Arquitetura de alta disponibilidade e drenagem sem perda de sala.
- TURN/TLS corporativo e operação multi-região no Brasil.
- Protocolo E2EE e integração com gravador escolhido.

## 4. Daily

### Fatos oficiais

#### Hospedagem e autenticação

- Daily é uma plataforma gerenciada com REST API, `daily-js`, hooks React e uma UI Prebuilt; para UI própria, a documentação recomenda o call object. [Daily documentation](https://docs.daily.co/) e [Daily call client](https://docs.daily.co/reference/daily-js/daily-call-client)
- Salas podem ser privadas. Meeting tokens podem ser restritos à sala, `nbf`, `exp`, expulsão na expiração, owner e permissões granulares de enviar/receber/admin. A documentação recomenda sempre definir `room_name` para controle de acesso e `exp` para tokens. [Create meeting token](https://docs.daily.co/reference/rest-api/meeting-tokens/create-meeting-token)

#### Regiões e latência

- Daily declara servidores em várias regiões AWS. O primeiro participante determina a região automaticamente por Route 53, mas `geo` pode fixá-la; a lista oficial inclui `sa-east-1` em São Paulo. A mesma documentação alerta que escolher pela localização do primeiro participante pode ser subótimo para os demais. [Create room — `geo`](https://docs.daily.co/reference/rest-api/rooms/create-room)
- A página institucional declara 75+ pontos de presença, mediana de 13 ms no primeiro salto e disponibilidade de 99,99%; são métricas do fornecedor, não resultados do protótipo NOrium. [Daily](https://www.daily.co/)

#### Gravação e screen share

- Sala/token controla screen share e permissões `canSend` distinguem vídeo, áudio, screen video e screen audio. O ecossistema possui hooks/demos React para interface customizada. [Create room](https://docs.daily.co/reference/rest-api/rooms/create-room) e [official demos](https://docs.daily.co/guides/additional-resources/demos)
- Gravação suporta modos cloud, cloud-audio-only, local e raw tracks; a REST API inicia múltiplas instâncias até o limite contratado e pode retornar 503 quando faltam workers. [Start recording](https://docs.daily.co/reference/rest-api/rooms/recordings/start)
- É possível gravar diretamente em bucket S3 do cliente; nesse modo Daily declara que não guarda o arquivo em seus próprios servidores. [Custom S3 recording](https://docs.daily.co/guides/products/live-streaming-recording/storing-recordings-in-a-custom-s3-bucket)

#### Observabilidade

- A API `/logs` retorna logs e, opcionalmente, métricas filtradas por reunião e participante. [List logs](https://docs.daily.co/reference/rest-api/logs/list-logs)
- Há REST API de reuniões/presença e webhooks de início/fim, entrada/saída, gravação, transcrição e streaming. [Webhooks](https://docs.daily.co/reference/rest-api/webhooks)
- A tabela de preços coloca Advanced Insights como adicional de US$ 500/mês para cinco assentos; retenção de métricas/logs publicada é um dia sem cartão e três dias com cartão, salvo planos de suporte. [Daily pricing](https://www.daily.co/pricing/video-sdk/)

#### Custo

Valores observados em 4–5 de setembro de 2026; devem ser revalidados antes de contratar:

- primeiros 10.000 participant-minutes/mês gratuitos;
- faixa seguinte a US$ 0,004 por participant-minute de vídeo/áudio e US$ 0,00099 para sessão somente áudio, com descontos graduais por volume;
- gravação cloud de vídeo a US$ 0,01349 por minuto gravado, armazenamento adicional a US$ 0,003/minuto e gravação apenas de áudio a US$ 0,005/minuto;
- Regional Media Zones são listadas como gratuitas; firewall avançado/IP proxy/TURN override custa US$ 500/mês.

Fonte: [Daily Video pricing](https://www.daily.co/pricing/video-sdk/).

#### Privacidade e lock-in

- Daily declara TLS de 256 bits, AES-256 para áudio/vídeo em trânsito, E2EE disponível, SOC 2 Type 2, GDPR e opção HIPAA/BAA. Também declara não armazenar áudio, vídeo ou screen share fora das APIs explícitas de gravação. [Security and privacy at Daily](https://www.daily.co/products/security-at-daily/)
- Reuniões, tokens, permissões, eventos, faixas e gravações seguem APIs proprietárias. Há SDKs React maduros, mas não foi encontrada uma edição autohospedada equivalente do SFU Daily na documentação oficial consultada.

### Inferências para o NOrium

- É uma integração hospedada rápida: FastAPI cria sala privada/token curto depois da autorização da equipe, e um `DailyMediaTransport` traduz eventos do call object para o snapshot existente.
- A riqueza de permissões, gravação, webhooks e logs reduz código novo. Em contrapartida, cria dois ciclos de vida — `CallCoordinator` e sala Daily — que precisam de reconciliação determinística para expulsão, múltiplas abas e idempotência.
- Fixar São Paulo é favorável ao público brasileiro, mas uma sala de equipes distribuídas pode sofrer com single-region; a escolha automática pelo primeiro participante também precisa de teste.
- A migração futura para self-host é maior que no LiveKit porque não existe um servidor Daily equivalente aberto. `MediaTransport` limita esse impacto na UI, mas o backend ainda precisaria substituir tokens, webhooks, recording e semântica de participantes.

### Lacunas a validar

- Termos e implementação de E2EE em conjunto com cloud recording.
- QoE e retenção disponíveis sem o add-on Advanced Insights.
- Comportamento de expulsão/revogação durante reconnect e múltiplas abas.
- Custos reais de screen share, áudio apenas e gravação no mix NOrium.

## 5. Comparação orientada aos critérios do ADR

### Hospedado versus autogerenciado

- **Menor esforço operacional:** LiveKit Cloud e Daily.
- **Serviço global baixo nível:** Cloudflare Realtime SFU.
- **Caminho hospedado→self-host com API semelhante:** LiveKit.
- **Máximo controle, máximo ônus:** mediasoup.

### Autenticação

- **Modelo mais alinhado ao FastAPI atual:** LiveKit JWT grants e Daily meeting token, ambos emitidos depois da autorização interna.
- **Mais responsabilidade no NOrium:** Cloudflare e mediasoup. Isso preserva controle, mas amplia a superfície de autorização de IDs, publish/subscribe e limpeza.
- Em todas as opções, associação à equipe e função continuam sendo decisões do `CallCoordinator`; nunca se deve aceitar room/session/track IDs do cliente como prova de acesso.

### Regiões e latência

- **Brasil explicitamente disponível:** LiveKit Cloud (`sa`, Brasil) e Daily (`sa-east-1`, São Paulo).
- **Global anycast sem gestão de região:** Cloudflare, mas sem garantia específica de pinning/residência encontrada.
- **Controle total:** LiveKit self-host e mediasoup, ao custo de implantar e operar cada região.

### Gravação

- **Pronta e documentada:** LiveKit Egress e Daily cloud/raw/S3.
- **Exige pipeline de aplicação:** mediasoup.
- **Ainda insuficiente para a gravação atual sem trabalho adicional:** Cloudflare SFU bruto; o adapter WebSocket beta não entrega uma composição A/V equivalente.

### Screen share

Todas podem transportar screen share. LiveKit e Daily têm API/SDK explícita e permissões integradas; Cloudflare e mediasoup tratam tela como faixa de mídia e deixam captura, autorização, prioridade e UX ao produto.

### Observabilidade

- **Mais pronta no serviço:** LiveKit Cloud; Analytics exportável requer Scale.
- **Pronta, porém retenção/add-on relevantes:** Daily.
- **Primitivas para stack própria:** LiveKit self-host e mediasoup.
- **Lacuna QoE maior:** Cloudflare SFU bruto, onde a aplicação deve instrumentar cliente e backend.

### Custo

- **Entrada potencialmente mais barata:** Cloudflare por causa de 1.000 GB gratuitos, desde que o tráfego medido confirme a hipótese.
- **Mais previsível por participante/duração:** Daily.
- **Franquias grandes e custo composto:** LiveKit Cloud; é preciso modelar minutos, downstream e gravação.
- **Sem tarifa de licença, não sem custo:** LiveKit self-host e mediasoup; a comparação precisa atribuir custo a capacidade ociosa, egress, observabilidade, upgrades, incidentes e equipe.

### Privacidade

- **Maior custódia de infraestrutura:** LiveKit self-host e mediasoup.
- **E2EE documentada de forma mais técnica:** LiveKit; Daily também declara E2EE disponível, mas a interação com gravação precisa de validação.
- **Lacuna contratual/técnica:** Cloudflare SFU bruto para E2EE contra o SFU e residência regional.
- Gravação sempre muda o modelo de ameaça: um gravador que produz mídia utilizável é um participante confiável ou um ponto onde a mídia deixa de ser E2EE. Consentimento, chaves, auditoria e retenção precisam constar do ADR independentemente do provedor.

### Lock-in e integração

- **Menor lock-in de infraestrutura com integração rápida:** LiveKit, pois Cloud e self-host compartilham protocolo/SDK e o servidor é aberto.
- **Menor lock-in de modelo de produto, porém API proprietária:** Cloudflare mantém sala/presença no NOrium e fala WebRTC bruto.
- **Menor lock-in comercial e maior código próprio:** mediasoup.
- **Maior time-to-value e maior dependência de produto:** Daily.

## 6. Recomendação provisória, com tradeoffs explícitos

Para a fatia vertical descartável, a opção mais equilibrada é **LiveKit Cloud, encapsulado por `MediaTransport`, mantendo LiveKit self-hosted como saída arquitetural**.

Razões:

1. Existe exemplo oficial FastAPI para emissão de token, SDK React/JS maduro, screen share e Egress, reduzindo o protótipo a integração em vez de reconstrução de SFU.
2. Sala/participante/grants mapeiam bem para `call_id`, participant/client e autorização existente.
3. O edge brasileiro é explícito e a mesma API pode ser testada contra um servidor self-hosted.
4. E2EE, telemetria e gravação têm documentação suficiente para identificar claramente o que ainda precisa ser provado.

Tradeoffs que impedem tratar a recomendação como escolha automática:

- O Cloud cobra por três dimensões relevantes e pode custar mais que Cloudflare em alto tráfego.
- Pinning e Analytics API exigem Scale, hoje a partir de US$ 500/mês.
- O caminho self-host perde capacidades do Cloud e cria um ônus significativo de Redis, TURN, Egress, multi-região e observabilidade.
- E2EE e gravação precisam de uma decisão explícita sobre chave do gravador; o protótipo não deve ocultar isso.
- Adotar objetos LiveKit fora do adapter criaria lock-in na UI; o limite `MediaTransport` é condição da recomendação.

**Alternativa se o decisor priorizar custo de rede e preservação integral do protocolo atual:** Cloudflare Realtime SFU. Antes, porém, o fornecedor deve responder sobre E2EE/residência e o time deve aceitar construir gravação e QoE.

**Alternativa se o decisor priorizar menor tempo de produto e aceita lock-in hospedado:** Daily.

**Alternativa se soberania/autogestão for requisito não negociável e houver equipe de mídia:** LiveKit self-host antes de mediasoup. mediasoup só passa à frente quando controle de baixo nível justificar um serviço Node/Rust e toda a plataforma operacional própria.

## 7. Hipóteses verificáveis para o protótipo

O protótipo não deve “provar” produção; deve tentar refutar as seguintes hipóteses:

1. FastAPI consegue emitir credencial curta somente depois de validar equipe, chamada ativa e participante, sem expor segredo de provedor.
2. Dois adapters, `MeshMediaTransport` e `LiveKitMediaTransport`, podem produzir o mesmo snapshot/commands consumido pela `CallSession`.
3. A escolha de transporte rejeita determinística e antecipadamente uma chamada acima do limite suportado pelo mesh, com código estável e mensagem útil, sem criar mídia parcial.
4. Duas ou mais sessões independentes entram, publicam áudio/vídeo sintético, recebem participantes e saem sem participante fantasma.
5. Revogar equipe/usuário fecha imediatamente o transporte SFU e a mídia local.
6. Screen share, mute e reconexão não vazam tipos do SDK para overlay/drawer.
7. Telemetria expõe tempo de entrada, CPU, memória e bytes enviados sem IP, SDP ou candidatos.
8. O caminho de gravação escolhido publica os mesmos estados auditáveis de início/parada/falha e respeita consentimento e retenção.

## 8. Perguntas que exigem decisão do responsável

1. Cloud gerenciado é aceitável para mídia de equipe? Há requisito formal de residência no Brasil?
2. E2EE contra o operador do SFU é obrigatório? Se sim, gravação deve ser desabilitada, client-side ou realizada por um participante gravador que recebe a chave?
3. Qual métrica domina: prazo, custo variável, soberania ou flexibilidade de protocolo?
4. Qual volume esperado de participant-minutes, bitrate médio, chamadas concorrentes e gravações?
5. A organização aceita o plano Scale para pinning/analytics ou precisa reproduzir isso na telemetria própria?
6. Qual é o limite público de membros por chamada e o comportamento desejado acima dele durante a coexistência mesh/SFU?

Até essas respostas e as medições da fatia vertical estarem anexadas ao ADR, a recomendação permanece provisória e nenhuma etapa de migração de produção deve começar.
