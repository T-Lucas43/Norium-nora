# Anexos na prévia de e-mail da Nora — 13/10/2026

## Pedido e estado

Adicionar à própria prévia do e-mail a opção de selecionar arquivos, exibir os
nomes anexados e preparar novamente a aprovação sem enviar a mensagem. Estado:
implementado localmente na branch `codex/novas-funcionalidades-20261012`, sem
push, PR ou deploy desta alteração.

## Comportamento

- O cartão de aprovação de envio de e-mail mostra os anexos atuais e o botão
  **Anexar arquivos**. Ele aparece somente para uma aprovação pendente com uma
  sessão de rascunho vinculada.
- O seletor usa a sessão indicada pelo payload exato da aprovação. Os arquivos
  passam pelo endpoint autenticado de arquivos da Nora e são resolvidos pelo
  backend como arquivos pertencentes ao usuário.
- Até 8 arquivos e 24 MB no total. Cada aprovação inclui IDs, tamanho e SHA-256
  dos anexos; qualquer edição gera novo digest e nova aprovação.
- A aprovação anterior só sai do chat quando a nova prévia é preparada. Enquanto
  o upload ocorre, Permitir e Negar ficam desativados. O envio continua exigindo
  clique explícito em **Permitir esta ação** no cartão atualizado.
- Nenhum e-mail real foi enviado nesta implementação.

## Arquivos

- `norium-front-end/src/components/nora/NoraApprovalCard.tsx`
- `norium-front-end/src/components/layout/Nora.tsx`
- `norium-front-end/src/components/nora/NoraApprovalCard.test.tsx`
- `norium-back-end/app/services/email_agent.py`
- `norium-back-end/tests/unit/test_nora_email_approvals.py`

## Evidências locais

- Vitest focado no cartão: 12/12 testes passaram com um worker de threads. A
  primeira tentativa usando workers `forks` expirou antes de carregar testes.
- `npm run build`: TypeScript, Vite e orçamento do bundle passaram.
- `npm run lint` nos três arquivos de interface: código de saída 0; dois avisos
  em `NoraApprovalCard.tsx` (export não componente) e `Nora.tsx` (dependência de
  hook), fora das linhas introduzidas.
- AST Python passou para `email_agent.py` e `test_nora_email_approvals.py`.
- O teste backend de substituição da aprovação não pôde ser executado: o Python
  disponível não tem `pytest`; via `unittest`, a importação do router parou por
  ausência de `httpx`. Não contar esse teste como aprovado.
- CI do GitHub, scan de segurança e smoke autenticado do novo fluxo ainda não
  foram executados.

## Revisão e próximo gate

`docs/AI_GOVERNANCE.md`, Processo obrigatório item 5, exige aprovação humana para
código crítico. Esta mudança mexe na preparação e no digest de uma autorização
para envio externo. A aprovação anterior do usuário cobriu o hotfix de tokens e
pré-preenchimento; ela não cobre esta mudança nem as rotinas críticas pendentes
das fases 6/7.

Antes de promover, o responsável deve revisar a mudança, executar/aguardar os
gates do GitHub e confirmar que a prévia exibe os arquivos, que editar anexos
substitui o cartão anterior e que nenhum envio ocorre antes de Permitir. Usar
GitHub como origem do deploy para homologação e manter rollback conforme o
procedimento do projeto.
