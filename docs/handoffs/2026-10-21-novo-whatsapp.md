# Novo WhatsApp — execução direta, 21/10/2026

## Pedido, fontes e limites

- Implementar as funcionalidades da proposta do WhatsApp, histórico antigo,
  etiquetas visíveis e atualização por eventos; seguir os PDFs claro/escuro.
- Executor individual, sem Muse ou agentes. Checkout original com alterações
  preexistentes preservado; trabalho no checkout limpo `output/expansao-20261019/source`.
- Branch `codex/whatsapp-experiencia-20261021`, base main `c7fc444`.
- Especificação lida em Downloads: `prompt-codex-whatsapp.md`, 17 páginas em
  cada PDF. Fontes HTML citadas na especificação não existem neste checkout;
  os PDFs foram renderizados integralmente em `output/whatsapp-20261021/references`.
- Evolution continua selecionada pelo backend; W-API permanece compatível.
  Nenhuma mudança de provedor, pareamento, envio real ou publicação integra
  implicitamente a validação local desta nova revisão.

## Fase 0 — decisões antes do código de produto

### Propriedade e acesso

- `app/modules/chat/router.py:435`: `tenant_id(user)` é o ID da pessoa,
  não `teamOwnerId`. `:1554` exige chat + integração WhatsApp.
- `services/conversation_store.py:36`: documento de conversas por usuário
  identificado; sem fallback de identidade. Parâmetros ainda opcionais em
  assinaturas falham fechados em `require_user_id`.
- `services/wapi_binding.py:325` e chamadas de `get_owned_binding(user_id)`:
  vínculo e unicidade da instância pertencem à conta. Não existe autorização
  para um membro ler o WhatsApp de outro membro apenas por compartilhar equipe.
- `core/identity.py:19`: os documentos de negócios usam dono da equipe como
  workspace, identidade diferente da propriedade da instância.
- Pergunta do item 4.2 apresentada ao responsável: implementar caixa de equipe
  opcional, desligada por padrão, com `whatsapp.atender` e `whatsapp.ver_todas`.
  **Autorizado pelo responsável em 21/10/2026:** “Sim, implementar caixa de equipe
  opcional”. Implementar opt-in por instância, desligado por padrão; nenhuma
  conta pessoal passa a ser compartilhada implicitamente.

### Persistência e eventos existentes

- Conversas/mídia/vínculo continuam nos serviços atuais, sem copiar mensagens
  de um usuário para outro. Metadados novos de atendimento terão tabelas
  dedicadas com workspace, proprietário e conversa; migração aditiva/idempotente.
- `business/store.py`: base PostgreSQL com lock por documento, quota e versão;
  fallback de arquivo com lock local. Reutilizar cadastros comuns existentes.
- `modules/inbox/router.py:82`: gerenciador WebSocket autenticado por usuário,
  revalida sessão antes de enviar; frontend `hooks/useWebSockets.ts:600` já
  despacha `norium:whatsapp-event` ao receber eventos WhatsApp.
- Mensagens criam eventos; atualizações de leitura, reação e catálogo ainda
  não têm invalidação dedicada e uniforme. Reutilizar esse socket para aviso
  mínimo, sem duplicar o histórico da caixa nem enviar conteúdo no evento.
- `ChatCentral.tsx:766/795`: reservas ainda de 30 s. Trocar por eventos e
  reserva de ao menos 120 s, somente visível; QR continua limitado ao modal.

### Histórico: causa confirmada

- `evolution_client.py:142`: instância criada com `syncFullHistory=false`.
- `:282`: leitura fixa da primeira página, 100 registros.
- `chat/router.py:3274`: páginas antigas consultam apenas o snapshot; o indicador
  de mais páginas do provedor é gravado, mas não alimenta a próxima leitura.
- Implementar paginação real, deduplicação por ID, fronteira estável para
  timestamps iguais, guarda de vínculo/conta e preservação da posição de scroll.
- Histórico só pode conter mensagens efetivamente disponibilizadas pelo
  provedor/dispositivo. Não prometer recuperar mensagens que não foram fornecidas.

### Bases reutilizáveis

