> Registro historico de 11/10. Estado vigente: 2026-10-12-fase6-fase7-revisao.md. A implementacao e a revisao posteriores foram individuais; as pendencias listadas abaixo nao representam o estado final.

# Fase 6 — execução e evidências

Checkout `output/homologacao-20261011/source`, branch `codex/fase6-fase7-20261011`.
Codex direto; dados sintéticos; sem publicação ou ativação do cérebro em homologação.
Preservadas alterações recebidas e colaboração com Fase 7.

## Implementado nesta execução

- Aprovação Gmail v2: dono, remetente, workspace, permissões atuais, expiração e digest.
- Intent durável antes do envio em `norium_outbound_receipts`; PK por usuário/workspace/operação.
  Local usa `outbound_receipts.sqlite3`; PostgreSQL usa tabela do mesmo nome. Sem corpo ou destinatário.
  Nenhuma tentativa incerta é rearmada; ausência de ID do provedor permanece incerta.
- Reconciliação Gmail exclusivamente pelo cabeçalho `X-Norium-Email-Key`, metadados limitados.
  Ausência em Enviados mantém incerteza e não sugere reenvio.
- Histórico de comprovantes com ID estável; intents não dependem do corte de 1.000 registros da UI.
- Franquia de tokens por plano/pessoa e `noraCalls`, editáveis no catálogo administrativo;
  reservas incluem franquia compartilhada da equipe com serialização PostgreSQL.
- Medição do planner pelo `Meter` central, com reserva perdida contabilizada uma vez;
  pausas por ciclo retomam após data de renovação, rechecando os limites.
- Rota autenticada `/api/auth/nora-usage`, projeção pessoal/equipe autorizada; sem catálogo/auditoria globais.
- Notificações 80/95 por ciclo, modelos OpenAI routine Luna/document Sol, cache curto por usuário/workspace.
- Resumo de contexto por IA com mascaramento e fallback limitado identificado.
- UI login/acessibilidade e aba Consumo da Nora, campos de tokens no admin (subagente interrompido
  por limite de uso antes da conferência visual final; alterações reais preservadas).

## Evidências executadas

- `output/pos-correcao/fase6-email-2.json`: 39 testes, zero falhas/erros, 37,235 s.
- `output/pos-correcao/fase6-budget.json`: 57 testes, zero falhas/erros, 83,532 s.
- Ensaio local PostgreSQL `scripts/nora_brain_smoke.py` feito pelo coordenador: queued/running/completed,
  sem efeito antes de aprovação, digest incorreto recusado, interrupção permanece unknown sem duplicação.
- Subagente relatou 25 testes UI focados; resultado precisa ser reexecutado na revisão final.

## Pendências reais

Ainda faltam ferramentas dos especialistas, compostos exatos, memória unificada,
Conhecimento com embeddings mascarados/citações e fallback, Brave, worker Gmail incremental,
bateria pt-BR, inventário completo e regressão completa/QA visual. Não declarar Fase 6 concluída.
Tarifas OpenAI verificadas em 11/10/2026 nas páginas oficiais de gpt-5.6-luna e gpt-5.6-sol;
Sol promocional expira 21/11/2026 e exige revisão após essa data.
