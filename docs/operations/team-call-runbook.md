# Operação, rollout e rollback de chamadas de equipe

Este runbook se aplica à branch `codex/team-call-remediation-baseline`, à imagem unificada Azure e ao transporte mesh. Configuração detalhada: [matriz](team-call-configuration.md). Resultado desta auditoria: [lançamento](team-call-release-audit.md). Os limites de carga acordados permanecem em [quality gates](../testing/team-call-quality-gates.md).

## Condições para lançar

1. Executar testes completos backend/frontend, build, lint, varredura de segredos, Bandit, pip-audit, npm audit, 13 cenários de navegador × 3 e carga 25 equipes × 4 sessões × 3. Uma falha conhecida interrompe a liberação. Não relaxar thresholds para passar.
2. Configurar TURN REST externo com TLS/443, certificado confiável, segredo em runtime e quotas do provedor. Executar `team_call_release_check.py` e `team_call_e2e.py --external-turn --scenario relay_only --repeat 3`. O perfil usa somente URLs `turns:...:443`, portanto a evidência local UDP não pode satisfazer o gate TLS.
3. Criar previamente duas contas e uma equipe exclusiva de smoke test; configurar os seis segredos e a lista interna descritos na matriz. Confirmar coleta HTTPS autenticada de métricas, receptor de alertas, plantonista e entrega de um alerta de teste. Registrar a evidência HTTPS e os três atestados obrigatórios da matriz; o preflight não verifica entrega automaticamente. Segredos não entram no build.
4. Manter gravação e SFU desabilitadas. Consentimento individual persistido/revogável e controle SFU server-side são marcos separados. A disponibilidade das classes de adapter não autoriza ativar essas opções.
5. Conferir destino e imagem anterior imutável, Azure Files montado em `/app/data`, modo de revisão `Single`, exatamente uma réplica e um worker. Inspecionar o inventário de gravações: documentos corrompidos ou lojas secundárias pendentes impedem considerar a retenção saudável. O gate de carga comprova 100 conexões de sinalização, não capacidade ilimitada de mídia. O lançamento fixa 25 chamadas/100 sockets e mesh de até 6 participantes, no workspace principal.
6. Drenar chamadas e gravações e reservar janela de manutenção para mudanças de revisão/configuração. O armazenamento JSON não permite distribuir tráfego entre revisões/réplicas simultâneas. A alteração de variáveis Azure reinicia o runtime; não há garantia de chamada ininterrupta durante deploy.

O workflow bloqueia publicação por `validate`, `team-call-quality` e `team-call-release`. O scan de segredos é obrigatório, inclusive quando a ferramenta falha por autenticação/licença/rede. O deploy verifica a imagem `sha-<commit>`, saúde, Chromium e protocolo de duas sessões em produção. Não disparar workflow nem atualizar `main` para contornar pré-requisitos ausentes.

## Rollout por equipe

| Passo | Configuração | Evidência mínima antes de avançar |
| --- | --- | --- |
| Preparação | `ENABLED=false`, percentual 0 | Todos os gates locais; infraestrutura e alertas prontos |
| Interno | `ENABLED=true`, percentual 0, lista apenas da equipe de teste | Gate TLS externo; smoke de produção; 20 admissões e 30 min de observação sem alerta |
| Piloto | percentual 5 | Pelo menos 24 h e 100 admissões; sem falhas de autorização, retenção ou isolamento |
| Expansão | 25 → 50 → 100 | Em cada passo, pelo menos 24 h e 100 admissões, métricas e feedback revisados |

Essas janelas e alertas são critérios operacionais iniciais propostos nesta etapa, não SLOs comerciais acordados. Baixo volume não equivale a aprovação automática: aguardar amostra ou decisão explícita do responsável. A mesma equipe mantém seu bucket ao aumentar o percentual. Chamadas já criadas mantêm transporte/capacidade; mudar uma flag não remove participantes nem impede saída, heartbeat, aborto ou finalização.

## Telemetria

### telemetry

