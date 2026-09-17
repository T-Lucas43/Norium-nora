# Plano de correção priorizado

> Auditoria local de 16/09/2026. Branch `main`, commit `a8196d82620b867692203295e5b35130adbed8a7`. Código de produção: conforme declaração do responsável, igual ao checkout local; configuração, dependências instaladas, dados e operação de produção não foram verificados. Nenhum deploy ou alteração de dados reais foi realizado.

Critério de conclusão do plano: gates P0/P1 aceitos com provas repetíveis, nenhuma alteração de produção nesta auditoria. Prazos começam somente após alocação de responsáveis e ambiente de homologação.

## P0 — Antes de qualquer lançamento

| IDs | Ação | Dependências | Esforço e risco da mudança | Aceite verificável |
| --- | --- | --- | --- | --- |
| AUD-01 | Falhar fechado na persistência inválida e preservar bytes; simular JSON/OSError em auth e financeiro. | Acesso somente a cópias descartáveis e estratégia de migração/restore. | Médio; risco médio de deixar dados legados inválidos indisponíveis até reparar. | GET em arquivo inválido não grava; hash original permanece; alerta e 5xx controlado; restore ensaiado. |
| AUD-02 | Alinhar entitlement de membro para chat/chamada e separação de gestão. | Matriz de papéis e plano Equipe definida. | Médio; risco de ampliar permissão indevidamente. | Criar membro → login → chat/chamada permitido; gestão/admin e outra equipe negados. |
| AUD-03 | Aplicar `adminPermissions` a cada ação financeira ou suspender auxiliares financeiros. | Inventário de rotas financeiras e decisão sobre papel owner. | Médio; risco de bloquear auxiliares legítimos durante transição. | Todas as flags falsas => 403 sem mutação/importação/exportação; owner continua operando. |

## P1 — Antes do lançamento público

| IDs | Ação | Dependências | Esforço e risco da mudança | Aceite verificável |
| --- | --- | --- | --- | --- |
| AUD-06 | Implantar backup independente, consistente e retenção, e realizar restore completo. | AUD-01; inventário de JSON/SQLite/arquivos/chaves. | Médio; risco operacional alto se snapshot inconsistente. | RPO/RTO documentados; restore isolado com hashes, integridade SQLite, login e arquivos válidos. |
| AUD-04 | Quota por tenant/global e coleta dos uploads Nora/navegador. | Métricas de uso de disco e política de retenção. | Médio; risco de remover arquivo ainda referenciado. | 3 uploads com limite de índice2 deixam2 físicos ou limpeza explícita; gravação além da quota=413 sem arquivo órfão. |
| AUD-05 | Checkpoint e idempotência por etapa das automações. | Contrato de efeitos externos e AUD-08. | Grande; risco de reenviar ou pular efeito de status incerto. | Fake de falha pós-envio e rerun mantém contagem de envio=1; estados incertos pedem conciliação. |
| AUD-07/AUD-14 | Validar entidades financeiras e unificar preços, limites e assentos. | Decisão comercial única e levantamento de registros órfãos em cópia. | Médio; risco de incompatibilidade com dados legados. | ID inexistente=422/404; limites assentos aplicados; UI/API/admin mostram mesmos valores. |
| AUD-08/AUD-10 | Readiness de storage e recuperação da idempotência/outbox. | Semântica de resultado incerto e monitoramento. | Médio; risco de duplicata ao liberar pedidos antigos. | Storage inválido=>readiness503; liveness leve; retry antigo é reconciliado sem duplicata. |
| AUD-11/AUD-16 | Fixar e auditar dependências da imagem; ensaiar rollback e observabilidade. | Digest imutável, ambiente de homologação e responsável operacional. | Médio; risco de incompatibilidade ao atualizar dependências. | SBOM/digest auditado, scanners verdes, alerta recebido e reversão ensaiada com dados preservados. |
| AUD-12/AUD-18/AUD-19 | Completar termos/política/processo de exclusão; validar formulários e assinatura por workspace. | Revisão jurídica e esquema de tokens/scopes. | Médio; risco de links existentes exigirem migração. | Política aprovada, solicitações exercitadas; workspace removido invalida formulário; assinatura secundária abre sem header e não cruza workspace. |
| GATE-TESTES | Executar backend unittest, E2E de jornadas e integrações em homologação com duas contas. | Ambiente descartável e credenciais próprias de teste; correções P0/P1. | Médio; risco de falso positivo se fixtures não imitarem deploy. | Exit0 e log arquivado, matriz A/B por módulo, falhas reais de provedor documentadas sem dados pessoais. |

## P2 — Logo após o lançamento

| IDs | Ação | Dependências | Esforço e risco da mudança | Aceite verificável |
| --- | --- | --- | --- | --- |
| AUD-09 | Corrigir 500 no limite para 429 com Retry-After. | Nenhuma. | Pequeno; risco baixo. | Duas requisições no limite sintético => 401/429 e header correto. |
| AUD-13/AUD-17 | Definir duração/armazenamento de sessão e validar cadeia de segredo W-API. | Política de sessão e suporte do provedor. | Médio; risco de reautenticar usuários/invalidar webhook. | Documentação coincide com navegador; logs/proxy testados com segredo sintético e sem vazamento. |
| AUD-20 | Extrair arquivos grandes aos poucos, reduzir warnings/chunks e testar acessibilidade. | Gates funcionais verdes. | Médio; risco de regressão visual. | Sem aumento de avisos, orçamento de bundle definido e teste de teclado/nomes acessíveis. |

## P3 — Evoluções futuras

| IDs | Ação | Dependências | Esforço e risco da mudança | Aceite verificável |
| --- | --- | --- | --- | --- |
| AUD-15 | Migrar operações críticas para armazenamento transacional/pub-sub antes de múltiplas réplicas. | Medição de carga e modelo de tenant alvo. | Grande; risco alto de migração. | Concorrência de dois escritores sem perda, eventos isolados e restore/rollback ensaiados. |
