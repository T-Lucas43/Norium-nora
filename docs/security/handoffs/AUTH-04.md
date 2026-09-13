# Handoff — AUTH-04: reautenticação para alteração de senha

## Estado

- **Status:** corrigido e validado localmente em 13/09/2026.
- **Branch:** `codex/auth-04-reautenticacao-senha`.
- **Commit-base:** `9f94db86bc6f105dc46daabe0a290f0fb4ceb96c` (`origin/main` atualizado no início da etapa).
- **Commit funcional:** `2eb5ab526a673d73fd05d0449b179a93ab096b9d` (`fix(auth): require reauthentication for own password changes`).
- **Commit de robustez dos testes:** `3403ac858288328036e92c40735c1269c208163f` (`test(auth): verify password changes survive reload`).
- **Worktree isolado:** `C:\NOrium\deploy-worktrees\auth-04-reautenticacao-senha`.

## Causa e correção

`POST /api/auth/change-password` já exigia `currentPassword`, mas `PATCH /api/auth/users/{user_id}` também aceitava `password`. Como `can_manage_team` permite qualquer owner e `assert_can_touch_user` aceita autogestão, um token de owner gratuito, dono de equipe ou administrador bastava para substituir a própria senha e tornar o acesso persistente.

Depois da hierarquia compartilhada de AUTH-01, o PATCH agora rejeita `password` quando o ator e o alvo são a mesma conta, antes da cópia e de qualquer mutação. A troca própria continua exclusivamente em `/change-password`, com comprovação da senha atual. O PATCH mantém a redefinição da senha de outra conta quando a hierarquia autoriza a operação.

Não há migração nem mudança de esquema ou OpenAPI. O efeito de compatibilidade é intencional: clientes que enviavam a própria senha ao PATCH passam a receber `403` e devem usar `/change-password`. Atualizações próprias sem senha e redefinições administrativas legítimas continuam funcionando. Não havia consumidor frontend desse desvio, portanto nenhuma interface precisou ser alterada.

## Arquivos desta etapa

- `norium-back-end/app/modules/auth/router.py`: bloqueia senha própria na rota administrativa antes de qualquer mutação.
- `norium-back-end/tests/unit/test_auth_password_reauthentication.py`: executa cada cenário AUTH-04 em subprocesso com ambiente estabelecido antes da importação do módulo.
- `norium-back-end/tests/unit/auth_password_reauthentication_cases.py`: regressões HTTP com contas, hashes, assinatura e armazenamento sintéticos; cada leitura recebe uma cópia do último estado persistido, e conexões de rede externa são bloqueadas.
- `docs/security/reviews/2026-09-13-auth-sessions.md`: registra aplicabilidade, correção e evidência de AUTH-04 sem alterar o histórico dos demais achados.
- `docs/security/handoffs/AUTH-04.md`: este handoff.
- `output/security-fix-auth-04/`: logs e dados temporários locais ignorados pelo Git.

## Critérios de aceitação

| Critério | Teste | Resultado |
| --- | --- | --- |
| Token sozinho não troca a senha própria de owner gratuito e o payload misto é atômico | `test_management_patch_cannot_change_own_password` | PATCH `403`; nome e senha originais permanecem; token anterior continua válido |
| Dono de equipe, proprietário global e administrador auxiliar também não contornam a reautenticação | `test_privileged_accounts_cannot_bypass_reauthentication` | Todos os PATCH retornam `403`; sessões permanecem válidas e a senha substituta é recusada |
| Senha atual incorreta não altera senha nem sessão | `test_wrong_current_password_preserves_password_and_session` | `/change-password` `401`; token e senha originais continuam válidos; senha substituta falha |
| Senha atual correta troca a senha e revoga sessões anteriores | `test_correct_current_password_rotates_password_and_session` | Troca `200`; token antigo `401`, token novo `200`, login antigo `401` e novo `200` |
| Redefinição administrativa autorizada permanece disponível e revoga somente o alvo | `test_authorized_admin_reset_revokes_only_target_session` | PATCH `200`; sessão do alvo `401`, sessão do dono `200`, somente a nova senha autentica |
| Atualização própria sem senha permanece compatível | `test_self_profile_update_without_password_remains_allowed` | PATCH e `/me` `200` com o novo nome |
| Dono de equipe não redefine a senha de administrador auxiliar | `test_team_owner_cannot_replace_linked_assistant_password` de AUTH-01 | PATCH `403`; senha original válida e substituta recusada |
| Recuperação por token continua sendo uma prova alternativa legítima | `test_reset_revokes_sessions_only_for_token_owner` | Nova senha aplicada e somente a versão da sessão do titular foi incrementada |

