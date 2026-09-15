# Handoff — AUTH-02: bootstrap administrativo

## Estado

- **Status:** corrigido e validado localmente em 15/09/2026; release pendente.
- **Branch:** `codex/auth-02-bootstrap-administrativo`.
- **Commit-base:** `fce1724b27694df3c698a35d332173853dfad62b` (`origin/main` atualizado no início da etapa; merge do AUTH-04).
- **Commit funcional:** `f3877cd` (`fix(auth): isolate administrative bootstrap`).
- **Worktree isolado:** `C:\NOrium\deploy-worktrees\auth-02-bootstrap-administrativo`.

## Causa e correção

O armazenamento era normalizado por `ensure_seed_user` em leituras e gravações comuns. Nesse caminho, `ensure_admin_roles` procurava primeiro um usuário cujo ID ou e-mail coincidisse com `NORIUM_BOOTSTRAP_ADMIN_*`, antes mesmo do `systemOwnerId` persistido. Por isso, um cadastro público podia ser convertido em proprietário global ao ser salvo; configuração parcial também promovia contas e uma mudança posterior de ambiente podia substituir o proprietário legítimo.

A criação inicial foi separada da normalização rotineira. Os quatro valores — e-mail, ID, nome e senha — precisam estar presentes antes da primeira criação de `usuarios_db.json`. Somente esse caminho cria a identidade bootstrap. Arquivo existente, mesmo vazio ou inválido, importação legada, cadastro, leitura e gravação nunca consultam as variáveis para criar ou promover usuários.

`systemOwnerId` válido passou a ser a autoridade primária. Na ausência dele, a migração normaliza um papel `owner` já persistido ou uma flag `systemAdmin` legada sem papel tipado; os demais administradores legítimos permanecem auxiliares. Contas comuns e contas tipadas apenas como auxiliares não são promovidas para resolver ambiguidades.

O procedimento Azure de recuperação continua alterando papéis somente depois de parar a revisão e preservar um snapshot, mas deixou de redefinir variáveis de bootstrap. Depois da gravação verificada, ele reativa explicitamente a mesma revisão, registra o relatório e só então marca a operação como concluída. O procedimento foi exercitado apenas com Azure e armazenamento simulados; nenhuma migração ou conta real foi acessada.

## Arquivos desta etapa

- `norium-back-end/app/modules/auth/router.py`: restringe o bootstrap à criação inicial completa e normaliza somente evidência persistida.
- `norium-back-end/tests/unit/test_auth_administrative_bootstrap.py`: estabelece ambiente e armazenamento temporários antes dos imports e executa cada cenário em processo isolado.
- `norium-back-end/tests/unit/auth_administrative_bootstrap_cases.py`: regressões HTTP para configuração parcial/completa, coincidência por e-mail/ID, reinício, idempotência e compatibilidade legada.
- `infra/azure/set_system_administrators.py`: remove a dependência da identidade de ambiente e reativa a revisão original.
- `norium-back-end/tests/unit/test_set_system_administrators.py`: valida recuperação, snapshot/persistência, retomada e ausência de mutação de `NORIUM_BOOTSTRAP_ADMIN_*` com fronteiras simuladas.
- `SECURITY.md` e `docs/SECURITY_CONTROLS.md`: registram a fronteira obrigatória e sua evidência automatizada.
- `norium-back-end/.env.example`, `DEPLOY_AZURE.md` e `DEPLOY_VERCEL.md`: documentam os quatro valores, o uso único, recuperação explícita e o limite do armazenamento efêmero.
- `docs/security/reviews/2026-09-13-auth-sessions.md`: preserva o achado original e acrescenta o status e a evidência da correção.
- `docs/security/handoffs/AUTH-02.md`: este handoff.
- `output/security-fix-auth-02/`: logs locais ignorados pelo Git.

## Critérios de aceitação

| Critério | Teste | Resultado |
| --- | --- | --- |
| Somente e-mail em armazenamento novo não concede administração | `test_email_only_configuration_cannot_turn_public_registration_into_admin` | Cadastro `200`; `/me` informa conta comum e `/admin/overview` retorna `403` |
| Somente ID não promove conta persistida coincidente | `test_identifier_only_configuration_cannot_promote_existing_account` | Login permitido como conta comum; rota administrativa retorna `403` |
| Qualquer um dos quatro campos ausente desativa o bootstrap | `test_incomplete_identity_configuration_does_not_bootstrap_admin` | E-mail, ID, nome e senha ausentes foram exercitados; login bootstrap retorna `401` e cadastro comum permanece sem administração |
| Configuração completa em banco com usuários não promove cadastro do e-mail configurado | `test_complete_configuration_cannot_promote_public_registration_in_nonempty_store` | Cadastro e login usam somente a senha pública; `/me` permanece comum e admin retorna `403` |
| Configuração completa não promove conta persistida cujo ID coincide | `test_complete_configuration_cannot_promote_persisted_account_with_matching_id` | Conta coincidente permanece comum e admin retorna `403` |
| Bootstrap legítimo cria somente a identidade esperada e é idempotente | `test_complete_bootstrap_is_idempotent_and_creates_only_expected_admin` | Dois logins e leituras mantêm um único proprietário com ID/e-mail configurados; cadastro duplicado retorna `409` |
| Alterar o ambiente não substitui o proprietário persistido | `test_changed_configuration_does_not_replace_persisted_owner` | Em dois processos sobre o mesmo store, o proprietário original continua owner e a conta coincidente continua comum |
| Completar a configuração depois não reabre um store já inicializado vazio | `test_completed_configuration_cannot_bootstrap_initialized_empty_store` | Segundo processo recebe `401` para a identidade tardia; cadastro comum continua sem administração |
| Migração legada preserva administradores sem promover conta comum | `test_legacy_admins_are_preserved_without_promoting_common_account` | Primeiro admin legado vira owner persistido, segundo permanece assistant e conta coincidente recebe `403` |
| Recuperação explícita não depende de bootstrap de ambiente | `test_recovery_persists_roles_and_reactivates_without_bootstrap_environment` | Papéis e `systemOwnerId` persistidos; revisão original reativada; nenhuma chamada `containerapp update` ou variável bootstrap |

