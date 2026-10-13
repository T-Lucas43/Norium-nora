# Nora — franquia em tokens e preparação contextual de e-mails

## Pedido, finalidade e estado

O usuário pediu corrigir o saldo insuficiente de um membro ao preparar e-mail,
usar tokens como franquia operacional e aproveitar os dados já informados na
solicitação. Execução individual com Codex, sem Muse ou agentes.

Implementação e validação local concluídas; revisão humana pendente.
Esta correção ainda não foi publicada ou implantada.
O responsável pela revisão humana é o próprio usuário, conforme escolha anterior.
Seu aceite para esta mudança crítica deve ser registrado antes da promoção.

Checkout: `output/hotfix-tokens-email-20261012/source`.
Branch: `codex/fix-tokens-email-20261012`.
Base local: `7c300e9e0e1dc87476d92655485c91c32184a3c7`, árvore equivalente
à main publicada `9176971e572e9a8d2d9834c1bf7fd3332cf39775`.
A main foi reconferida pelo conector GitHub em 13/10/2026 e permanece nessa revisão.
As alterações preexistentes do checkout original foram preservadas.

## Diagnóstico confirmado

- A conta indicada tem acesso à Nora e franquia de 5.000 tokens, sem consumo ou
  reserva no ciclo investigado. Não foi necessário aumentar ou resetar sua quota.
- A preparação anterior carregava o prompt geral da Nora. Uma solicitação
  sintética semelhante reservava 9.602 tokens de entrada antes de chamar a IA;
  ultrapassava a franquia. Essa reserva conservadora não é consumo faturado.
- O endpoint de e-mail envolvia erros HTTP de quota/permissão em um erro 500
  genérico, ocultando a informação útil para o usuário.
- A descrição breve da aprovação não permitia revisar o fim de mensagens longas.
- Dados da conta investigada e recibos operacionais ficam fora do Git, em output.

## Comportamento implementado

1. Extrair parâmetros explícitos antes do agente: destinatários, Cc, Cco, assunto
   e corpo. Endereços citados no corpo não viram destinatários.
2. Preservar os campos já informados também nas continuações com vários campos.
   Destinatário e mensagem são necessários; Cc/Cco/anexos são opcionais, salvo
   solicitação explícita. Contatos sem endereço e anexos indisponíveis exigem dados.
3. Sugerir um assunto a partir da mensagem quando ele não foi informado.
   A sugestão é identificada na prévia. Não inventar contatos, datas ou fatos.
4. Mensagem literal entre aspas, ou resposta direta ao pedido de corpo, gera
   prévia nativa sem chamada à IA. Instruções que precisam de redação usam um
   prompt específico menor; a reserva conservadora continua valendo.
5. Dados completos geram diretamente um cartão de aprovação exata. Não é mais
   necessário responder “sim” para que o cartão seja preparado.
6. “Permitir” continua sendo a decisão explícita que autoriza o efeito externo.
   Revisar destinatários, cópias, assunto, anexos e corpo completo no cartão.
7. Repetições de uma mesma sessão reutilizam o cartão pendente. Editar revoga
   o anterior e cria outro vínculo com o conteúdo revisado. Cancelar também
   revoga o cartão. Falha de revogação é informada, sem declarar sucesso.
8. Pedido já decidido, executando, executado ou com tentativa incerta não ganha
   automaticamente outra autorização. Resultado incerto exige reconciliação.

O adaptador central está preparado para extensões, mas somente e-mail foi
integrado nesta correção. Os outros agentes mantêm seus parsers atuais.

## Franquia, dados e controles

- O limite operacional é entrada + saída em tokens, por ciclo e usuário.
  Reservas concorrentes, consumo efetivo e capacidade disponível são mantidos.
- Valores em USD continuam no relatório administrativo; preço desconhecido ou
  orçamento monetário antigo não bloqueia uma franquia válida em tokens.
- Conta legada com apenas orçamento em dólares exige alocação explícita de
  tokens pelo administrador. Não é convertida automaticamente para ilimitada.
- Zero tokens bloqueia; vazio continua permitindo um limite explicitamente
  ilimitado. Contas já sem ambos os limites mantêm o comportamento anterior.
- Histórico e custos são preservados. Nenhuma conta real recebeu aumento/reset.
- As sessões de e-mail verificam usuário e workspace, inclusive no cancelamento.
  Destinos vêm somente da mensagem do usuário; memória de preferências não
  introduz parâmetros da ação. Arquivos precisam pertencer ao usuário/workspace.
- DLP, origem do provedor, permissão da Nora, confirmação exata, expiração,
  registro de tentativa e reconciliação existentes continuam necessários.
- Locks de preparação/finalização são locais ao processo. Não representam um
  executor distribuído; a infraestrutura durável da Onda 0 permanece separada.

## Arquivos principais

