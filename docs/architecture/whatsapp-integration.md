# WhatsAppIntegration: módulo profundo da integração WhatsApp

Este documento define o desenho e acompanha a migração incremental do módulo
`WhatsAppIntegration`. O objetivo é concentrar as invariantes de WhatsApp atrás
de uma Interface pequena, preservando os contratos HTTP já consumidos pelo
frontend.

Aqui, **Módulo** significa a Interface e sua Implementação; **seam** é o ponto em
que uma implementação pode ser trocada sem alterar os chamadores; e **Adapter**
é a implementação concreta de uma Interface em um seam. A profundidade vem do
fato de cinco operações esconderem resolução de tenant e instância,
persistência, criptografia, concorrência, idempotência e o contrato da W-API.

Este documento não substitui:

- o [plano e contrato da W-API](./wapi-integration-plan.md), que continua sendo
  a fonte para endpoints, autenticação do provedor, operação, migração de
  credenciais, rotação e rollback;
- a [matriz de controles de segurança](../SECURITY_CONTROLS.md), que continua
  sendo a fonte para os controles e suas evidências automatizadas.

As correções críticas já aplicadas nesses documentos e no código permanecem
válidas. Esta refatoração muda o lugar em que elas são coordenadas; não relaxa
nem reimplementa seus procedimentos operacionais.

## Estado desta migração

Esta é a única seção que precisa ser atualizada para refletir o avanço da
migração. Os detalhes arquiteturais abaixo descrevem o estado-alvo estável.

Última aferição: **2026-09-01**.

| Marco | Estado nesta aferição | Evidência ou próximo passo |
| --- | --- | --- |
| Package `app/modules/whatsapp` e seam externo | Concluído nesta fatia | Interface, tipos públicos, ports e adapters estão concentrados no package. |
| Interface com os cinco métodos | Concluído | `ensure_connection`, `disconnect`, `send`, `handle_webhook` e `stream_media` são a superfície pública. |
| Port interno da W-API | Concluído nesta fatia | `WApiPort` cobre somente as capacidades usadas e recebe comandos privados já preparados. |
| Adapter em memória | Concluído | Simula ownership, conexão, envio, falhas programáveis, webhook, deduplicação e mídia por tenant. |
| `HttpWApiAdapter` de produção | Concluído | Usa suppliers late-bound sobre os serviços atuais, sem credenciais ou URLs na Interface pública. |
| Rotas delegando ao módulo | Concluído para as cinco operações | Conexão, desconexão, webhook, texto, arquivo e mídia chamam somente a Interface e traduzem o resultado. |
| Invariantes críticas legadas | Preservadas | `wapi_binding` e `wapi_connect` continuam como implementação autoritativa durante a migração. |
| Testes pela Interface do módulo | Concluído nesta fatia | 12 testes de Interface, 4 do Adapter HTTP e 225 regressões W-API passam. |

Ao concluir uma fatia, altere somente o estado e a evidência desta tabela. Não
marque uma rota como migrada enquanto ela ainda resolver binding, credencial,
owner, retry ou persistência diretamente.

## Seam externo e Interface

O seam externo vive no package `app.modules.whatsapp`. Rotas, Nora e outros
chamadores importam somente tipos exportados por esse package; `_ports`,
adapters, binding, cliente HTTP e tipos próprios da W-API são detalhes da
Implementação.

```python
class WhatsAppIntegration:
    async def ensure_connection(self, tenant_id: str) -> ConnectionResult: ...
    async def disconnect(self, tenant_id: str) -> DisconnectResult: ...
    async def send(self, tenant_id: str, command: SendCommand) -> SendResult: ...
    async def handle_webhook(
        self,
        headers: Mapping[str, str],
        payload: Mapping[str, object],
    ) -> WebhookResult: ...
    async def stream_media(self, tenant_id: str, media_id: str) -> MediaStream: ...
```

Esses cinco métodos formam toda a Interface pretendida. Ela inclui também os
erros estáveis, os resultados e as invariantes descritas neste documento.
Detalhes como status/polling não devem ser adicionados por conveniência antes de
se decidir se pertencem a esta Interface ou a outro módulo profundo.

### Tipos e comandos

Os tipos públicos expressam intenção do Norium, não o contrato do provedor:

- `ConnectionResult` contém estado normalizado, QR quando aplicável, telefone e
  indicação de consentimento; não contém `instanceId`, token ou URL da W-API;