| Base | Estado observado | Reutilização / trabalho necessário |
|---|---|---|
| Etiquetas, visões e lote | Parcial | `business/router.py`, `whatsapp_contacts.py`, `ClientTagsPanel`, `useConversationLabels`; projetar etiquetas no item/cabeçalho/painel, sem consultas por linha |
| Cliente/documentos | Parcial | `client_relations`, ACL de Clientes e documentos; falta projeção agregada por conversa e escolha explícita em ambiguidades |
| Aprovação exata | Existente | `operations/exact.py`, executores atuais; nunca criar envio paralelo |
| Presença | Existente no Chat da equipe | Reutilizar autorização e expiração; atividade WhatsApp depende do acesso aprovado |
| Respostas rápidas | Parcial | `message-templates/useQuickReplies`; manter cadastro e canais, bloquear variáveis não resolvidas |
| Catálogo | Existente | Valores em centavos, versões, duração e permissões; não inventar preço |
| Funil/orçamento/pedido de documentos | Parcial ou ausente na integração | Verificar serviços e implementar a base comum antes de expor atalhos |
| Lembretes/envios agendados | Parcial | Reutilizar workers e ledger existentes, com idempotência e estado unknown |
| Atendente Nora/NPS/resolução | Pendente de integração | Opt-in, delegações, orçamento em tokens e aprovação exata quando aplicável |

## Sequência / critérios

0. Registrar investigação e decisão de acesso, linha de base sintética.
A. Layout dos PDFs, navegação 60/330/flex/320, temas, mobile, menus existentes,
   histórico paginado real, busca e eventos sem polling curto.
B. Atendimento, responsável, estado, histórico, notas estritamente internas;
   só após confirmação do modelo opcional de equipe.
C. Etiquetas de contato e lote transacional, mesma base de Clientes.
D. Painel agregado do cliente com ACL de cada módulo.
E. Produtividade e bases faltantes, sem envio real durante testes.
F. Nora sob demanda e atendente opcional, DLP e medição, assumir cancela preparo.
G. Resolver com resumo, satisfação e acompanhamento idempotentes.

Preservar todos os controles e aria-labels atuais. Componentes novos menores
que aproximadamente 400 linhas. Regressões backend/frontend, tipos, lint,
build e verificação visual claro/escuro em 1440/1024/375 px por fase.
Não declarar fase concluída com botões sem ação ou fixtures como produto.

## Evidências e execução

- Referências: `output/whatsapp-20261021/references/` e texto extraído ao lado.
- Linha de base backend: 300 testes, zero falhas/erros/skips, em cópia
  descartável sem dotenv/rede externa (`whatsapp-baseline-20261021.json`).
- Linha de base frontend: 127 testes, todos aprovados; primeira tentativa não
  iniciou os testes por ausência da pasta de saída, corrigida sem mexer em testes.
- Nenhum código de produto alterado antes deste registro.
## Atualização de execução — 21/10/2026, fase A em validação

- Implementados: lista de 100 resumos por página e janela virtual de 92 px;
  busca no histórico sincronizado com debounce de 300 ms; histórico Evolution
  paginado com fronteira timestamp/ID, âncora e rejeição após troca de vínculo.
- Corrigida persistência dos três campos do cursor no normalizador do store.
  `MESSAGES_SET` apenas invalida o histórico: não reproduz mensagens antigas
  como novos envios, automações ou notificações de conteúdo.
- Eventos mínimos reaproveitam o WebSocket autenticado; leitura de reserva
  de 120 s, aba visível, rajadas agrupadas. Nenhum telefone/texto no aviso.
- Etiquetas visíveis em lote por dono + vínculo + workspace; sem consulta por
  linha. Galeria, teclado, download e encaminhamento pelo fluxo existente;
  miniatura privada limitada, sem buscar a mídia original para a prévia.
- Visual: rail/configurações, cabeçalho, compositor, cores dos PDFs, seletor
  compacto preservando os filtros antigos; busca com marcação e contador;
  painel com preferência por usuário/workspace e cache de 30 s.
- Revisão móvel encontrou regras antigas que escondiam abas e título e
  sobrepunham navegação. Ajustadas; conferência sintética em 375 px exibiu
  conteúdo de 375 px. Ainda concluir 1024/1440, claro/escuro e checklist.
- Validação direcionada: 323 testes backend aprovados; 138 do módulo frontend
  aprovados antes dos últimos testes de busca/preferência. Build + orçamento
  dos bundles aprovados. Suítes completas ainda em execução nesta atualização.
