# Runbook — Muse Code no Zed/Windows

Este runbook cobre o adaptador comunitário `muse-acp` no Windows. Ele complementa o [fluxo Codex + Muse](codex-muse.md); não altera os controles de segurança do projeto.

## Pré-voo

Antes de uma tarefa que use shell, Git ou rede:

1. Confirme a versão do Muse e do `muse-acp`.
   A combinação observada no piloto foi Muse 1.3.0 com `muse-acp` 0.4.5; o self-test local não registra essa versão do host como combinação validada. Trate compatibilidade `unknown` como risco operacional até existir teste upstream.
2. Execute `muse sandbox windows check`. O resultado esperado inclui `status=ready`, `runner_trusted=true` e `wfp_ready=true`. Se WFP não estiver pronto, execute o setup oficial com privilégio administrativo e repita a checagem.
3. No Zed, mantenha o seletor e `MUSE_APPROVAL_MODE` no mesmo modo. O piloto usa `promptUnmatched`.
4. Use `MUSE_SERVE_ARGS="--trust-workspace --sandbox-network enabled"` apenas no host destinado às tarefas que precisam de GitHub ou download. Sandbox de arquivos e aprovações continuam ativos.
5. Confirme que o projeto e cada worktree criado por uma conta sandbox estão na lista `safe.directory` da conta que executa o Zed. Registre somente caminhos específicos.
6. Confirme Python, Git e GitHub com comandos curtos antes de iniciar uma tarefa longa.

## Git e GitHub isolados

- A configuração pessoal em `%APPDATA%\GitHub CLI` não deve ser aberta para a conta sandbox.
- Neste workspace, os wrappers locais ficam em `C:\NOrium\.muse-runtime`, pasta ignorada pelo `.gitignore` e que nunca deve ser versionada:
  - `git.cmd` define o `GIT_CONFIG_GLOBAL` isolado;
  - `gh.cmd` define o `GH_CONFIG_DIR` isolado;
  - `gitconfig` usa `http.sslBackend=openssl` e `http.sslVerify=true` para evitar `SEC_E_NO_CREDENTIALS` do Schannel sob a conta sandbox.
- Autentique o perfil isolado por código de dispositivo. Tokens não entram em prompt, log, repositório ou wrapper.
- Regras persistentes de aprovação devem se limitar aos wrappers estáveis e aos subcomandos necessários. Caminhos efêmeros do sandbox e comandos genéricos de escrita não são políticas duráveis.

## Forma de execução

1. Um turno executa um checkpoint.
2. Uma chamada de ferramenta contém um comando.
3. O comando usa o wrapper solicitado e não contém separadores de shell.
4. Depois de cada marco, o Muse relata evidência e próximo passo.
5. Checkpoints de release: preparar; transferir; verificar; commit/PR; checks/merge; deploy/saúde.
6. Consulte um check e devolva o checkpoint. Não mantenha `--watch` indefinidamente em um turno ACP.

## Diagnóstico e recuperação

| Sintoma | Diagnóstico | Ação segura |
|---|---|---|
| `Failed to connect ... proxy 127.0.0.1` | WFP/proxy do sandbox indisponível ou host iniciado com postura antiga | Rode `muse sandbox windows check`; corrija WFP; reinicie completamente o agente após mudar `MUSE_SERVE_ARGS`. |
| `Access is denied` na configuração do `gh` | CLI tentou usar o perfil pessoal | Use o wrapper e o `GH_CONFIG_DIR` isolado dentro do workspace. |
| `SEC_E_NO_CREDENTIALS` | Git tentou Schannel com a identidade sandbox | Use o gitconfig isolado com OpenSSL e verificação TLS ativa. |
| `detected dubious ownership` | Zed e Muse usam identidades Windows diferentes | Adicione somente o worktree afetado a `safe.directory` para cada identidade que precisa lê-lo. |
| Python inacessível | Venv aponta para interpretador no perfil privado | Disponibilize leitura/execução somente na instalação Python ou use um interpretador de projeto acessível. Não abra o perfil inteiro. |
| Aprovação alegada sem popup | Estado de aprovação divergiu entre Muse, adaptador e Zed | Cancele a sessão, verifique o disco e retome em sessão nova. Não envie um follow-up para destravar. |
| Comando curto sem novo evento por cinco minutos | Turno/adapter travado | Cancele; confira `git status` e logs; reinicie agente. Na segunda ocorrência, continue pelo Muse CLI direto. |
| Teste silencioso | Pode ser execução normal ou loop de permissão | Confira processo/CPU e duração histórica. Use saída verbosa ou captura de stack. No sandbox Codex, `NamedTemporaryFile` pode repetir após negação de escrita; rode os testes sintéticos fora dele com autorização. |

## Logs e evidência

- Zed: `%LOCALAPPDATA%\Zed\logs\Zed.log`.
- Registre horário, último evento, comando, estado do worktree e versões.
- `muse-acp --selftest` valida compatibilidade estática; `muse-acp --support` gera material de suporte redigido.
- No incidente observado, o log registrou falhas do ledger de aprovação antes de `unrecorded human resolution`; isso confirma decisão recebida e não persistida, em vez de omissão do usuário.
- Um erro repetível do adaptador deve ser reportado com logs redigidos. Não inclua token, conteúdo de cliente ou arquivo de produção.

## Fallback pelo Muse CLI

Quando o ACP falhar duas vezes no mesmo checkpoint, execute o Muse diretamente no checkout:

```powershell
Set-Location "<checkout>"
& "<muse.exe>" --trust-workspace --sandbox-network enabled --approval-mode on-request
```

Envie um pacote de retomada autossuficiente e limite o turno ao checkpoint interrompido.
