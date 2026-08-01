# Refatoracao do EmailDashboard

Fatiamento arquitetural do `EmailDashboard`, que tinha 2.257 linhas num unico
arquivo, junto com a criacao da infraestrutura de testes do frontend.

**Resultado:** 2.257 -> 617 linhas (-73%), de 0 para 236 testes.

Nenhuma regra de negocio foi alterada. Cada passo foi validado com type-check,
build, suite de testes e verificacao no navegador antes do commit seguinte.

---

## Por que

O arquivo concentrava 42 `useState`, 17 `useEffect`, 25 handlers e 1.040 linhas
de JSX. Qualquer alteracao exigia entender o conjunto inteiro, e nao havia teste
algum protegendo o comportamento.

## Como ficou

```
src/features/mail/
├── api.ts              cliente HTTP do modulo
├── types.ts            tipos, quickFilters, MailboxSnapshot
├── formatters.ts       bytes, iniciais, categoria, rotulos, sanitizacao
├── queryBuilder.ts     rotas de mensagens e query de busca do Gmail
├── mailboxCache.ts     cache por usuario/pasta/filtro/busca
├── noraPrompts.ts      prompts enviados a Nora
└── hooks/
    ├── useGmailConnection.ts   status da conta, rotulos, conectar/desconectar
    ├── useMailbox.ts           listagem, paginacao, cache, prefetch, auto-refresh
    ├── useMessageDetail.ts     leitura e acoes (individuais e em lote)
    ├── useCompose.ts           nova mensagem, resposta, anexos
    ├── useNoraMail.ts          agente e sugestoes de redacao
    └── useMailPreferences.ts   preferencias persistidas no navegador

src/components/emails/
├── EmailDashboard.tsx       orquestrador (617)
├── MailSidebar.tsx          pastas, marcadores, quota
├── MailToolbar.tsx          busca e acoes da conta
├── AdvancedSearchPanel.tsx  formulario de pesquisa avancada (portal)
├── MailMessageList.tsx      cabecalho, filtros, acoes em lote, lista
├── MailMessageRow.tsx       linha da lista
├── MailMessageDetail.tsx    leitura: acoes, metadados, corpo, anexos
├── MailReplyBox.tsx         resposta rapida
├── NoraSuggestionPanel.tsx  sugestao editavel da Nora
├── AttachmentPreview.tsx    anexos em edicao (redacao e resposta)
└── modals/
    ├── ComposeModal.tsx · NoraMailDrawer.tsx
    ├── MailSettingsDrawer.tsx · LabelDialog.tsx · ProfilePopover.tsx
```

## Infraestrutura de testes

O frontend nao tinha nenhuma: sem vitest, sem testing-library, sem script
`test`, zero arquivos de teste. Foram adicionados:

- **vitest + @testing-library/react + jsdom**
- `src/test/setup.ts` preenchendo `matchMedia`, `ResizeObserver` e
  `IntersectionObserver`, ausentes no jsdom e usados por varios componentes
- scripts `test`, `test:watch`, `test:coverage`

## Padroes adotados

**Hooks nao roubam estado alheio.** Varias funcoes mexiam em estado que nao era
delas - o `disconnect` limpava mensagens e paineis, o efeito de carga limpava
selecao. Em vez de arrastar esse estado para dentro dos hooks, eles recebem
callbacks (`onDisconnected`, `onMailboxChanged`) e o dashboard continua dono do
que e dele.

**Callbacks em ref dentro do `useMailbox`.** Se entrassem como dependencia dos
`useCallback`, `fetchMessages` seria recriado a cada render do dashboard e o
efeito principal dispararia um loop de requisicoes ao Gmail.

**Componentes recebem JSX pronto quando o conteudo e de outro dominio.** O
painel da Nora entra no `ComposeModal` e no `MailReplyBox` como `ReactNode`;
a caixa de resposta entra no `MailMessageDetail` do mesmo jeito. Assim a janela
de redacao nao precisa conhecer o estado da Nora para renderizar um trecho dela.

**Prompts separados do hook.** `noraPrompts.ts` guarda os literais que definem o
comportamento do modelo. Em modulo proprio da para testa-los sem simular rede, e
mudar uma instrucao fica visivel no diff.

## Codigo morto removido

`EmailList.tsx`, `EmailSidebar.tsx`, `EmailContent.tsx` e `EmailTabs.tsx` - 288
linhas sem nenhum import no projeto. O `Nora.tsx` define seu proprio
`EmailContent` local, entao nem esse era usado. Tambem saiu o `Card.tsx` do kit
compartilhado, com zero usos.

## Comportamentos que a extracao tornou explicitos

Coisas que o codigo ja fazia mas ninguem tinha escrito, agora cobertas por teste:

- Marcar a caixa de selecao ou clicar na estrela **nao** abre a mensagem
  (`stopPropagation` na linha da lista)
- Pasta virtual so fica ativa quando nenhum filtro rapido esta aplicado
- Prefetch de caixa dispara tambem no foco por teclado, nao so no mouse
- Rascunho digitado nao pode ser perdido quando o envio falha
- "Aceitar sugestao" continua liberado mesmo com outra geracao em andamento -
  travar faria o usuario perder um texto ja pronto na tela
- O `<iframe>` do corpo mantem `sandbox=""`: HTML vem do remetente e nao pode
  executar script
- `clearMailboxCacheForUser("u1")` nao pode apagar as entradas de `u10`
- Precedencia do conteudo: `bodyText > snippet > bodyHtml`

## Acessibilidade corrigida no caminho

Cinco botoes so-icone nao tinham rotulo e eram invisiveis para leitor de tela.
Ganharam `aria-label` ou `sr-only` ao serem extraidos: fechar modal, remover
anexo, enviar a Nora, anexar arquivo (redacao e resposta) e o textarea da
sugestao.

Nao e coincidencia que so apareceram agora - num arquivo de 2.257 linhas
ninguem revisa o JSX inteiro de uma vez.

## Pendencias conhecidas

**Preferencias nao persistem em aba oculta.** `useMailPreferences` marca o fim
da leitura inicial dentro de um `requestAnimationFrame`, que nao dispara quando
a aba esta em segundo plano (`visibilityState: "hidden"`). Enquanto isso, o
efeito de gravacao fica bloqueado e nada e salvo.

O padrao e pre-existente (o codigo original usava o mesmo `requestAnimationFrame`)
e foi preservado aqui para nao misturar mudanca de comportamento com refatoracao.
Confirmado no navegador: com a aba oculta, `rAF` nunca dispara e o `localStorage`
nao recebe as preferencias.

**Saudacao estranha no fallback da Nora.** Sem nome do remetente, o texto sai
como "Ola, tudo." - o fallback `"tudo bem"` e cortado no primeiro espaco pelo
`split`. Preservado e registrado em teste com comentario.

Ambas merecem correcao, mas em mudanca de comportamento propria.

## Limitacao da verificacao

A lista de mensagens e a leitura do e-mail nao puderam ser conferidas na tela: a
conta de teste local nao tem Gmail conectado, e o app renderiza o estado
"Conectar Gmail". Por isso esses dois componentes concentram 48 testes, cobrindo
os estados que a verificacao visual nao alcanca.