- `DisconnectResult` informa somente o resultado local;
- `SendCommand` é a união fechada de `SendText` e `SendMedia`, ambas cobertas
  por testes da Interface;
- um comando de mídia recebe conteúdo validado ou uma referência local opaca,
  nunca uma URL remota controlada pelo provedor;
- `SendResult` expõe o identificador estável necessário ao Norium, sem recibo
  bruto da W-API;
- `WebhookResult` usa estados estáveis como `success`, `duplicate` e `ignored`;
  instância desconhecida é um erro público sanitizado, sem payload do provedor;
- `MediaStream` contém stream ou bytes, MIME validado, tamanho e metadados de
  cache seguros; não revela a URL de origem.

Tokens, API keys, `instanceId` operacional e URLs remotas podem existir nos
tipos privados entre a Implementação e seus adapters. Eles nunca atravessam o
seam externo, nunca entram em `repr`, resposta HTTP, log ou exceção pública.

## Diagrama textual

```text
Cliente HTTP
    |
    | contratos /api/chat/* e /api/whatsapp/webhook preservados
    v
Rotas FastAPI
    | validam forma, tamanho, autenticação/permissão HTTP
    | obtêm somente o tenant autenticado e traduzem resultado/erro
    v
+-------------------------------------------------------------+
| seam externo: WhatsAppIntegration                           |
|                                                             |
|  ensure_connection | disconnect | send | handle_webhook     |
|                                      | stream_media          |
|                                                             |
|  invariantes, resolução tenant<->instância, transições,      |
|  deduplicação, persistência, criptografia e sanitização      |
+----------------------------+--------------------------------+
                             | seams internos, não exportados
                 +-----------+-------------+
                 |                         |
                 v                         v
        WApiPort privado          Persistência/runtime privados
          |          |             wapi_binding, stores, locks,
          |          |             leases, fencing, credenciais
          v          v
 HttpWApiAdapter  InMemoryWApiAdapter
   produção          testes
          |
          v
        W-API
```

O seam externo permanece estável mesmo enquanto a Implementação troca chamadas
diretas aos serviços legados por adapters. Os seams internos existem para
substituir I/O em testes; não são dependências das rotas.

## Port interno da W-API

`WApiPort` é um `Protocol` privado, definido em `_ports.py`. Ele descreve apenas
as capacidades remotas necessárias à Implementação, usando tipos privados do
provedor. Não é um espelho dos 82 endpoints e não é reexportado por
`app.modules.whatsapp`.

O port pode receber um contexto privado já resolvido, com instância e
credencial, e fornecer operações de provisionamento/reconciliação, consulta
segura, envio e download. A escolha de endpoint, autenticação Bearer, query
`instanceId`, timeout, allowlist de origem, recusa de redirects, parsing de
erro e política de retry pertencem ao Adapter HTTP.

Há dois adapters concretos, o que torna o seam real:

- `HttpWApiAdapter`, usado em produção, adapta o port ao transporte HTTP. Na
  primeira etapa ele pode delegar a `WapiClient`, `WapiConnectService` e
  `WapiMessagingService`; isso evita uma reescrita de risco e mantém as
  correções críticas já exercitadas;
- `InMemoryWApiAdapter`, usado nos testes do módulo, mantém estado por tenant,
  contadores de chamadas e respostas/falhas programáveis. Ele deve simular as
  propriedades relevantes do provedor, sem imitar HTTP ou expor fixtures com
  tokens reais.

Persistência e runtime podem usar ports privados próprios quando houver duas
implementações úteis, por exemplo produção e memória. Essa composição interna
não aumenta a Interface de `WhatsAppIntegration`.

## Invariantes explícitas

### Uma instância por tenant

`ensure_connection(tenant_id)` converge chamadas repetidas e concorrentes para
o mesmo vínculo. Um lock `asyncio` por tenant reduz trabalho duplicado dentro do
processo, mas não é a garantia autoritativa. A unicidade deve continuar sendo
aplicada na transação compartilhada de `wapi_binding`.

Chamadas de tenants diferentes não usam um lock global e podem avançar em
paralelo. Uma indisponibilidade transitória ao consultar a W-API não prova que a
instância deixou de existir e, portanto, não autoriza criar uma segunda.

### Um proprietário por instância

Uma instância pertence a no máximo um tenant. Toda resolução feita a partir de
um tenant confirma o owner antes de devolver credenciais internas; toda
resolução reversa de webhook confirma o binding atual antes de persistir. Um
conflito não altera o vínculo anterior de nenhum dos tenants e é traduzido sem
revelar a existência de recursos de outro proprietário.