| Área | Arquivos |
|---|---|
| Interpretação | `app/services/nora_action_prefill.py`, `app/services/email_agent.py` |
| Entrada dos agentes | `app/modules/nora/router.py`, `app/modules/nora/orchestrator.py`, `app/modules/mail/router.py` |
| Redação e reserva | `app/services/nora.py`, `app/services/nora_system_prompt.py`, `app/services/ai_costs.py` |
| Aprovação exata | `app/modules/operations/service.py`, `src/components/nora/NoraApprovalCard.tsx`, `src/components/layout/Nora.tsx` |
| Administração | `src/components/admin/AiCostsDashboard.tsx`, `ai-costs.css`, `app/modules/auth/ai_costs_pdf.py` |

Caminhos `app/` são relativos a `norium-back-end`; `src/` a `norium-front-end`.
Regressões cobrem os cinco módulos de IA/e-mail, chat natural, painel de custos
e cartão de aprovação. Sem novas dependências de aplicação.

## Evidências

- 86 regressões focadas passaram, com dados temporários, dotenv desativado e
  conexões externas bloqueadas. Cobrem quota de 5.000 tokens, uso efetivo,
  limite excedido, falha/incompletude do provedor, extração de campos, prévia
  literal, usuário/workspace, concorrência, cancelamento, edição, expiração,
  digest, repetição e reconciliação sem reenvio.
- Primeira suíte completa: 1.466 testes; uma expectativa antiga de mock falhou
  porque cancel_session passou a receber o usuário autenticado. Expectativa
  atualizada e regressões de revogação/isolamento acrescentadas.
- Suíte completa final do backend: 1.469/1.469 passaram, sem falhas, erros ou
  skips; recibo `output/pos-correcao/tokens-email-completo-final-20261013.json`.
- Frontend completo final: 877/877 passaram, sem falhas ou pendências; recibo
  `norium-front-end/output/tokens-email-tests-aceite.json`.
- TypeScript, build e orçamento de bundle aprovados na versão final; logs em
  `norium-front-end/output/tokens-email-*-aceite.log`.
- Lint: zero erros; avisos preexistentes, sem novos avisos nos arquivos alterados.
- Bandit no nível exigido (`-ll`): zero achados e zero erros de scan.
  pip-audit: 71 dependências, zero vulnerabilidades. npm audit completo:
  zero vulnerabilidades. Dependências da aplicação e gates não foram alterados.
- Gitleaks 8.24.3, checksum oficial verificado: zero achados nos arquivos da
  correção. Canary sintético foi detectado e redigido após repetir a execução
  fora do sandbox cuja limpeza temporária falhou. Scan do commit registrado
  separadamente em `output/pos-correcao/tokens-email-gitleaks-history.*`.
- Browser local com componentes reais e fixtures sintéticos. Gravações /api
  bloqueadas e sem encaminhamento a API real. Formulário com duas colunas em
  1280 px e uma em 375 px; página sem overflow horizontal, gaveta com scroll.
  Os temas claro/escuro foram conferidos. Capturas desktop tiveram baixa nitidez
  no navegador desta sessão; geometria também conferida pelo DOM.
- Corpo completo do cartão conferido por teclado: área de 223 × 288 px,
  conteúdo de 972 px e scrollTop 652 com o fim da mensagem sintética visível.
  A prévia ocupa ambas as colunas do cartão. Capturas e métricas em `output/ui`.
- Nenhum envio real, alteração de quota real, confirmação autenticada do amigo,
  CI remoto, push, merge ou deploy ocorreu para esta correção.

## Revisão humana e publicação

`docs/AI_GOVERNANCE.md`, Processo obrigatório item 5, exige aprovação humana
para código crítico. Esta correção muda o controle de consumo de IA e a
preparação/revogação de autorizações para envio externo. Apresentar o resultado
concreto e as evidências ao responsável antes de promover.

Após aceite, publicar no GitHub, exigir CI e scans verdes e usar a imagem
imutável correspondente em homologação na Shard. Fazer backup e ensaio de
restauração/rollback; preservar credenciais/configuração atuais, incluindo a
voz ElevenLabs já configurada e confirmada pelo usuário. O container ativo
mudou na correção de voz: conferir o estado real antes de operar.

Aceite funcional pós-deploy: o membro prepara uma mensagem curta sem saldo
insuficiente; informações já dadas não são perguntadas de novo; corpo completo
visível; envio somente após Permitir; cancelamento/edição e repetição não enviam
automaticamente. Não pedir conteúdo privado ou chaves na conversa.

## Relação com fases 6/7 e novas ondas

A consolidação das fases 6/7 permanece em branch separada, ainda sem promoção.
Integrar este hotfix validado antes de publicá-la para não reintroduzir controle
por dólares ou o fluxo antigo. Resolver conflitos preservando os controles de
chamadas/cache/provedores existentes naquela branch e validar a integração.
As 22 funcionalidades novas e a Onda 0 continuam fora deste hotfix.
