# Revisão de segurança — módulo 1: autenticação e sessões

Data: 13/09/2026. Resultado: **7 achados, sendo 4 P1 (alta) e 3 P2 (média)**. A prioridade indica a ordem recomendada de correção; não representa uma pontuação CVSS.

## Escopo e versão examinada

- Pasta: `C:\NOrium`; branch: `main`; commit: `2747b264d5d3ce223e5386e9401666341be4875d`.
- A referência local `origin/main` estava em `32d8fb6bb1f4478a56a839fe476b70575618f5cf`, 129 commits à frente. Não houve fetch, sincronização ou verificação da versão implantada.
- O objeto desta revisão é o código dessa pasta, incluindo alterações locais preexistentes. Os resultados não devem ser atribuídos automaticamente à produção ou à versão mais recente do projeto.
- Foram examinados o módulo `auth`, primitivas de senha/token, controles de acesso e workspace, middleware relacionado, armazenamento de sessão no frontend e consumidores diretos de autenticação WebSocket. As regras de negócio de Inbox, Equipe e Brainstorm não foram auditadas integralmente.
- Referências de requisitos: [SECURITY.md](../../../SECURITY.md) e [matriz de controles](../../SECURITY_CONTROLS.md).
- Ponto de encerramento: entregar os achados deste módulo, com evidências e critérios de correção. Nenhuma correção funcional foi aplicada.

## Achados

| ID | Prioridade | Problema | Evidência nesta rodada |
| --- | --- | --- | --- |
| AUTH-01 | P1 | Dono de equipe pode redefinir senha de administrador auxiliar vinculado | Análise estática |
| AUTH-02 | P1 | Cadastro com e-mail de bootstrap pode adquirir administração global | Análise estática; depende da configuração descrita abaixo |
| AUTH-03 | P1 | Conexões abertas continuam recebendo dados após logout | Reprodução unitária isolada |
| AUTH-04 | P1 | Rota de gestão permite trocar a própria senha sem a senha atual | Análise estática |
| AUTH-05 | P2 | Desvinculação de equipe é revertida pela migração de `createdBy` | Análise estática |
| AUTH-06 | P2 | Token é persistido no navegador contra a política do projeto | Código e testes existentes |
| AUTH-07 | P2 | Outra aba muda a identidade das requisições sem atualizar a interface | Reprodução isolada com React e jsdom |

### AUTH-01 — Redefinição da senha de administrador por dono de equipe

