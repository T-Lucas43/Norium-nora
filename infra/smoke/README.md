# Membro exclusivo para validação de privacidade

`provision_private_member_637106e.py` cria no máximo um membro exclusivo na equipe de teste de homologação, pela API normal. Fonte revisada SHA256: `25470f8239fc55b19a0af2b866fa90767f39f4d1bbb46f63c3fd8f9e2ae6f058`.

O operador deve ter autorização humana para a criação. Executar no host Linux como root, com Docker local e container `norium-api` publicado na revisão `637106e347a0621bb2ad8548382e1a3cf3f57dee`, ambiente `homologacao`.

Pré-requisitos privados já existentes na VPS:

- `/srv/norium/private/` root `0700` e `smoke-accounts-9176971.json` root `0600`, com as duas contas exclusivas originais confirmadas.
- `/srv/norium/private/vps_authenticated_smoke_9176971.py`, SHA256 `266ac3fa766ef58184759409301d21dad1d9e431bef9b526288e18b08527d7d9`. Esse arquivo é o loader revisado das contas; sua revisão `9176971` é procedência das credenciais, enquanto o guard do runtime exige `637106e`.
- Patrocinador canônico ativo, não administrador, equipe com exatamente as duas contas conhecidas, plano/assento disponível e nenhuma automação automática relevante.

```sh
python3 infra/smoke/provision_private_member_637106e.py --self-check
python3 infra/smoke/provision_private_member_637106e.py --create-one-dedicated-member
```

Sem a opção explícita de criação, o script encerra sem criar conta. O self-check usa dados sintéticos e não acessa rede ou credenciais; fora do Linux, depende do loader local já revisado no caminho indicado pelo script.

O preflight lê PostgreSQL com TLS, snapshot somente leitura e rollback antes do login/POST. As credenciais passam por stdin privado ao runner UID `10001`; stdout do host contém somente booleanos, contagens e classes de erro fixas.

A nova senha aleatória é persistida em arquivo root `0600` exclusivo antes de qualquer POST. O resultado usa substituição atômica, preservando a senha se a atualização falhar. A execução faz uma única tentativa de criação, verifica login normal, vínculo, exatamente três membros conhecidos e permissões de dashboard, central, tarefas, chat e perfil. A API agenda seu e-mail normal de verificação na caixa exclusiva; o resultado não afirma entrega SMTP.

O registro `/srv/norium/private/smoke-private-member-637106e.json` impede repetição automática. Em conflito, timeout ou resultado incerto, preserve o registro e reconcilie a conta antes de nova ação; não apague os registros nem resete credenciais para repetir a execução. A conta de outra equipe permanece fora deste script.

A criação do membro não é aceite dos quatro perfis de privacidade nem publicação da aplicação. Fixtures de projetos/tarefas e seus testes devem ter preparação e evidência próprias, conforme `docs/AI_GOVERNANCE.md` e `DEPLOY_SHARDCLOUD.md`. Este PR permanece rascunho para revisão humana.