Coletar `/api/team-chat/calls/metrics` a cada 30 s, por HTTPS, com `Authorization: Bearer` do token dedicado. Sem token, token errado ou query string, o retorno é 404. Não usar sessão de usuário como credencial do coletor. O processo também emite uma linha JSON `event=team_call_metrics`, esquema 1, a cada ciclo de manutenção (default 60 s), inclusive quando a manutenção falha.

Contadores monotônicos reiniciam com o processo; usar `rate`/`increase`, não subtração manual entre revisões. Gauges contam estado conhecido pelo coordenador/servidor, não tracks RTP. As séries não possuem labels de usuário/equipe/chamada/IP. O histograma mede da intenção de entrada à primeira conexão de mídia observada pelo cliente, inclui espera pelo outro participante, limita em 120 s e **não mede sucesso de uma chamada inteira**. Anfitrião sozinho ainda não gerou conexão de mídia. Eventos de cliente são amostras não confiáveis, autenticadas, limitadas e validadas; falha do socket pode descartar até oito amostras pendentes ao encerrar. Não usar essas amostras para faturamento ou prova de consentimento.

| Métrica `team_call_*` | Significado |
| --- | --- |
| `join_attempts_total`, `join_admitted_total`, `join_rejected_total` | Operações INVITE/ACCEPT, inclusive retries; ACK admitido é distinto de mídia conectada |
| `client_connected_total`, `connect_seconds_*` | Primeira conexão de mídia e histograma de duração |
| `client_ice_failed_total`, `turn_errors_total`, `turn_issued_total` | Estado ICE falhou; falha/sucesso de emissão TURN |
| `client_reconnecting_total`, `client_reconnected_total` | Episódios de recuperação de socket ou mídia |
| `active_calls`, `active_participants`, `active_sockets`, `call_limit`, `socket_limit` | Estado agregado do processo e limites configurados |
| `recording_*_total`, `recording_http_errors_total`, `recording_quota_errors_total` | Ciclo de gravação, falhas HTTP e 413/429 |
| `cleanup_*_total`, `cleanup_last_success_seconds` | Ciclos, erros, expirações, arquivos excluídos e última manutenção bem-sucedida |
| `sfu_token_issued_total`, `sfu_errors_total`, `client_sfu_failed_total` | Emissão/falhas SFU; qualquer atividade é inesperada no perfil atual |
| `socket_quota_errors_total`, `socket_rate_errors_total`, `telemetry_rejected_total`, `control_errors_total` | Limites e rejeições de controle |

As regras prontas estão em `infra/azure/team-call-alerts.yml`. Antes de instalação executar `promtool check rules`, configurar job `norium-team-calls` e testar roteamento até o receptor. Se `MetricsMissing` disparar, verificar token, TLS, endpoint, estado do processo e scrape; não abrir métricas publicamente.

### admission

Verificar relação de rejeição e volume mínimo. Conferir percentual, equipe interna, capacidade, conta ativa e permissões. Rejeições de chamadas encerradas, abas antigas ou acima da capacidade são esperadas e não devem ser transformadas em aceites. Erro inesperado sustentado interrompe expansão; reduzir percentual ou desabilitar novas chamadas na próxima revisão drenada.

### connectivity

Verificar saúde e certificado do TURN, DNS/egress, TLS/443, sincronismo dos relógios, quotas do provedor e emissão/renovação de credenciais. Rodar o gate relay externo com contas/mídia sintéticas. Não coletar SDP, candidatos completos, endereços, tickets ou credenciais. Não desabilitar TLS, autorização, expiração ou limites para recuperar conectividade. Queda de rede tem tolerância de 8 s; heartbeat a cada 10 s expira em 30 s, lease do anfitrião em 35 s. Revogação é reconciliada em até 5 s e imediatamente quando ela fecha o último socket.

### recordings

No perfil de lançamento, `TEAM_CALL_RECORDING_ENABLED=false`. Se surgirem novos uploads, investigar desvio de configuração. Para operações já em andamento, 413 indica tamanho e 429 taxa/concorrência/quota. Verificar espaço/quota Azure Files e o ciclo de finalização. O frontend limita fila pendente e usa retry/backpressure. Não salvar mídia em logs de diagnóstico. Uma notificação de início não constitui prova de consentimento de todos os participantes.

