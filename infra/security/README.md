# Perfil de sandbox usado no CI

`playwright-seccomp-v1.62.0.json` é cópia do arquivo oficial Microsoft Playwright, versão correspondente ao lock do backend:

- Fonte: https://github.com/microsoft/playwright/blob/v1.62.0/utils/docker/seccomp_profile.json
- Git blob da fonte: `fddc05fb520affb145404e6f6f647ca96af8087d`.
- Licença Apache 2.0, preservada em `LICENSE.playwright`.

O perfil mantém defaultAction=SCMP_ACT_ERRNO e permite clone/setns/unshare para namespaces do usuário, como documentado pelo mantenedor. O CI usa UID sem privilégios, nenhuma capability, no-new-privileges, filesystem somente leitura, tmpfs limitados e rede desligada no smoke DOM. Não altera sysctl/AppArmor da máquina, não usa SYS_ADMIN, privileged ou seccomp unconfined.

Esse arquivo é usado **somente no runner descartável**. Sua inclusão não configura o Shard. A compatibilidade do sandbox e qualquer política de runtime do provedor precisam de revisão humana e comprovação na imagem promovida. Se o Shard não suportar isolamento adequado, a publicação continua bloqueada; não desabilitar sandbox para fazer o gate passar.

O inventário executado durante build não prova navegação, clique ou sandbox. Esses comportamentos têm gate de runtime próprio, obrigatório.
