# Operadores manuais de privacidade em homologação

Estes operadores usam a API normal e exigem autorização humana para seus efeitos persistentes. Ambos guardam o runtime `637106e347a0621bb2ad8548382e1a3cf3f57dee`, ambiente `homologacao`, host Linux root, Docker local e runner UID `10001` no container `norium-api`.

O loader privado existente `/srv/norium/private/vps_authenticated_smoke_9176971.py`, SHA256 `266ac3fa766ef58184759409301d21dad1d9e431bef9b526288e18b08527d7d9`, permanece obrigatório. Sua revisão917 é procedência das credenciais; o runtime esperado é637. O diretório privado deve ser root `0700` e seus registros root `0600`. Não adicione credenciais, registros, IDs privados, relatórios reais ou logs ao repositório.

## 1. Criar um membro exclusivo

`provision_private_member_637106e.py`, SHA256 `25470f8239fc55b19a0af2b866fa90767f39f4d1bbb46f63c3fd8f9e2ae6f058`, exige as duas contas exclusivas confirmadas em `smoke-accounts-9176971.json`, patrocinador canônico ativo não administrador, exatamente dois membros conhecidos, plano/assento disponível e ausência de ações automáticas relevantes.

```sh
python3 infra/smoke/provision_private_member_637106e.py --self-check
python3 infra/smoke/provision_private_member_637106e.py --create-one-dedicated-member
```

Persiste a senha proposta antes de uma única tentativa de POST. Verifica o login normal do novo membro, vínculo, equipe com três contas conhecidas e permissões mínimas de dashboard, central, tarefas, chat e perfil. A API agenda o e-mail normal de verificação; o operador não afirma entrega SMTP. O registro `smoke-private-member-637106e.json` impede repetição automática e preserva a senha para reconciliação.

## 2. Preparar fixtures dos três perfis

`primary_privacy_637106e.py`, SHA256 `26905f49d39fc1bf4f06a27e25ff3df74d27f93336eaeac004bd6f32a8925f71`, usa as contas P/A/N existentes. P é o proprietário canônico; A é a conta conhecida explicitamente vinculada a P; N é o membro criado e verificado. O papel legado owner de A não muda a ACL dos projetos, que depende dos IDs e do compartilhamento explícito.

O preparador exige os registros privados das contas originais e do membro criado e verificado, login normal dos três perfis P/A/N, equipe primária com exatamente três contas conhecidas, permissões aplicáveis, ausência de automações relevantes e chamadas ativas, capacidade reservada para histórico e marcador ainda inédito. Cria somente dois projetos e três tarefas sintéticos com compartilhamento explícito.

```sh
python3 infra/smoke/primary_privacy_637106e.py --self-check
python3 infra/smoke/primary_privacy_637106e.py --prepare-fixtures
```

Cada POST depende de checkpoint privado persistido e confirmado pelo host. O ledger `privacy-primary-fixtures-637106e.json` é exclusivo, bloqueia repetição automática e deve ser preservado quando houver conflito, timeout ou resultado incerto.

Depois de confirmar a preparação completa, a fase distinta de revisão usa o mesmo ledger:

```sh
python3 infra/smoke/primary_privacy_637106e.py --read-update-review
```

Essa fase faz três logins normais, leituras de Tarefas/histórico/previews/Inbox, seis sockets com tickets próprios e uma reconexão de A. Até oito PATCHs normais verificam atualização autorizada, duas recusas esperadas, revogação/restauração de A e projeto privado de A. A atividade gerada pelos PATCHs deve alcançar e persistir somente nos perfis autorizados. O helper não envia mensagens ou sinais de chamada; DELETE não possui rota ou flag permitida.

Login atualiza sessão/lastLogin pelo fluxo normal; GET de Tarefas pode inicializar o workspace padrão das contas de teste. A fase e cada POST/PATCH são registrados antes da ação. Guardas PG usam TLS e snapshot somente leitura, antes do login; não inicializam stores ou chamam GET de Automações.

