# Custos de IA no Admin

Aba **Custos por usuário**, restrita a administradores do sistema. Exibe custos em USD por usuário, modelo e provedor; totais de todos os usuários; tokens de entrada, saída, cache e raciocínio; histórico de chamadas; exportação CSV; auditoria de alterações e limites por ciclo semanal ou mensal.

## Tarifas e integração

- Groq/Nora e Google Gemini são detectados pelas configurações existentes. Modelos de fallback e conexões adicionais em todos os workspaces entram no catálogo. A identificação combina provedor, URL base e modelo, evitando misturar APIs compatíveis de fornecedores diferentes.
- As tarifas iniciais de texto padrão foram verificadas em 10/09/2026: [GPT OSS 20B](https://console.groq.com/docs/model/openai/gpt-oss-20b), [Gemini 3.7 Flash](https://ai.google.dev/gemini-api/docs/pricing) e [Qwen 3.6 27B](https://console.groq.com/docs/model/qwen/qwen3.6-27b). O preço padrão gerenciado do Gemini acompanha a mudança publicada para janeiro de 2027; uma tarifa editada pelo administrador passa a ser manual.
- É possível cadastrar preços por qualquer unidade inteira de tokens, inclusive 1.000 ou 1.000.000. Entrada, saída, leitura e gravação de cache têm campos separados. Zero significa gratuidade; ausência de tarifa significa custo pendente.
- Conexões e credenciais permanecem em Modelos de IA. O cadastro de tarifa não altera credenciais nem habilita uma API nova. O uso passa a ser associado automaticamente quando provedor, URL e modelo correspondem.
- Fórmula: `(entrada sem cache × tarifa de entrada + leitura de cache × tarifa de cache + gravação de cache × tarifa de gravação + saída × tarifa de saída) / unidade de tokens`.
- No Groq/OpenAI, raciocínio já compõe a saída. Nas Interactions do Gemini ele é acrescentado à saída textual conforme os campos de uso da API. O cache é parte da entrada, sem dupla contagem.
- Cada chamada preserva a tarifa aplicada e seu custo em nanodólares inteiros. Alterações não reescrevem custos históricos já calculados; registros antes sem tarifa são preenchidos quando ela é cadastrada.

## Medição e limites

O gateway multprovedor e a Nora (respostas comuns, streaming, pesquisa e chamadas auxiliares) usam um único registro central. Cada tentativa bem-sucedida conta, mesmo se o conteúdo estiver vazio ou truncado. Respostas de erro HTTP são liberadas; desconexões ou respostas sem estatísticas ficam como estimativas conservadoras, nunca como consumo gratuito. Retentativas com fallback usam o modelo efetivo retornado pela API.

Orçamento em dólares e teto de tokens são opcionais e independentes: campo vazio = sem limite, zero = bloquear. Valem para o usuário, somando todos os modelos e workspaces. Cada conta escolhe ciclo semanal (7 dias) ou mensal e sua data inicial, a partir de 00h de Brasília. Nos meses sem o dia escolhido, usa-se o último dia, recuperando o dia original nos meses seguintes (31/01, 28/02, 31/03). As contas existentes continuam com renovação mensal no dia 1.

A renovação automática abre um novo saldo ao fim do ciclo. Na renovação manual, o uso bloqueia ao encerrar; antes da data inicial também fica bloqueado. O saldo mostrado sempre é do ciclo atual, mesmo ao consultar períodos anteriores. A consulta “Ciclos atuais” soma os ciclos individuais, que podem ter datas diferentes.

“Resetar saldo” exige confirmação na tela: pode manter a próxima data de renovação ou iniciar um novo calendário a partir de hoje. A contagem reinicia no instante confirmado; a próxima renovação continua às 00h. O histórico financeiro permanece íntegro e o motivo/autor/data são auditados. Um ciclo encerrado só pode ser reaberto reiniciando seu calendário. Chamadas pendentes impedem reset e alteração de limites (HTTP 409), evitando reclassificar reservas em andamento. Alterar datas e limites recalcula o saldo com o histórico existente e preserva o último reset; não concede um reset implícito.

Por compatibilidade, os campos da API `monthlyBudgetUsd` e `monthlyTokenLimit` representam o teto do ciclo escolhido. `period`, `startDate` e `autoRenew` configuram o calendário. `currentCycle` e `cycle` mostram consumo e datas efetivos; `currentMonth` permanece como alias de compatibilidade do consumo do ciclo.

Antes de enviar a chamada, a API reserva saldo em transação e limita a saída enviada ao provedor. O contexto usa uma margem conservadora baseada em bytes UTF-8 e estrutura da mensagem; pode ser necessário reduzir um contexto grande quando o saldo é pequeno. Chamadas simultâneas compartilham reservas. O consumo informado pelo provedor liquida a reserva; gastos incertos recebem estimativa. Falta de tarifa bloqueia chamadas de contas com orçamento financeiro definido, até regularização.

As capacidades de tokens exibidas são alternativas para o mesmo saldo: somente entrada, somente saída, ou mistura de 75% entrada / 25% saída, sem desconto de cache. Não são franquias cumulativas. Custos extras de voz, ferramentas, armazenamento e ajustes comerciais do provedor não compõem o cálculo de tokens.

## Persistência e histórico

`NORIUM_DATA_DIR/ai_costs.sqlite3` guarda o registro, tarifas, reservas, limites e auditoria. Incluir esse arquivo nos backups do volume persistente. Usa transações SQLite com journal DELETE (sem WAL) e timeout de bloqueio de 30 segundos.

No Azure Files, o deploy define `NORIUM_AI_COSTS_SQLITE_VFS=unix-dotfile`: o [VFS do SQLite](https://www.sqlite.org/vfs.html) usa arquivo de bloqueio para serializar conexões, evitando os bloqueios POSIX incompatíveis com SMB. Todas as conexões ao registro devem usar o mesmo VFS; não abrir o arquivo diretamente com ferramentas que usem o padrão. O CI testa a mesma configuração no Linux, e o deploy verifica exclusão de gravações simultâneas, commit e integridade no volume real. Após encerramento abrupto, um bloqueio órfão pode exigir recuperação operacional: interromper todas as revisões/processos que acessam o registro, preservar backup do banco e journal, confirmar que o bloqueio não possui dono ativo e só então remover o diretório `.lock` vazio; reabrir com o mesmo VFS para recuperação do journal e executar `PRAGMA integrity_check`. Nunca remover bloqueios de uma aplicação em execução.

Registros anteriores em `intelligence_db.json` são importados por usuário e workspace com chave idempotente. Entradas novas incluem `ledgerId`, impedindo dupla importação. O histórico legado é identificado como estimado porque não guardava todos os componentes de cobrança. Uso antigo sem estatísticas não pode ser recuperado. Nenhum prompt, resposta, chave de API ou credencial é armazenado no registro central.

## API

- `GET /api/auth/admin/ai-costs?month=YYYY-MM|all|cycle&userId=...&modelId=...`
- `POST /api/auth/admin/ai-costs/tariffs`
- `PUT /api/auth/admin/ai-costs/users/{user_id}/limits`

Administradores auxiliares não podem alterar os limites do proprietário. A interface atualiza a cada 30 segundos enquanto visível, com filtros e exportação do período completo. As últimas 100 chamadas são exibidas, mas os totais consideram todo o período.

- `POST /api/auth/admin/ai-costs/users/{user_id}/reset` com `restartCycle` e `reason`.
- `GET /api/auth/admin/ai-costs/pdf?month=YYYY-MM|all|cycle&userId=...`: PDF geral ou individual, restrito a administradores, com totais por modelo, custos de entrada/saída, limites, saldos, datas e notas de estimativas. Usa os mesmos registros e filtros da tela, com download autenticado e `Cache-Control: no-store`.
