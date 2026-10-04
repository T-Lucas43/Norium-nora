# Sessões e segurança: decisão, revisão e homologação

Atualizado em 04/10/2026. Candidato do PR #45, branch `codex/security-session-homologacao`. Responsável pela revisão humana: usuário que se designou no diálogo. Execução direta Codex com IA. O usuário aprovou os diffs até `ffa4b4a93ae9f54be656b25ea76d262241e39fe9`, `6baffcc0b699d52c04be70b0fed6eb27c9373ed4` e `1868f3cef7ed2ff2916b8543e0d82bac82481a1b`, condicionando a publicação aos gates. Depois determinou usar somente Shard Cloud; a remoção/arquivamento de workflows Azure atende a essa instrução e não muda o produto aprovado. Este documento não registra deploy.

## Decisões aprovadas e contrato implementado

O usuário autorizou implementação e publicação em homologação e aprovou especificamente a exceção de cookie em `SECURITY.md`. `docs/AI_GOVERNANCE.md` continua exigindo aceite humano do código crítico e artefato imutável com rollback.

| Controle | Implementação do candidato |
| --- | --- |
| Banco de sessões | PostgreSQL em ambiente compartilhado; SQLite somente local/teste. Schema aditivo v1, locks de conta e transações |
| Credencial de acesso | Bearer assinado, 15 minutos, sub/SID/SV/JTI; exclusivamente sessionStorage; SID obrigatório |
| Renovação persistente | 32 bytes aleatórios, somente SHA-256 no banco; cookie `__Host-norium-refresh`, HttpOnly/Secure/SameSite=Lax/Path=/, sem Domain |
| CSRF | Cookie auxiliar `__Host-norium-csrf` também HttpOnly/Secure/SameSite/Path; não autentica. Header obtido em contexto de mesma origem e hash vinculado à sessão |
| Prazo | Teto absoluto de sete dias desde login, 24h de inatividade; rotação/heartbeat não estendem os prazos |
| Limites | 20 sessões por conta; intervalo mínimo 5s entre rotações; máximo 1.024 hashes por sessão |
| Rotação | Consumo/emissão transacionais; replay revoga a sessão e confirma a revogação antes de retornar erro |
| Ações sensíveis | Reautenticação por senha, validade 5min; versões/epoch bloqueiam login concorrente com revogação global |
| Dispositivos | Próprias sessões: navegador/SO/tipo normalizados, rótulo até 80 caracteres, datas e sessão atual. Sem IP, fingerprint ou identificação física |
| Abas | Web Locks serializam cookie quando disponíveis; single flight na aba; aviso de encerramento contém só SID. Respostas antigas não limpam a identidade nova |
| HTTP | APIs de negócio permanecem Bearer. Renovação antes da mutação; resposta perdida não autoriza reenvio automático |
| Sockets | SID/SV/status/permissões conferidos antes e depois de receber, antes de enviar e em idle até 5s quando o banco está saudável |
| Senhas | PBKDF2-HMAC-SHA256, sal aleatório de 16 bytes e 600.000 iterações; hash legado reemitido após login válido; não há recuperação reversível |
| Erros | Validação 422 retorna apenas loc/msg/type, nunca input/ctx; falha de banco de sessões sanitizada e fechada |
| Integrações OAuth | Fernet com chave dedicada; envelope vinculado à conta/finalidade, suporta leitura com chaves anteriores e reescrita com a ativa |
| Retenção | Sessões/hashes até validade absoluta; eventos por 30 dias e no máximo 500/conta; limpeza paginada. Exclusão remove metadados e mantém epoch opaco de invalidação |
| Quota | JSONB e BYTEA compartilham orçamento lógico e lock transacional; local gerenciado usa lock/replace. Índices, WAL e tabelas especializadas não entram nessa medição |
| Rede/browser | CONNECT 443 autenticado por execução, allowlist obrigatória para todos os hosts/subrecursos, DNS público validado no TCP, TLS original; sandbox obrigatório, identidade sem root |

CORS/TLS/permissões e regras de negócio continuam exigidos. Desenvolvimento usa proxy Vite de mesma origem; a prova de cookies Secure exige HTTPS local. A identificação da sessão não comprova o aparelho físico.

## Arquivos críticos para revisão humana