### retention

Alerta de limpeza exige verificar montagem, disponibilidade, permissões e disco. O ciclo tenta equipes independentes mesmo quando uma falha; a varredura de órfãos só ocorre após ler todas com sucesso. Repetir manutenção normal após restaurar acesso. `deleted` sem `filesDeletedAt` significa exclusão pendente e será tentada novamente; não apagar a entrada para “resolver” o erro. Downloads expirados já são recusados. Nunca remover recursivamente o diretório compartilhado nem alterar JSON para esconder arquivos pendentes. Verificar separadamente expurgo de snapshots/backups do provedor.

### capacity

Comparar gauges com limites da revisão. O perfil de 100 WebSockets valida sinalização e memória do backend; mesh replica mídia no navegador. Não aumentar réplicas/workers, participantes ou quotas como resposta automática. Reduzir entrada, analisar vazamentos e somente ampliar após medir o novo perfil. Uma segunda aba substitui a sessão lógica da primeira; fechar a aba antiga não pode expulsar a nova.

### sfu

Manter `TEAM_CALL_SFU_ENABLED=false`. JWT curto não revoga um participante já conectado. A ativação depende de remoção/encerramento server-side, webhooks assinados e deduplicados, reconciliação, testes do provedor e política de mídia/gravação. Não migrar o transporte de uma chamada ativa.

## Rollback

Primeiro interromper expansão. Para falha de produto, usar `TEAM_CALL_ENABLED=false` e `TEAM_CALL_RECORDING_ENABLED=false` na próxima revisão; reduzir percentual não encerra chamadas existentes. Como a Azure reinicia o processo ao alterar variáveis, usar a janela de manutenção e informar os participantes pelo canal operacional já autorizado.

O workflow registra a imagem anterior em seu resumo **antes** de atualizar a imagem. Recuperar esse valor exato (SHA ou digest, nunca `latest`), conferir sua procedência e compatibilidade com o JSON atual e o mount `/app/data`. Não restaurar backup de dados como parte do rollback de código: isso ressuscitaria chamadas e arquivos já expirados.

```powershell
# Executar no ambiente Azure autorizado, após conferir imagem e drenagem.
az containerapp update --resource-group $resourceGroup --name $appName `
  --image $previousImmutableImage --min-replicas 1 --max-replicas 1 `
  --set-env-vars TEAM_CALL_ENABLED=false TEAM_CALL_RECORDING_ENABLED=false TEAM_CALL_SFU_ENABLED=false `
  --output none
```

Conferir a imagem ativa, `/health`, frontend, uma réplica/worker, tickets/socket, encerramento/expiração de chamadas e continuidade da limpeza. Se a imagem antiga não reconhece as flags novas ou contém a falha que motivou o rollout, não é rollback seguro: manter coorte fechada na imagem corrigida e tratar o incidente. A imagem anterior e a permissão Azure não estão materializadas localmente nesta etapa; nenhum rollback foi executado.

## Smoke de produção

`infra/azure/team_call_smoke.py <URL> --expected-revision <SHA completo>` verifica a revisão servida por `/health` antes do login e após a limpeza, HTTPS/SPA, login de duas contas na equipe indicada, flags, credenciais ICE sem cache, tickets, INVITE/ACCEPT/heartbeat, recusa de encerramento pelo não anfitrião, proteção das métricas e remoção da chamada. Revisão ausente ou antiga interrompe o smoke. O encerramento roda em `finally`, incluindo perda do ACK. Saída contém apenas nomes dos checks, revisão, status, duração ou classe do erro. A execução cria dois eventos sintéticos de ciclo no chat da equipe de teste.

Esse smoke valida o protocolo publicado e não declara RTP em produção. A evidência de RTP/TURN TLS vem do gate de navegador externo obrigatório antes da publicação; homologação em redes corporativas/CGNAT e compatibilidade mobile continuam exigindo infraestrutura/dispositivos representativos. Não executar testes contra equipes reais de clientes.
