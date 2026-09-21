# Ponte Codex -> Muse Code -> Zed

Esta integração mantém o Muse Code no painel ACP do Zed. Ela não inicia uma conversa paralela com `muse exec` e não usa teclado, mouse nem área de transferência.

## Arquitetura

1. O Zed inicia `scripts/muse-codex-bridge.mjs proxy` como seu agente ACP.
2. O proxy inicia o adaptador comunitário `muse-acp`, sem alterar o protocolo nem os eventos.
3. O proxy registra apenas as sessões que o próprio Zed abriu ou retomou.
4. O servidor MCP `norium-muse` conecta-se ao proxy por `127.0.0.1`, autenticado por um token aleatório gravado em `tmp/muse-codex-bridge/active.json`.
5. `muse_delegate` envia `session/prompt` à mesma sessão. As mensagens, ferramentas, diffs, testes e pedidos de aprovação emitidos pelo Muse continuam fluindo para o Zed.
6. O Codex aguarda a resposta final, inspeciona o Git diff e os testes e, se necessário, envia uma correção com uma nova chamada limitada.

O arquivo de estado é local, efêmero e ignorado pelo Git. A ponte recusa uma segunda tarefa enquanto a sessão selecionada estiver ocupada. Pedidos de aprovação não são respondidos pela ponte: permanecem sob controle do Zed/usuário.

## Uso

Abra o projeto no Zed e crie ou retome uma conversa em **Muse Code**. Depois, em uma nova tarefa do Codex aberta neste projeto, o servidor MCP `norium-muse` disponibiliza:

- `muse_status`: lista as sessões ACP abertas e o estado ocupado/livre;
- `muse_delegate`: envia o plano e aguarda o turno do Muse;
- `muse_cancel`: cancela o turno ativo.

O Zed precisa reiniciar o agente Muse depois de qualquer alteração na entrada `agent_servers`. O Codex precisa abrir uma nova tarefa (ou reiniciar) para recarregar `.codex/config.toml`.

## Diferença para Terminal Threads

Um Terminal Thread executaria o TUI/CLI do Muse dentro de um terminal organizado pelo Zed. Isso é visível, mas constitui outra sessão e não é o chat ACP já aberto. Esta ponte usa o chat ACP real: o processo `muse-acp` continua traduzindo ACP para o protocolo oficial de sessões do Muse (`muse serve`).

## Validação

Execute o teste determinístico da ponte:

```powershell
node --test scripts/test-muse-codex-bridge.mjs
```

Para o teste real, abra uma conversa Muse no Zed para uma pasta temporária autorizada e peça ao Codex para chamar `muse_delegate` com uma tarefa que crie um arquivo e um teste. A conclusão só é válida depois de observar os eventos no Zed, conferir o arquivo no disco e executar o teste fora do Muse.
