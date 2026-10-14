> Registro historico de 11/10. Estado vigente: 2026-10-12-fase6-fase7-revisao.md. A implementacao e a revisao posteriores foram individuais; as pendencias listadas abaixo nao representam o estado final.

# Fase 7 — execução local com dados sintéticos

## Escopo e limites

Executor Codex direto, checkout compartilhado `output/homologacao-20261011/source`.
Sem push/deploy, sem exclusão de dados reais e sem ativação da retenção. A Fase 6
é executada em paralelo em outros arquivos. Mudanças críticas e minutas jurídicas
precisam da revisão humana antes da promoção.

## Implementação em andamento

- Catálogo único de exportação/eliminação: arquivos do dono e anexos planos
  referenciados, SQLite com predicados por titular, tabelas relacionais, eventos
  de sessões sem credenciais, mensagens pessoais em chat compartilhado.
- Revogação OAuth no Google antes de eliminar o token recuperável; falhas deixam
  conta bloqueada e eliminação pendente para nova tentativa.
- Registro de exclusões mínimo e separado do conteúdo dos backups; reaplicação
  após restauração será ensaiada em ambiente isolado.
- Retenção opt-in com prazos conservadores e zero desativando cada categoria;
  timestamps ausentes não geram exclusão.
- Anexos novos de equipe/tarefas pertencem ao dono/workspace; leitura legado
  continua autorizada pelo registro; quota inclui anexos antigos referenciados.
- Cache por prefixo é invalidado na eliminação de conta/workspace.
- Logs minimizados no bootstrap e em `record_system_log`; POST de auditoria
  recusa registros forjados e GET oferece paginação.

## Validação

Ainda em execução: testes LGPD sintéticos, revisão de cobertura de stores,
frontend, ensaio PostgreSQL e uploads com contagens/hashes e tempo medido.
Nenhuma confirmação de conformidade jurídica ou de comportamento em produção.
