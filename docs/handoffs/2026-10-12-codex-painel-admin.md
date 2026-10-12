# Painel administrativo — execução individual

## Pedido e autorização

O responsável confirmou a implementação visual do arquivo
`prompt-codex-painel-admin.md` e depois autorizou deploy ao terminar.
Ambiente vigente: homologação na Shard; GitHub é a fonte da publicação.
Codex individual, sem agentes/Muse. Fases 6/7 continuam fora desta promoção.

## Fonte e isolamento

- Base visual/código: árvore `5054bbf89f8ad30b8cdda0a7d1cc5cd23bb1df25`,
  idêntica à main/deploy `ccfb058e9470f92dba3682d16348cb6b9d470cfb`.
- Checkout isolado: `output/admin-layout-20261012/source`,
  branch `codex/admin-layout-20261012`, base local equivalente `28dbdca`.
- PDFs claro/escuro com 59 páginas em Downloads. Referência HTML/CSS/JS
  encontrada em `feat/fase1-seguranca-voz`, copiada somente para consulta.
  A informação antiga de que o layout do app não chegou à main não é atual.
- Preservar checkouts/alterações preexistentes. Não ler .env ou dados reais.

## Entregas planejadas

1. Casca: menu agrupado 232px, topo 56px, logo oficial, rodapé fixo,
   gaveta no celular, filtro da tela atual/Ctrl+K e estado real de saúde.
2. Contas: resumo, tabela/gaveta de usuário, modal existente, equipes,
   planos e permissões com campos/ações atuais.
3. Financeiro: dez abas existentes, indicadores/tabelas/estados, paginação,
   registro/importação/exclusão e confirmações preservadas.
4. IA/comunicação: custos e entrada direta em tarifas; limites/calendário,
   CSV/PDF/histórico e edição existentes; e-mails, remetente e envio manual.
5. Operação: integrações, monitoramento, logs, configurações, auditoria
   e backup existente. Nenhuma restauração/rotação de segredo nova.
6. Testes, conferência de cada tela em claro/escuro e documento de 375px,
   inventário de controles antes/depois e comparação de contratos de chamadas.
7. GitHub/CI, imagem imutável auditada, backup/restauração/rollback e deploy
   em homologação, seguido de conferência pública/autenticada disponível.

## Limites e critérios

Somente frontend/estilo/documentação. Não alterar endpoints, payloads,
permissões, regras de negócio, credenciais ou rotinas de retenção/exclusão.
Estados de carregamento/erro/vazio e todos os campos/ações continuam acessíveis.
Dados ausentes geram estado vazio explícito; não inventar números ou controles.
O email completo já visível deve permanecer acessível; não perder dados para
copiar a máscara ilustrativa do PDF. Foto do perfil e nome acompanham os avatares.
Recursos dos mocks sem função existente vão ao BACKLOG, sem entrada no menu.

## Implementação e revisão

- Menu de 232 px por grupos, topo de 56 px, logo oficial, busca local/Ctrl K,
  saúde real, foto/nome e Nora vinculada ao compositor de e-mails existente.
- Contas em tabela, paginação de 12, filtros, gavetas Dados/Acesso/Histórico,
  equipes com membros; plano/status/vínculo/admin auxiliar e proteções mantidos.
- Permissões em matriz do usuário selecionado: a API existente administra
  permissões por usuário, e não uma matriz global de perfis. Nenhuma regra nova.
- Financeiro com as dez abas sublinhadas; indicadores, gráficos, CRUD, duplicação,
  seleção em lote, importação/mapeamento, CSV/Excel/PDF e exclusão mantidos.
- IA em tabela com barras de orçamento, tarifas em tabela, limites em gaveta,
  reset/tarifa em modal; ciclo, zero como bloqueio, ilimitado, histórico e exportações
  preservados. Quatro abas de consumo/modelos/chamadas/alterações.
- Comunicação com Envios/Modelos/Remetente, indicadores/tabela de entrega,
  compositor/Nora/contexto/tom/assinatura/destinatários em modal. Nenhum envio
  automático ao abrir o admin, abas ou compositor.
- Integrações em cartões de permissão e detalhes; logs/auditoria em tabelas
  com filtro/paginação/gaveta; configurações/monitoramento/snapshot preservados.
- Overlays com foco, Escape, retorno ao acionador e confirmação sobreposta.
  Mobile com menu rolando por dentro e rodapé fixo; tabelas rolam no cartão.

## Diferenças justificadas do mockup

- Resumo não fornece receita histórica, p95, memória ou latência por conector:
  mostrar dados reais disponíveis/estado vazio. Gráficos financeiros existentes
  continuam completos no Financeiro; nenhuma série ou estado operacional inventado.
- E-mail completo preservado para cumprir a regra de não perder/mascarar dado
  já visível. Sessões, impersonação, restauração, rotação de segredo e telas Nova
  não têm função neste admin e não foram criadas. Sugestões registradas no BACKLOG.
- Aplicar plano a usuário e permissões individuais continuam; edição comercial
  de planos permanece no Financeiro. Todos os campos atuais dos formulários mantidos.
- Recurso Nora do topo abre o compositor com Nora já existente, sem criar chat/API.
- Campos estruturais adicionais das fases 6/7 permanecem fora desta promoção.

## Evidências locais

- TypeScript: sucesso. Oxlint: zero erros; avisos anteriores fora deste admin.
- Vitest completo: 875/875, incluindo foco/Escape, confirmação sobreposta,
  todas as entradas, gaveta, paginação, hierarquia, payloads de limites/reset/tarifa
  e ausência de envio automático de boas-vindas.
- Vite build e orçamento de bundles: sucesso.
- Snapshot AST: 55 chamadas em 13 arquivos e handlers críticos idênticos.
  Diff do backend contra a base: zero. Checkouts preexistentes preservados.
- Browser local com componentes reais e dados sintéticos; todos os POST/PUT
  bloqueados. Telas e dez abas financeiras percorridas nos temas claro/escuro,
  PC/375 px, com screenshots em output/ui. Sem overflow horizontal da página;
  menu móvel: rodapé termina no pixel 811 de viewport de 812 px, navegação interna
  com conteúdo maior que sua altura. Ctrl K conferido. Nenhum cliente real usado.

## Publicação

- Base atual incorporada: main 49505b7d1bfb505dc871305cbb18043c3c9409ba,
  árvore 0e0c552d1aa698210a1093b1540630a0a2c4cce9. Preserva PRs #52 e #57.
- O usuário solicitou retomar o admin e deixar a investigação TURN de lado.
  Nenhuma alteração de chamadas/TURN é incluída nesta branch.
- Push, merge e deploy em homologação autorizados pelo usuário. Ainda pendentes
  nesta versão do handoff: CI remoto, promoção da imagem auditada sem rebuild,
  backup/ensaio de restauração/rollback e conferência pós-deploy. Recebimentos
  operacionais finais ficarão em output/admin-layout-20261012 para não modificar
  a árvore já auditada. Não declarar deploy antes desses recebimentos.
