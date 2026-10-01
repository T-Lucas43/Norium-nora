# Integração upstream de segurança — 29/09/2026

## Estado dos branches

- Base conferida: `origin/main` em `56ece8e102144a4ad9777d374f471a7199824dff`.
  O checkout principal `C:\NOrium` está no commit antigo
  `2747b264d5d3ce223e5386e9401666341be4875d` e contém mudanças locais
  preexistentes. Não usá-lo como pacote de release: ele reintroduz acesso a
  arquivos locais em rotas que agora usam PostgreSQL.
- [PR #41](https://github.com/T-Lucas43/Norium-nora/pull/41), branch
  `codex/upstream-security-integration-2026-09-28`, contém a retirada do Muse e
  do autodeploy Azure, validação de CI, atualização de dependências travadas e
  correção do teste de transmissão de tela. Está em rascunho.
- [PR #42](https://github.com/T-Lucas43/Norium-nora/pull/42), branch
  `codex/pdf-resource-integration-2026-09-29`, contém os limites do worker de
  PDF e tem o PR #41 como base. Está em rascunho.
- [PR #43](https://github.com/T-Lucas43/Norium-nora/pull/43), branch
  `codex/shardcloud-readiness-contract-2026-09-28`, contém o contrato de
  `/health/ready`, exigência de PostgreSQL e TLS `verify-full`. Tem o PR #41
  como base e está em rascunho.
- A mudança de autenticação, cofre e chave de e-mail está só no branch local
  `codex/auth-vault-integration-2026-09-29`, commit
  `59d3e678c40645d9e7456f1c3b803c0f47798f07`. Ainda requer revisão humana
  e plano de preservação dos ciphertexts antes de qualquer envio ou publicação.

## Evidência e bloqueios

- PR #41: 1.121 testes backend, 780 frontend, lint, build e scans locais
  aprovados. O gate de chamadas passou 45/45 cenários de navegador em três
  repetições com Chromium 149 e TURN UDP local, após o teste respeitar a escolha
  **Assistir transmissão**. Carga: 25 equipes, 100 conexões e três repetições
  sem violações; p95 de heartbeat 749,431 ms para limite de 750 ms.
- PR #42: 1.130 testes backend após rebase e 113 testes específicos de
  PDF/persistência aprovados. PR #43: 20 testes direcionados de readiness e
  persistência aprovados com banco simulado. Esses números não substituem o
  teste remoto integrado.
- As primeiras execuções do GitHub Actions não iniciaram os jobs por restrição
  de cobrança. A [tentativa 2 de 01/10](https://github.com/T-Lucas43/Norium-nora/actions/runs/36631738886/attempts/2)
  iniciou normalmente: segredos, regressão real de PostgreSQL e chamadas
  passaram; backend e frontend falharam pelos motivos registrados abaixo.
  PRs #42 e #43 não disparam o workflow enquanto sua base não for `main`.
- Este Windows não tem PostgreSQL/Docker/Podman local. O teste de persistência
  sintético escreve esquemas e IDs fixos; não apontar para um banco existente.
- A preparação experimental do container da tarefa 7 permanece sem commit e
  com achados HIGH/CRITICAL de vulnerabilidade. Não é candidata a publicação.
- Não houve merge em `main`, build de release, deploy no ShardCloud ou smoke
  autenticado no endereço publicado.

## Incidente observado no ambiente publicado em 29/09/2026

- Às 21:08–21:11 UTC, `https://norium.shardweb.app/health` respondeu 200,
  enquanto `/health/ready` respondeu 503 duas vezes com
  `{"detail":{"status":"not_ready","reason":"PostgresStoreError"}}`.
  A instância de rollback respondeu 200 e 503, respectivamente, com o mesmo
  erro de prontidão. O painel do workspace Norium mostrou a única database
  `norium-postgresql` como **Offline**, inclusive após atualizar a página.
- O estado Offline é compatível com o erro de prontidão, mas a causa da queda
  e a configuração efetiva das duas aplicações não foram comprovadas. O painel
  de eventos só mostrou restarts antigos; logs brutos de produção, dados e
  credenciais não foram lidos, conforme `docs/AI_GOVERNANCE.md`.
- Este é um gate de disponibilidade reprovado no ambiente já publicado, não
  resultado do PR #41, que não foi implantado. Não reiniciar aplicações nem
  trocar imagens como suposta correção do banco. Antes de qualquer novo deploy,
  o operador responsável deve apurar por que o PostgreSQL está Offline,
  preservar evidência/backup e restabelecer o serviço sem recriar documentos.
  Depois, repetir readiness, login, dados e WebSocket nas instâncias aplicáveis.

## Reavaliação em 01/10/2026

- O painel mostrou `norium-postgresql` **Online**. A instância principal
  respondeu duas vezes a `/health/ready` com HTTP 200 e
  `checks.persistence.driver=postgresql`; o formato publicado ainda não contém
  o `ready=true` exigido no procedimento. A instância de rollback continuou a
  responder HTTP 503 com `PostgresStoreError` em ambas as consultas. Não foi
  investigada a causa da indisponibilidade nem verificados documentos, backup,
  login ou WebSocket de produção.
- No CI Linux, a tentativa 2 passou o gate de chamadas em 45/45 cenários de
  navegador e 100/100 conexões sintéticas. O p95 de heartbeat foi 217,015 ms
  contra limite de 750 ms. A execução usou TURN UDP local; não validou TURN/TLS
  externo nem chamadas no endereço publicado.
- O CI reprovou a auditoria Python por `oauthlib==3.3.1` e `urllib3==2.7.0`,
  e o frontend por `dompurify==3.4.14` e um teste financeiro que pressupunha
  setembro. Correções nos locks e no teste passaram localmente: backend
  1.121/1.121, OAuth 21/21, frontend 780/780, build, lint, `pip-audit` e
  `npm audit`. Em 01/10, o usuário aprovou o envio do diff ao PR #41 após
  revisão da atualização de `oauthlib` 4.0.0. O fluxo OAuth com provedor real
  ainda precisa de validação antes de publicação no ShardCloud; o CI precisa
  rodar novamente no commit corrigido.

## Próximos gates

Exigir todos os jobs verdes no novo commit do PR #41 e validar o fluxo OAuth
real antes do deploy. Revisar e integrar os PRs em ordem, retargetando #42 e #43 para `main`
e exigindo CI verde no commit integrado. A publicação exige o SHA exato enviado
a `origin/main` e todas as verificações de `DEPLOY_SHARDCLOUD.md`, inclusive
dados existentes, login, WebSocket, chamadas e módulos. A causa do limite de
rede do PostgreSQL e a falha da instância de rollback ainda precisam de
avaliação operacional. A mudança de autenticação/cofre segue em revisão local
separada.
