# Backup e restauração do Norium

O backup operacional cobre todo o volume `NORIUM_DATA_DIR`: bancos JSON, anexos,
subworkspaces e bancos SQLite. A exportação `/api/operacoes/backup` continua sendo
uma cópia portátil e redigida para o usuário; ela não substitui recuperação de
desastre.

## Objetivos

- RPO máximo: 24 horas para o volume Azure Files e 5 minutos para PostgreSQL.
- RTO alvo: 4 horas, incluindo restauração, verificação e smoke autenticado.
- Retenção: 35 dias no PostgreSQL e 30 dias para snapshots do compartilhamento.
- Toda cópia exportada do ambiente deve ser criptografada antes da transferência.

`backup_archive.py` cria um pacote completo autenticado com Fernet. Bancos SQLite
são copiados pela API de backup do SQLite. A restauração exige diretório vazio,
valida caminho, tamanho e SHA-256 de cada arquivo e executa `PRAGMA integrity_check`.
Use uma chave exclusiva no secret manager como `NORIUM_BACKUP_KEY`; nunca grave a
chave, o pacote descriptografado ou dados do cliente em artefatos de CI.

O ensaio trimestral deve restaurar em ambiente isolado, executar a verificação do
arquivo, iniciar uma única réplica com integrações externas desabilitadas e validar
login, workspace secundário, anexo e ledger SQLite. Registre apenas contagens,
hash do pacote, duração, revisão e resultado. Uma falha bloqueia o lançamento até
novo ensaio aprovado.
