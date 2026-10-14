# Backup e restauração — Shard Cloud e PostgreSQL

O runtime de homologação usa VPS Shard Cloud, PostgreSQL e volume persistente.
Backup operacional cobre PostgreSQL inteiro e `NORIUM_DATA_DIR`: uploads, SQLite
remanescente e arquivos. Exportação redigida do titular é portabilidade e não
recuperação de desastre. Instruções históricas de Azure não se aplicam ao deploy.

## Metas e aprovação

- RPO proposto: até 24 horas para volume e até 5 minutos para PostgreSQL, se
  backup incremental/PITR for contratado e configurado pelo operador.
- RTO alvo: 4 horas, incluindo restauração, reaplicação de exclusões, readiness e
  smoke autenticado. Ensaio sintético local não confirma esse SLA.
- Retenção proposta de backup: 35 dias; confirmar contrato, calendário e política.
- Toda cópia fora do host deve ser criptografada e ter acesso restrito.

## Procedimento de recuperação

1. Registrar revisão/digest ativos; bloquear escritores durante snapshot
   consistente de PostgreSQL e volume. Preservar o backup anterior.
2. Produzir `pg_dump -Fc --no-owner --no-acl` ou snapshot/PITR do provedor; copiar
   volume usando API de backup SQLite. `infra/azure/backup_archive.py` permanece
   utilitário genérico de pacote Fernet autenticado; seu nome é histórico.
3. Guardar `NORIUM_BACKUP_KEY` no secret manager; nunca no pacote, CI ou conversa.
   Validar tamanho, hash, manifesto e integridade antes da transferência.
4. Restaurar em banco e diretório vazios, isolados, com workers e integrações
   externas desativados. Comparar contagem/digest de tabelas e hashes do volume.
5. Recuperar o ledger atual de exclusões, separado do snapshot antigo. Configurar
   `NORIUM_DELETION_LEDGER_PATH` protegido fora da rotação dos backups. Contém
   apenas IDs opacos, workspace e instante; sem nome, e-mail ou token.
   Em ambiente compartilhado a ausência da configuração bloqueia exclusão; o
   caminho deve ficar fora de `NORIUM_DATA_DIR`, em volume protegido próprio.
   O utilitário de backup exclui ledgers e restauração recusa ledger antigo.
6. Diagnosticar com `scripts/reapply_privacy_deletions.py --ledger <ledger-atual>`;
   aplicar somente no restore isolado com `--apply --isolated-restore`. Reaplica
   eliminação física e sessão/cadastro bloqueados, sem chamar Google. Provar que
   titulares excluídos não voltaram e que um vizinho continua intacto.
7. Iniciar uma réplica da imagem aprovada; verificar `/health/ready`, driver
   PostgreSQL, anexos, autorização e login. Registrar apenas hashes, contagens,
   duração, revisão, resultado e limites da evidência.
8. Promover com aprovação humana e gates completos. Eliminar temporários e chave
   efêmera do ensaio; guardar backups conforme política aprovada.

## Ensaio local

`python scripts/run_backup_restore_pg.py` usa `postgres:16` disponível localmente,
container exclusivo sem porta/rede externa e volume tmpfs. Gera fixture sintético,
dump criptografado e pacote uploads/SQLite, restaura em banco isolado, compara
hashes/contagens, mede tempo e reaplica exclusão posterior ao snapshot. Remove
somente seus temporários/container. Recibo sanitizado em
`output/pos-correcao/fase7-backup-restore.json`.

Não substitui PITR, restauração real de todo o volume Shard, verificação de
contratos de backup ou smoke autenticado do ambiente publicado.
