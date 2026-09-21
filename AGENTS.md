# Fluxo padrão de implementação com Muse Code

Para tarefas que pedem alteração de código neste repositório, o Codex atua como supervisor e usa o servidor MCP `norium-muse` como executor principal quando uma sessão Muse Code correspondente estiver aberta no Zed.

1. Inspecione o repositório e produza um plano técnico específico, incluindo arquivos, critérios de aceitação, testes e limites de segurança.
2. Confirme com `muse_status` que existe exatamente uma sessão livre para `C:/Users/Tarcisio Lucas/norium`.
3. Envie o plano completo com `muse_delegate`. Não edite simultaneamente os mesmos arquivos e aguarde o término do turno.
4. Revise independentemente o Git diff e os arquivos reais. Execute os testes adequados; não aceite o relato do Muse como prova suficiente.
5. Se houver defeito, envie uma instrução objetiva de correção. O limite padrão é duas tentativas no total (`maxAttempts: 2`). Ao atingir o limite, pare e informe o problema ao usuário.
6. Não faça push, deploy, exclusão destrutiva nem amplie o escopo sem autorização explícita. Preserve isolamento de dados, tenancy, aprovações e demais regras de segurança do Norium.

Se a sessão ACP do Zed não estiver disponível, explique o bloqueio. Não alegue que uma execução independente de `muse exec` apareceu no chat do Zed. Para mudanças pequenas, urgentes ou quando o usuário pedir execução direta pelo Codex, siga a instrução explícita do usuário.