- Tentativas iniciais de teste tinham nomes de módulos inexistentes e uma
  fixture sem plano WhatsApp; recibos preservados e corrigidos. O resultado
  de 323 usa os 20 módulos reais da linha de base mais os dois novos módulos.
- Docker Desktop falhou em socket transitório bloqueado no Windows; o usuário
  informou ter reiniciado. Engine 29.8.1 voltou, stack existente saudável,
  `/health/ready` ready e `/` HTTP 200 em http://localhost:8765. Não foi preciso
  recriar volumes nem pareamento. Essa imagem ainda contém a versão anterior.
- Revisão visual em Vite 127.0.0.1:5177 usa apenas dados sintéticos e rotas
  interceptadas; não comprova pareamento real nem entrega ao provedor.
- Caixa de equipe segue autorizada para implementar, mas ainda não habilitada
  em conta alguma. Fases B–G ainda não concluídas. Sem push/deploy desta revisão.
### Fechamento técnico da primeira entrega visual (A) — em andamento

- Suíte completa backend: 1.742 aprovados no recibo `whatsapp-phase-a-full`.
  Após acrescentar tradução: 44 testes de tradução/provedores/franquia/DLP
  aprovados. Após migrar assinatura de eventos: 23 aprovados. A última execução
  completa está em `whatsapp-phase-a-final-full` e ainda não terminou neste registro.
- Frontend atual: 982 testes completos aprovados (`whatsapp-phase-a-final-all`),
  incluindo 144 da pasta chat. Build com verificação de tamanho aprovado.
  A primeira repetição tinha uma expectativa antiga de carregar perfil sem abrir
  o painel; o caso foi atualizado mantendo abertura por telefone e conferindo
  que detalhes são carregados somente após abrir Dados. Os cinco casos envolvidos
  passaram em `whatsapp-phase-a-last-cases`.
- Tradução antiga era um botão sem execução. Agora há escolha de idioma e ação
  explícita por mensagem, usando o mesmo serviço Nora, provedor/política atuais,
  medidor e modo de erro estrito opcional. Somente um texto acessível é usado;
  CPF, telefone, e-mail e segredos são mascarados; sem ferramenta/envio/armazenamento
  da tradução. Testado apenas com adaptadores sintéticos, sem cobrança real.
- Migração de webhook Evolution sobe o marcador para 2 na sincronização normal,
  incluindo CHATS_SET/MESSAGES_SET em instâncias existentes sem reconectar.
  syncFullHistory=true aplica-se à criação de novas instâncias. Uma conexão
  antiga não recupera retroativamente mensagens que o telefone/provedor jamais
  disponibilizou; nenhuma reconexão forçada foi implementada.
- Layout exercitado com componentes reais + API sintética em viewports internos
  de 375, 1024 e 1440 px (1440 reduzido externamente para caber na captura).
  Claro/escuro, lista → conversa → painel e todas as abas móveis acessíveis.
  Capturas em `output/whatsapp-20261021/*-panel.png` e `mobile-dark-chat.png`.
  Conferência automática de largura mostrou conteúdo igual ao viewport nas três
  larguras. Estas capturas não são evidência de envio/pareamento de telefone real.
- Bandit anterior sem achados médios/altos; Gitleaks 8.24.3 oficial com checksum
  verificado e canário de detecção aprovado. Snapshot de 1.289 arquivos de código
  sem dotenv/dados ignorados: nenhum segredo encontrado. Repetir ambos após as
  últimas alterações antes do checkpoint.

### Preparação da fase B (sem ativação)

- Usar caixa pessoal atual por padrão e entrada opcional explícita por dono,
  restrita ao workspace atual e ao vínculo atual. Nunca trocar o dono por um
  identificador arbitrário do navegador nem copiar conversas entre contas.
- Preferir rotas próprias da caixa de equipe que autorizem cada conversa antes
  de reutilizar os serviços de leitura/envio existentes. Reescrever mídia para
  rotas autenticadas da caixa que validem mensagem/conversa antes de resolver
  bytes; nenhuma URL administrativa ou credencial é entregue aos membros.
- Tabelas novas devem incluir tenant (dono da equipe), workspace, proprietário
  da instância, hash do vínculo e conversa. Permissões de atender/ver todas são
  verificadas em cada operação; conta pessoal continua em seu caminho atual.
- Reutilizar `team/router.record_team_event` e presença de `chat_presence` com
  projeção autorizada; ainda não chamar estes caminhos com dados reais.
