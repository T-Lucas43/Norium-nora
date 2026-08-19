# Matriz de controles de seguranca

| Risco | Controle preventivo | Evidencia automatizada |
| --- | --- | --- |
| Mistura entre usuarios | Tenant derivado do Bearer; evento exige `metadata.userId`; estado de notificacao por usuario | Testes de isolamento com dois usuarios |
| IDOR em anexos/midias | Verificacao de propriedade/projeto antes de servir arquivo | Testes de acesso negado |
| SSRF e vazamento de chave | HTTPS, allowlist de host, sem redirect, tamanho e MIME limitados | Testes do proxy |
| Webhook forjado | Segredo opcional do provedor, instancia verificada e destino fixo da integracao | Testes de destino divergente |
| XSS e rastreamento por e-mail | iframe sem scripts, CSP interno e bloqueio de recursos remotos | Teste do documento responsivo |
| Roubo persistente de token | `sessionStorage`, CSP, headers e sessao revalidada no backend | Testes de autenticacao |
| Dependencia vulneravel | Dependabot, SCA, SAST, secret scan, SBOM e proveniencia | Workflow do GitHub Actions |
| Exposicao a IA | Minimizacao local, prompt injection tratado como dado, confirmacao humana | Testes de guardrails |

Risco residual relevante: o armazenamento JSON e a fila WebSocket usam uma replica. Escala horizontal exige banco transacional e pub/sub com isolamento por tenant antes de aumentar replicas.
