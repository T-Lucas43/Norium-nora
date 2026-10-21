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