- Notas ficam em armazenamento próprio e nunca entram no adaptador WhatsApp.
  Exportação, exclusão e anonimização de contribuições pessoais fazem parte
  da implementação, com transações/concorrência e testes antes de promoção.
- Fases B, C, D, E, F e G permanecem pendentes; nenhuma foi declarada entregue.

### Checkpoint A — 21/10/2026, 12:30 (São Paulo)

- Frontend congelado: 984/984 testes aprovados em
  `norium-front-end/output/whatsapp-phase-a-release-all.json`; build e orçamento
  aprovados em `whatsapp-phase-a-release-build.log`; lint encerrou com código 0.
- A repetição completa backend `whatsapp-phase-a-final-full` executou 1.747
  casos e falhou somente no teste de cookie persistente: a virada de segundo
  entre criação e resposta produzia Max-Age=604799. O teste agora usa o mesmo
  relógio nas duas operações e conserva a exigência exata Max-Age=604800.
  Nenhum código de autenticação foi alterado. Os 74 casos de sessão, histórico,
  catálogo, tradução e projeções passaram em `whatsapp-phase-a-session-corrected`.
  Nova suíte completa em `whatsapp-phase-a-verified-full`, ainda em execução.
- Uma tentativa dirigida usou prefixo `unit` incorreto e não executou casos;
  recibo preservado. A execução correta usa `tests.unit` e é a dos 74 aprovados.
- Bandit e Gitleaks anteriores terminaram sem achados; novo snapshot fonte
  será conferido antes do commit. Não entram dados, backups nem dotenv no scan.
- Backup PostgreSQL local anterior à atualização preservado em
  `output/whatsapp-20261021/backups/before-phase-a.dump`, SHA-256
  `F242B45095EC2909C6657753182B03F02EE6A54DBC73E687B807F96145794E4D`.
- Atualização local será somente do serviço app, mantendo os volumes e os
  serviços Evolution existentes. Essa revisão continua sem promoção remota;
  revisão humana e CI serão necessários para homologação.

### Entrega local A e hotfix do histórico — 21/10/2026

- `fd2b0f388635dc5cb051052e6a9a01decb2bd555` instalado no Docker local em
  http://localhost:8765. Página HTTP 200, prontidão true e identidade pública
  local/2026.10.21/esse SHA, com os mesmos volumes antes/depois. Recibo em
  `output/whatsapp-20261021/local-release-a.json`; imagem anterior preservada.
- A suíte completa A terminou: 1.749 testes aprovados, zero falhas/erros/skips,
  recibo `whatsapp-phase-a-verified-full.json`. Frontend: 984 aprovados, build e
  orçamento aprovados. Na preparação da imagem, SHA abreviado foi recusado pelo
  verificador; a imagem efetiva foi construída do ZIP Git com SHA completo.
- A revisão das transições da fase B revelou que o snapshot continua limitado
  a 250 mensagens em `sync_catalog_messages` e no webhook. O novo hotfix usa
  consultas limitadas no PostgreSQL privado já existente da Evolution, com
  cursor timestamp/ID e collation C. Não cria outro arquivo integral de histórico
  nem aumenta o snapshot da lista. O banco privado está configurado no Docker
  local; somente essa presença foi consultada, sem ler mensagens reais.
- Leituras comprovam o proprietário no registro existente e revalidam a geração
  do vínculo depois de aguardar. Referências antigas alimentam mídia, miniatura,
  encaminhamento, resposta citada, edição e tradução pelos caminhos atuais.
- Visibilidade local e reações próprias têm metadados pequenos por usuário,
  workspace e geração do vínculo, com quota/lock do repositório existente.
  Apagar localmente não faz a mensagem reaparecer ao consultar o gateway.
  Esses documentos entram na exportação/exclusão já existentes e no prazo de
  retenção WhatsApp quando habilitado. Mensagens apagadas no provedor não
  devolvem conteúdo/mídia anterior pelo histórico privado.
- Prova SQL em PostgreSQL 17 descartável, sem rede/portas públicas: 751 mensagens
  paginadas sem duplicação, 750 no mesmo segundo, isolamento de conta/conversa,
  aliases explícitos e referência ambígua negada. Recibo
  `output/whatsapp-20261021/history-postgres-proof.log`; o container de teste
  foi identificado pelo label e encerrado, sem tocar nos serviços do projeto.
