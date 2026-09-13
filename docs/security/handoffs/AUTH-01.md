# Handoff — AUTH-01: hierarquia administrativa

## Estado

- **Status:** corrigido e validado localmente em 13/09/2026.
- **Branch:** `codex/auth-01-hierarquia-administrativa`.
- **Commit-base:** `2747b264d5d3ce223e5386e9401666341be4875d` (`main` local no início da etapa).
- **Commit funcional:** `067e1e4` (`fix(auth): enforce administrative hierarchy`).
- **Referência local registrada:** `origin/main` em `32d8fb6bb1f4478a56a839fe476b70575618f5cf`, 129 commits à frente do commit-base. Não houve fetch, sincronização, descarte, push, merge ou deploy.

## Causa e correção

`assert_can_touch_user` protegia o proprietário global, mas aceitava em seguida `target.teamOwnerId == current.id`. Como a promoção a administrador auxiliar preserva o vínculo de equipe, um dono de equipe sem administração global podia alcançar a alteração de senha, status, permissões e a desativação do auxiliar.

O helper agora rejeita qualquer alvo administrativo quando o ator não possui administração global, antes dos atalhos de vínculo de equipe e de autogestão. A checagem do proprietário global permanece primeiro, de modo que administradores auxiliares continuam impedidos de alterá-lo; proprietários e auxiliares mantêm as operações globais já autorizadas. Não há migração nem mudança de esquema.

## Arquivos desta etapa

- `norium-back-end/app/modules/auth/router.py`: aplica a hierarquia administrativa no helper compartilhado por PATCH e DELETE.
- `norium-back-end/tests/unit/test_auth_administrative_hierarchy.py`: executa cada regressão em subprocesso limpo quando a suíte não está sob o runner isolado.
- `norium-back-end/tests/unit/auth_administrative_hierarchy_cases.py`: cenários HTTP com contas fictícias, armazenamento em memória, criptografia de senha simulada, segredo sintético e bloqueio de rede externa.
- `docs/security/reviews/2026-09-13-auth-sessions.md`: registra aplicabilidade, correção, evidências e limites de AUTH-01 sem alterar os demais achados.
- `docs/security/handoffs/AUTH-01.md`: este handoff.
- `output/security-fix-auth-01/`: executor e logs locais ignorados pelo Git.

## Critérios de aceitação

| Critério | Teste | Resultado |
| --- | --- | --- |
| Dono de equipe não global não redefine a senha do auxiliar vinculado; senha original permanece válida | `test_team_owner_cannot_replace_linked_assistant_password` | PATCH `403`; login original `200`; login com substituta `401` |
| Dono de equipe não global não inativa o auxiliar por PATCH nem DELETE | `test_team_owner_cannot_deactivate_linked_assistant` | PATCH e DELETE `403`; `/me` do auxiliar continua `200` e `ativo` |
| Auxiliar não altera nem desativa o proprietário global | `test_system_assistant_cannot_change_or_deactivate_system_owner` | PATCH e DELETE `403`; nome e status do proprietário intactos |
| Proprietário global mantém operações legítimas sobre o auxiliar | `test_system_owner_can_update_and_deactivate_linked_assistant` | PATCH de nome/senha `200`, nova senha válida, senha anterior inválida e DELETE `200` |
| Dono de equipe mantém gestão do membro comum da própria equipe | `test_team_owner_can_update_and_deactivate_own_regular_member` | PATCH e DELETE `200` |
| Membro de outra equipe permanece inacessível | `test_team_owner_cannot_manage_member_from_another_team` | PATCH e DELETE `403`; nome e status intactos |

## Validação executada

