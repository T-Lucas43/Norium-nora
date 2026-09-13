# Integração W-API no Norium — plano e matriz de cobertura

> Substitui a API própria de WhatsApp (OpenWA auto-hospedada) pela **W-API**
> (`https://api.w-api.app/v1`). Fonte de verdade: `docs/W-API.postman_collection.json`
> (82 requests) + verificação ao vivo. Mantém o contrato público `/api/chat/*` do
> frontend; adiciona ciclo de instância por tenant e aceite obrigatório antes do QR.

## Contrato W-API confirmado

- **Base**: `https://api.w-api.app/v1`
- **Auth (instância)**: header `Authorization: Bearer <instanceToken>`, `?instanceId=<id>` na query.
- **Auth (conta/mestra)**: `GET /client/list-instances` usa a API Key Mestra em
  `Authorization: Bearer <WAPI_MASTER_API_KEY>`. A coleção chama essa credencial
  genericamente de `{{token}}`; `apiKey`, token e segredos nunca vão na query.
  Outros endpoints `client/*` mantêm seus contratos individuais documentados.
- **Envio enfileira mesmo desconectado** (categoria "Fila de mensagens") — nunca sondar envio.

## Isolamento (regra crítica)

Identidade sempre da sessão autenticada no backend; nunca confiar em `userId/instanceId`
vindo do front nem do payload de webhook. Cada tenant → no máx. 1 instância W-API própria.
Vínculo seguro em store por-tenant; toda operação valida propriedade (401 sem auth, 404 para
recurso de outro dono, sem revelar existência). Webhooks mapeados por `instanceId` → dono interno.

## Matriz de cobertura

| Área | Endpoint W-API | Tela/fluxo Norium | Serviço backend | Persistência | Teste |
|---|---|---|---|---|---|
| Instância (criar) | `POST /client/create-instance` | Conectar WhatsApp | `wapi_client.create_instance` | binding store | isolamento, idempotência |
| Instância (listar) | `GET /client/list-instances` | (admin/diagnóstico) | `wapi_client.list_instances` | — | Bearer mestra sem segredo na URL; 401; vazio/múltiplas |
| Instância (QR) | `GET /instance/qr-code` | Etapa QR (pós-aceite) | `connect_flow.qr` | consent gate | QR só com aceite |
| Instância (pareamento) | `GET /instance/pairing-code` | Conectar por telefone | `connect_flow.pairing` | — | — |
| Instância (status) | `GET /instance/status-instance` | Estado conexão | `connect_flow.status` | — | — |
| Instância (device) | `GET /instance/device` | Número conectado | `connect_flow.device` | — | — |
| Instância (desconectar) | `GET /instance/disconnect` | Botão desconectar | `connect_flow.disconnect` | binding | destrutivo confirma |
| Instância (restart) | `GET /instance/restart` | Reconectar | `connect_flow.restart` | — | — |
| Instância (perfil) | `PUT /instance/profile-*` | Perfil WhatsApp | `wapi_client` | — | — |
| Mensagem texto | `POST /message/send-text` | Enviar (`/api/chat/enviar`) | `messaging.send_text` | conversa store | envio/erro |
| Mensagem mídia | `send-image/audio/video/document/sticker/gif/ptv` | `/api/chat/enviar-arquivo` | `messaging.send_media` | uploads | tipos/limite/malicioso |
| Reação | `POST /message/send-reaction` `remove-reaction` | `/api/chat/reagir` | `messaging.react` | — | — |
| Editar/Apagar/Ler | `edit-message` `delete-message` `read-message` | `/api/chat/apagar-mensagem` etc. | `messaging.*` | — | — |
| Localização/Contato | `send-location` `send-contact(s)` | anexos | `messaging.*` | — | — |
| Baixar mídia | `POST /message/download-media` | media-proxy | `messaging.download_media` | cache | download seguro |
| Conversas | `GET /chats/fetch-chats` `chat` | `/api/chat/conversas` | `chats.*` | conversa store | paginação, isolamento |
| Presença | `POST /chats/send-presence` | digitando… | `chats.presence` | — | — |
| Contatos | `fetch-contacts` `phone-exists` `check-numbers` `profile-picture` `block-contact` | `/api/chat/contatos-disponiveis` | `contacts.*` | — | isolamento |
| Grupos | `group/*` (15) | `/api/chat/grupos` | `groups.*` | — | criar/participantes |
| Webhooks | `PUT /webhook/update-webhook-*` (6) + logs | (config na criação) | `wapi_client.set_webhooks` | binding | assinatura, dedup |
| Fila | `GET/DELETE /instance/quere/*` | (diagnóstico) | `wapi_client.queue_*` | — | — |
| Recebimento | webhook `received/delivery/message-status/...` | realtime WS | `webhook_router` | conversa store | dedup, fora de ordem, isolamento |