O `instanceId` recebido em payload, query ou header de uma rota autenticada não
seleciona a instância usada em uma operação. Para conexão, envio, desconexão e
mídia, a instância é sempre resolvida internamente a partir do tenant da sessão.

### Webhook autenticado antes da resolução

`handle_webhook(headers, payload)` executa obrigatoriamente nesta ordem:

1. valida a configuração local do segredo e autentica a chamada com comparação
   constante;
2. somente após autenticar, extrai o `instanceId` do payload;
3. resolve o tenant exclusivamente pelo owner registrado desse `instanceId`;
4. ignora `userId`, tenant ou destino declarado pelo payload;
5. reconfirma que o binding ainda é atual dentro da transição do tenant;
6. deduplica e aplica o evento atomicamente.

Assim, payload não autenticado não dispara consulta de ownership, e um evento
que estava em voo quando ocorreu `disconnect` não repovoa os stores limpos. A
rota HTTP não conhece o segredo nem consulta `wapi_binding`; apenas entrega os
headers recebidos e traduz o resultado estável.

Por compatibilidade com testes e desenvolvimento local, o composition root
mantém uma exceção explícita somente quando não há marcador de ambiente
compartilhado. Produção, staging, Railway e outros ambientes compartilhados
falham fechados se o segredo estiver ausente ou inválido.

### Transições atômicas, leases e fencing

As transições existentes de `wapi_binding` e `wapi_connect` são preservadas e
passam a ser coordenadas por `WhatsAppIntegration`:

- o registro SQLite e o lock interprocesso serializam ownership e lifecycle em
  processos que compartilham `NORIUM_DATA_DIR`;
- um claim de provisionamento elege um único executor por tenant, com lease
  renovável;
- `attempt_id` mais `lease_owner` funcionam como fencing: um executor antigo
  que perdeu o lease não pode gravar resultado, concluir ou desfazer a tentativa
  nova;
- o resultado remoto e a credencial cifrada são registrados antes da promoção
  do binding, e o journal permite recuperar uma escrita interrompida;
- falhas preservam o estado anterior ou deixam um estado explícito e
  reconciliável; nunca uma associação pela metade;
- criação remota com resultado ambíguo é reconciliada por nome determinístico e
  listagem antes de qualquer nova criação.

Locks em memória são otimizações de localidade. Eles não substituem as
transações, leases nem fencing necessários entre processos/réplicas.

Atomicidade aqui significa atomicidade das transições locais de binding,
ownership, lifecycle e deduplicação. Um `send` que cruza HTTP e persistência
local não é, nem finge ser, uma transação distribuída: o módulo serializa
preparação, uma única tentativa remota e persistência, mas sinaliza resultado
ambíguo sem retry quando a conexão falha depois de um possível aceite. Uma
garantia durável de entrega exatamente uma vez exigiria idempotência confirmada
pelo provedor ou um outbox com reconciliação, e permanece trabalho futuro.

### Disconnect é local

`disconnect(tenant_id)` remove o vínculo e os caches do Norium. Ele **não chama**
`/instance/disconnect` e não faz logout remoto, pois isso derrubaria o telefone
e outros aparelhos do usuário.

O binding é invalidado antes da limpeza de conversas, catálogo, Status e caches,
sob a mesma coordenação usada pelos webhooks. Depois disso, tarefas locais são
canceladas e eventos com o binding antigo falham na reconfirmação. Se uma
operação administrativa de logout remoto vier a ser necessária, ela deverá ter
outro nome, autorização e confirmação explícita; não altera a semântica deste
método.

### Retry somente quando seguro

Retries pertencem à Implementação e aos adapters internos e só são habilitados
para operações explicitamente seguras: mídia/leitura, probes idempotentes e
reconciliação. Usam limite de tentativas, backoff e a mesma origem validada.

`send` nunca é repetido automaticamente. A W-API pode enfileirar a mensagem e
uma falha de rede após o aceite remoto produz resultado ambíguo; repetir criaria
duplicatas. A mesma regra vale para qualquer mutação sem chave de idempotência
confirmada. A criação de instância não usa retry HTTP cego: lease, marcação de
`remote_started` e reconciliação tratam a ambiguidade.

### Mídia é tenant-scoped

`stream_media(tenant_id, media_id)` procura o descritor e o cache exclusivamente
nos dados do tenant autenticado. `media_id` é opaco e não é uma URL. Encontrar o
mesmo identificador em outro tenant não concede acesso; ausência no tenant
resulta em `not_found`.

