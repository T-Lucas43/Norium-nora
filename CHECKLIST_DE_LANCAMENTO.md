# Checklist de lançamento

> Auditoria local de 16/09/2026. Branch `main`, commit `a8196d82620b867692203295e5b35130adbed8a7`. Código de produção: conforme declaração do responsável, igual ao checkout local; configuração, dependências instaladas, dados e operação de produção não foram verificados. Nenhum deploy ou alteração de dados reais foi realizado.

Status possíveis: Pendente, Em andamento, Aprovado, Bloqueado. Nenhum item abaixo foi marcado como aprovado só por existir código. Os três P0 são bloqueadores ativos; os P1 dependem das provas indicadas.

| Área | Prioridade | Responsável sugerido | Verificação objetiva | Status | Evidência/assinatura |
| --- | --- | --- | --- | --- | --- |
| Segurança | P0 | Backend/Segurança | AUD-01: leituras inválidas preservam dados, com alerta e restore | Pendente | — |
| Segurança | P0 | Backend/Produto | AUD-02: membro Equipe participa do chat/chamada sem permissão administrativa | Pendente | — |
| Segurança | P0 | Backend/Segurança | AUD-03: matriz de adminPermissions aplicada a todos endpoints financeiros | Pendente | — |
| Dados | P1 | SRE/Backend | Backup completo, independente e criptografado com RPO/RTO aprovados | Pendente | — |
| Dados | P1 | SRE/QA | Restauração integral em homologação: JSON, SQLite, arquivos, login, hashes | Pendente | — |
| Dados | P1 | Backend/QA | Integridade de relações financeiras e preços/assentos coerentes | Pendente | — |
| Disponibilidade | P1 | SRE | Readiness real e alarmes para storage, disco, erro e fila | Pendente | — |
| Disponibilidade | P1 | SRE | Ensaio de rollback de imagem/dados compatíveis com tempo registrado | Pendente | — |
| Integrações | P1 | Backend/QA | Quota/limpeza dos uploads Nora e navegador | Pendente | — |
| Integrações | P1 | Backend/QA | Retomada de automações não repete efeito concluído | Pendente | — |
| Testes | P1 | QA/Backend | Unittest backend completo com saída/exit arquivados | Pendente | — |
| Testes | P1 | QA/Segurança | Matriz A/B expandida: tarefas, documentos, propostas, busca, WS, jobs | Pendente | — |
| Testes | P1 | QA/Produto | Jornadas cadastro, convite, dados, assinatura, e-mail e integrações em staging | Pendente | — |
| Testes | P1 | SRE/Segurança | Dependências runtime da imagem auditadas por digest/SBOM; Gitleaks CI verde | Pendente | — |
| Operação | P1 | SRE | Processos de alerta, plantão, incidente e reversão com responsáveis | Pendente | — |
| Privacidade | P1 | Jurídico/Privacidade | Termos, política, retenção, canal e fluxo de direitos aprovados | Pendente | — |
| Comercial | P1 | Produto/Financeiro | Preços, limites, cobrança e plano de indisponibilidade reconciliados | Pendente | — |
| Verificação final | P1 | Release/QA | Versão implantada e configuração documentadas; smoke autorizado com duas contas | Pendente | — |

## Decisão de release

- [ ] Produto, Segurança, Backend, SRE e Privacidade assinaram aceites aplicáveis.
- [ ] Todas as exceções foram documentadas com escopo, prazo, responsável, monitoramento e plano de revogação.
- [ ] Veredito alterado de NO-GO somente após nova evidência; nenhuma exceção pode autorizar vazamento cross-tenant ou perda de dados.