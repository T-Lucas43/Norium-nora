# Perfil de sandbox usado no CI

`playwright-seccomp-v1.62.0.json` é cópia do arquivo oficial Microsoft Playwright, versão correspondente ao lock do backend:

- Fonte: https://github.com/microsoft/playwright/blob/v1.62.0/utils/docker/seccomp_profile.json
- Git blob da fonte: `fddc05fb520affb145404e6f6f647ca96af8087d`.
- Licença Apache 2.0, preservada em `LICENSE.playwright`.

O perfil mantém defaultAction=SCMP_ACT_ERRNO e permite clone/setns/unshare para namespaces do usuário, como documentado pelo mantenedor. O CI usa UID sem privilégios, nenhuma capability, no-new-privileges, filesystem somente leitura, tmpfs limitados e rede desligada no smoke DOM. Não altera sysctl/AppArmor da máquina, não usa SYS_ADMIN, privileged ou seccomp unconfined.

Esse arquivo é usado **somente no runner descartável**. Sua inclusão não configura o Shard. A compatibilidade do sandbox e qualquer política de runtime do provedor precisam de revisão humana e comprovação na imagem promovida. Se o Shard não suportar isolamento adequado, a publicação continua bloqueada; não desabilitar sandbox para fazer o gate passar.

O inventário executado durante build não prova navegação, clique ou sandbox. Esses comportamentos têm gate de runtime próprio, obrigatório.

## Perfil derivado para o runner sem capabilities

A rodada `38423c2` construiu a imagem, mas o zygote Chromium morreu antes da confirmação do sandbox. Hipótese específica a validar: o perfil oficial permite `chroot` somente se o Docker mantiver `CAP_SYS_CHROOT`; o CI remove todas as capabilities. O código oficial Chromium 151.0.7922.34 em `sandbox/linux/services/credentials.cc` usa `chroot('/proc/self/fdinfo/')` para retirar acesso ao filesystem dentro do namespace próprio.

`build_browser_seccomp.py` confere SHA-256 da cópia oficial (LF), preserva todas as suas regras e acrescenta somente a permissão de syscall `chroot` em um arquivo temporário do runner. Isso não concede `CAP_SYS_CHROOT`: o kernel continua verificando capabilities no namespace. O smoke exige UID 10001, CapInh/Prm/Eff/Bnd/Amb zero, no-new-privileges e filtro seccomp. Um subprocesso separado deve comprovar que `chroot('/')` no namespace inicial continua negado, além das confirmações namespace/seccomp do Chromium e interação DOM.

Essa alteração é uma proposta testável **apenas no CI**, ainda não validada no runtime. Não aplicar ao Shard sem revisão crítica humana e compatibilidade comprovada. Não expandir a lista de syscalls por tentativa genérica. Não alterar capabilities, AppArmor ou sysctl nem remover sandbox.

CI `37200158812` / `761cbe5`: após a derivação, o smoke confirmou UID/capabilities/seccomp/no-new-privileges/negação de chroot inicial e o Chromium **iniciou**. A próxima checagem reprovou porque procurava a linha obsoleta "Namespace sandbox". A fonte oficial da versão instalada [sandbox_internals.ts](https://github.com/chromium/chromium/blob/151.0.7922.34/chrome/browser/resources/sandbox_internals/sandbox_internals.ts), blob `9273695331dc2af87234ff865ab1f1b343a4ff35`, usa "Layer 1 Sandbox / Namespace". O smoke corrigido aguarda a avaliação e exige exatamente essa linha, PID/network namespaces Yes, Seccomp-BPF Yes e "You are adequately sandboxed.". Não reduz os controles de runtime.
