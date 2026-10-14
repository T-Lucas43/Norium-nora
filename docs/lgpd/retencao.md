# Tabela de retenção — política proposta, desativada por padrão

`NORIUM_RETENTION_ENABLED=0` desliga a manutenção por idade. Habilitar exige
aprovação da política e backup verificado. Definir qualquer prazo abaixo como
`0` desliga essa categoria. Timestamp inválido/ausente preserva o registro.
Execução por hora (`PRIVACY_MAINTENANCE_INTERVAL_SECONDS`, mínimo 300 s), com
lotes limitados. Não foi ativada em homologação ou produção nesta implementação.

| Categoria | Variável | Padrão proposto |
|---|---|---|
| Conversas e contexto da Nora | NORIUM_RETENTION_NORA_DAYS | 365 dias |
| Histórico de mensagens WhatsApp | NORIUM_RETENTION_WHATSAPP_DAYS | 180 dias |
| Cache de mídia WhatsApp | NORIUM_RETENTION_MEDIA_DAYS | 90 dias |
| Uploads genéricos | NORIUM_RETENTION_UPLOADS_DAYS | 365 dias |
| Logs técnicos | NORIUM_RETENTION_SYSTEM_LOGS_DAYS | 90 dias |

Anexos comerciais de tarefas/financeiro/equipe seguem o registro proprietário e
entram na quota; a retenção genérica não apaga documentos de negócio ativos por
idade. Workspace excluído é bloqueado imediatamente e purgado após 30 dias.
Conta excluída segue revogação/purga sem prazo automático inventado. Recibos de
envio e tombstones opacos não são removidos por manutenção para evitar duplicação.

Backups: a organização deve aprovar prazo e calendário real. RPO e RTO em
`docs/operations/backup-and-restore.md` são metas, não SLAs comprovados. Registrar
exclusões em cópia separada atual; reaplicar antes de qualquer restauração voltar
ao serviço. Exceções fiscais, obrigação legal e defesa de direitos exigem análise.
