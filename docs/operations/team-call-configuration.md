# Matriz operacional das chamadas de equipe

Fonte de verdade: `app/modules/team/{call_configuration,call_release,turn_credentials,sfu_tokens,recording_coordinator}.py` e `.github/workflows/azure-container-apps.yml`. Nenhuma variável desta matriz usa prefixo `VITE_`, build arg ou armazenamento do navegador.

## Flags e capacidade

`TEAM_CALL_RELEASE_PROFILE`: GitHub Variable com valores `public` (default) ou `internal-test`. A seleção explícita `internal-test`, autorizada em 2026-09-08, adia os três requisitos externos da [lista de lançamento público](team-call-public-launch-checklist.md). Nesse perfil, o workflow mantém `ENVIRONMENT=production`, habilita mesh para as contas autenticadas de teste (percentual default 100, salvo override explícito), desabilita TURN obrigatório e o endpoint de scrape sem token, e mantém gravação/SFU desligadas. Perfil inválido falha no preflight. Voltar a `public` restaura todas as exigências externas; não alterar `ENVIRONMENT` para contornar controles de segurança.

| Variável backend | Default local/teste | Default produção/staging | Validação / uso |
| --- | --- | --- | --- |
| `TEAM_CALL_ENABLED` | `true` | `false` | Booleano estrito; autoriza criar chamadas novas. `false` prevalece sobre a lista interna |
| `TEAM_CALL_ROLLOUT_PERCENT` | `100` | `0` | Inteiro 0–100; bucket SHA-256 estável por equipe, crescente entre percentuais |
| `TEAM_CALL_INTERNAL_TEAMS` | vazio | vazio | IDs de equipe separados por vírgula; máximo 8.192 caracteres; nunca enviados à telemetria |
| `TEAM_CALL_RECORDING_ENABLED` | `true` | `false` | Bloqueia novos uploads; completar/abortar gravações existentes continua possível |
| `TEAM_CALL_MESH_MAX_PARTICIPANTS` | 6 | 6 | Inteiro 2–12; perfil de lançamento fixa 6; capacidade fica persistida na chamada |
| `TEAM_CALL_MAX_ACTIVE_PER_TEAM` | 8 | 8 | 1–100; admissão atômica |
| `TEAM_CALL_MAX_ACTIVE_TOTAL` | 100 | 100 | 1–1.000; contagem de chamadas carregadas no processo; não representa capacidade comprovada de mídia |
| `TEAM_CALL_MAX_SOCKETS` | 1.000 | 1.000 | 100–5.000; conecta somente dentro da quota |
| `TEAM_CALL_MAX_SOCKETS_PER_TEAM` | 100 | 100 | 4–1.000 |
| `TEAM_CALL_MAX_SOCKETS_PER_USER` | 4 | 4 | 2–16; aceita troca de aba dentro da quota |
| `TEAM_CALL_METRICS_TOKEN` | vazio | vazio | Segredo dedicado, mínimo 32 caracteres ASCII sem espaços; sem valor o endpoint responde 404 |
| `WEB_CONCURRENCY` | 1 | 1 | Exigência do lançamento; JSON, tickets, locks e presença são locais ao processo |

Ambiente compartilhado usa a classificação canônica de `app/core/tenant.py`. `ENVIRONMENT=test` junto de `APP_ENV=production` continua fechado. Flags de ambiente não são controle remoto em tempo real: mudar variáveis na Azure cria uma revisão e pode interromper sessões. Planejar drenagem/janela de manutenção. O rollout é por equipe dentro de uma única revisão, nunca por divisão de tráfego entre réplicas.

Mensagens WebSocket: máximo 120.000 caracteres; orçamento por conexão de 240 eventos em rajada, reposição de 60/s; excesso encerra com 1008. Telemetria: rajada de 20 amostras, reposição de uma a cada 3 s, payload fechado e duração de 0–120.000 ms. Nenhuma dimensão de métrica aceita IDs arbitrários. O limite da aplicação ocorre depois da recepção do frame; o servidor WebSocket também deve limitar o frame na borda.

## ICE e SFU

| Variável | Default / validação | Perfil de lançamento |
| --- | --- | --- |
| `TEAM_CALL_TURN_REQUIRED` | `false`; configuração parcial falha no startup | `true` |
| `TEAM_CALL_STUN_URLS` | Google e Cloudflare, CSV | Descoberta STUN opcional; não substitui a prova TLS |
| `TEAM_CALL_TURN_URLS` | vazio; pelo menos um `turns:` quando configurado | Somente `turns:host:443?transport=tcp`, certificado confiável e acesso externo real |
| `TEAM_CALL_TURN_SHARED_SECRET` | vazio; mínimo 32 caracteres ASCII sem espaços | Segredo GitHub → secretref Azure `team-call-turn`; mesmo segredo no TURN REST |
| `TEAM_CALL_TURN_TTL_SECONDS` | 600; 60–3.600 s | Credencial curta por usuário/equipe autenticados |
| `TEAM_CALL_TURN_REFRESH_MARGIN_SECONDS` | 120; mínimo 15, menor que TTL | Renovação em memória |
| `TEAM_CALL_SFU_ENABLED` | `false` | Obrigatoriamente `false` até controle de revogação server-side e webhooks |
| `TEAM_CALL_LIVEKIT_URL` | vazio; `wss:` | Não configurar para este lançamento |
| `TEAM_CALL_LIVEKIT_API_KEY` | vazio; somente backend | Não configurar |
| `TEAM_CALL_LIVEKIT_API_SECRET` | vazio; mínimo 32 caracteres | Não configurar |
| `TEAM_CALL_SFU_TOKEN_TTL_SECONDS` | 300; 60–600 s | Sem emissão no perfil mesh |