## Validação executada

- Ciclo TDD: antes da correção, o cadastro com somente e-mail retornou `systemAdmin=true`; ID/nome ausentes ainda criavam o owner pelos defaults; completar o ambiente depois de um store vazio permitia login bootstrap `200`; e o recovery terminava em `runtime_owner_verification_failed` por depender da alteração de ambiente. Cada regressão ficou verde depois da mudança correspondente.
- Regressões AUTH-02: **9/9 aprovadas**. Junto de AUTH-01, AUTH-04, controle de acesso e recovery: **38/38 aprovadas**. Log: [`relevant-tests.log`](../../../output/security-fix-auth-02/relevant-tests.log).
- Suíte completa do backend: **768/768 aprovados** em Python 3.12. O Windows exigiu repetição fora do sandbox porque diretórios criados por `tempfile.mkdtemp` não aceitavam os arquivos atômicos dos próprios testes sob a restrição local. Log: [`backend-full-tests.log`](../../../output/security-fix-auth-02/backend-full-tests.log).
- Compilação de `app`, `main.py` e do procedimento Azure: exit `0`. Log: [`backend-compileall.log`](../../../output/security-fix-auth-02/backend-compileall.log).
- Dependências instaladas: `pip check`, exit `0`. Log: [`backend-pip-check.log`](../../../output/security-fix-auth-02/backend-pip-check.log).
- Análise estática: Bandit com severidade média/alta, exit `0`, sem achados. Log: [`backend-bandit.log`](../../../output/security-fix-auth-02/backend-bandit.log).
- Auditoria do backend: nenhum pacote vulnerável conhecido, exit `0`. Log: [`backend-pip-audit.log`](../../../output/security-fix-auth-02/backend-pip-audit.log).
- Frontend: lint exit `0` com 18 avisos preexistentes e nenhum erro; **652/652 testes**; build de produção concluído; auditoria das dependências de produção sem vulnerabilidades. Logs: [`frontend-lint.log`](../../../output/security-fix-auth-02/frontend-lint.log), [`frontend-tests.log`](../../../output/security-fix-auth-02/frontend-tests.log), [`frontend-build.log`](../../../output/security-fix-auth-02/frontend-build.log) e [`frontend-audit-production-high.log`](../../../output/security-fix-auth-02/frontend-audit-production-high.log).
- Scanner do frontend de chamadas: 196 arquivos examinados, nenhum segredo permanente nem harness de teste no build. Log: [`frontend-call-security.log`](../../../output/security-fix-auth-02/frontend-call-security.log).
- Revisão independente final: nenhum achado P0–P3 remanescente no código, nos testes ou no procedimento de recuperação.

## Trabalho preexistente preservado

O checkout principal permaneceu na branch `codex/auth-01-hierarquia-administrativa`, defasado e com alterações locais e arquivos não rastreados extensos. Nada desse checkout foi descartado, incluído ou reformatado. O AUTH-02 foi implementado em novo worktree limpo a partir do `origin/main` que já continha AUTH-01 e AUTH-04. Todos os demais worktrees e documentos externos também foram preservados.

## Compatibilidade e limitações

- Stores com `systemOwnerId` válido mantêm esse proprietário. Stores legados sem ponteiro usam apenas papéis/flags administrativas já persistidos; usuários comuns nunca são candidatos.
- Um `systemOwnerId` que já tenha sido persistido pela vulnerabilidade não pode ser distinguido automaticamente de uma escolha legítima. A correção o preserva e exige auditoria/recuperação explícita para qualquer remediação; não houve tentativa de inferência nem migração de dados reais.
- Remover deliberadamente `usuarios_db.json` elimina a evidência de inicialização e representa um novo armazenamento. A documentação exige parada, snapshot e comprovação de ausência de dados antes de qualquer reinicialização.
- O armazenamento `/tmp` do Vercel pode desaparecer entre instâncias e não oferece a persistência necessária para produção administrativa.
- A validação local usou Windows e Python 3.12; a CI repetirá os gates em Linux/Python 3.14, incluindo Gitleaks e os cenários de qualidade de chamadas em navegador real.
- A instalação npm completa informou três vulnerabilidades moderadas em dependências de desenvolvimento; a auditoria do conjunto de produção retornou zero vulnerabilidades e o gate configurado passou.
- Este handoff registra o estado anterior ao push, integração e deploy; essas evidências devem ser vinculadas ao SHA integrado na entrega final.

## Próximo marco

**AUTH-05 — remoção do vínculo de equipe.**