- Regressões dirigidas anteriores: 177 aprovados (`whatsapp-history-actions-final`).
  Suíte final com mensagens apagadas está em `whatsapp-history-private-full`.
  Hotfix ainda sem instalação local/push/deploy remoto neste registro.
- O fallback Evolution sem banco privado mantém a API existente e sua limitação
  de snapshot; o acesso ao histórico profundo exige o banco privado configurado.
  Nenhuma recuperação de mensagens que o provedor nunca recebeu é prometida.
- Fase B preservada em `codex/whatsapp-equipe-20261021`, stash nomeado
  `whatsapp-team-foundation-before-history-archive-fix`. Inclui opt-in, permissões,
  quatro tabelas, responsáveis/estados/notas, ciclo LGPD e rotas próprias.
  71 casos dirigidos passaram antes das últimas notificações. Ainda falta
  concluir integração de envio, eventos/presença e UI; não está no Docker local.
  Retomar B após fechar este hotfix e manter C–G como pendentes.

### Retomada B — histórico aceito, 21/10/2026

- Hotfix A `fa63f37f1f49f04a1f556af3b438b1329ef8ea06` instalado em
  http://localhost:8765, prontidão true/HTTP 200, mesmos volumes. O usuário
  confirmou: "As antigas carregam". Suíte backend completa: 1.759 aprovados;
  frontend inalterado: 984 aprovados. Bandit e snapshot Git Gitleaks sem achados.
- B restaurada na branch `codex/whatsapp-equipe-20261021`, ainda sem imagem
  local ou publicação. 113 testes dirigidos aprovados, com adaptadores falsos;
  PostgreSQL descartável comprovou claim concorrente, rollback, isolamento e
  anonimização. Nenhuma instância real foi compartilhada ou mensagem enviada.
- Estão implementados opt-in por workspace/vínculo, permissões, tabelas,
  responsáveis, estados, notas, notificações e transições de envio/resposta.
  Prosseguir com ações autenticadas, presença, retenção e interface. Fases C–G
  continuam pendentes; a aceitação do histórico não cobre a caixa de equipe.

### Candidata B — 21/10/2026, sem ativar compartilhamento real

- Implementada seleção explícita "Meu WhatsApp / WhatsApp da equipe". Só o dono
  pode compartilhar sua instância no workspace e vínculo atuais. Permissões
  `whatsapp.atender` e `whatsapp.ver_todas` são revalidadas no backend; os números
  pessoais dos membros conservam os caminhos e o armazenamento anteriores.
- Responsável, estado e histórico próprios em quatro tabelas PostgreSQL com
  chave tenant/workspace/dono/vínculo, DDL aditivo e fallback arquivo. Versões
  concorrentes recusam atualização obsoleta. Resolver pede confirmação; nova
  resposta reabre sem trocar o responsável. Envio manual confirmado pode assumir
  conversa não atribuída; falha/resultado desconhecido não dispara novo envio.
- Rodízio opcional entre membros online sem foco, desligado por padrão, sem
  distribuir replay de mensagens antigas. Não foi ligado em nenhuma conta real.
- Notas âmbar na linha do tempo, composição e rascunho separados de resposta,
  menções autorizadas, edição/exclusão lógica por autor/gestor. O serviço de
  notas não importa adaptadores de envio. Avisos privados no Chat e na Central
  contêm referência opaca; não levam corpo, telefone ou nome de cliente ao feed.
- Rotas compartilhadas de texto/mídia, resposta citada, reação, edição, exclusão,
  encaminhamento e metadados validam conversa/mensagem antes de chamar os
  serviços atuais. Encaminhamento resolve todos os IDs na origem exata e confere
  o destino antes do primeiro efeito. QR/identidade administrativa não aparecem
  no status da equipe. URLs de mídia/foto passam por autorização específica.
- Socket existente transporta caixa + área, sem conteúdo. Reatribuição também
  invalida o antigo responsável; UI descarta conversa após perda de acesso.
  A atualização preserva mensagens antigas já abertas. Presença reutiliza o
  serviço do Chat, suas preferências e TTL, com título por leitor autorizado.
- Exportação pessoal inclui somente contribuições próprias; exclusão anonimiza
  notas/eventos e libera atribuições sem apagar trabalho alheio. Retenção global
  opt-in remove notas/eventos em lotes, preservando a atribuição que controla ACL.