Downloads usam somente metadados previamente persistidos para esse tenant,
limites de tamanho e MIME, origem permitida, redirects recusados e cache
separado por tenant. URLs do provedor permanecem internas e não aparecem no
resultado. A rota mantém `Cache-Control: private` e
`X-Content-Type-Options: nosniff` ao traduzir o stream.

## Responsabilidade das rotas

Depois de migrada, uma rota faz somente quatro coisas:

1. valida path, query, headers e body com os tipos HTTP existentes;
2. autentica a sessão, verifica a permissão do canal e obtém o tenant canônico;
3. constrói um comando público e chama um dos cinco métodos;
4. traduz resultado ou erro estável para o status e o shape HTTP legado.

A rota não importa `wapi_client`, `wapi_binding`, `wapi_connect`,
`wapi_messaging`, criptografia ou stores de conversa. Também não decide retry,
não manipula locks e não traduz payload bruto da W-API.

### Mapeamento incremental das rotas

| Rota pública preservada | Chamada ao módulo | Tradução HTTP preservada | Estado |
| --- | --- | --- | --- |
| `POST /api/chat/inicializar-login` | `ensure_connection(tenant_id)` | Mantém `status`, `qrcode`, `sincronizacao` e `403 consent_required`. | Migrada; o agendamento de sincronização permanece em callback interno até ter módulo próprio. |
| `POST /api/chat/desconectar` | `disconnect(tenant_id)` | Mantém `{"status":"desconectado"}`. | Migrada; limpeza e binding usam o mesmo lock legado e nunca chamam logout remoto. |
| `POST /api/chat/enviar` | `send(tenant_id, SendText(...))` | Mantém o shape e os códigos atuais para não conectado/falha. | Migrada; preparação, chamada remota única e persistência são coordenadas pelo módulo. |
| `POST /api/chat/enviar-arquivo` | `send(tenant_id, SendMedia(...))` | Mantém validação de upload e resposta atual. | Migrada com quote, sticker, áudio, view-once e persistência atrás do seam. |
| `POST /api/whatsapp/webhook` | `handle_webhook(headers, payload)` | Mantém `success`, `duplicate`, `ignored`, `403`, `404` e falha temporária. | Migrada em bloco: autenticação, owner, dedup, serialização e dispatch. |
| `GET /api/chat/midia/{message_id}` | `stream_media(tenant_id, message_id)` | Mantém body binário, MIME e headers privados. | Migrada; `conversa_id` continua aceito por compatibilidade, e a resolução interna pesquisa conversa, Status e catálogo do tenant. |

`GET /api/chat/status-canais` continua usando o fluxo atual enquanto
status/polling não tiver uma decisão de Interface. `GET /api/chat/media-proxy`
também permanece como compatibilidade separada nesta etapa; a nova Interface de
mídia não recebe a URL remota dessa rota.

## Estratégia de migração

1. Criar o seam externo, tipos de domínio e testes comportamentais sem alterar
   contratos HTTP.
2. Introduzir `WApiPort`, `HttpWApiAdapter` e `InMemoryWApiAdapter`. O Adapter
   HTTP inicialmente envolve `wapi_connect`, `wapi_binding`, `wapi_client` e
   `wapi_messaging` em vez de copiar seu comportamento.
3. Migrar conexão e envio de texto, que já têm a primeira fatia no módulo.
4. Migrar `disconnect` como operação estritamente local.
5. Migrar webhook em bloco, pois autenticação, resolução reversa, deduplicação e
   persistência formam uma única invariante e não devem ficar divididas entre
   rota e módulo.
6. Migrar mídia recebida, incluindo cache, SSRF, MIME e limites.
7. Remover duplicação somente depois que testes pela nova Interface cobrirem o
   comportamento observável correspondente. Os testes antigos continuam úteis
   até essa substituição; depois, mantenha apenas testes específicos de adapters
   e as regressões que não possam ser expressas pela Interface.

`wapi_binding` e `wapi_connect` não são reescritos nesta migração. Eles preservam
o store cifrado, ownership transacional, journal, lifecycle, leases, fencing,
reconciliação e consentimento. Ao longo das fatias, chamadas diretas saem das
rotas e passam primeiro pelo Adapter HTTP. Somente uma etapa posterior, com
paridade comprovada, pode mover implementação para dentro do package ou
renomear esses módulos.

## Testes pela Interface

