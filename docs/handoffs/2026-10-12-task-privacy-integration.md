# Integracao da privacidade e fila de chamadas - 12/10/2026

## Estado e autorizacao

Usuario aprovou PR52 nesta conversa. Merge3f6b6622e95470c523fe0c84e3ff74d9baa73578 em2026-10-12T16:59:27Z, preservando mainccfb058 e PRs53-56 (agendamentos/fotos/voz/deploy). Comparacao independente sem incompatibilidade concreta;64 regressoes de privacidade PASS. Checkout principal C:/NOrium e suas alteracoes preexistentes preservados; trabalho no worktree gerenciado shardcloud-smoke-fixes. Nova correcao abaixo ainda exige revisao humana antes de integrar/publicar.

CI do merge38281209049: backend1441 PASS, frontend139 arquivos/857 PASS, empacotamento48 PASS, PostgreSQL e imagem PASS. Chamadas FAIL pelo LOAD:heartbeatp95890.4ms>750ms; pacoteSKIPPED/deploySKIPPED. Browser43/45, dois transientes distintos(call_studio e simultaneous_offer rep3), blockingFailed0 pela politica existente. Nao afirmar midia resolvida ou45/45.

## Causa medida e correcao local

Carga isolada sequencial manteve25 equipes x4 participantes x3 repeticoes e750ms. Heartbeatp95:3f6b662958.455ms;ccfb058948.610ms;758277f967.310ms. Falha preexistente nesta maquina, sem regressao especifica demonstrada da PR52. Perfil duravel mediu2954 aquisicoes por1477 heartbeats, espera media106.155ms por aquisicao e retencao4.788ms. Fila global soma cerca212ms/heartbeat versus9.6ms de trabalho sob lock. Fsyncmedio0.530ms; omiti-lo somente no harness descartavel reduziu947.301 para875.130ms e continuouFAIL. Essa experiencia diagnostic-only nunca foi aceita como gate.

O novo diff substitui o mutex global por locks fracos derivados do caminho normalizado do documento (incluindo workspace), sem consultar existencia local antes da persistencia. Chat, chamadas, gravacoes e autorizacao do estudio usam a mesma chave para o mesmo documento. Escritas de JSON aguardam o worker real mesmo apos cancelamentos repetidos. Fsync, repositorio PostgreSQL, autorizacao, ACL, protocolo, frequencia, timeouts e limites de carga permanecem. Nao mudou SDP/ICE, frontend, dependencias ou schema.

## Evidencia da candidata local

-191 regressoes afetadas PASS, zero falhas/erros/skips; incluem64 de privacidade e7 novos testes de concorrencia, workspace/alias e cancelamento de fsync real.
-LOAD25x4x3 com fsyncREAL PASS:heartbeatp95530.143ms/p99548.633, controlep95427.770, sinalp9516.193;100 conexoes retidas, zero violacoes, ghostmax9.023s. Fontes congeladas e hashes registrados no recibo.
-Suite backend completa:1448 PASS, zero falhas/erros/skips,179.750s. Fonte/dados descartaveis, dotenv desativado e sockets externos bloqueados. Output do worktree:output/pos-correcao/document-lock-final-full-20261012.json/.log.
-Frontend identico ao merge:857 testes CI PASS, npm.cmd run build Windows PASS apos npm.cmd ci pelo lock atual. Primeira tentativa local sem a nova fonteInter instalada falhou; log preservado. Nenhum lockfile alterado.
-Standards e Spec independentes:zero achados ativos. Spec confirmou os7 testes relevantes. Garantia de cancelamento cobre documentosJSON; workers de upload/movimentacao de midia possuem limite preexistente fora deste diff. Nao alegar protecao geral de todoI/O.
-git diff --check PASS. CI dos cinco gates do novo SHA continua obrigatoria antes de integrar/promover.

Recibos locais em C:/NOrium/.tmp-tests/privacy-live-vps-2026-10-09-163745:document-lock-regression-20261012.json;document-lock-load-20261012.json;local-load-comparison-20261012.json;call-heartbeat-causal-summary-20261012.json;integrated-build-after-dependencies-20261012.json;ci-integrated-3f6b662.json. Evidencia original do incidente e falhas anteriores preservadas.

## Publicacao e limites

Nao houve nova publicacao, restart, migracao, reset, envioSMTP, alteracao de rede/plano ou remediacao historica. A API de homologacao recusou conexao em12/10; tela de login renderizada nao prova liveness. PainelShard exige login e pergunta de acesso foi enviada ao usuario. Bloqueio network limit confirmado em10/10 e historico; causa atual da indisponibilidade nao foi confirmada no painel.

Imagem auditada do merge3f6 baixada e conferida localmente:IDsha256:8ddb983b12f396cb1179842f3c74b6a2ba3df8c8ba225848786f896309075542;arquivo7f0bd8a5262edfcd41f3ebc61a00213634d19d45bbd9911adee35d18589e8522. Essa imagem nao contem esta correcao e nao deve ser reutilizada. Sem novo pacote aceito do merge pois gate de carga bloqueou. Nova revisao exige nova imagem/pacote do SHAexato aprovado de main e todosgatesDEPLOY_SHARDCLOUD.md.

Aceite completo=false. Acesso ao painel, preflight de dados/backup/rollback, sessoes exclusivas, privacidade publicada em quatroperfis, WebSocket, TURN/midia/sons, SMTP/recuperacao/OAuth e logs sanitizados permanecem pendentes. Nao expandir para producao nem ativar fases6/7. Qualquer remediacao historica continua proposta para revisao humana; dados/evidencias nao excluidos.