## Fases

- **Fase 0 — Contrato** ✅ (introspecção completa; 82 endpoints; base/auth/QR/send-text verificados ao vivo).
- **Fase 1 — Fundação**: `wapi_client` (base/auth/timeout/retry idempotente/erros/sem log de segredo) + config `WAPI_*` + store de vínculo por tenant + validação de propriedade.
- **Fase 2 — Ciclo de instância + aceite**: criar (idempotente via mestra), status, QR/pairing, disconnect, restart, delete; consent gate (usuário, versão do termo, UTC, origem; recusa QR sem aceite) + etapa no front.
- **Fase 3 — Mensagens + mídia**: ligar send-* e download-media ao contrato `/api/chat/*`; validação de arquivo (tipo/tamanho/nome), proxy de mídia.
- **Fase 4 — Webhooks + realtime**: endpoint público por evento; autenticidade/segredo; map evento→instância→dono; dedup por id; WS por usuário; configurar URLs na criação.
- **Fase 5 — Conversas/contatos/grupos**: fetch-chats, contatos, grupos.
- **Fase 6 — Remoção do legado + testes + docs**: remover `WhatsAppService` antigo após paridade; testes de isolamento/IDOR; `.env.example`; docs de instalação/webhook/operação/rollback; matriz final.

## Status (2026-08-22)

Fases 0–6 implementadas. Backend de WhatsApp 100% via W-API; serviço legado
(`app/services/whatsapp.py`) removido. Suíte: 97 testes backend + testes de
frontend, verdes.

Validado ao vivo (instância de teste pareada): conexão/QR/status/device, aceite
obrigatório antes do QR (consent gate), envio de texto (individual e grupo),
envio de imagem (data-URI base64), listagem de grupos.

Limitações reais confirmadas:
- Plano **LITE** nega `fetch-chats`/`fetch-contacts` ("Acesso negado"). Nessas
  contas o catálogo de conversas vem dos **webhooks**; o backfill degrada para
  vazio sem quebrar. Em conta **PRO** esses endpoints devem funcionar (shape do
  item ainda a confirmar em conta PRO).
- A W-API não expõe **histórico** de mensagens nem **encaminhamento**: histórico
  é servido do store local; encaminhar responde `501`.

## Operação

- Configurar no ambiente: `WAPI_BASE_URL`, `WAPI_MASTER_API_KEY`,
  `WAPI_CREDENTIAL_ENCRYPTION_KEY` e `WAPI_WEBHOOK_SECRET`. Em produção
  defina `BACKEND_PUBLIC_URL` para que os
  webhooks sejam registrados na criação da instância. O startup exige um
  `WAPI_WEBHOOK_SECRET` válido em qualquer ambiente fora da allowlist local/teste
  (`local`, `development`, `dev`, `test`, `testing`). O valor deve usar ASCII e
  não pode conter whitespace; a query é redigida dos access logs do Uvicorn.
- Webhooks: a URL registrada é `<BACKEND_PUBLIC_URL>/api/whatsapp/webhook?secret=<WAPI_WEBHOOK_SECRET>`.
  O backend valida o segredo, resolve o dono pelo `instanceId` (mapa seguro) e
  ignora `userId` do payload.
- Homologação sem `create-instance`: somente em ambiente explicitamente
  `local`/`development`/`dev`/`test`/`testing`, defina em conjunto
  `WAPI_TEST_TENANT_ID`, `WAPI_TEST_INSTANCE_ID` e
  `WAPI_TEST_INSTANCE_TOKEN`. Apenas o tenant indicado pode reivindicar a
  instância. Qualquer uma dessas variáveis em ambiente compartilhado
  (`production`, `prod`, `railway`, `staging` etc.) interrompe o startup.

### Credencial de instância em repouso

- O campo `InstanceBinding.token` existe somente em memória. No JSON é
  persistido um envelope Fernet autenticado e versionado em `credential`; o
  campo legado `token` nunca é escrito pelo código novo.