- Validações: 132 testes backend dirigidos aprovados, 43 do delta final; frontend
  completo repetido com 992/992, 11 contratos recentes. PostgreSQL 17 sintético
  comprovou claim concorrente, rollback, isolamento, anonimização e retenção.
  Container temporário encerrado pelo label, sem volumes do projeto.
- A primeira suíte completa B executou 1.802 casos, zero falhas e um erro:
  `test_postgres_retention_does_not_use_local_fallback` simulava `configured=True`
  sem URL/conexão real e ainda não simulava o novo repositório. O teste passou
  a simular `_postgres`, exigir sua chamada e conservar a proibição de `Path.stat`
  e exclusão local. A prova SQL real separada cobre o novo caminho PostgreSQL.
  Não tratar esse primeiro recibo como aprovação integral; repetir a suíte.
- Bandit: zero achados médios/altos e zero erros. Gitleaks: snapshot de 1.303
  arquivos de código, zero segredos; dados/dotenv ignorados não são enviados.
  Build/orçamento frontend aprovados. Lint sem erros; cinco avisos de organização
  de exports para Fast Refresh, sem avisos de dependências de hooks pendentes.
- Visual com componentes reais e API sintética: claro/escuro em 1440, 1024 e 375 px,
  mensagens + notas, composição sem sobreposição. Capturas `team-desktop-*.png`
  e `team-mobile-*.png`; gaveta em `team-tablet-*.png`. Mesma largura de conteúdo
  e viewport nas três medidas; botões de modo sem sobreposição no celular.
  Nada foi enviado a WhatsApp real. Revisão humana da candidata e CI continuam
  necessários antes de promoção. A imagem em 8765 permanece A/fa63f37.
- Limites ainda abertos: edições de etiquetas em equipe/C, dados agregados do
  cliente/D, novas ações e lembretes/E, Nora contextual da caixa/F e resolução
  com resumo/satisfação/acompanhamento/G. Nora pessoal continua disponível;
  chamadas que dependeriam do contexto compartilhado ficam explicitamente
  desabilitadas nesta candidata, evitando consultar o número pessoal por engano.
  Máscara granular de telefone e revisão final de acessibilidade ficam no aceite
  integrado C/D. Não declarar o conjunto de funcionalidades do WhatsApp concluído.

### Retomada C — 21/10/2026

- B consolidada no commit local `dcb683b467eabba23910e8ff3eea339516472545`.
  A repetição integral `whatsapp-team-verified-full.json` passou: 1.802 casos,
  zero falhas/erros/skips. O delta de identidade/workspace passou com 17 casos.
  ZIP Git imutável separado; ainda não instalado nem publicado. Docker local
  permanece A/fa63f37 com pareamento preservado e histórico aceito pelo usuário.
- C na branch `codex/whatsapp-etiquetas-20261021`: reutilizar `business_tags` e
  `business_tag_links`, com aliases explícitos de contato e vínculo atual.
  Lote de até 200, todos os itens autorizados antes da escrita, rollback integral,
  estados mistos e criação no modal. Nenhuma mensagem em massa. Atribuição usa
  versões concorrentes existentes; etiquetas verificam definições sob o mesmo
  lock da gravação. Arquivar/lida são metadados locais, sem recibos externos.
- Critérios: conta/workspace/vínculo isolados, lote inválido sem escrita parcial,
  etiqueta arquivada recusada, aliases sem duplicação, modal misto acessível e
  lista/painel atualizados por evento. Preservar exportação CSV e controles atuais.

### Candidata C — etiquetas, seleção e filtros

- Modal reutiliza definições/vínculos atuais: busca, criação, estado misto,
  contagem por contato canônico, aplicação só das escolhas explícitas. Cabeçalho
  e painel permitem editar também na caixa compartilhada. Seleção até 200;
  Arquivar/Lida alteram o Norium, sem enviar recibos ou mensagens ao provedor.
- `POST /api/chat/conversas/lote` valida ação, limites, vínculo e cada item.
  Atribuir/Resolver usam uma transação do repositório, versões e eventos atuais.
  Etiquetas/metadados têm um único documento gravado, dependências bloqueadas e
  autoridade da caixa revalidada sob lock. PostgreSQL falha fechado, sem arquivo.
  Sem PostgreSQL, locks de arquivo + cópia e uma gravação atômica preservam o lote.
