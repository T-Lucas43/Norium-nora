# ShardCloud — correção local do contrato de prontidão

## Estado

Preparado em 28/09/2026 na branch `codex/shardcloud-readiness-contract-2026-09-28`, a partir de `56ece8e102144a4ad9777d374f471a7199824dff`. O commit `ce0152c942300766386317a3a81b7d6d7841056f` já foi enviado ao `origin`; nenhuma imagem foi construída ou publicada e nenhum dado de produção foi alterado. O checkout principal, que contém alterações preexistentes, não recebeu esta correção.

## Causa e mudança

O procedimento em `DEPLOY_SHARDCLOUD.md` exige que `GET /health/ready` responda HTTP 200 com `ready=true` e `persistence.driver=postgresql`. O endpoint consultava o PostgreSQL, mas retornava a informação apenas em `checks.persistence` e omitira `ready`. A resposta bem-sucedida agora apresenta os dois campos na raiz e preserva `status`, `checks` e `latencyMs` para os consumidores existentes. Falhas continuam retornando HTTP 503.

O `Dockerfile.shard` desta base passou a exigir PostgreSQL (`NORIUM_POSTGRES_REQUIRED=1`) e TLS verificado (`NORIUM_DATABASE_SSLMODE=verify-full`). Sem URL do banco, a prontidão falha. O Dockerfile da preparação separada da tarefa 7 já contém essas duas variáveis; ao integrar as branches, manter uma única definição.

## Verificação local

Com a venv local e diretório temporário isolado, `python -m unittest tests.unit.test_audit_readiness tests.unit.test_persistence_fail_closed tests.unit.test_json_repository -v`: **20 testes aprovados**. Incluem respostas HTTP reais para PostgreSQL saudável, falha de consulta e ausência de configuração obrigatória, além da regressão de persistência e prioridade do PostgreSQL sobre arquivos locais. Os cenários de arquivo local isolam explicitamente a configuração PostgreSQL. `git diff --check` passou.

## Pendências para aceite

- Revisão humana da mudança de infraestrutura conforme `docs/AI_GOVERNANCE.md` e integração com a preparação do container da tarefa 7. A imagem experimental dessa tarefa ainda falha seu gate de segurança; não a promover por causa desta correção.
- Confirmar a cadeia de certificados do PostgreSQL no ambiente de publicação. `verify-full` usa o repositório de CAs do sistema por padrão; o bundle `azure_postgres_roots.pem` é validado no build, mas só passa a ser usado pela conexão se `NORIUM_DATABASE_SSLROOTCERT` apontar para ele. Não presumir que o banco atual usa a cadeia Azure.
- Identificar o digest/SHA efetivamente em execução. O painel autenticado mostrou imagem personalizada sem seus dados e o workspace não listou a imagem. A [documentação de imagens do ShardCloud](https://docs.shardcloud.app/custom-docker-images) diz que o ID da imagem persiste entre rebuilds e o app conserva a versão anterior até reinício ou redeploy; `custom_image_id` sozinho não prova a versão ativa. A CLI não está instalada localmente.
- Construir o ZIP somente do commit aprovado e enviado para `origin/main`, seguir o pre-flight e publicar após revisão. Configurar e comprovar um SHA verificável na imagem ou no endpoint; o Dockerfile atual aceita `NORIUM_RELEASE_SHA` como argumento opcional e a resposta pública de `/health` observada em 28/09 não o mostrava.
- Após publicar, validar PostgreSQL e documentos essenciais antes e depois da troca, `/health/ready` no endereço publicado, login, duas contas exclusivas da mesma equipe, chat, WebSocket, chamadas, módulos e logs conforme `DEPLOY_SHARDCLOUD.md`. Não usar contas reais para mensagens ou chamadas de smoke sem autorização.
- Demonstrar o isolamento do Chromium no runtime efetivo. O painel não mostrou controles de seccomp/capacidades; suporte ainda desconhecido. A [API de execução do ShardCloud](https://docs.shardcloud.app/api-reference/apps/run-a-shell-command-in-the-apps-container) documenta uma forma de ler o estado do processo quando houver acesso autorizado, mas não informa digest OCI.

**Resultado:** correção local verificada; deploy e segurança de produção ainda não aceitos.
