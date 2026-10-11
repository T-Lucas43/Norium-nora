# GitHub Actions para a VPS de homologação

## Estado em 11/10/2026

O responsável integrou o PR #53 em main e orientou depois usar o próprio painel
Shard para esta publicação. Push em main preserva a imagem auditada por cinco
dias; para refazer por dispatch, usar `export_image=true` e
`deploy_homologacao=false`. Aguardar todos os gates e usar o artifact
`shard-deploy-image-<sha>` da mesma revisão. A imagem é carregada
na VPS sem rebuild; configuração, dados e contêiner anterior devem ser preservados,
com aceite remoto antes de concluir. A exportação isolada não usa secrets SSH.

Se o conector limitar o download a 512 MiB, executar `Shard Cloud - transferencia
da imagem auditada` em main, indicando run, artifact e SHA originais. O workflow
confere todos os gates, o hash GitHub, a identidade e o audit receipt; divide o
ZIP original em até três partes de 250 MiB e registra hashes individuais. Reunir
as partes e conferir o hash original antes de carregar a imagem no host. Não há
rebuild nem acesso à VPS nesse workflow.

O workflow existente fazia CI e pacote de fonte. Esta proposta acrescenta exportação
da **mesma imagem auditada** e transporte SSH por GitHub Actions. O console Shard
foi usado somente para leitura. A VPS segue no release `1878aa7`.

**Ainda não está provisionado:** o executor de release da VPS descrito abaixo e a
configuração SSH do environment. O transporte bloqueia antes de transferir/publicar
quando o executor não existe ou não passa no preflight. Testes com mocks não provam
deploy remoto, restauração, login ou disponibilidade. Não apresentar este PR como
homologação concluída.

## Fluxo

1. Revisar tecnicamente o PR crítico e incorporar o SHA aprovado em `main`.
2. Configurar o environment `homologacao`, restrito a `main`, e aprovação técnica
   antes da promoção. A disponibilidade de regras de proteção depende do plano
   GitHub; quando não houver required reviewers, registrar revisão do SHA no PR
   e restringir dispatch aos responsáveis. Não declarar proteção sem conferi-la.
3. Executar `Shard Cloud - validacao e homologacao` em `main`, marcando
   `deploy_homologacao`. Push/PR e dispatch sem essa opção somente validam.
4. Todos os gates devem passar, inclusive PostgreSQL, chamadas e Trivy. A imagem
   exportada não é reconstruída na VPS. SHA, ID Docker e hash do arquivo são
   conferidos novamente pelo executor do host.
5. Guardar recibo sanitizado no artifact `shard-deploy-receipt-*`. `deployed` exige
   todos os gates do protocolo; arquivo ZIP/CI verde não prova publicação.

## Configuração pelo responsável

No environment `homologacao`, cadastrar os secrets `SHARD_VPS_HOST`,
`SHARD_VPS_USER`, `SHARD_VPS_SSH_KEY` e `SHARD_VPS_KNOWN_HOSTS`. Variáveis:
`SHARD_VPS_PORT` (padrão 22) e `SHARD_HOMOLOGACAO_URL` (origem HTTPS).
O responsável insere a chave privada diretamente no GitHub. Não enviar na conversa.
Não dar acesso root genérico ao runner. Conferir a fingerprint do host por um canal
independente antes de salvar known_hosts; nenhuma aceitação automática de hostkey.

## Contrato do executor separado da VPS (pendente de implementação/provisão)

O transporte chama, sem prompt, `sudo -n /usr/local/sbin/norium-release`. Esse
executável e todos os arquivos de configuração usados por ele devem pertencer a
root e não ser graváveis pelo usuário SSH. O executor deverá ser implementado,
testado com falhas e aprovado por especialista antes de instalar. Este PR não
instala software, cria credenciais ou amplia sudo/SSH na VPS.

- `preflight --protocol 1 --environment homologacao`: comprovar configuração,
  espaço, executor aprovado e gates de rollback; emitir somente
  `{"protocolVersion":1,"ready":true}` quando estiver pronto.
- `prepare --revision <sha40>`: criar exclusivamente `/srv/norium/releases/<sha40>`
  para receber os quatro arquivos do artifact. Recusar links, traversal, revisão
  diferente, arquivo sobrescrito e arquivos de configuração/credenciais.
- `deploy --revision <sha40> --image <sha256:id> --archive-sha256 <hash64>
  --origin <https-origin>`: conferir hashes, receipt e identidade da imagem;
  `docker load` sem rebuild; não executar código recebido como script no host.
- Serializar releases com lock do host. Preservar `/srv/norium/data`, PostgreSQL,
  secrets/auth epoch, rede/proxy/TLS e imagem/container anterior. Preservar UID
  10001, rootfs somente leitura, CapDrop ALL, no-new-privileges, seccomp e tmpfs.
  Não alterar sysctl/AppArmor, ativar cérebro ou realizar migrações sem o gate
  correspondente. Exigir um worker Uvicorn e smoke real de sandbox.
- Backup fresco de banco e uploads, restauração em PostgreSQL isolado e comparação
  de inventário antes da promoção. Evidência privada permanece no host; não
  imprimir dumps, env, conteúdo ou dados de clientes nos logs Actions.
- Troca transacional e rollback testado: conservar container/imagem anteriores;
  em falha de readiness, identidade, TLS, login, dados, WebSocket ou sandbox,
  restaurar o runtime anterior e registrar `rolled_back`. Nunca reiniciar a versão
  antiga sobre schema incompatível; esse caso exige plano de restauração aprovado.
- Confirmação funcional autenticada com contas sintéticas próprias do ambiente,
  inclusive isolamento entre duas contas e WebSocket. Não tratar HTTP 401 como
  teste autenticado. Receber credenciais dessas contas somente no host.
- Para sucesso, emitir JSON sem campos privados: `protocolVersion=1`,
  `state=deployed`, `revision`, `imageId`, `environment=homologacao`, `origin`, e
  todos estes campos booleanos verdadeiros: `backupRestoredInIsolation`,
  `dataInventoryMatched`, `configurationPreserved`, `containerSecurityPreserved`,
  `browserSandboxPassed`, `postgresReady`, `publicHttpsReady`,
  `authenticatedSmokePassed`, `websocketSmokePassed`, `previousContainerPreserved`.

O contrato não substitui a implementação nem a prova remota desses controles.
Provisionamento e revisão técnica permanecem bloqueadores explícitos do deploy.

Referências oficiais: [artifact action fixada](https://github.com/actions/download-artifact/commit/d3f86a106a0bac45b974a628896c90dbdf5c8093)
e [environments e limitações por plano](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments).
