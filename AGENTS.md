# Fluxo padrão de implementação direta com Codex

Preserve alterações preexistentes e leia apenas as fontes pertinentes à tarefa.

- Para código e dados tratados com IA, siga `docs/AI_GOVERNANCE.md`.
- O Codex executa diretamente as tarefas deste repositório. Não consulte, acione ou delegue ao Muse por padrão.
- Use o piloto Muse Code e `docs/workflows/codex-muse.md` somente quando o usuário pedir Muse explicitamente na tarefa atual.
- Quando o Muse for pedido, o núcleo obrigatório do prompt é: `AGENTS.md`, `docs/AI_GOVERNANCE.md` e `docs/workflows/codex-muse.md`, além do handoff específico da tarefa.
- Mantenha regras duráveis neste arquivo e o estado de cada tarefa no respectivo handoff; não dependa da memória de outra conta ou conversa.
- Se a revisão do Codex encontrar falhas, registre os achados no handoff e entregue ao usuário um prompt pronto para o Muse corrigir, com arquivos afetados, resultado esperado, testes de regressão e limites de escopo. Se a entrega for aceita sem falhas, informe o aceite sem gerar prompt de correção.

Para tarefas que pedem alteração de código neste repositório, o Codex atua como executor principal. O fluxo abaixo só se aplica quando o usuário solicitar Muse explicitamente:

1. Inspecione o repositório e produza um plano técnico específico, incluindo arquivos, critérios de aceitação, testes e limites de segurança.
   Crie ou atualize `docs/handoffs/AAAA-MM-DD-muse-assunto.md` e use-o como fonte do estado da tarefa.
2. Confirme com `muse_status` que existe exatamente uma sessão livre para `C:/Users/Tarcisio Lucas/norium`.
3. Envie o plano completo com `muse_delegate`. Não edite simultaneamente os mesmos arquivos e aguarde o término do turno.
4. Revise independentemente o Git diff e os arquivos reais. Execute os testes adequados; não aceite o relato do Muse como prova suficiente.
5. Se houver defeito, envie uma instrução objetiva de correção. O limite padrão é duas tentativas no total (`maxAttempts: 2`). Ao atingir o limite, pare e informe o problema ao usuário.
6. Não faça push, deploy, exclusão destrutiva nem amplie o escopo sem autorização explícita. Preserve isolamento de dados, tenancy, aprovações e demais regras de segurança do Norium.

Se o usuário tiver solicitado Muse e a sessão ACP do Zed não estiver disponível, explique o bloqueio. Não alegue que uma execução independente de `muse exec` apareceu no chat do Zed. Sem pedido explícito de Muse, implemente diretamente com Codex.