**Local:** [auth/router.py:731](../../../norium-back-end/app/modules/auth/router.py#L731), especialmente linhas 732–737; atribuição de senha nas linhas 1020–1022.

`assert_can_touch_user` protege o proprietário global, mas permite a alteração quando `target.teamOwnerId == current.id`, mesmo que o alvo tenha `systemAdminRole="assistant"`. A rota `PATCH /api/auth/users/{user_id}` aplica essa autorização antes de aceitar uma nova senha.

**Condição e impacto:** se um administrador auxiliar estiver vinculado à equipe de um usuário sem administração global, esse dono de equipe pode substituir a senha do administrador e assumir os privilégios da conta. A operação de promoção para administrador não remove o vínculo de equipe.

**Correção recomendada:** verificar a hierarquia administrativa antes de qualquer permissão baseada em equipe. Usuários sem administração global não devem alterar senha, status ou outros campos sensíveis de administradores, mesmo que compartilhem uma equipe.

**Critério de validação:** dono de equipe recebe 403 ao tentar alterar administrador auxiliar vinculado; alterações legitimamente autorizadas continuam funcionando. Não foi executada reprodução desse cenário nesta rodada.

**Status da correção em 13/09/2026:** **corrigido e validado localmente** no commit `067e1e4` da branch `codex/auth-01-hierarquia-administrativa`, a partir do commit `2747b264d5d3ce223e5386e9401666341be4875d`. O achado ainda estava presente antes da correção: a regressão inicial recebeu `200` em vez do `403` esperado ao tentar substituir a senha do administrador auxiliar vinculado.

A autorização compartilhada por `PATCH /api/auth/users/{user_id}` e `DELETE /api/auth/users/{user_id}` agora verifica se o alvo possui administração global antes de conceder acesso pelo vínculo de equipe. A proteção existente do proprietário global continua precedendo a permissão dos administradores do sistema. Não houve migração de dados nem alteração da visibilidade da equipe; a gestão de membros comuns e a alteração da própria conta permanecem com a política anterior.

Seis regressões HTTP isoladas cobrem senha, status e desativação do auxiliar, proteção do proprietário global, operação legítima do proprietário sobre o auxiliar, gestão de membro comum da própria equipe e bloqueio de outra equipe. O conjunto pertinente concluiu **31 testes**, e a suíte completa do backend concluiu **384 testes**, todos aprovados. A suíte completa exigiu repetição fora do sandbox porque dois testes preexistentes de multiprocessamento não conseguiam criar pipes locais sob a restrição do Windows; a repetição manteve ambiente sintético e rede externa bloqueada.

Também passaram a compilação de 125 arquivos Python, `pip check`, Bandit sem achados médios/altos, lint do frontend sem erros, **374 testes** do frontend, build e auditoria das dependências de produção do frontend. A auditoria do backend encontrou três vulnerabilidades preexistentes em `pypdf==6.15.0` (`PYSEC-2026-3910`, `PYSEC-2026-3911` e `PYSEC-2026-3913`; correção disponível em 6.16.1), mantidas fora desta correção isolada. Logs e executor estão em [`output/security-fix-auth-01`](../../../output/security-fix-auth-01/).

Esta evidência valida o código local no commit funcional indicado; não valida, por si só, a versão implantada nem a referência mais recente de `origin/main`.

### AUTH-02 — Promoção automática por e-mail de bootstrap

**Local:** [auth/router.py:460](../../../norium-back-end/app/modules/auth/router.py#L460), linhas 460–485; chamadas em `ensure_seed_user` e `write_user_store`, linhas 557–563 e 598–601.

`ensure_admin_roles` escolhe `environment_owner` pela correspondência de ID ou e-mail com a configuração e o coloca à frente do proprietário já registrado. A correspondência por e-mail concede `systemAdminRole="owner"` sem comprovar posse do endereço nem verificar a senha de bootstrap. A normalização também é executada ao salvar um cadastro público.

**Condição e impacto:** `NORIUM_BOOTSTRAP_ADMIN_EMAIL` está configurado para um endereço ainda não cadastrado, e a conta bootstrap não foi efetivamente criada. Isso pode ocorrer, por exemplo, quando somente o e-mail está configurado, ou quando já existem outros usuários e o bootstrap não cria uma conta nova. Quem cadastrar aquele endereço pode adquirir administração global com a senha escolhida no cadastro. Não foi verificado se essa condição existe no ambiente implantado.

**Correção recomendada:** executar bootstrap explicitamente, uma única vez, exigindo configuração completa. Vincular a identidade administrativa a um ID criado e registrado nesse processo; não promover usuários durante leituras/salvamentos comuns por coincidência de e-mail.

**Critério de validação:** cadastro público com endereço reservado de bootstrap é rejeitado ou permanece sem administração; configuração parcial não concede privilégios; cadastro não substitui o proprietário existente. Não foi executada reprodução desse cenário nesta rodada.

**Status da correção em 15/09/2026:** **corrigido e validado localmente; release pendente** no commit funcional `f3877cd` da branch `codex/auth-02-bootstrap-administrativo`, baseado em `fce1724b27694df3c698a35d332173853dfad62b`. A criação do armazenamento foi separada da normalização rotineira. O bootstrap só cria a identidade esperada quando `usuarios_db.json` não existe e e-mail, ID, nome e senha estão completos. Um armazenamento já existente — inclusive vazio ou inválido — não é preenchido posteriormente por mudanças de ambiente. Cadastro público, leitura e gravação não consultam mais a identidade de bootstrap para promover usuários.

A normalização agora usa apenas evidência persistida: primeiro `systemOwnerId`, depois uma função administrativa explícita e, por fim, flags `systemAdmin` do formato legado. Ela persiste a identidade do proprietário e preserva administradores legados legítimos, sem transformar uma conta comum em administradora por coincidência de e-mail ou ID. Não houve leitura, alteração ou migração de dados reais nesta correção.

As **9/9 regressões AUTH-02** passaram em processos isolados, com contas, segredos, configuração e armazenamento temporário sintéticos e rede externa bloqueada. Elas cobrem configuração parcial por e-mail ou ID, os quatro campos obrigatórios, bootstrap completo e idempotente, coincidência por e-mail e ID em armazenamento não vazio, reinício com configuração alterada, armazenamento já inicializado vazio e compatibilidade com administradores legados. Também passaram **28/28 regressões relacionadas** de autenticação e controle de acesso, além do teste isolado do procedimento Azure, que comprova a retomada da revisão sem redefinir variáveis de bootstrap. A suíte completa concluiu **768/768 testes**; compilação, integridade e auditoria das dependências, Bandit, lint, **652/652 testes** do frontend, build e scanner do bundle também passaram. Essas contagens são evidência somente da worktree local; integração, implantação e validação remota ainda estão pendentes.

### AUTH-03 — Revogação não alcança WebSockets estabelecidos

**Locais:** [auth/router.py:886](../../../norium-back-end/app/modules/auth/router.py#L886), [inbox/router.py:97](../../../norium-back-end/app/modules/inbox/router.py#L97) e [team/router.py:83](../../../norium-back-end/app/modules/team/router.py#L83).

Logout e troca de senha incrementam `sessionVersion`. Tokens HTTP e tickets ainda não consumidos conferem essa versão. Entretanto, as conexões estabelecidas não armazenam nem revalidam a versão da sessão: Inbox envia eventos diretamente, e Equipe confere apenas existência, status e vínculo de equipe.

**Impacto reproduzido:** uma conexão anteriormente autenticada permanece recebendo dados privados depois do logout. Na reprodução, o token antigo e um ticket pendente retornaram 401; Inbox e Equipe receberam um novo evento cada e permaneceram abertos. Depois de desativar a conta fictícia, Inbox ainda recebeu outro evento; Equipe fechou corretamente.

**Extensão observada estaticamente:** [inbox/router.py:341](../../../norium-back-end/app/modules/inbox/router.py#L341) continua aceitando `REGISTER_EVENT`, e [brainstorm/router.py:297](../../../norium-back-end/app/modules/brainstorm/router.py#L297) processa `BOARD_UPDATE` com o usuário capturado na conexão. Escritas após revogação e troca de senha não foram reproduzidas dinamicamente nesta rodada.

**Correção recomendada:** vincular conexões à versão e validade da sessão, encerrá-las quando houver revogação e revalidar autorização antes de enviar dados ou processar alterações.

**Critério de validação:** conexões abertas deixam de receber e escrever após logout, mudança de senha, desativação ou perda da permissão relevante. Preservar os testes de revogação de tokens e tickets.

### AUTH-04 — Alteração da própria senha contorna reautenticação

**Local:** [auth/router.py:738](../../../norium-back-end/app/modules/auth/router.py#L738) e [auth/router.py:1020](../../../norium-back-end/app/modules/auth/router.py#L1020). Comparação com `/change-password`, linhas 865–875.

`/change-password` exige a senha atual. Entretanto, um usuário autorizado a gerenciar sua própria conta pode enviar `password` à rota de gestão e substituí-la sem a senha atual. `assert_can_touch_user` permite o próprio usuário, e `can_manage_team` considera suficiente `role="owner"`, inclusive para contas gratuitas criadas pelo cadastro público.

**Condição e impacto:** quem já possui um token de uma conta com esse papel pode transformar o acesso temporário em acesso persistente por senha, além de revogar as sessões anteriores. O cenário pressupõe posse prévia de um token; não constitui login sem credenciais.

**Correção recomendada:** separar a alteração da própria senha da redefinição administrativa. Exigir reautenticação para a primeira e autorização hierárquica explícita para a segunda.

**Critério de validação:** `PATCH` da própria conta não aceita senha sem reautenticação, inclusive no plano gratuito; `/change-password` rejeita senha atual incorreta. Não foi executada reprodução desse cenário nesta rodada.

**Status da correção em 13/09/2026:** **corrigido e validado localmente** no commit `2eb5ab5` da branch `codex/auth-04-reautenticacao-senha`, criada a partir de `origin/main` em `9f94db86bc6f105dc46daabe0a290f0fb4ceb96c`. A aplicabilidade foi revalidada antes da correção: a primeira regressão recebeu `200` no `PATCH` próprio com senha quando esperava `403`.

O endpoint de gestão agora rejeita `password` quando ator e alvo são a mesma conta, depois da autorização hierárquica de AUTH-01 e antes da cópia ou de qualquer mutação. A alteração própria permanece exclusivamente em `/change-password`, que comprova a senha atual e preserva a rotação de `sessionVersion`; redefinições autorizadas de outras contas continuam no `PATCH`. Não houve mudança de esquema, contrato ou frontend porque nenhum consumidor atual envia senha própria pela rota de gestão.

**Evidência da correção:** as 6 regressões HTTP de AUTH-04, as 6 de AUTH-01 e a regressão de recuperação por token passaram (**13/13**); a suíte completa do backend passou (**751/751**). Também passaram compilação, `pip check`, `pip-audit`, Bandit, lint do frontend sem erros, **634/634** testes de frontend, build de produção, auditoria npm de severidade alta e a verificação do bundle de chamadas. Contas, segredo de assinatura, hashes e armazenamento foram sintéticos; conexões externas foram bloqueadas nos cenários AUTH-04. Logs locais estão em `output/security-fix-auth-04/`.

### AUTH-05 — Remoção de equipe é revertida ao salvar

**Local:** [auth/router.py:532](../../../norium-back-end/app/modules/auth/router.py#L532), linhas 532–538; atribuição do novo vínculo nas linhas 1054–1058.

A migração de `createdBy` trata `teamOwnerId=None` como ausência de migração. Quando um administrador remove explicitamente o vínculo de um membro criado por um dono de equipe, `write_user_store` executa a normalização e restaura o vínculo com o criador.

**Condição e impacto:** membro com `createdBy` apontando para um usuário com papel `owner`. A remoção administrativa não revoga o pertencimento à equipe; a autorização que depende desse vínculo continua aplicável. O teste existente cobre trocar por outra equipe, mas não a remoção explícita.

**Correção recomendada:** distinguir campo legado ausente de vínculo explicitamente nulo e registrar a conclusão da migração. Não recriar vínculos em salvamentos normais.

**Critério de validação:** após remover o vínculo, salvar e reler, ele permanece nulo e o antigo dono perde acesso de gestão. A importação de registros realmente legados permanece coberta. Não foi executada reprodução desse cenário nesta rodada.

### AUTH-06 — Persistência de token contrária ao controle obrigatório

**Local:** [useAuthSession.ts:14](../../../norium-front-end/src/app/hooks/useAuthSession.ts#L14), linhas 14–17 e 28–30; [config.ts:45](../../../norium-front-end/src/core/api/config.ts#L45).

Login grava o Bearer em `localStorage` e remove `sessionStorage`. A inicialização também promove uma sessão temporária para persistente. Isso contraria expressamente `SECURITY.md` e a matriz, que exigem armazenamento por sessão.

**Impacto:** a credencial pode permanecer no mesmo perfil do navegador após fechar e reabrir o aplicativo/navegador, enquanto válida. Isso amplia a exposição em perfis compartilhados. A validade padrão do token no backend é de sete dias; logout e alteração de senha ainda podem revogá-lo. Este achado não afirma que `sessionStorage` impeça acesso por JavaScript malicioso.

**Correção recomendada:** restaurar armazenamento por sessão, remover a migração para armazenamento persistente e ajustar os testes que hoje exigem persistência.

**Critério de validação:** login não deixa Bearer em `localStorage`; inicialização não promove tokens; encerramento e nova sessão do navegador respeitam a política definida.

### AUTH-07 — Interface e requisição passam a usar contas diferentes entre abas

**Local:** [useAuthSession.ts:27](../../../norium-front-end/src/app/hooks/useAuthSession.ts#L27), efeito de inicialização sem sincronização de alterações de armazenamento; [client.ts:92](../../../norium-front-end/src/core/api/client.ts#L92).

O hook guarda usuário e token em estado React, enquanto chamadas padrão de API consultam novamente o token compartilhado em `localStorage`. Após sair de A e entrar em B em outra aba, a aba antiga pode continuar mostrando A e enviar chamadas autenticadas como B.

**Impacto reproduzido:** duas instâncias independentes do hook representaram abas; após mudança de conta e evento de armazenamento, a interface da primeira permaneceu em A, a segunda passou para B e uma chamada padrão da primeira usou o Bearer de B. Isso pode exibir dados ou executar ações na conta diferente daquela indicada na interface. Não foi demonstrado desvio do isolamento do backend: ele recebe a credencial de B.

**Correção recomendada:** vincular identidade, token e chamadas à mesma sessão por aba. Mudanças de identidade devem invalidar estado, caches e conexões associados. Corrigir em conjunto com AUTH-06.

**Critério de validação:** cenário de duas abas nunca envia uma requisição de B enquanto a interface declara A; conferir também chamadas com token explícito.

## Verificação e limites

**40 testes existentes passaram:** 25 no backend (`test_security`, `test_access_control` e `TeamIsolationTests`) e 15 no frontend (`useAuthSession.test.ts` e `client.test.ts`). Esses testes não cobrem todos os achados; alguns testes de frontend consolidam a persistência descrita em AUTH-06.

**Duas reproduções adicionais tiveram saída 0:**

- WebSocket: corpos reais de funções/classes extraídos do código, com armazenamento e transportes fictícios. Não é um teste HTTP/ASGI completo.
- Contas em abas: módulos reais transpilados em memória, React/jsdom, instâncias independentes do hook e rede simulada. Não foram usadas abas de um navegador real nem um backend remoto.

Os testes de backend usaram configuração sintética, carregamento de `.env` desabilitado e diretórios isolados sob `output`. O primeiro preparo encontrou restrições de permissões em diretórios temporários do Windows; o executor final usou pastas com permissões herdadas dentro do workspace. Não foram acessados dados de usuários nem serviços reais.

A verificação auxiliar dinâmica de gestão de usuários foi interrompida por um filtro automático de segurança. AUTH-01, AUTH-02, AUTH-04 e AUTH-05 são conclusões de análise estática, com condições e critérios de validação explícitos; não são apresentados como explorações executadas.

Evidências locais, preservadas em pasta ignorada pelo Git:

- [Executor do backend](../../../output/security-review-auth-2026-09-13/run_baseline.py) e [log dos 25 testes](../../../output/security-review-auth-2026-09-13/baseline.log).
- [Log dos 15 testes do frontend](../../../output/security-review-auth-2026-09-13/frontend-existing-tests.log).
- [Verificação de revogação WebSocket](../../../output/security-review-auth-2026-09-13/verify_websocket_revocation.py) e [resultado](../../../output/security-review-auth-2026-09-13/websocket-revocation.log).
- [Verificação de contas em abas](../../../output/security-review-auth-2026-09-13/frontend-multi-tab-proof.mjs) e [resultado](../../../output/security-review-auth-2026-09-13/frontend-multi-tab-proof.log).

Controles verificados favoravelmente incluem hash com sal, rejeição de token assinado por outra chave, revogação HTTP por versão de sessão, uso único de ticket, restrições de workspace e bloqueio da ativação pública de plano pago. Isso não equivale a uma certificação geral do módulo. Dependências, infraestrutura, produção e os demais módulos permanecem fora desta rodada.

## Handoff

- **Branch/commit:** `main` / `2747b264d5d3ce223e5386e9401666341be4875d`; diferença para a referência local remota registrada acima.
- **Concluído:** revisão do primeiro módulo, relatório e evidências isoladas. Sem alterações funcionais, commit ou deploy.
- **Trabalho preservado:** alterações anteriores de integração WhatsApp, infraestrutura, documentação, testes, arquivos não rastreados e `deploy-worktrees` não foram alterados por esta revisão.
- **Limites pendentes:** aplicabilidade à versão mais recente e à produção não verificada; quatro achados precisam de regressões executáveis na etapa de correção.
- **Exatamente um próximo marco:** corrigir e validar autenticação/sessões na base de código escolhida para continuidade, com regressões para AUTH-01 a AUTH-07. Encerrar esse marco quando os cenários negativos forem bloqueados e os fluxos legítimos continuarem passando; só então selecionar o próximo módulo.
