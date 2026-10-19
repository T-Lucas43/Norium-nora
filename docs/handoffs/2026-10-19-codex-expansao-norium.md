# Continuidade da fase 6 e das novas funcionalidades

## Autorização e base

- Pedido direto de 19/10: continuar todas as pendências, especialmente operação
  da fase 6 e as 22 funcionalidades. Executor individual, sem Muse/agentes.
- Fontes confirmadas em Downloads: plano fase6/fase7, prompt das funcionalidades
  e PDFs. Referências são especificações; não autorizam envio de dados ou
  ativação automática de provedores.
- Branch `codex/expansao-norium-20261019`, base `origin/main` `b81bce9`.
  Inclui o PR #67 posterior à entrega #63. Checkouts antigos preservados.
- Consulta das duas credenciais autorizada pelo usuário: leitura filtrada de
  presença, sem exibir valores. Sem migração de dados reais, envios ou ativação
  remota. Publicação depende do pacote concreto e de sua revisão.

## Ordem e critérios de aceite

1. Fase 6: diagnóstico operacional autenticado na interface; sincronização Gmail
   de metadados paginada e retomável, com checkpoint anterior à primeira página,
   limites de leitura, intervalo adaptativo, sem carregar corpos da caixa.
2. Onda 0: escopo de empresa/workspace/ator, vínculos explícitos com ACL atual,
   etiquetas, capacidades públicas, aprovação exata registrada, presença e
   notificações. Nenhum vínculo por nome concede acesso.
3. Onda 1: catálogo em Documentos, atalhos nos compositores existentes,
   etiquetas/visões/lote e importação com prévia e idempotência.
4. Onda 2: funil, orçamento, renovações, recibos, pedidos de documentos e portal.
5. Onda 3: caixa adicional, atendente com delegações desligadas, widget,
   lembretes, satisfação, sugestões de horário e espera.
6. Onda 4: presença contextual, rotinas, metas, datas e resumo por cliente.

Não declarar onda pronta sem integração e critérios de aceite. Layout e rotas
existentes permanecem; funcionalidades novas entram como abas relacionadas.
Revisão humana das mudanças críticas antes da promoção. Dados jurídicos e
credenciais reais dependem do responsável; nenhum campo será inventado.

## Conferência real no ShardCloud

Após o login confirmado pelo usuário, consulta somente de presença no contêiner
ativo `norium-api`, sem chamadas aos provedores:

- `OPENAI_API_KEY`: ausente/vazia.
- `BRAVE_SEARCH_API_KEY`: ausente/vazia.
- `NORA_KNOWLEDGE_EMBEDDINGS_ENABLED`: desativado.
- `NORIUM_BRAVE_ENABLED`: habilitado, sem a chave necessária.

As duas chaves também estão ausentes/vazias no `.env` local do backend. Isso
comprova o ambiente em uso; não é inventário de todos os cofres de segredos.
Evidências sem valores: `output/expansao-20261019/shard-key-presence.json` e PNG.
Configuração privada e limites em `docs/operations/nora-phase6-shard.md`.

## Implementado localmente, ainda sem aceite funcional

