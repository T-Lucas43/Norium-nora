# Matriz de controles de seguranca

| Risco | Controle preventivo | Evidencia automatizada |
| --- | --- | --- |
| Mistura entre usuarios | Tenant derivado do Bearer; evento exige `metadata.userId`; estado de notificacao por usuario | Testes de isolamento com dois usuarios |
| IDOR em anexos/midias | Verificacao de propriedade/projeto antes de servir arquivo | Testes de acesso negado |
| SSRF e vazamento de chave | HTTPS, allowlist de host, sem redirect, tamanho e MIME limitados | Testes do proxy |
| Webhook forjado | Segredo obrigatorio em producao, comparacao constante, instancia verificada e destino fixo da integracao | Testes fail-closed e de destino divergente |
| XSS e rastreamento por e-mail | iframe sem scripts, CSP interno e bloqueio de recursos remotos | Teste do documento responsivo |
| Roubo persistente de token | `sessionStorage`, CSP, logout e troca de senha revogam sessoes; WebSockets usam ticket efemero de uso unico | Testes de autenticacao e reutilizacao de ticket |
| Elevacao de plano/permissao | Plano pago exige operacao administrativa; permissoes da conta sao intersectadas com os direitos do plano em toda API protegida | Testes de acesso direto e autoativacao negada |
| Troca arbitraria de workspace | `X-Norium-Workspace` e validado contra workspaces ativos da conta autenticada | Testes com workspace conhecido e workspace de terceiro |
| Dependencia vulneravel | Dependabot, SCA, SAST, secret scan, SBOM e proveniencia | Workflow do GitHub Actions |
| Exposicao a IA | Minimizacao local, prompt injection tratado como dado, confirmacao humana | Testes de guardrails |

Risco residual relevante: o armazenamento JSON e a fila WebSocket usam uma replica. Escala horizontal exige banco transacional e pub/sub com isolamento por tenant antes de aumentar replicas.
