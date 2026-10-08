# Expansão da Nora — 08/10/2026

Autorização: implementar o plano, publicar em main e fazer deploy na VPS atual.

Base: 086de0749a3f5888c7866ff1008ec64d582b8f05, conferida contra main pelo conector GitHub.

Checkout original preservado; execução em worktree isolado, branch `codex/nora-expansion-20261008`.

## Entrega

- Opções continuar/cancelar/resposta livre dentro da mensagem, com escolha salva e sem usar essas opções como autorização de envio.
- Estilos por conversa e busca fundamentada nos títulos/prévias do histórico privado.
- Foco discreto nos campos da Nora, mantendo indicação de teclado.
- Trabalhos Gmail com paginação, checkpoint, pausa, retomada, limite ampliável, falhas explícitas, análise opcional de trechos e relatório Markdown real.
- Campanhas individuais com personalização, prévia por destinatário, anexos da biblioteca ligados ao hash, teste para si com aprovação separada, confirmação exata, limite de 100 tentativas/dia por conta e reconciliação sem reenvio.
- Novas ferramentas do catálogo governado: email_query, email_read, mailbox_start, history_search e workspace_query. Reutilizam serviços e permissões dos módulos.
- Automação nativa prepara trabalho de leitura revisável dos últimos 1 dia, até 100 mensagens. Não lê nem envia automaticamente ao preparar.
- Retenção de conteúdo dos trabalhos por sete dias, aplicada no acesso ao domínio. Recibos minimizados permanecem; envios incertos preservam sua referência para reconciliação.

## Limites operacionais

- A leitura/execução desta central avança em chamadas autenticadas enquanto sua interface está acompanhando o trabalho; fechar a área interrompe próximos passos e preserva o checkpoint. A ferramenta de leitura não depende de ativar um novo worker.
- Até 500 destinatários por campanha, 8 anexos/18 MB; sem comprovação de abertura/entrega. Corpo analisado limitado a 4.000 caracteres, anexos não analisados, até 100 lotes de IA; relatório expõe a cobertura.
- Caixa inteira percorre páginas até o orçamento escolhido, com opção de ampliá-lo até 50.000 mensagens. Não há truncamento silencioso.
- Catálogo do cérebro só é executável quando seus pré-requisitos existentes estiverem configurados; esta entrega não provisiona infraestrutura adicional nem faz disparos reais de smoke.
- Sincronização contínua por history/watch e execução sem interface permanecem fora deste piloto. Não são anunciadas como ativas.

## Validação

- Snapshot inicial da implementação: 1.338 testes backend, zero falhas/erros/skips, execução em cópia temporária sem dotenv e sem sockets externos.
- Snapshot inicial frontend: 829 testes em 134 arquivos, zero falhas.
- Após os ajustes finais: 19 regressões do domínio Gmail, minimização financeira e consolidação passaram; 43 testes focados de Gmail/conversa e 11 testes de controles, revisão e workspace passaram.
- TypeScript, Vite e orçamento de bundle passaram. Bandit nas novas fontes passou com o nível exigido. Diff sem erros de whitespace.
- CI e smokes da mesma revisão publicada ainda pendentes; atualizar este handoff com os recibos após a publicação.

## VPS

Destino conferido ao vivo: `homologacao.norium-ai.com`, VPS `norium-homologacao` do painel Shard.
Release atual observado antes da troca: `086de0749a3f5888c7866ff1008ec64d582b8f05`.
Console autenticado disponível. A aplicação usa `/srv/norium/data`, uma instância API, UID10001 e rootfs somente leitura.
Preservar volumes, variáveis/segredos e proteções da configuração existente. Nenhuma migração de dados é necessária para estes contratos aditivos.