1. `app/infrastructure/auth_sessions.py`, `app/modules/auth/session_http.py`, `app/modules/auth/router.py`, `app/core/security.py`: transações, replay, CSRF, cookie, invalidação, senha, emissão e status.
2. `app/modules/auth/email_router.py`, `app/modules/{inbox,brainstorm,team}/router.py`, `app/modules/privacy/router.py`: reset, sockets, permissões e exclusão.
3. `app/services/oauth_credentials.py`, `gmail_service.py`, `calendar_service.py`, `scripts/migrate_oauth_credentials.py`: finalidade/conta, chave, envelopes, legado e migração.
4. `app/infrastructure/browser_egress.py`, `app/modules/intelligence/browser_runtime.py`, `Dockerfile.shard`: limites de rede, sandbox, UID e compatibilidade com o provedor.
5. `app/infrastructure/persistence/{postgres_store,files,json_repository}.py`: quota, substituição, concorrência e isolamento.
6. Frontend `cookieSession.ts`, `fetchAuth.ts`, `sessionScope.ts`, `useAuthSession.ts`, `SessionDevices.tsx`: identidade, renovação, mutações, erro de rede e sessão compartilhada entre abas.
7. Incrementos posteriores ao aceite 6baffcc, aprovados até 1868f3c: `app/modules/team/call_adapters.py`, `app/infrastructure/persistence/files.py`, `app/infrastructure/async_session_validation.py` e integração `team/router.py`; frontend `MeshMediaTransport.ts`; workflow de validação e `scripts/build_shard_release.py`. Término de worker sob cancelamento, limite/frescor da consulta, renegociação pendente e derivação/verificação do pacote sem promoção automática foram revisados.

Os paths de app/scripts acima são relativos a `norium-back-end`; frontend em `norium-front-end/src`. A revisão será vinculada ao commit exato do PR, não apenas à aprovação anterior do desenho.

## Preparação operacional obrigatória

| Gate | Evidência exigida antes da promoção | Situação |
| --- | --- | --- |
| Revisão humana crítica | Aceite do diff/SHA, prazos/retencão e riscos residuais pelo responsável | ffa4b4a, 6baffcc e 1868f3c aprovados condicionalmente; mudança posterior de workflow somente Shard ordenada pelo usuário |
| CI exato | Backend/frontend/lint/build/SCA/scanner, PG real concorrente e chamadas verdes no SHA candidato | b24e457 /37210916664 verde: 1.265 backend/806 frontend, 19 scripts e 44/45 browser (uma falha isolada tolerada pelo critério original); carga 100 conexões aprovada. Patches dev/SCA ampliada exigem novo CI exato |
| Imagem | Build `Dockerfile.shard`, SHA/digest, SBOM e proveniência; app UID 10001 e smoke DOM com sandbox | Sandbox real aprovado no CI de 1868f3c; ZIP Linux/Windows idêntico. Digest/SBOM da imagem efetivamente publicada e comprovação no Shard pendentes |
| Shard | Sandbox funcional e bind do PORT injetado com UID sem privilégio; volume gravável sem dar privilégio ao app | Pendente; não usar no-sandbox/SYS_ADMIN/seccomp unconfined |
| Chave de assinatura | `NORIUM_AUTH_SECRET` presente no secret manager, >=32 bytes, **mesmo valor atual** | Nome listado no painel Shard em 04/10; valor/tamanho/origem não lidos; compatibilidade precisa ser comprovada |
| Chave OAuth | `NORIUM_OAUTH_CREDENTIAL_ENCRYPTION_KEY` Fernet dedicada, mantida em secret manager e backup protegido | Campo preparado sem valor/salvar; entrada/salvamento privados pelo responsável aguardam confirmação |
| Dados | Backup PostgreSQL e volume completos, restauração em destino isolado e contagens/recibo de preservação | Backups pre-sessoes-2026-10-04 (08:29:55) e pre-sessoes-postgresql-2026-10-04 (10:08:28) confirmados; restore/contagens ainda pendentes |
| Migração OAuth | Inventário offline de JSONB e arquivos legados; aplicação e repetição idempotente com writers parados | Pendente; nenhuma execução remota feita |
| Conta B | Segunda conta de homologação sem dados reais, designada pelo usuário, prova A/B | Pendente |
| Aceite remoto | Login/reabertura, sessões, revoke, senha/reset, sockets, Gmail consent/callback e arquivos na imagem exata | Pendente |
| Operação/lançamento | Alertas entregues, rollback praticado, privacidade/termos/retenção e produção criada/autorizada | Pendente |