## 3. Revisar candidatos à exclusão em fonte separada

`primary_privacy_delete_637106e.py`, SHA256 `fa2bf05d7174f4b359ee9da0a83c0e22b868ee7cdd40ed772bcb7319503329e8`, carrega por hash fixo o FULL26905 privado. O FULL e seu ledger permanecem intactos; esta fonte usa ledger próprio `privacy-primary-task-deletes-637106e.json`.

```sh
python3 infra/smoke/primary_privacy_delete_637106e.py --self-check
python3 infra/smoke/primary_privacy_delete_637106e.py --review-candidates
```

Essa revisão faz três logins normais e somente GETs de negócio. Exige o ledger primário em `updates-reviewed`, verifica digest/IDs exatos e os snapshots completos das três tarefas, incluindo descrição/categoria, estado, prioridade, criador/responsável, vencimento e arrays vazios de comentários/anexos/labels. Grava o snapshot privado, sem DELETE, PATCH, POST de negócio, sockets ou Undo. Sucesso exige `candidateReviewComplete=true`, `taskSnapshotVerified=true`, zero tentativas e zero tarefas excluídas.

A exclusão é bloqueada por padrão. Somente após a autorização humana aplicável às três tarefas concretas revisadas, conforme item5 de `docs/AI_GOVERNANCE.md`, a combinação explícita abaixo habilita outra fase:

```sh
python3 infra/smoke/primary_privacy_delete_637106e.py --execute-approved-three-task-deletes --human-approved-three-task-deletes
```

Nenhuma flag isolada permite DELETE. O snapshot é novamente comparado imediatamente antes da execução; confirmação e cada ação pending dependem de checkpoint/ACK durável. A fase tem no máximo seis tentativas: N deve receber404 e preservar a tarefa; depois A exclui T2/P1, P exclui T1/P1 e A exclui T3/P2. IDs vêm exclusivamente do ledger. Projetos, contas, registros e histórico não são alvos.

Seis sockets e novas leituras devem comprovar somente os eventos autorizados, seus snapshots persistidos e os projetos preservados; N não recebe atividade nem aumento de unread. Não há mensagens/chamadas enviadas, retry ou recuperação automática. Recuperação/Undo não foi atestada por este operador e fica fora desta fase; não considerar exclusão reversível pela existência de comprovante.

## Reconciliação e limites

Os self-checks usam dados sintéticos, sem rede nem credenciais; fora do Linux dependem do loader local de código revisado no caminho indicado nas fontes. O preflight consulta PostgreSQL com TLS e snapshot somente leitura antes de login/POST. Credenciais seguem somente por stdin privado; stdout contém booleanos, contagens e classes de erro fixas.

O ledger usa lock exclusivo, arquivo irmão root0600, fsync, substituição atômica e fsync do diretório. Sem ACK durável, o child não executa a próxima mutação. Child/host possuem prazos próprios de 240/270 segundos e encerramento com esperas limitadas.

`completeChildReportReceived` indica somente recibo completo e término confirmado. Na ausência dele, `countsAreLowerBounds=true`: contagens mínimas vêm das ações verified do ledger; zero não prova ausência de ação. Uma criação/PATCH/DELETE pending força `postOutcomeUnknown`/`patchOutcomeUnknown`/`deleteOutcomeUnknown` na fonte correspondente, inclusive diante de um recibo do child. `operationOutcomeUnknown=true` impede sucesso e exige reconciliação privada.

Não apague registros, resete contas ou repita uma tentativa incerta. Reconcile o estado durável antes de nova ação. A conta de outra equipe fica fora destes operadores e `fourProfilePrivacyAccepted` permanece false. Comentários/anexos, produtores Nora/automações, exclusão/recuperação e matriz completa precisam de provas próprias. A revisão de candidatos não autoriza DELETE; nenhuma dessas fontes autoriza merge, deploy ou limpeza abrangente. Seguir `docs/AI_GOVERNANCE.md` e `DEPLOY_SHARDCLOUD.md`; o PR permanece rascunho para revisão humana.