- `WAPI_CREDENTIAL_ENCRYPTION_KEY` deve ser uma chave Fernet de 32 bytes em
  base64 URL-safe, armazenada como secret no provedor. O startup falha em
  qualquer ambiente que não seja explicitamente `test`/`testing` quando a
  chave está ausente ou inválida.
- `WAPI_CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS` é opcional e aceita chaves
  anteriores separadas por vírgula. Elas servem somente para leitura durante
  rotação; toda leitura com chave antiga regrava o envelope com a chave ativa.
- Nenhum token, chave, plaintext recuperado, fragmento desses valores ou
  ciphertext é enviado aos logs ou incorporado às exceções. Erros de
  autenticação criptográfica usam mensagem estática e falham fechados.

### Migração segura do formato legado

1. Trate o volume e snapshots anteriores como material sensível. Se houver
   possibilidade de acesso indevido, rotacione também os tokens das instâncias
   no painel W-API; criptografar o arquivo não revoga uma credencial já exposta.
2. Gere a chave em uma estação confiável com
   `python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"`.
   Transfira o valor diretamente para o secret manager. Não o cole em chat,
   issue, arquivo versionado, saída de CI ou ferramenta de observabilidade.
3. Cadastre `WAPI_CREDENTIAL_ENCRYPTION_KEY` no ambiente de destino **antes**
   de publicar esta versão. Não faça deploy se o secret estiver ausente.
4. Publique a versão. Registros ativos são migrados no primeiro acesso por
   leitura controlada: o código cifra, regrava atomicamente e só então devolve
   a credencial ao chamador. Falha de regravação interrompe o uso.
5. No container/processo que monta o volume persistente, execute a partir de
   `norium-back-end`:

   ```text
   python scripts/migrate_wapi_credentials.py
   ```

   O sweep cobre `user_*/wapi_instance_db.json` e
   `user_*/backups/*/wapi_instance_db.json`, preserva campos desconhecidos e
   imprime somente quantidades. A criação de backup também migra o arquivo
   antes da cópia; a restauração migra o snapshot antes de torná-lo ativo.
6. Execute o comando novamente. O resultado esperado é zero arquivos
   regravados. Qualquer falha deve bloquear a retirada do formato legado.
7. Avalie snapshots externos ao volume, imagens de máquina e cópias exportadas:
   eles não são alcançados pelo sweep. Recriptografe-os ou elimine-os conforme a
   política de retenção, e rotacione o token W-API quando não for possível
   comprovar sua confidencialidade.

### Rotação da chave de criptografia

1. Gere uma nova chave fora do código e mantenha a chave ativa atual disponível.
2. Configure a nova chave em `WAPI_CREDENTIAL_ENCRYPTION_KEY` e coloque a
   chave anterior em `WAPI_CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS` na mesma
   atualização. Reinicie todas as réplicas com o mesmo keyring.
3. Execute `python scripts/migrate_wapi_credentials.py`. Envelopes lidos com
   chave anterior são autenticados e regravados com a nova chave ativa.
4. Execute o sweep uma segunda vez e exija zero regravações. Valide também
   snapshots externos ou mantenha a chave antiga em armazenamento de recuperação
   isolado até que a retenção deles expire.
5. Remova a chave antiga de `WAPI_CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS`,
   reinicie todas as réplicas e execute os testes de status/envio W-API. Nunca
   troque somente a chave ativa: isso torna todos os envelopes irrecuperáveis.

## Rollback

Não reverta para uma versão que persista ou espere `token` em texto puro.
Rollback deve usar uma versão compatível com o envelope `credential` e manter
a chave ativa/anteriores configuradas. Remover
`WAPI_CREDENTIAL_ENCRYPTION_KEY` é deliberadamente um erro de startup, não um
mecanismo de desativação. Os dados de conversa continuam independentes.

## Pendências externas

- **Rotacionar a `WAPI_MASTER_API_KEY`** (exposta durante o setup no chat).
- Teste ao vivo de **recebimento** via webhook exige `BACKEND_PUBLIC_URL` público
  e webhooks registrados na instância.
- Amostra real de payload de webhook para travar `wapi_webhook.adapt_incoming`
  (nomes de campos/eventos/status) e habilitar download de mídia recebida
  (guardar `mediaKey/directPath/type/mimetype`).
- Verificar shapes de `fetch-chats`/`fetch-contacts` em conta PRO.
