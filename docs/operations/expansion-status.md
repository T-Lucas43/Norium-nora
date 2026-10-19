# Estado da implementação — 19/10/2026

## Disponível no código local

| Área | Implementação integrada |
|---|---|
| Catálogo | Produtos/serviços em Documentos, preço em centavos, SKU, duração, desconto permitido, histórico de preço, versão e consulta autorizada da Nora |
| Clientes | Etiquetas, filtros, visões pessoais/de equipe, exportação da seleção, responsável em lote, arquivamento/restauração individual e em até 100 selecionados |
| WhatsApp | Etiquetas na conversa e na agenda, seleção de até 100 contatos/conversas, filtro por etiquetas, exportação da seleção e correspondência por IDs locais explícitos |
| Provedor WhatsApp | Adaptador Evolution API com vínculos/histórico separados, identificação na interface e Docker privado. Pareamento bloqueado: a imagem oficial falhou na auditoria de vulnerabilidades; detalhes em `evolution-api.md` |
| Respostas rápidas | Modelos por canal, atalhos e teclado em Gmail/WhatsApp/Chat, variáveis conhecidas preenchidas e bloqueio de variáveis ainda vazias |
| Importação | CSV/XLSX/vCard, prévia e mapeamento, validação, fila, progresso, duplicados, conflitos, retomada e expiração dos arquivos temporários |
| Vínculos | Propostas e contratos ligados explicitamente à ficha do cliente, abertura da ficha pelo documento, ACL dos dois lados |
| Operação da Nora | Diagnóstico de configuração para administrador e Gmail incremental paginado/retomável, sem ativação dos provedores/workers novos |
| Base comum | Persistência, quotas, auditoria, preparação idempotente de aprovações, inventário de privacidade e registro de capacidades públicas |
| Execução local | Docker Compose, PostgreSQL próprio, frontend/API na mesma origem e conta administrativa de desenvolvimento |

Implementação integrada e compilação não equivalem a aceite funcional. A página,
readiness, PostgreSQL e login local foram conferidos. As novas funcionalidades
ainda precisam das validações de autorização, concorrência, retomada e interface
descritas no handoff. Nenhuma onda está declarada concluída.

## Parcial ou pendente

- **Onda 0:** páginas/projeções dos links públicos; vínculos com os demais
  módulos; notificador/preferências e aplicação da base PDF em cada entrega.
- **Onda 1:** envios em massa com manifesto, aprovação exata, limites e opt-out;
  responsável/arquivamento no WhatsApp e aceite funcional das telas e importação.
- **Ondas 2–4:** funil, orçamento completo, renovação, recibos, pedidos de
  documentos, portal, caixa omnicanal, atendente, widget, lembretes, satisfação,
  encaixes/espera, presença contextual completa, rotinas, metas, datas e resumo
  semanal por cliente. Não foram entregues nesta branch.
- **Fase 6:** ativação operacional dos provedores/executor e validação da
  configuração; diário durável completo das mudanças Gmail ainda pendente.
- **Fase 7:** revisão/aceite das alterações de privacidade e preenchimento dos
  responsáveis, dados jurídicos, contratos de tratamento, regiões e retenções
  reais. Não há declaração de conclusão ou certificação de conformidade.
- **Nora em chamadas:** continua parcial e desativada.

## Acesso e publicação

URL local: `http://localhost:8765`. Instruções em `local-docker.md`.
As integrações externas exigem configuração própria neste ambiente. A base local
foi criada separada de homologação; o script preserva os volumes nos próximos usos.
Esta sequência ainda não foi publicada no GitHub nem promovida ao ShardCloud.
O estado detalhado está em `docs/handoffs/2026-10-19-codex-expansao-norium.md`.