O backend devolve credenciais TURN/LiveKit efêmeras somente depois da autorização. Respostas de credencial usam `no-store, private`; o snapshot público não contém segredo permanente. O adapter LiveKit desativa os logs do SDK; os erros são contados apenas em categorias normalizadas. A implementação SFU permanece dormente conforme o ADR 0002.

## Gravação, retenção e disco

Todas as variáveis abaixo aceitam somente inteiro positivo, até quatro vezes o default; valor inválido interrompe startup. O lançamento mantém os defaults e **novas gravações desabilitadas**. Aumentar limites exige medir recursos e revisar a política de retenção; o teto de parsing não é uma promessa de capacidade.

| Variável | Default |
| --- | ---: |
| `TEAM_RECORDING_MAX_CHUNK_BYTES` | 16.777.216 |
| `TEAM_RECORDING_MAX_TOTAL_BYTES` | 536.870.912 |
| `TEAM_RECORDING_MAX_DURATION_SECONDS` | 21.600 |
| `TEAM_RECORDING_MAX_CONCURRENT_PER_TEAM` | 2 |
| `TEAM_RECORDING_MAX_TEAM_BYTES` | 2.147.483.648 |
| `TEAM_RECORDING_REQUEST_LIMIT` | 60 |
| `TEAM_RECORDING_REQUEST_WINDOW_SECONDS` | 60 |
| `TEAM_RECORDING_RETENTION_HOURS` | 24 |
| `TEAM_RECORDING_ORPHAN_GRACE_SECONDS` | 600 |

`TEAM_RECORDING_MAINTENANCE_INTERVAL_SECONDS`: default 60 s, mínimo efetivo 5 s. A limpeza inclui diretórios persistidos de equipes que já não possuem contas no diretório atual. Um erro em uma equipe não impede tentativas nas demais; qualquer leitura incompleta impede a varredura de órfãos naquele ciclo. Arquivos cujo delete falhou permanecem marcados para nova tentativa; só `filesDeletedAt` confirma exclusão. O download de gravação expirada é recusado mesmo com a manutenção indisponível. Azure Files deve permanecer montado em `/app/data`; snapshots/backups precisam obedecer a uma política de expurgo separada, ainda não verificada neste ambiente.

## Configuração externa do lançamento

GitHub Variables: `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `AZURE_CONTAINER_APP_NAME`, `AZURE_RESOURCE_GROUP`, `AZURE_PUBLIC_URL`, `TEAM_CALL_ENABLED`, `TEAM_CALL_ROLLOUT_PERCENT`, `TEAM_CALL_INTERNAL_TEAMS`, `TEAM_CALL_SMOKE_TEAM_ID`, `TEAM_CALL_TURN_URLS`.

Atestados operacionais obrigatórios (default fechado): `TEAM_CALL_METRICS_COLLECTOR_READY=true`, `TEAM_CALL_ALERT_RECEIVER_READY=true`, `TEAM_CALL_ALERT_TEST_DELIVERED=true` e `TEAM_CALL_OBSERVABILITY_EVIDENCE_URL` com uma referência HTTPS concreta. O responsável deve registrar coleta autenticada, receptor, horário e entrega do alerta de teste antes de preencher esses campos. O preflight verifica a presença/formato desses atestados; não verifica automaticamente a instalação ou a entrega. Nunca marcar pronto apenas para liberar o pipeline.

O smoke exige `--expected-revision <SHA completo de 40 caracteres>` e compara `/health.revision` antes de autenticar e depois de encerrar a chamada. O workflow fornece `github.sha`.

## Escopo de armazenamento do lançamento

Chamadas e gravações usam somente o workspace `primary`, assim como o socket de sinalização. HTTP em workspace secundário recebe flags fechadas e não pode substituir o estado global da chamada. Chat comum mantém seu armazenamento existente por workspace.

A manutenção lê documentos existentes sem transformar corrupção em banco vazio; mantém metadados de gravações ativas, retidas e com exclusão pendente, mesmo além do limite de 200 entradas. Esse limite vale para históricos cuja exclusão de arquivos já foi confirmada. Arquivos finais órfãos `team-recording-*.webm`/`.mp4`, além de `.part`, entram na limpeza após o prazo de graça e inventário completo; anexos comuns ficam fora dessa varredura.

Se houver `user_*/workspace_*/team_chat_db.json`, a manutenção continua a retenção das equipes primárias, suspende a exclusão global de órfãos e incrementa `cleanup_errors`. Antes do lançamento, o operador deve inspecionar o volume e resolver esse inventário legado com migração/expurgo controlado, preservando autorização e retenção. Não remover diretórios para silenciar o alerta. Não houve inspeção nem migração do volume Azure nesta tarefa.

GitHub Secrets adicionais: `TEAM_CALL_TURN_SHARED_SECRET`, `TEAM_CALL_METRICS_TOKEN`, `NORIUM_SMOKE_EMAIL`, `NORIUM_SMOKE_PASSWORD`, `NORIUM_SMOKE_PEER_EMAIL`, `NORIUM_SMOKE_PEER_PASSWORD`. As duas contas devem pertencer à mesma equipe exclusivamente de teste, explicitamente incluída na coorte interna. Não colocar valores em issues, logs ou arquivos versionados.

O coletor consulta `GET /api/team-chat/calls/metrics` por HTTPS com bearer dedicado a cada 30 s. Guardar o token em arquivo de credencial do coletor, sem query string. Instalar `infra/azure/team-call-alerts.yml`, validar regras com `promtool`, configurar receptor/plantonista e testar entrega. A definição versionada de alertas não comprova instalação ou entrega.
