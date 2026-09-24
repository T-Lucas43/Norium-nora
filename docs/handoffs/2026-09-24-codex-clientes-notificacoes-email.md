# Entrega Codex — compartilhamento de clientes e alertas por e-mail

Data: 2026-09-24

## Escopo autorizado

- Adicionar compartilhamento de clientes seguindo o modelo de Documentos.
- Permitir acesso por equipe inteira ou por pessoa, com níveis de visualização e edição.
- Tornar as notificações automáticas por e-mail configuráveis por usuário para reuniões agendadas, lembretes, tarefas próximas do vencimento, menções no chat, contas a pagar e acompanhamentos de clientes.
- Publicar a entrega na branch principal e implantar no ShardCloud.
- Executar diretamente com Codex, sem Muse.

## Resultado implementado

- Clientes antigos permanecem privados por padrão e o proprietário controla o compartilhamento.
- Usuários com visualização podem consultar a ficha, documentos, contratos e histórico; usuários com edição também podem alterar a ficha e seus vínculos; exclusão e alteração de acesso continuam exclusivas do proprietário.
- Preferências de e-mail são persistidas por usuário e verificadas novamente no momento da entrega.
- A fila automática cobre reuniões criadas na Agenda, reuniões da equipe e agendamentos públicos, lembretes de reunião, tarefas vencendo hoje ou amanhã, menções no chat, contas a pagar vencendo hoje ou amanhã e acompanhamentos de clientes nas próximas 24 horas.
- Mensagens comuns do chat não geram e-mail; somente menções geram o alerta específico.
- `Dockerfile.shard` mantém o runtime imutável em `/opt/norium`, separado do mount persistente `/app/data`, para que o deploy no ShardCloud não oculte `main.py`.

## Evidências locais

- Backend: 92 testes integrados de clientes, e-mail, menções, agendamentos, agenda, escopo de tarefas, idempotência e autorização financeira passaram.
- Frontend: 13 testes focados de Clientes e preferências de e-mail passaram.
- `npm run build` passou, incluindo o orçamento de bundles.
- `npm run lint` passou sem erros; permanecem apenas avisos preexistentes fora do escopo.
- QA visual autenticada em navegador local: tela de Clientes, diálogo de compartilhamento e categorias de e-mail renderizaram corretamente; a preferência de menção foi desativada, salva, recarregada e reativada com persistência confirmada; nenhum erro de console foi registrado.

## Segurança e dados

- A leitura de clientes compartilhados percorre apenas membros ativos e visíveis da mesma equipe.
- As respostas de contratos vinculados usam uma lista explícita de campos e não expõem o documento comercial completo.
- Os e-mails automáticos não copiam conteúdo privado de chat, e-mail ou WhatsApp; direcionam o usuário autenticado ao Norium.
- A entrega não cria migração destrutiva e preserva os dados existentes do ambiente.

## Publicação

- Branch de trabalho: `codex/client-sharing-email-alerts`.
- O commit, push em `main`, execução do pipeline e verificações do ShardCloud serão registrados na conclusão da tarefa.
