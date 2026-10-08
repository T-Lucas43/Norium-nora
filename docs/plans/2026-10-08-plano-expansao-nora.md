# Plano de ação: ampliar as capacidades da Nora

**Estado:** implementação, publicação em main e deploy na VPS autorizados pelo responsável neste chat em 8/10/2026.
**Data:** 8 de outubro de 2026.
**Escopo:** experiência conversacional da Nora, leitura e análise de e-mails, ações nos módulos do Norium e geração de relatórios.

## 1. Objetivo

Evoluir a Nora para uma assistente de trabalho conversacional que consiga consultar dados autorizados do Norium, preparar ações, mostrar o que fará e executar somente após a confirmação exigida. A experiência deve reduzir a necessidade de comandos repetitivos, permitir continuar ou corrigir o fluxo pelos controles na própria mensagem da Nora e mostrar progresso e evidências das tarefas longas.

O plano toma como referência categorias de capacidade do Claude e do Codex — contexto de ferramentas conectadas, instruções reutilizáveis, busca no histórico, rotinas, pesquisa, geração de documentos e ações controladas — e as adapta aos dados, identidade, permissões e módulos reais do Norium. Não propõe copiar código nem reproduzir marcas ou telas desses produtos. Claude documenta conectores para buscar dados e agir em serviços conectados, além de instruções de projeto, estilos e busca de conversas anteriores; Codex documenta conectores/plugins, skills e automações agendadas com resultados revisáveis. [Conectores do Claude](https://support.anthropic.com/en/articles/11817150-connect-your-tools-to-unlock-a-smarter-more-capable-ai-companion), [personalização do Claude](https://support.anthropic.com/en/articles/10185728-understanding-claude-s-personalization-features), [Codex e automações](https://openai.com/index/introducing-the-codex-app/), [skills e MCP](https://developers.openai.com/plugins/concepts/skills).

## 2. Ponto de partida observado

O repositório já contém uma experiência Nora com histórico persistente de conversas, busca, biblioteca, anexos/arquivos e painel de trabalhos do cérebro ([NoraWorkspace.tsx](../../norium-front-end/src/components/nora/NoraWorkspace.tsx), [NoraBrainJobs.tsx](../../norium-front-end/src/components/nora/NoraBrainJobs.tsx)). Há fluxos de e-mail que consultam, resumem e preparam envios ([email_agent.py](../../norium-back-end/app/services/email_agent.py)); a API Gmail já reconhece paginação por `nextPageToken` ([gmail_service.py](../../norium-back-end/app/services/gmail_service.py)). Na conversa interna existem sugestões de resposta, resumo e ações personalizadas da Nora ([NoraChatComposer.tsx](../../norium-front-end/src/components/chat/NoraChatComposer.tsx), [MessageNoraActions.tsx](../../norium-front-end/src/components/chat/MessageNoraActions.tsx)).

Também existe uma arquitetura de trabalhos persistentes, aprovações, orçamento e reconciliação. A documentação operacional diz que o executor autônomo permanece desligado até que banco gerenciado, segredo exclusivo, credencial do executor e validação dos modelos sejam provisionados ([runbook](../operations/nora-brain-runbook.md)). Portanto, presença de código não significa que a capacidade está habilitada, testada com dados reais ou disponível em produção.

**Limite deste diagnóstico:** esta leitura é do checkout local em 8/10/2026. Há numerosas alterações preexistentes sem commit, inclusive em arquivos da Nora, Gmail, autenticação e segurança. Não revisei nem atribuí essas alterações a esta proposta, não determinei o que está na produção e não as alterei. Antes da implementação, será necessário revisar esse diff e estabelecer uma linha de base limpa para cada arquivo da entrega.

## 3. Experiência conversacional proposta

### 3.1 Controles na própria mensagem

Quando a Nora fizer uma pergunta de confirmação ou oferecer próximos passos, a própria mensagem exibirá opções contextuais, sem abrir uma janela/modal:

- **Continuar** — responde à pergunta ou inicia a próxima etapa de leitura/preparação que já foi pedida.
- **Não continuar** — cancela o fluxo pendente e informa que nenhuma ação externa foi feita.
- **Editar pedido** — revela um campo curto na própria mensagem para o usuário escrever a alternativa/instrução.
- Para mensagens informativas: **Continuar analisando**, **Ver detalhes**, **Gerar relatório** ou opções equivalentes ao contexto.
- Para ações externas: cartão de revisão mostrando destino, conteúdo, anexos, quantidade de destinatários e efeitos; botões específicos como **Aprovar e enviar**, **Editar** e **Cancelar**. “Continuar” nunca substitui o consentimento final de envio.

As escolhas, revisão e resultado ficam ligados ao identificador e à versão exata do trabalho. Mudança em destinatários, conteúdo, anexos ou alvo invalida a aprovação anterior. Uma retomada deve recuperar o trabalho pelo estado salvo, sem repetir um efeito externo incerto.

### 3.2 Conversa de trabalho

- Continuar conversa existente e pesquisar conversas anteriores acessíveis ao próprio usuário, citando título/data da conversa usada.
- Preferências de resposta e instruções por workspace/projeto, com estilos como conciso, detalhado e formal; manter configuração explícita e editável.
- Respostas em andamento com estado visível: preparando, consultando, aguardando aprovação, executando, concluído, parcial, falhou ou precisa de reconciliação.
- Ações sobre a mensagem: copiar, refazer, ajustar, resumir, gerar tarefa, gerar documento/relatório e feedback.
- Resultados longos abrem um artefato Norium editável/reutilizável (relatório, planilha ou documento) e ficam vinculados à conversa e às fontes consultadas.

### 3.3 Foco visual dos campos

Rever os estilos globais e os estilos da área de conversa para remover o contorno azul intenso/duplicado que aparece ao clicar nos campos de digitação, substituindo-o por um estado discreto coerente com os tokens do Norium. Preservar um indicador de foco visível para navegação por teclado e contraste suficiente; o pedido visual não deve tornar os campos inacessíveis. A verificação deve cobrir mouse, teclado, tema claro/escuro e foco em textarea e botões.

## 4. Capacidades por área do Norium

Separar cada capacidade em **consultar**, **preparar** e **executar**. Toda leitura respeita permissões, tenant/workspace e escopo escolhido; toda gravação passa pela autorização do módulo existente.

| Área | Nora poderá consultar/analisar | Poderá preparar | Execução e controle |
| --- | --- | --- | --- |
| E-mails/Gmail | Caixa de entrada completa dentro do escopo, filtros, não lidos, remetentes, tópicos, anexos e histórico; classificar intenção, urgência, prazos, perguntas e sentimento com explicação/evidência | Resumo executivo, tabela de mensagens, rascunhos individuais, respostas sugeridas, relatório de pendências e campanha revisável | Enviar somente após prévia e aprovação; campanhas limitadas por destinatário, quota e ritmo. Sem inclusão automática de todos os contatos |
| Tarefas/projetos | Atrasos, responsáveis, dependências, atividade, bloqueios e mudanças | Criar/editar tarefas, priorização e resumo de status | Prévia de alterações e confirmação quando gravar ou notificar; registrar IDs e autor |
| Agenda | Compromissos, disponibilidade e conflitos autorizados | Opções de horário, pauta, lembretes e follow-up | Confirmar antes de criar, alterar, convidar ou cancelar evento; mostrar participantes e horário/fuso |
| Comercial/CRM/documentos | Clientes, propostas e contratos permitidos, histórico e estágio | Rascunhos, propostas, follow-ups, atas e comparativos com fonte | Revisão humana para valores, condições, envio e assinatura; assinatura nunca implícita |
| Financeiro | Resumos agregados e itens acessíveis, períodos e variações | Relatórios financeiros e explicações com referências aos registros | Sem transferências, pagamentos ou mudanças em orçamento; decisões financeiras ficam com pessoa autorizada |
| WhatsApp/equipe | Conversas autorizadas, mensagens e pendências | Resumo, respostas sugeridas, tarefas e avisos | Mostrar canal e destinatários; exigir confirmação imediatamente antes de enviar/publicar |
| Automações | Gatilhos, execuções, falhas, histórico e configurações | Criar fluxo em rascunho, simular e explicar impactos | Ativar, desativar ou executar após revisão de escopo, gatilhos e efeitos; nunca adotar instalação/ação externa silenciosamente |
| Relatórios e documentos | Combinar apenas fontes selecionadas e acessíveis | Relatório com período, filtros, fontes, lacunas, métricas e exportação | Exibir cobertura e horário da extração. A Nora não deve chamar uma amostra de “caixa inteira” nem inferir campos sem dados |
| Brainstorm/operações | Sessões, decisões, indicadores e histórico | Planos, atas, retrospectivas, listas e conversão de ideias em tarefas | Gravações e notificações seguem confirmação e trilha normal do módulo |
| Pesquisa web/navegador | Pesquisar fontes autorizadas e páginas públicas com citações | Comparativos, notas, extração estruturada e plano de navegação | Ações em formulários, downloads/uploads, credenciais ou publicação aguardam confirmação imediatamente antes do efeito |

Para cada área, começar por consultas e preparação, depois habilitar execução controlada quando o módulo já tiver contrato de API, autorização, auditoria e comportamento idempotente. A Nora não deve obter acesso amplo ao banco para contornar APIs de negócio.

## 5. E-mails: leitura integral, análise e envio em massa

### Leitura e análise da caixa

“Ler a caixa inteira” deve significar percorrer todas as páginas de mensagens do escopo solicitado, não descarregar um único lote nem enviar todo o conteúdo ao modelo de uma só vez. A API Gmail retorna IDs e oferece `pageToken`; `maxResults` tem máximo de 500 por página, e os detalhes completos são buscados separadamente. [Documentação Gmail: listar mensagens](https://developers.google.com/workspace/gmail/api/guides/list-messages).

Proposta de fluxo:

1. Nora pergunta ou confirma o escopo: Inbox, período, rótulos, incluir/enxergar spam e lixeira separadamente, e se deve ler conteúdo/anexos. Mostrar a estimativa inicial e o provedor autorizado.
2. Criar trabalho durável com checkpoint de página, quantidade encontrada/lida/analisada, cursor e cancelamento. Processar lotes pequenos e limitados, sem manter todo o corpo de e-mail na memória nem no prompt.
3. Buscar metadados e corpo necessário por mensagem, reduzir/mascarar dados, marcar remetente, data, assunto, thread, estado de leitura e anexos; tratar mensagem/anexo como conteúdo não confiável, nunca como instrução para a Nora.
4. Retomar com cursor/cópias temporárias de curta duração, deduplicar por IDs e reportar erros, mensagens não processadas, limites e cobertura. Nunca registrar texto integral em logs.
5. Analisar em partes e consolidar: tópicos, pedidos, perguntas sem resposta, prazos, sentimento como sinal incerto, remetentes recorrentes, prioridades e sugestão de ações. Todo achado aponta para as mensagens de origem; o relatório expõe período, contagem total, contagem analisada, itens ignorados e data da execução.
6. Para atualizações contínuas, considerar sincronização incremental pelo histórico do Gmail depois do fluxo inicial, em fase separada e com retenção mínima.

O Gmail aplica quotas por projeto/usuário, limites próprios de envio e uma quota de no máximo 500 destinatários por mensagem; respostas 200 não são prova suficiente de que todos os envios foram concluídos. Planejar ritmo, tratamento de 429/backoff, reconciliação de resultado incerto e limites configuráveis por conta antes de disponibilizar lotes. [Quotas Gmail](https://developers.google.com/workspace/gmail/api/reference/quota), [erros e limites de envio](https://developers.google.com/workspace/gmail/api/guides/handle-errors).

### Campanhas em massa

- Criar uma tela/fluxo de campanha dentro de E-mails: finalidade, segmento/lista revisada, origem dos destinatários, assunto, conteúdo, personalização e anexos.
- Mostrar destinatários individualmente, contagem final, duplicados, endereços inválidos, supressões e um modo de prévia “enviar teste para mim”. O padrão deve ocultar destinatários entre si (envios individuais ou política explícita de cópia), não expor a lista no campo To/Cc.
- Exigir confirmação com resumo imutável da campanha e um segundo botão para a ação externa. Guardar quem aprovou, versão e escopo. Editar destinatários ou conteúdo exige nova aprovação.
- Implementar fila limitada, pausa/cancelamento, deduplicação/idempotência, limite diário por workspace/conta, controle de quota, tentativas com backoff e estado por destinatário: pendente, enviado, rejeitado, resultado incerto ou falha.
- Não repetir automaticamente resultado incerto; reconciliar com a pasta enviados/identificador do provedor. Ao final, gerar relatório de entrega sem afirmar abertura/recebimento se isso não for confirmado pelo serviço.
- Não transformar a ferramenta em disparador irrestrito. A origem legítima dos contatos, preferências de comunicação, política aplicável e regras do provedor precisam ser validadas pelo responsável do produto antes de ativar campanhas reais.

## 6. Segurança, privacidade e governança

Aplicar [docs/AI_GOVERNANCE.md](../AI_GOVERNANCE.md): finalidade explícita, minimização, mascaramento local, provedor aprovado, tenant autenticado, conteúdo externo tratado como dado não confiável, chaves apenas no backend e aprovação humana para ações irreversíveis. Para e-mail e relatórios:

- separar permissões de leitura, leitura de anexos, geração de rascunho e envio;
- validar cada ferramenta no backend com usuário/tenant e política do módulo; não confiar em botão, prompt, role ou aprovação descrita dentro de um e-mail;
- nunca usar corpo de e-mail/anexo para alterar instruções, aprovar envio, ampliar destinatários ou autorizar acesso;
- cifrar credenciais, limitar escopos OAuth ao necessário e oferecer desconexão/revogação;
- registrar metadados de auditoria (ação, identidade, alvo, versão, estado e evidência), evitando corpos completos e segredos;
- estabelecer retenção, exclusão, opt-out da indexação e política de anexos antes de habilitar leitura total;
- pausar fail-closed se o worker, o PostgreSQL, a identidade do usuário, o orçamento ou a confirmação exata estiverem indisponíveis.

## 7. Entrega em fases e critérios de aceite

### Fase 0 — Linha de base e contratos

Revisar diffs preexistentes nos arquivos da Nora/Gmail/segurança; confirmar estado local e produção separadamente; mapear ações, permissões e dados por módulo; definir modelo de retenção, provedor e budgets. **Aceite:** matriz aprovada de ferramentas `read / prepare / execute`, responsável de cada área, retenção, fontes e efeitos externos. Sem ativação do worker.

### Fase 1 — Conversa, ações na mensagem e foco visual

Criar componente de opções contextuais embutidas na mensagem, continuação/recusa/edição inline, estados de trabalho e cartão de aprovação associado à versão exata da ação. Ajustar foco dos campos da Nora mantendo foco de teclado. **Aceite:** fluxo em desktop e mobile; continuar/recusar/editar; reabrir conversa e preservar estado; não duplicar execução em duplo clique/reload; nenhuma aprovação reutilizada após edição; sem modal para escolha contextual; foco visível por teclado.

### Fase 2 — Gmail completo e relatórios de leitura

Cobrir paginação, checkpoint, cancelamento, deduplicação, status de cobertura, acesso a anexo opcional, análise em lote e relatório exportável ligado às fontes. **Aceite:** caixa sintética com mais de uma página, duplicidade, erro no meio, cancelamento e retomada; contagem encontrada = lida + ignorada/erro; relatório marca limites e fontes; sem texto integral em logs; mensagem maliciosa não altera política.

### Fase 3 — Campanhas de e-mail com aprovação

Construir segmento, personalização, envio teste, aprovação exata, fila, limites, pausa e reconciliação por destinatário. **Aceite:** testes com Gmail simulado; sem envio antes da aprovação; aprovação invalidada por edição; idempotência em replay; quota/429 interrompe ou desacelera corretamente; falha parcial gera estado inequívoco e não reenvia sucessos.

### Fase 4 — Ferramentas por módulo

Adicionar ferramentas pela matriz começando por leitura e preparação em Tarefas, Agenda, Comercial, Financeiro, Equipe, WhatsApp, Relatórios, Documentos e Brainstorm; depois execução aprovada módulo a módulo. **Aceite:** cada ferramenta tem contrato tipado, autorização server-side, isolamento de tenant, fonte/evidência, limite de resultados, erro seguro e teste de usuário sem permissão. Sem acesso SQL direto.

### Fase 5 — Automações e sincronização recorrente

Integrar rotinas recorrentes/acionadas com limites, janela de execução, notificações configuráveis, fila e revisão dos resultados; incluir sincronização incremental de e-mails só após a leitura inicial passar os gates. **Aceite:** dry-run, pausa global, cancelamento, deduplicação, orçamento, trilha de auditoria e nenhuma tarefa que continue após revogação de permissão.

### Gate de ativação

Antes de ativar o cérebro autônomo com dados reais: confirmar PostgreSQL/HMAC/worker de acordo com o runbook, validar credenciais e escopos com responsável, testar com contas/dados sintéticos, revisar permissões por tenant e testar rollback/pausa. O pedido posterior autorizou publicação em main e deploy na VPS atual. Disparos reais continuam exigindo a revisão específica de cada campanha, e a expansão não cria contas ou migra dados por consequência do deploy.

## 8. Proposta de medição

- cobertura de leitura e proporção de relatórios com contagem/fonte explícitas;
- taxa de conclusão, parcial, erro e reconciliação de trabalhos longos;
- precisão amostrada de resumo/classificação, com revisão humana em conjuntos consentidos e minimizados;
- envios duplicados (meta: zero), ações sem aprovação (meta: zero) e vazamento entre tenants (meta: zero);
- tempo/custo por caixa analisada, limites de tokens, volume de dados do provedor e falhas de quota;
- retomadas após pausa/reload e acessibilidade de teclado nos controles da conversa.

Métricas de qualidade não devem encorajar ler mais dados do que o escopo autorizado ou enviar mais e-mails.

## 9. Decisões adotadas no piloto autorizado

1. Implementação faseada, publicação em main e deploy na VPS atual autorizados neste chat.
2. Leitura inicial por período (30 dias), com filtro vazio para caixa inteira e pedido explícito de caixa inteira na conversa.
3. Campanhas com envios individuais, lista e anexos revisados, limite inicial conservador e reconciliação de incerteza.
4. Reutilização das ferramentas de Tarefas/Agenda e ampliação do catálogo de consulta por módulo. Limites de cada etapa constam do handoff.

A aprovação recebida inclui publicação em main e deploy na VPS de homologação atual. O acompanhamento concreto está em [handoff da expansão](../handoffs/2026-10-08-nora-expansao.md).