| Frente | Código e integração |
|---|---|
| Diagnóstico da fase 6 | `nora/operational_readiness.py` e `NoraOperationsSettings.tsx`, restritos ao administrador, somente configuração, sem ativar serviços |
| Gmail incremental | `services/gmail_incremental.py`: baseline de 100 IDs por página, checkpoint anterior à varredura, replay de histórico, inventário limitado a 500 IDs, coordenação ociosa de 60 s |
| Persistência comum | `business/store.py`: documentos atuais, transação PostgreSQL com lock de linha, versão e quota; JSON com lock local |
| Aprovação comum | `operations/exact.py`: preparação idempotente para os executores existentes de e-mail e WhatsApp; nenhuma nova rota de envio direto |
| Catálogo | `business/router.py`, ferramenta `catalog_query` e aba em Documentos: centavos inteiros, SKU, edição com versão esperada, histórico de preço, duração de serviço e oferta pela Nora explicitamente habilitada |
| Etiquetas e visões | criação, consulta, edição, arquivamento e reativação com versão esperada e permissão do criador/gestor; filtros de clientes e WhatsApp; edição de visões pessoais/de equipe; aplicação/remoção em até 100 clientes ou conversas e exportação da seleção |
| Respostas rápidas | cadastro existente de modelos recebe canais permitidos; lista com teclado no Gmail/WhatsApp/Chat; variáveis ausentes impedem envio pelos compositores; comandos resumir/tarefa/agendar/relatorio/buscar, enquete e lembrete compartilham seleção por teclado; invalidam o cache quando o modelo muda |
| Importação | `business/imports.py`, `import_apply.py`, `jobs.py` e `ImportPanel.tsx`: CSV/XLSX/vCard, prévia, mapeamento, confirmação dos válidos, fila com lease, progresso e retomada por recibos de linha; nenhum arquivo real foi importado |
| Limites da importação | 8 MB, 5.000 registros, 60 colunas; XLSX sem macros/entidades, ZIP descompactado limitado e coordenadas reais validadas; duplicados por identidade no cadastro próprio; conflitos exigem revisão |
| Privacidade | inventário inclui as duas novas tabelas; contribuições compartilhadas anonimizadas na exclusão do membro; entradas temporárias e prévias expiram em 24 h, com limpeza em lotes a cada 5 min pelo worker interno |
| Relações | ficha lista propostas/contratos principais, antigos e explícitos; busca paginada para vincular e desvincular com ACL atual dos dois lados; documento abre a ficha autorizada do cliente; fluxo antigo de contratos reconhece vínculos novos; demais tipos ainda pendentes |
| Links públicos | registro de capacidades com hash, finalidade, versão, limite, expiração e revogação; token no fragmento; sem projeções registradas e sem página pública nova funcional nesta entrega |

Após interrupção/reinício de importações, registros já aplicados são reconhecidos
por recibos gravados junto aos dados. A topologia continua exigindo o escritor
único legado. A limpeza temporária não remove clientes nem itens do catálogo.
Mesmo com o processamento pausado, a manutenção de temporários continua ativa.

### Continuação solicitada após a checagem das chaves

- Etiquetas do WhatsApp são vinculadas também ao hash da instância e de sua
  criação. Trocar a instância não reaproveita vínculos do cadastro anterior.
- Consulta de conversas por etiquetas pagina 200 IDs; a lista renderiza 50
  conversas por vez, com opção de carregar mais. Não há polling adicional.
- Catálogo ganhou histórico de preço paginado na edição do item.
- Mudanças de etiqueta e de vínculo entram na auditoria sem texto de mensagens.
- Relacionamentos são explícitos por ID e dono, com versão monotônica entre
  desvincular e vincular novamente; não mudam ACL e não inferem cliente pelo nome.
- Gmail preenche o nome do remetente conectado e, na resposta, o nome conhecido
  do outro remetente. Os campos sem informação continuam para revisão manual.
- Seletores de modelos e respostas rápidas descartam resultados de sessão ou
  workspace anterior. O Chat também mantém cache vazio como carregado, evitando
  consultar de novo a cada tecla quando ainda não existem modelos.

## Conferências executadas

- `tsc -b`: passou após a integração de catálogo, visões, importação e atalhos.
- Conferência final também com `tsc -b --force`: passou, reconstruindo os dados
  de compilação. Log fora do Git em `output/expansao-20261019/typescript-build.log`.
- Vite build: passou; log fora do Git em `output/expansao-20261019/frontend-build.log`.
- Limite do bundle: passou (JS até 500 KB, LiveKit até 520 KB, CSS até 410 KB).
- Oxlint dos novos componentes business, diagnóstico e hook de atalhos: passou
  sem avisos após remover dependência redundante de callback.
- A verificação ampliada encontrou cinco avisos de dependências em hooks antigos
  de `EmailDashboard.tsx`, idênticos na base `b81bce9`. Apenas três linhas JSX
  foram acrescentadas nesse arquivo. Comparação estática da base fora do Git em
  `output/expansao-20261019/lint-baseline/EmailDashboard.tsx`; esses avisos não
  foram tratados como um resultado limpo de lint global.
- AST Python: 20 arquivos alterados/novos analisados sem erro de sintaxe.
- `git diff --check`: passou.
- Não foram adicionados nem executados testes funcionais/automatizados nesta
  etapa. Não houve QA das novas telas no navegador, chamadas reais à IA,
  importação real, novo CI, push ou deploy.