A superfície principal de testes é `WhatsAppIntegration`, construída com o
Adapter em memória. Os testes devem observar resultados e efeitos públicos, não
locks, arquivos ou chamadas privadas. O Adapter em memória oferece contadores e
falhas programáveis apenas para comprovar propriedades remotas relevantes.

Cobertura mínima antes de remover qualquer caminho duplicado:

- isolamento: tenant A nunca conecta, envia, desconecta, recebe webhook nem lê
  mídia do tenant B;
- concorrência: chamadas simultâneas do mesmo tenant criam uma instância e um
  owner; tenants diferentes progridem independentemente; executor sem lease é
  fenced;
- atomicidade: falha de persistência não deixa binding/índice/cache parcial e a
  recuperação preserva o estado anterior;
- falhas remotas: erros públicos são sanitizados; erro transitório não apaga
  binding; criação ambígua reconcilia sem duplicar;
- retries: operação segura repete dentro do limite; `send` faz exatamente uma
  tentativa mesmo diante de timeout/5xx;
- webhook: segredo inválido é recusado antes de resolver instância; tenant vem
  somente de `instanceId`; `userId` forjado é ignorado; duplicata é idempotente;
  binding antigo não grava depois de disconnect;
- envio: comandos válidos são normalizados e persistidos uma vez; tenant sem
  conexão recebe erro estável; recibo não vaza dados do provedor;
- mídia: cache e descritor são por tenant, MIME/tamanho são validados, URL
  remota não atravessa a Interface e o stream preserva headers seguros;
- disconnect: limpa apenas estado local e o contador de logout remoto do
  Adapter permanece zero.

Além desses testes do módulo, testes finos das rotas verificam somente validação
HTTP e tradução dos contratos congelados. Testes do `HttpWApiAdapter` verificam
o contrato HTTP do provedor, redaction, allowlist, redirect, timeout e retry;
eles não repetem as regras de negócio do módulo.

## Decisões tomadas

- O seam externo é tenant-centric; não aceita credenciais nem identificadores
  operacionais escolhidos pelo chamador.
- `handle_webhook` não recebe `tenant_id`, impedindo que o chamador associe o
  evento a um tenant antes da autenticação e da resolução por `instanceId`.
- `disconnect` significa desvincular localmente. Logout remoto não é um detalhe
  de implementação equivalente.
- Envio usa comandos próprios do Norium e não payloads da W-API.
- O port da W-API é interno porque trocar transporte/provedor não deve aumentar
  o conhecimento exigido das rotas.
- Produção e testes usam adapters reais distintos; não se cria um seam apenas
  hipotético.
- Concorrência multiprocesso permanece apoiada em transações, leases e fencing;
  locks por tenant em memória servem somente ao processo atual.
- A migração é vertical e incremental por comportamento público, mantendo
  `wapi_binding` e `wapi_connect` como implementação comprovada até a substituição
  estar coberta.

## Ainda não migrado

Os seguintes fluxos permanecem fora dos cinco métodos ou continuam chamando a
integração legada diretamente. Eles não devem ser apresentados como concluídos:

- os callbacks incrementais de preparação/persistência de envio, dispatch de
  eventos e resolução de mídia ainda vivem no módulo grande de chat; as rotas
  já não executam essas responsabilidades, mas uma etapa futura pode mover os
  callbacks para adapters próprios sem alterar a Interface;
- status de conexão, polling, estabilidade/renovação de QR e sincronização de
  catálogo;
- consentimento, enquanto sua leitura/aceite ainda permanecerem fora de
  `ensure_connection`;
- catálogo de conversas e contatos, backfill e cache de fotos;
- histórico e detalhes de conversa;
- canais/newsletters;
- grupos e participantes;
- perfil do WhatsApp e foto de perfil;
- feed, leitura e tentativa de publicação de Status do WhatsApp;
- reações, edição, exclusão, marcação como lida, presença, localização, contatos
  e demais comandos de mensagem ainda não modelados;
- encaminhamento e limitações do plano W-API;
- integrações da Nora e qualquer outro chamador fora das rotas de chat;
- o `media-proxy` legado que ainda recebe URL e o registro de mídia remota;
- remoção ou fusão final de `wapi_binding`, `wapi_connect`, `wapi_messaging`,
  `wapi_webhook` e helpers grandes do router.

Cada item deve migrar somente quando houver uma Interface menor que a
complexidade escondida, um Adapter de teste adequado e testes de comportamento
que permitam remover a duplicação correspondente com segurança.
