# Release, observabilidade e rollback

O release publica imagem imutável, registra a imagem ativa anterior e mantém uma
única revisão e réplica. Readiness verifica leitura/escrita/fsync e espaço no
volume, além do PostgreSQL da Nora quando habilitado. Liveness continua leve em
`/health` para não reiniciar uma instância por falha transitória de dependência.

Qualquer gate posterior ao deploy que falhar aciona o passo final de rollback. O
workflow reaplica a imagem imutável anterior, mantém uma réplica, espera
`/health/ready` e confirma que a referência ativa voltou exatamente à imagem
registrada. Se o rollback falhar, o job permanece vermelho e exige intervenção.

Antes de uma migração incompatível, o operador deve provar restauração do backup
e preparar uma migração reversa; a troca de imagem não reverte dados. O ensaio
trimestral usa staging, provoca uma falha de smoke sintética, confirma a volta da
imagem e mede o RTO. Registre somente revisão, digests, duração e resultado.

Os diagnósticos autenticados expõem erros e p95 por integração. A operação deve
encaminhar logs do Container Apps a um workspace externo e manter alertas para
readiness, HTTP 5xx, latência, capacidade do volume, filas e falha de backup. O
destinatário de plantão é configuração externa obrigatória e não deve ser
inventado no repositório.
