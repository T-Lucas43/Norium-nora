# Release e rollback — GitHub e Shard Cloud

GitHub é fonte e produtor da imagem imutável. CI deve concluir validação,
PostgreSQL, chamadas reais de browser, segurança da imagem e artefato de fonte.
Console autenticado Shard pode transportar essa mesma imagem aprovada, verificando
hashes das partes/arquivo e camadas. Não reconstruir código na VPS.

Antes da promoção registrar container/imagem anterior e políticas; fazer backup
fresco de PostgreSQL e volume; provar restore isolado com contagens e hashes.
Preservar secrets, volume, proxy, rede, sessões e rollback. Não imprimir conteúdo
privado, configuração completa ou credenciais.

Parar escritores para troca e manter container anterior recuperável. Novo runtime
usa uma réplica, UID não root, rootfs readonly, CapDrop ALL, seccomp e
no-new-privileges. Readiness confirma PostgreSQL e revisão; health prova liveness.
Confirmar release público e smoke humano autenticado.

Falha nos gates da promoção restaura container anterior com a mesma configuração,
volume e digest e verifica readiness. Status continua falho se rollback não
concluir. Trocar imagem não desfaz dados; migração incompatível precisa estratégia
reversa previamente revisada e restauração provada.

Restauração não pode ressuscitar dados excluídos: reaplicar ledger atual de
exclusões conforme `backup-and-restore.md` antes de reabrir acessos; manter
workers/integrações desligados no banco restaurado até concluir.

Alertas do operador devem cobrir readiness, reinícios, HTTP 5xx, latência,
capacidade, filas e falha de backup. Plantão e SLA são configurações externas a
confirmar; não inventar contato no repositório. RTO real de rollback/restore deve
ser medido em ensaio aprovado, com evidência minimizada.