Essas conferências de compilação e análise estática não comprovam os contratos
de autorização, concorrência, recuperação, exportação/exclusão ou a aparência
em 375 px. Não promover este estado como onda concluída.

## Pendências concretas

1. **Fase 6 operacional:** responsável cadastrar OpenAI/Brave no ambiente privado;
   conferir executor separado, PostgreSQL dedicado/HMAC/ponte e escritor único;
   validar consulta sem efeito e franquia; só então revisar ativação dos flags.
   Gmail não depende dessas chaves. O worker Gmail ainda não mantém um diário
   durável completo de mudanças para os futuros lembretes/resumos.
2. **Onda 0:** completar projeções/páginas públicas e registro detalhado de
   acessos; vínculos com financeiro/e-mail/WhatsApp/agendamentos;
   notificador com preferências/descadastro e base PDF aplicada a cada entrega.
   Presença já existe no Chat, mas requer conferência das integrações de tela.
3. **Onda 1:** aceite funcional de responsável e arquivamento/restauração em lote; preparação de
   envios com manifesto/aprovação e opt-out; aceite da seleção/etiquetas na agenda
   de contatos e na lista de conversas; comprovar importação/retomada, ACL,
   privacidade, navegação por teclado e layout nos dois temas. Os filtros de
   WhatsApp, edição de visões, histórico do catálogo e seleção dos comandos da
   Nora já estão integrados no código, sem aceite funcional ainda.
4. **Ondas 2–4:** não iniciadas nesta branch. Permanecem funil, orçamento completo,
   renovações, recibos, pedidos de documentos, portal, novos canais/atendente,
   lembretes/satisfação/horários/espera, metas/rotinas/datas/resumos por cliente.
   Não avançar para promoção dessas ondas com a base anterior incompleta.
5. **Fase 7:** dados jurídicos reais, DPA/regiões/encarregado e aceite da política
   de retenção continuam dependentes do responsável; não preencher por suposição.
6. Revisão humana das novas mudanças de autorização/privacidade e gates reais
   antes de publicar. O aceite do PR #63 não cobre esta branch.

## Estado de publicação

Em implementação local na branch isolada. Não há nova publicação nem ativação no
ShardCloud nesta etapa. Checkouts e alterações antigos permanecem preservados.

Commits locais de implementação:

- `d62cc94`: backend, persistência comum, diagnóstico e importação.
- `576cb17`: telas e integrações nas áreas existentes.

São checkpoints de implementação parcial. Não representam aceite funcional,
conclusão das ondas ou autorização de promoção.

## Execução local com Docker e continuação da Onda 1

- `compose.local.yaml` reutiliza `Dockerfile.shard`, com estágio `local`, porta
  `127.0.0.1:8765`, PostgreSQL 17 e volumes exclusivos `norium-expansao-local`.
- `scripts/start_local_docker.ps1` cria segredos locais em pasta ignorada,
  preserva-os nos próximos usos, aguarda readiness e confirma o primeiro login
  antes de remover a senha de bootstrap do ambiente do container.
- Conta de desenvolvimento e instruções em `docs/operations/local-docker.md`.
  Dados/chaves de homologação não foram copiados. Os provedores e workers
  externos continuam desativados; a fila de importação interna está disponível.
- O primeiro build Docker terminou e o serviço ficou pronto com PostgreSQL;
  primeiro login administrativo local confirmado pelo script. Uma configuração
  obrigatória W-API foi suprida com chave de criptografia nova e exclusiva desta
  base vazia; isso não configura uma instância/provedor externo.
- `business/client_assignment.py`: responsáveis elegíveis são membros ativos da
  equipe com permissão de Clientes. Cada ficha exige edição do solicitante e
  leitura do novo responsável. A operação mantém `createdBy` e `access`.
- Até 100 IDs distintos, com `expectedUpdatedAt` por ficha; usa o mesmo lock
  de escrita de Clientes/importação. Grava uma vez por proprietário e retorna
  resultados individuais, inclusive conflito, falta de acesso e necessidade
  de recarregar após falha incerta. Não promete transação entre proprietários.
- `ClientAssignDialog.tsx` mostra a seleção antes da confirmação, permite
  atribuir/remover responsável e exibe resultados por cadastro; descarte de
  resultados na troca de sessão/workspace. A barra de lote existente abre a tela.
