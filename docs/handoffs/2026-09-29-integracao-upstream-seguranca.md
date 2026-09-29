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
- [Exemplo de execução bloqueada no GitHub Actions](https://github.com/T-Lucas43/Norium-nora/actions/runs/36601513709)
  não iniciou nenhum dos seis jobs porque o GitHub reportou problema de cobrança
  recente ou limite de gastos. Não há resultado de CI Linux, PostgreSQL ou TURN
  TLS. PRs #42 e #43 não disparam o workflow enquanto sua base não for `main`.
- Este Windows não tem PostgreSQL/Docker/Podman local. O teste de persistência
  sintético escreve esquemas e IDs fixos; não apontar para um banco existente.
- A preparação experimental do container da tarefa 7 permanece sem commit e
  com achados HIGH/CRITICAL de vulnerabilidade. Não é candidata a publicação.
- Não houve merge em `main`, build de release, deploy no ShardCloud ou smoke
  autenticado no endereço publicado.

## Próximos gates

Regularizar o GitHub Actions; repetir os jobs do PR #41; revisar e integrar os
PRs em ordem, retargetando #42 e #43 para `main` e exigindo CI verde no commit
integrado. A publicação exige o SHA exato enviado a `origin/main` e todas as
verificações de `DEPLOY_SHARDCLOUD.md`, inclusive dados existentes, login,
WebSocket, chamadas e módulos. Autenticação continua em revisão local separada.