- Filtros combinados antes da contagem/paginação, incluindo período em Brasília.
  Visões versionadas usam `saved_views`/`team_views`, com contexto explícito da
  caixa, autor/gestor e compartilhamento opcional. As rotas antigas de Clientes
  não listam nem editam os registros WhatsApp. Troca de caixa limpa filtros e
  preserva o bloqueio de ações pessoais na caixa compartilhada.
- PostgreSQL 17 descartável comprovou rollback de capacidade e versão, rótulos
  concorrentes sem duplicação, recusa de etiqueta arquivada, ACL sob lock,
  isolamento de workspace e ausência de fallback; recibo
  `output/whatsapp-20261021/bulk-postgres-proof-final.log`. Pool fechado e
  container encerrado/removido após conferir seu label; nenhum volume do projeto.
- Backend dirigido: 61 casos (lote + equipe/ciclo) e 46 (visões/filtros + lote +
  rotas), todos aprovados, com sobreposição entre os conjuntos. Frontend final
  dirigido: 33 aprovados. Bandit: zero achados médios/altos e zero erros;
  Gitleaks em 1.287 fontes, zero segredos. Build/orçamento aprovados; lint sem
  erros e um aviso de organização dos exports no contexto já existente.
- Primeira suíte completa frontend: 1.004 aprovados, seis falhas no Status e
  cinco erros associados. Uma resposta `{}` da consulta opcional de visões
  deixava `views` indefinido. Corrigida validação de resposta, com regressões;
  os testes do Status voltaram a passar nos 33 dirigidos. Repetição completa
  `whatsapp-phase-c-verified-all` e backend `whatsapp-phase-c-full` em execução;
  não contar a primeira execução como aprovação integral.
- Visual real com API sintética em 1280 e 375 px, claro/escuro: modal de estado
  misto legível, menu de ferramentas sem recorte e barra com todas as ações.
  Modal de filtros em 375: largura cliente/scroll 320/320, altura 684/970;
  rolagem alcança o rodapé. Capturas `phase-c-labels-*.png` e
  `phase-c-filters-mobile-light.png`. Nenhuma ação sobre WhatsApp real.
- Pendente integrado com D: vínculo explícito cliente/contato para projetar a
  mesma etiqueta em Clientes; não inferir esse vínculo pelo telefone/nome.
  Máscara granular e dados agregados ainda pendentes. C não representa aceite
  do conjunto WhatsApp; D–G seguem abertos. A imagem ativa em 8765 ainda é A.


## Hotfix de identidade e Nora — 21/10/2026

- O usuário confirmou a imagem C em localhost:8765: histórico antigo e menu de etiquetas funcionam.
- Novo relato: contato recebido/enviado aparecia em dois cartões, título de grupo recebia nome de participante e Nora não respondia.
- WIP do painel do cliente/funil preservado no stash `whatsapp-client-pipeline-wip-before-identity-hotfix`, branch `codex/whatsapp-cliente-20261021`. Não compõe esta imagem.
- Correção isolada em `codex/whatsapp-identidade-20261021`: identidade por aliases explícitos PN/LID do catálogo/webhook da própria conta, variantes PN normalizadas, eventos deduplicados por ID. Nomes/textos/números parecidos não são evidência. Conflito entre telefones distintos impede fusão. Aliases originais preservados no registro e usados na paginação antiga.
- Grupo: subject do catálogo de grupos tem prioridade; pushName e remetente não são títulos. A agenda individual não substitui o título do grupo.
- Nora pessoal: usuário explícito nas consultas personalizadas e resumos, contexto limitado a 12 mensagens/600 caracteres, respeitando estado local e visualização única.
- Nora da caixa: somente rascunhos explícitos; autenticação e acesso rechecados antes/depois da leitura e depois da IA, sem notas internas/anexos brutos, cobrança ao solicitante, nenhum envio automático. Botões existentes reativados com rota dedicada, sem fallback para o WhatsApp pessoal.
- Causa operacional confirmada: container local sem GROQ_API_KEY/OPENAI_API_KEY. Chave Groq já configurada no backend da máquina foi preparada no `.env` local ignorado, sem impressão do segredo. Compose passa apenas essa variável opcional. Nenhuma nova chave/provedor foi criado.
- Regressões `whatsapp-identity-release-regression`: 218 testes backend, zero falhas/erros/skips. Front `whatsapp-identity-final-directed`: 60 testes/9 arquivos, zero falhas. Build TypeScript/Vite e orçamento de bundle aprovados. Bandit módulos novos/ACL/histórico: zero achados/erros. Primeira bateria ampliada errou o nome do módulo de testes de visões; a repetição usou `test_whatsapp_views_filters` e passou.
- Não houve uso de conversas reais em testes nem envio/reação/pareamento externo. Publicação GitHub/ShardCloud deste hotfix não executada. A atualização local e seu recibo serão registrados após verificar a imagem.

