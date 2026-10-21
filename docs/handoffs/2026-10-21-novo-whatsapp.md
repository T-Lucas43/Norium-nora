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