Não aumentar réplicas/WEB_CONCURRENCY: o registro de sessões é transacional e compartilhado, mas o diretório de usuários ainda usa substituição de documento JSONB e outros módulos possuem estado de processo. Duas conexões de teste não provam a aplicação inteira em duas réplicas.

Não trocar inadvertidamente `NORIUM_AUTH_SECRET`: integrações/configurações existentes podem depender dele para decifrar dados. Se hoje estiver em arquivo legado, transferir o valor exato ao secret manager por operação administrativa privada, conferir compatibilidade e somente depois retirar a cópia segundo o procedimento aprovado. Um segredo novo causa perda de compatibilidade, além de invalidar tokens.

## Migração e ativação

1. Registrar imagem/digest ativos, backup e restauração, contagens de usuários/workspaces/documentos/blobs/tabelas especializadas e hash do recibo. Não salvar conteúdo pessoal em artefatos do PR.
2. Preparar imagem exata com as chaves existentes e a chave OAuth dedicada configuradas; `NORIUM_PERSISTENT_SESSIONS_ENABLED=false`. O novo startup exige chave OAuth válida quando há cliente Google configurado; não promover sem configuração.
3. Pausar todos os writers/workers na janela aprovada. Usar ambiente administrativo com as variáveis injetadas; não despejar environment/logs.
4. Executar `python scripts/migrate_oauth_credentials.py` para inventário agregado. A ferramenta examina caminhos conhecidos de Gmail/Agenda em JSONB; não inventaria automaticamente arquivos soltos ou backups.
5. Inspecionar offline os legados `gmail_token.json`, `gmail_oauth_state.json` e equivalentes Calendar no volume/backups. Definir vínculo de conta por evidência e tratar cópias conforme política; não adivinhar o titular nem ativar fallback compartilhado.
6. Após restore comprovado, executar `python scripts/migrate_oauth_credentials.py --apply --writers-paused --backup-restore-verified`. Uma transação, lock consistente e verificação de envelope/roundtrip; erro aborta. Quota insuficiente exige capacidade planejada, não desabilitar proteção.
7. Repetir inventário: legado conhecido deve ser zero e segunda aplicação não reescreve documentos. Validar contagens e integridade dos campos não OAuth com comparação feita offline. Proteger e revisar retenção dos backups que ainda contêm legado.
8. Promover pelo fluxo GitHub Actions/Shard aprovado, manter uma instância/worker, conferir digest ativo e `/health/ready` PostgreSQL/schema de sessões. Comunicar novo login obrigatório: tokens sem SID são rejeitados.
9. Validar conta designada com persistência desativada (desmarcar "Manter conectado"). Ativar explicitamente `NORIUM_PERSISTENT_SESSIONS_ENABLED=true` após os gates e executar aceite HTTPS completo, incluindo fechar/reabrir o navegador.
10. Verificar ausência de dados misturados em conta B, sem executar automações/envios reais da conta A. Consentimento Gmail real requer intervenção do titular com caixa de teste; callback configurado não prova o fluxo.

## Rollback e recuperação

- Suspender emissão/renovação persistente pela flag sem desligar SID/SV/registro. Banco indisponível não concede sessão nem fallback.
- Preferir imagem anterior **já compatível com validação de SID/revogação**. Ao voltar a um binário antigo que aceita Bearer sem registry, pausar writers e incrementar SV de todas as contas afetadas antes da troca; verificar que todos os tokens anteriores são recusados. Não realizar isso sem plano/diff operacional revisado.
- Preservar tabelas aditivas e evidências minimizadas; não apagar dados de autenticação para reabrir acesso.
- Restaurar backup pode reativar hashes consumidos/sessões revogadas. Recuperação exige invalidar versões/epoch/sessões antes de reabrir tráfego e exigir novo login. A chave OAuth do backup deve permanecer disponível de forma protegida.
- Replay/resposta de renovação perdida encerra a sessão e exige novo login. Em rede/503, informar erro; não comunicar logout remoto confirmado quando o servidor não confirmou.