- Caso adicional reproduzido: o chat usa PN e a última mensagem chega com `remoteJid=LID`, `remoteJidAlt=PN`. O adaptador anterior só guardava o alias na ordem direta. Agora aceita ambas, recupera a evidência do cache existente e rejeita mensagens de terceiros. Regressões `whatsapp-identity-reverse-alias`: 42/42 aprovadas.

- Verificação de visibilidade: exclusão em um alias antigo permanece oculta após a consolidação, inclusive Nora e mídia antiga. Override de reação mais recente prevalece. `whatsapp-identity-visibility`: 49/49 aprovados. A revisão 8d7c109 foi instalada localmente e a Nora respondeu ao marcador sintético pelo Groq, com franquia do admin local; zero mensagens WhatsApp enviadas. Volumes idênticos e PostgreSQL pronto. Acrescentado ajuste final de visibilidade à candidata subsequente.

- Compatibilidade da caixa de equipe: aliases entram no grant e na revalidação de todas as ações/etiquetas; atribuições são sincronizadas sob o lock existente ao reatribuir, preservando versões e notas. Resposta nova reabre o atendimento antigo sem trocar o responsável; notas/eventos anteriores continuam acessíveis por paginação autorizada. Mesmo um chat somente no catálogo mantém a ACL do identificador antigo. `whatsapp-identity-complete-final`: 227/227 aprovados. Não foi ativado compartilhamento de nenhuma instância real.

### Recibo local final do hotfix

- Imagem ativa `norium-expansao:whatsapp-identity-697d252`, revisão `697d252ec5d9a6b4f699cb822bc4a32766a9ebbb`, URL http://localhost:8765. Banco PostgreSQL pronto, volumes idênticos ao C, 13 arquivos JS/CSS referenciados retornaram 200, WhatsApp sem autenticação retorna 401. Recibo `output/whatsapp-20261021/local-release-identity-final.json`; inicialização permanece com os dois arquivos Compose registrados em `output/docker-local/active-release.json`.
- Backup privado anterior: `output/whatsapp-20261021/backups/before-whatsapp-identity.dump`, SHA256 FD6160CAF9BFF96013E73EC15049BF5B173FD2636107E62FFF91194F5488A21B. Rollback `norium-expansao:before-whatsapp-identity-20261021`, sem restauração/exclusão de dados.
- Bateria da revisão exata `whatsapp-identity-697d252-final`: 227 testes backend aprovados, zero falhas/erros/skips. Bandit recursivo dos módulos novos/equipe/histórico/estados: zero achados/erros. Compilação da interface e orçamento aprovados dentro da imagem.
- Groq configurado no runtime; a chamada real sintética anterior confirmou resposta NORIUM_OK, contabilizada no admin local. Não se enviou conteúdo de chat ao provedor nesta verificação, nem mensagem ao WhatsApp. A conferência autenticada das três correções na conta real ainda depende do usuário. Nenhum push/PR/deploy remoto deste hotfix.

### Aceite local e pedido de publicação — 21/10/2026

- Após atualizar a sessão local, o usuário confirmou: “Sim, tudo certo” para conversa única por contato, nome dos grupos e sugestão da Nora. Em seguida solicitou “faça o deploy agora”.
- Candidata de código validada: 697d252ec5d9a6b4f699cb822bc4a32766a9ebbb. Este registro só acrescenta documentação; não altera a árvore da aplicação aceita. Publicação solicitada via GitHub e ShardCloud, preservando volumes, segredos do servidor, sessões e rollback. A caixa de equipe segue opt-in, desligada por padrão; o WIP de Cliente/Funil está preservado fora desta candidata.
- Não confundir aceite local com aceite autenticado da homologação. Os gates e recibos remotos serão vinculados ao SHA efetivamente promovido.
