# Automações por eventos

O editor oferece 11 eventos: WhatsApp recebido; mensagem ou menção no chat da equipe; e-mail recebido; tarefa criada, atualizada ou comentada; lançamento financeiro criado ou atualizado; compromisso criado ou atualizado.

No bloco de gatilho, selecione o evento, configure os filtros e marque **Executar automaticamente ao receber este evento**. Salve o fluxo ativo. O backend registra a data de ativação; eventos anteriores não executam. Fluxos existentes não recebem ativação automática por migração.

As ações de mensagem aceitam contato ou número com DDI/DDD no WhatsApp e equipe geral, membro ou subequipe no chat. Os destinos são verificados com as permissões da conta. Simulação não envia mensagens.

## Eventos e histórico

- WhatsApp depende dos eventos recebidos pela integração conectada.
- Gmail dispara quando uma mensagem nova é sincronizada, não por um serviço adicional de polling.
- Agenda contempla criação e alteração pelo Norium; sincronizar eventos antigos não dispara o fluxo.
- Filtros: origem, remetente, subequipe, projeto e texto contido no título/descrição do evento.
- O histórico mostra o evento de origem e a fila de disparos. Fluxos com aprovação obrigatória não executam automaticamente.

## Operação

O lifespan do backend inicia o worker. A fila SQLite fica em `NORIUM_DATA_DIR/automation_events.sqlite3` (ou no diretório de dados padrão). O volume deve ser persistente. As chaves incluem conta, workspace, automação, tipo de evento e identificador do evento/mensagem. Processos que compartilham esse arquivo reivindicam cada item por transação; réplicas com volumes separados não compartilham deduplicação.

Eventos produzidos durante a execução não iniciam novos fluxos. Mensagens de saída do WhatsApp e mensagens do próprio usuário no chat são ignoradas. Alterar/desativar um fluxo cancela itens pendentes da versão anterior.

Não existe repetição automática de envios com falha ou resultado desconhecido. O worker renova a reserva a cada 15 segundos; após 90 segundos sem renovação, o item é marcado como interrompido. Confira o canal antes de repetir manualmente um envio interrompido. Não há garantia de entrega exatamente uma vez entre o banco e um provedor externo.

## Validação

Testes usam diretórios temporários e serviços de envio simulados. A prévia visual usa componentes isolados; a sessão autenticada e mensagens reais não fazem parte dessa validação. Agendamento por horário, endpoints de webhook genéricos e ações antigas sem implementação não foram adicionados neste trabalho.