## Validação executada

- Ciclo TDD: antes da guarda, `test_management_patch_cannot_change_own_password` falhou porque o PATCH respondeu `200` em vez de `403`; depois da correção mínima, passou.
- Regressões AUTH-04, AUTH-01 e recuperação por token: **13/13 aprovadas**. Log: [`relevant-tests.log`](../../../output/security-fix-auth-04/relevant-tests.log).
- Suíte completa do backend no ambiente isolado: **751/751 aprovados**. A primeira tentativa documentada usou uma dependência local incompleta e o VFS SQLite exclusivo de Linux no Windows; a repetição com as dependências travadas e VFS nativo passou integralmente. Logs: [`backend-full-tests.log`](../../../output/security-fix-auth-04/backend-full-tests.log) e [`backend-full-tests-rerun.log`](../../../output/security-fix-auth-04/backend-full-tests-rerun.log).
- Compilação de `app` e `main.py`: exit `0`. Log: [`backend-compileall.log`](../../../output/security-fix-auth-04/backend-compileall.log).
- Dependências instaladas: `pip check`, exit `0`. Log: [`backend-pip-check.log`](../../../output/security-fix-auth-04/backend-pip-check.log).
- Análise estática: Bandit com severidade média/alta, exit `0`, nenhum achado. Log: [`backend-bandit.log`](../../../output/security-fix-auth-04/backend-bandit.log).
- Auditoria de dependências do backend: nenhum pacote vulnerável conhecido, exit `0`. Log: [`backend-pip-audit.log`](../../../output/security-fix-auth-04/backend-pip-audit.log).
- Frontend: lint exit `0` com 18 avisos preexistentes e nenhum erro; **634/634 testes**; build de produção concluído; auditoria de dependências de produção com severidade alta sem vulnerabilidades. Logs: [`frontend-lint.log`](../../../output/security-fix-auth-04/frontend-lint.log), [`frontend-test-unsandboxed.log`](../../../output/security-fix-auth-04/frontend-test-unsandboxed.log), [`frontend-build.log`](../../../output/security-fix-auth-04/frontend-build.log) e [`frontend-audit-production-high.log`](../../../output/security-fix-auth-04/frontend-audit-production-high.log).
- Verificação do frontend de chamadas: 193 arquivos examinados, nenhum segredo permanente ou harness de teste no bundle de produção. Log: [`frontend-call-security.log`](../../../output/security-fix-auth-04/frontend-call-security.log).

## Trabalho preexistente preservado

O checkout principal permaneceu na branch anterior, defasado e com alterações locais extensas. Nenhum arquivo, commit ou referência desse checkout foi descartado ou incorporado. A etapa foi executada em um novo worktree limpo baseado no `origin/main` atualizado; o prompt não rastreado e todos os demais worktrees preexistentes também foram preservados.

## Limitações

- Esta evidência local usa Python 3.12 e Windows; a CI obrigatória repetirá os gates em Python 3.14 e Linux, incluindo Gitleaks e a qualidade de chamadas em navegador real.
- O encerramento de WebSockets já abertos após rotação da sessão permanece fora deste achado.
- O estado local ainda não comprova merge, imagem publicada ou revisão saudável em produção; esses resultados devem ser vinculados ao SHA integrado durante a entrega.

## Próximo marco

**AUTH-02 — bootstrap administrativo.**