- AST Python, TypeScript forçado, sintaxe PowerShell e lint dos componentes
  alterados passaram. Nenhum teste de suíte foi executado nesta continuação;
  aceite funcional do lote, conflitos e concorrência ainda pendente.
- Sem push, novo CI ou deploy remoto. A execução Docker é desenvolvimento local.

### Continuação: arquivar e restaurar clientes

- Endpoint autenticado `POST /api/business/clients/archive`, com IDs distintos,
  até 100 registros, flag booleana estrita, conferência de edição e
  `expectedUpdatedAt` por registro, usando o lock existente de Clientes.
- Guarda apenas `archivedAt` e a atualização do cadastro. Restauração remove a
  marca; status, responsável, permissões, arquivos e relações são preservados.
  Resultado individual: concluído, já no estado solicitado, conflito, sem
  acesso ou resultado de gravação incerto que exige recarregar.
- GET de Clientes omite arquivados por padrão, com opções explícitas `only` e
  `all`. A tela carrega apenas cadastros autorizados e oferece Em uso,
  Arquivados e Todos; essa escolha entra nas visões salvas. Contadores principais
  consideram os cadastros em uso. Vínculos diretos ainda permitem abrir o
  histórico autorizado, com identificação de cadastro arquivado.
- Confirmação da seleção tanto na ficha como na barra do lote; resultado por
  cadastro. A seleção é limpa ao trocar filtros, e os diálogos descartam ações
  de uma sessão/workspace anterior.
- Importação sinaliza identidade de cadastro arquivado para revisão manual e
  não o restaura. Seleção inicial da Nora para novas propostas e novos lembretes
  de acompanhamento ignoram arquivados. Isso não cancela notificações já
  enfileiradas nem ações aprovadas antes do arquivamento.
- TypeScript forçado, lint sem avisos dos componentes alterados e AST de seis
  arquivos Python passaram; `git diff --check` passou. Nenhuma suíte funcional
  ou mutação de cadastro real foi executada para validar esta etapa.
- Critérios pendentes de aceite: três clientes selecionados, concorrência com
  edição, falta de permissão, restauração conservando arquivos/vínculos,
  seleção por teclado, dois temas e 375 px. Exigem validação antes da promoção.

### Continuação: agenda de contatos do WhatsApp

- `WhatsAppDirectory.tsx` ganhou seleção de até 100 contatos, selecionar os
  visíveis, aplicação/remoção de etiquetas e exportação CSV só de nome/telefone
  da seleção, com proteção de fórmulas. Lista renderiza 50 contatos/grupos por
  vez; filtros e cabeçalho rolam sem ocupar toda a lista.
- Hook de filtros existente agora atende contatos e conversas. A agenda usa
  `GET /api/business/tagged-contacts`, pagina 200 identidades por consulta e
  oferece carregar as demais correspondências. Seleção e resultados são
  separados por sessão/workspace e descartados ao trocar seção/filtro.
- `POST /api/business/tags/contacts` aceita apenas IDs encontrados no catálogo
  local do próprio ator. Nenhuma conversa ou sincronização é criada por essas
  rotas. O gerenciador de etiquetas permite criar a primeira etiqueta.
- `whatsapp_contacts.py` aproxima somente representações de identidade que já
  constam em campos/aliases explícitos do provedor e no histórico local. Não usa
  nome como identidade nem adivinha números. Limites: 50.000 registros locais,
  64 aliases por identidade e 300.000 aliases no total; erro fechado ao exceder.
- Aplicação, remoção e leitura na ficha usam esses mesmos aliases; vínculos
  antigos continuam reconhecidos. Contatos sem histórico podem receber etiqueta
  sem criar uma conversa. Troca de instância continua isolada pelo bindingKey.
- Os vínculos mantêm o formato já inventariado em privacidade, com
  `conversationOwnerId`; exclusão de membro também cobre as relações de contatos.
  A auditoria registra etiqueta, quantidade e operação, sem nomes/telefones.
- TypeScript forçado, AST Python, lint dos quatro componentes alterados e
  `git diff --check` passaram. Não houve suíte funcional, chamada a provedor,
  sincronização ou alteração de dados de WhatsApp para validar esta etapa.
- Aceite pendente: três contatos, contato sem conversa, variantes JID/LID
  explícitas, preservação de etiquetas antigas, outro ator/workspace/instância,
  remoção de etiqueta, paginação, teclado e layout em 375 px.