- Ciclo TDD: a primeira regressão falhou antes da correção com `403 != 200` e passou depois da mudança.
- Isolamento autônomo das regressões: **6/6 aprovadas** em subprocessos com ambiente limpo; nenhum diretório temporário permaneceu. Log: [`isolated-wrapper-tests.log`](../../../output/security-fix-auth-01/isolated-wrapper-tests.log).
- Regressões de AUTH-01 e testes atingidos: **31/31 aprovados**. Log: [`relevant-tests.log`](../../../output/security-fix-auth-01/relevant-tests.log).
- Suíte completa do backend: **384/384 aprovados** em ambiente sintético, sem rede externa. A primeira tentativa no sandbox aprovou 382 e teve dois erros `WinError 5` apenas na criação de pipes de testes preexistentes; a repetição fora do sandbox aprovou todos. Logs: [`backend-full-tests.log`](../../../output/security-fix-auth-01/backend-full-tests.log) e [`backend-full-tests-unsandboxed.log`](../../../output/security-fix-auth-01/backend-full-tests-unsandboxed.log).
- Compilação: `python -m compileall app main.py`, **125 arquivos**, exit `0`. Log: [`backend-compileall.log`](../../../output/security-fix-auth-01/backend-compileall.log).
- Dependências instaladas: `python -m pip check`, exit `0`. Log: [`backend-pip-check.log`](../../../output/security-fix-auth-01/backend-pip-check.log).
- Análise estática: Bandit com severidade média/alta, exit `0`, nenhum achado. Não há Ruff, Flake8 ou Mypy configurado no repositório. Log: [`backend-bandit.log`](../../../output/security-fix-auth-01/backend-bandit.log).
- Frontend: lint exit `0` com 15 avisos e nenhum erro; **374/374 testes**; build de 1.649 módulos; `npm audit --omit=dev --audit-level=high` sem vulnerabilidades. Logs: [`frontend-lint.log`](../../../output/security-fix-auth-01/frontend-lint.log), [`frontend-test.log`](../../../output/security-fix-auth-01/frontend-test.log), [`frontend-build.log`](../../../output/security-fix-auth-01/frontend-build.log) e [`frontend-audit-production-high.log`](../../../output/security-fix-auth-01/frontend-audit-production-high.log).
- Auditoria de dependências do backend: executada fora do sandbox após uma tentativa impedida por ACL. Encontrou três vulnerabilidades em `pypdf==6.15.0`: `PYSEC-2026-3910`, `PYSEC-2026-3911` e `PYSEC-2026-3913`; `6.16.1` corrige o conjunto. Exit `1`, sem alteração de dependência por estar fora do escopo exclusivo de AUTH-01. Log: [`backend-pip-audit-unsandboxed.log`](../../../output/security-fix-auth-01/backend-pip-audit-unsandboxed.log).

## Trabalho preexistente preservado

O início da etapa registrou alterações já existentes em workflow, deploy, `SECURITY.md`, matriz de controles, arquitetura, infraestrutura, configuração de exemplo, bootstrap, chat, Workhub, serviços W-API, dependências e testes W-API. Também já eram não rastreados `CONTEXT.md`, `deploy-worktrees`, `docs/adr`, documentação de WhatsApp, todo `docs/security`, credenciais, o módulo WhatsApp, scripts e regressões W-API. Nenhum desses itens foi revertido, sincronizado ou incorporado à correção funcional de AUTH-01; somente os caminhos listados em “Arquivos desta etapa” foram editados ou criados por esta etapa.

## Limitações

- A validação cobre a cópia local no commit-base indicado com o working tree preservado; não comprova produção nem a versão mais recente da referência remota.
- `docs/security` já era uma árvore não rastreada no início; somente este handoff e o relatório associado foram selecionados para o registro documental de AUTH-01.
- A auditoria de dependências permanece vermelha pelas três vulnerabilidades de `pypdf` registradas acima; não foi ampliado o escopo para atualizar a biblioteca.
- O commit funcional foi criado; push, merge e deploy ainda não faziam parte da evidência local desta etapa.

## Próximo marco

**AUTH-04 — alteração da própria senha.**