## Registro de evidências

### Estado mais recente

- Suíte completa isolada do incremento de validação fresca: **1.265 backend**, zero falhas/erros/skips, 464,541s (`release-candidate-fresh-session-complete.json`). **137 focados** cobrem limites/cancelamento/recuperação do scheduler e guards de sockets; revisão estática independente confirmou fechamento dos riscos de cancelamento sem encontrar novo bloqueador nessa integração.
- **59 testes frontend** de chamadas/transportes passaram, incluindo renegociação solicitada durante oferta pendente e rejeição atrasada de peer substituído; TypeScript, build e orçamento passaram. Revisão estática independente não encontrou novo bloqueador no diff final. Ofertas simultâneas em navegador real passaram 3/3 nos CI de 1868f3c e b24e457; isso não substitui a validação na imagem ativa do Shard.
- **19 testes de workflow/pacote** passaram: ZIP determinístico, SHA/tree/blobs, limites de tamanho, rejeição de links/traversal/credenciais/export filters/overwrite e gates de release. Prova adicional mantém bytes do Git com core.autocrlf=true no Windows, sem mudar a configuração do usuário. O job `shard-source-artifact` só produz fontes depois de validate/PG/chamadas/imagem aprovados; não recebe chave Shard nem reinicia aplicação. Checkout dos gates e pacote usa o HEAD concreto do PR.
- Por instrução posterior do usuário, o único workflow ativo é `.github/workflows/shard-homologacao.yml`. Jobs de publicação/deploy Azure retirados e 13 workflows manuais movidos para `docs/archives/azure-workflows`, preservando os blobs. Nenhuma configuração ou recurso remoto Azure alterado. A branch main histórica não deve ser despachada. O novo pacote fonte não comprova digest/SBOM do rebuild gerenciado no Shard.
- `python scripts/build_shard_release.py --repo . --commit SHA40_REVISADO --output-dir output/shard-release/ID_UNICO` gera ZIP, manifesto interno e recibo externo SHA256. O `Dockerfile` derivado copia `Dockerfile.shard` e muda apenas o valor padrão de `NORIUM_RELEASE_SHA`; não há credenciais, arquivos locais não versionados ou dados do ambiente.
- O Shard documenta rebuild de imagem a partir de contexto ZIP separado do restart. ID de imagem, credencial privada, preservação do digest anterior/rollback e gates operacionais ainda precisam de prova. Não usar `app commit` para promover antes dos gates nem tratar um rebuild como imagem ativa.
- Restauração sobre a database ativa `database` foi cancelada. Restauração para destino isolado exige confirmar ausência do destino e procedimento do provedor, aprovação concreta da operação e comparação privada agregada; não restaurar sobre a ativa.
- Inspeção do Visualizer autorizada pelo usuário, restrita a nomes de databases/contagens e permissões existentes, após bloqueio de revisão automática por possível exposição de dados privados. Interface está **desabilitada** e requer **512 MB livres**, com botão indisponível. Não habilitada, nenhum conteúdo privado lido. Restauração/contagens continuam pendentes.
- [CI 37209336835](https://github.com/T-Lucas43/Norium-nora/actions/runs/37209336835), 1868f3c: todos os quatro gates e artifact aprovados. **1.265 backend, 806 frontend, 19 scripts, 45/45 cenários reais**; simultaneous_offer passou 3/3. Carga manteve **100/100 conexões**, com sinal p95 30,076 ms e heartbeat p95 449,138 ms, demais limiares aprovados sem mudança. O log-resumo não publica controle p95; não inventar seu valor.
- ZIP de 1868f3c no Linux CI e Windows local: **13.885.454 bytes**, SHA256 **fa8a50097a8480998accb2b511e49ae17acfe8b9ffc0b20070b2dd83557e194a**, manifesto/tree iguais. Essa equivalência é de fontes, não da imagem Shard. O incremento posterior exclusivo de workflow precisa de seu CI/artifact concreto antes de promoção.
- [CI 37210916664](https://github.com/T-Lucas43/Norium-nora/actions/runs/37210916664), b24e457: cinco jobs aprovados; 1.265 backend/806 frontend/19 scripts, PG e sandbox. Browser **44/45**, com uma falha de `tab_close_and_crash` na primeira repetição; outras duas passaram. Critério original de maioria por cenário tolerou essa falha; limiares não alterados. Carga 100/100, sinal p95 16,402 ms/heartbeat274,361 ms. ZIP Linux/Windows de **13.870.050 bytes**, SHA256 **bdc27794a6368e39aba0f8d9948876507490455135e1713665568917968c6bb5**; não enviado ao provedor.
- SCA completa de frontend encontrou quatro pacotes dev afetados (Vitest/mocker/coverage 4.1.10, undici8.9.0); audit omitindo dev retornou zero. Patches dev em preparação: Vitest/coverage4.1.11 e undici8.10.2, compatíveis com Node24/Vite8. Gate ampliado exige audit completo e runtime separados, gravidade moderada ou superior bloqueia. 20 testes scripts/workflow aprovados; regressão frontend e CI exato do incremento pendentes.
- Restauração com nome de destino aleatório cancelada sem execução: documentação pública não confirma criação de destino ausente/preservação do original. Exigir prova de isolamento e acesso administrativo antes de propor a operação concreta.
- Patches dev aplicados no lock: Vitest/coverage e grupo interno4.1.11, undici8.10.2. Instalação isolada passou, audit completo/runtime zero e **806 testes/132 arquivos** aprovados, lint/TypeScript/Vite/orçamento aprovados. Tooling npm.cmd avulso falhou na chamada aninhada do orçamento depois de build concluído; comando do orçamento reexecutado diretamente passou. Nenhuma junction/dependência compartilhada alterada. Novo CI exato obrigatório; código crítico aprovado até186 permanece sem alteração.

As entradas abaixo preservam a evolução histórica; resultados de candidatos antigos não substituem os gates da referência final.

- Suíte isolada `security-sessions-current-complete`: 1.220 backend, zero falhas/erros/skips; não inclui as últimas quatro regressões de quota JSON.
- Frontend completo antes das últimas regressões: 793 aprovados; depois, 22 focados de transporte/cookie/hook e quatro de dispositivos aprovados.
- `session-storage-review`: 83 regressões backend aprovadas. Novo gate PG verifica JSON+binário em duas conexões; resultado real dessa versão ainda pendente no CI.
- Build TypeScript/Vite/budget e lint aprovados localmente; lint mantém avisos preexistentes. Gitleaks de código atual e canário aprovados; scans não constituem prova universal de ausência de falhas.
- Nenhuma alteração desse candidato foi implantada em homologação. Produção não existe. Parecer atual: **NO-GO para lançamento público**.
- Painel Shard em 04/10: imagem continua `norium-fullstack-a7d339e`. Nomes de variáveis conferidos com valores ocultos: assinatura presente; chave OAuth dedicada e flag persistente ausentes. Não houve alteração no painel.
- [CI 37198209959](https://github.com/T-Lucas43/Norium-nora/actions/runs/37198209959), commit 2cea5bd: validate aprovado com **1.224 backend** sem falhas/erros/skips e **804 frontend**, lint com 20 avisos/zero erros, build/budget/SCA/scanner/canário/histórico aprovados. PG real aprovou quota mista, duas conexões de sessão, replay/epoch e migração OAuth idempotente. Chamadas ainda em andamento neste registro.
- Gate de imagem dessa rodada reprovou: Chromium não encontrou sandbox dentro do ambiente restrito do build. Ajuste preparado: inventário no build e **smoke DOM/namespace/seccomp obrigatório no runtime CI**, com perfil oficial Playwright v1.62.0, cap-drop=ALL, no-new-privileges, rootfs somente leitura e rede desligada. Não há fallback no-sandbox nem mudança do Shard. Nova prova necessária após o commit do ajuste.
- O browser recebe apenas variáveis de runtime permitidas; chaves/URL de banco/segredos de provedores não são herdados pelo processo Chromium. Código da imagem permanece pertencente a root e legível pelo app; apenas data/home são graváveis. A posse/gravação do volume montado no Shard deve ser comprovada para UID 10001 sem inicializar dados vazios.
- [CI 37198811332](https://github.com/T-Lucas43/Norium-nora/actions/runs/37198811332), 38423c2: **1.225 backend**, **804 frontend**, PG real, 45/45 cenários de chamadas e 100 conexões aprovados; build da imagem aprovado, mas smoke do zygote/sandbox reprovado. Imagem não promovida. Ajuste específico do perfil descartável de CI para chroot dentro do namespace e prova de capabilities zero preparado; não altera o Shard.
- Fanout agora usa uma consulta fresca de bindings completos sub/SID/SV por envio (máximo 1.000), sem cache. **79 testes focados** aprovam revogação real, versões/tenancy e falha fechada, além dos contratos do perfil e smoke. CI real desse ajuste ainda necessário.
- Backup Shard **pre-sessoes-2026-10-04**, 04/10/2026 08:29:55, aparece na lista 1/8; captura privada no diretório de evidências. Esta ação altera somente a lista de backups. Não demonstra restauração nem cobertura do PostgreSQL externo.

## Revisão aprovada e incremento de chamadas — 04/10

- Aceite humano recebido: **"Aprovar esse diff, condicionando a publicação aos gates"**, para `ffa4b4a93ae9f54be656b25ea76d262241e39fe9`. Mantém a autorização de homologação; não constitui aceite de diff posterior nem dispensa backup/restore, configuração e comprovação de release.
- [CI 37200593650](https://github.com/T-Lucas43/Norium-nora/actions/runs/37200593650): **1.235 backend**, zero falhas/erros/skips; **804 frontend/132 arquivos**; lint/build/budget/SCA/scanner/canário/histórico e PostgreSQL real aprovados. Job imagem `111432148074` aprovado: UID 10001, capabilities zero, no-new-privileges, seccomp, namespace PID/rede, avaliação positiva do Chromium e interação DOM real. Imagem descartável CI, não publicada no Shard.
- Workflow integral **reprovado**: chamadas `temporary_network_loss` reprovaram em 2/3 repetições por timeout do controle HTTP durante offline; `call_studio` falhou em uma repetição; carga p95 controle **1.109,444 ms** e heartbeat **758,826 ms**, ambos acima de 750 ms. Não aumentar limites nem apresentar essa rodada como verde.
- SEC-WS-02: respostas privadas após `await` do coordenador agora conferem novamente diretório/status/permissões/equipe e binding do transporte sub/SID/SV no registro autoritativo. Revogação durante processamento, SID de outra conta, ator trocado, equipe movida e banco indisponível negam a resposta e fecham 4403. Esta correção é incremento crítico posterior ao aceite ffa4b4a.
- Snapshots agrupam apenas destinatários com projeção idêntica de chamadas; o publisher continua validando cada transporte numa consulta fresca. Sem cache entre eventos. Testes demonstram chamada privada, destinatário sem participação e mudança de participantes.
- Fixture de teste: controle offline inicia o fechamento e informa `closingConnections`, permitindo ao navegador sair de offline antes de terminar o handshake; cenários continuam exigindo reconexão e mídia preservada. Reset aguarda todos os fechamentos em paralelo e handlers, mantendo ownership inclusive após saída do manager. Nenhuma rota de teste é incluída na imagem de produção.
- Windows: carga isolada posterior ao agrupamento também reprovou, com `LoadFailure` em reset; artefato `grouped-call-final-load/team-call-load.json`. Não é aprovação nem prova da causa de latência Linux. Revalidação CI do incremento permanece obrigatória.
- Snapshot final do incremento/fixture: **112 testes focados aprovados**, zero falhas/erros/skips (`call-group-revocation-offline-final.json`, 27,827s). Não substitui CI completo, carga ou validação remota.
- Chave OAuth: formulário preparado somente com o nome da variável e valor vazio; entrada/salvamento pelo responsável ainda sem confirmação. Não observar o campo enquanto a credencial estiver em edição. Backup completo externo/restauração e sandbox/volume do provedor seguem pendentes.
- Incremento final de performance: publicação de rede liberada do lock global somente após admissão/persistência atômicas. Publisher ainda revalida destinatários; respostas após await mantêm SEC-WS-02. Regressão de publisher bloqueado confirma capacidade global limitada entre equipes. **140 testes focados aprovados**; snapshot anterior 92401fb também aprovou **1.241 backend completos**. CI exato do incremento deve passar antes de promoção.
