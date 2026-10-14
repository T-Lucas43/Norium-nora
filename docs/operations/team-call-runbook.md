# Operação, rollout e rollback de chamadas de equipe

## Nora em reuniões — núcleos C/D/E ainda sem aceite integral

O [handoff C](../handoffs/2026-10-13-codex-nova-chamada-fase-C.md) registra código, testes e lacunas. `NORA_CALL_ENABLED=0` é padrão e não foi alterado em produção; entitlement operacional fica fechado. Não há agente operacional ou token de serviço, persistência durável nova de texto ou voz pública montada. Há transcrição volátil por audiência, distribuição interna e UI/legendas/perguntas privadas. Os testes de provedores usam fontes sintéticas/MockTransport; o SDK nativo foi instalado somente no ambiente isolado de QA, sem conexão SFU.

Antes de ligar uma ponte real: concluir [revisão especializada](../security/reviews/2026-10-13-nora-em-reunioes.md), gates SFU existentes, supervisor/processos/limite global, privacidade/retencão/exportação, tarifas e homologação com SDK/provedores reais. `measure_nora_native_audio.py` mede duas fontes locais do SDK e a fila Python, sem sala SFU. Após uma reprovação pelo critério antigo de faixa RSS, a medição passou a distinguir crescimento positivo da memória privada comprometida e oscilações do RSS. Consultar resultados completos no handoff; verificação curta não substitui 30 min.

Consentimento deve ser explícito por participante e revisão. Quem entra/troca de sessão ou retira autorização pausa a captura. "Aguardando conexão" significa que todos autorizaram e o agente ainda não está conectado. Áudio humano não deve parar quando Nora pausa. Não registrar áudio, texto bruto, tokens ou exceções do provedor em logs/artefatos. `speech_usage` conserva tentativas incertas; não apagar reservas para liberar um reenvio sem reconciliação.

Este runbook se aplica à branch `codex/team-call-remediation-baseline`, à imagem unificada Azure e ao transporte mesh. Configuração detalhada: [matriz](team-call-configuration.md). Resultado desta auditoria: [lançamento](team-call-release-audit.md). Os limites de carga acordados permanecem em [quality gates](../testing/team-call-quality-gates.md).

## Condições para lançar

### Interface da chamada (13/10/2026)

O palco oferece Automático/Galeria/Destaque/Apresentação. A escolha fica salva por usuário; limpar `norium.team-call.layout.<id>` no armazenamento local retorna ao automático. Apresentação tem prioridade no automático; o Destaque espera 1,5 s de fala. Esta ordenação é visual e não comprova redução de banda.

Gravação, dispositivos, qualidade e saída de áudio ficam em **Mais**. No celular, Mais também reúne apresentação, reações, mão, chat, pessoas e Estúdio. Ctrl+D alterna microfone, Ctrl+E câmera e Ctrl+Alt+H mão; campos de texto preservam seus atalhos. Minimizar mantém o áudio e permite mover a janela por arraste ou pelas setas no botão de movimento.

O organizador continua vendo **Encerrar**, pois sua saída também encerra a chamada no domínio atual. O guard de salvar o Estúdio é preservado. Remover alguém exige confirmação e usa `CALL_KICK`; silêncio e fixação pessoais não alteram o dispositivo dos demais. Dar a vez envia uma mensagem no chat temporário somente após o clique do organizador.

O organizador pode fixar alguém para todos e convidar para apresentar. O convite não captura a tela nem muda permissões: quem recebeu escolhe a tela no próprio navegador. Anotar marca uma posição por dez segundos; o apresentador pode bloquear os demais. O backend valida associação à sala, quem pode bloquear/fixar e coordenadas normalizadas. Não há persistência de marcas nem envio para IA. **Destacar controles** usa Document Picture-in-Picture quando disponível; ao fechar ou abrir um painel, a barra volta à aba.

O selo de sala autenticada informa acesso controlado, não E2EE. Nora, transcrição e comando de voz não estão ativos nesta entrega. O teste de microfone na pré-entrada é voluntário, não envia áudio e libera tracks/contexto ao parar, fechar ou passar para somente escuta. Limites e requisitos pendentes estão no [handoff](../handoffs/2026-10-13-codex-nova-chamada-fase-A.md).

As condições abaixo são do perfil `public` (padrão). Em 2026-09-08, o responsável autorizou o perfil `internal-test` enquanto o sistema estiver restrito a testes. Nesse perfil, somente TURN/TLS externo, coleta/entrega externa de alertas e contas dedicadas de smoke são adiados. As pendências e condições da exceção estão na [lista de abertura ao público](team-call-public-launch-checklist.md). O runtime continua em ambiente de produção com todos os controles de segurança; testes, scans, imagem imutável, saúde e SHA servido continuam obrigatórios.

1. Executar testes completos backend/frontend, build, lint, varredura de segredos, Bandit, pip-audit, npm audit, 13 cenários de navegador × 3 e carga 25 equipes × 4 sessões × 3. Uma falha conhecida interrompe a liberação. Não relaxar thresholds para passar.
2. Configurar TURN REST externo com TLS/443, certificado confiável, segredo em runtime e quotas do provedor. Executar `team_call_release_check.py` e `team_call_e2e.py --external-turn --scenario relay_only --repeat 3`. O perfil usa somente URLs `turns:...:443`, portanto a evidência local UDP não pode satisfazer o gate TLS.
3. Criar previamente duas contas e uma equipe exclusiva de smoke test; configurar os seis segredos e a lista interna descritos na matriz. Confirmar coleta HTTPS autenticada de métricas, receptor de alertas, plantonista e entrega de um alerta de teste. Registrar a evidência HTTPS e os três atestados obrigatórios da matriz; o preflight não verifica entrega automaticamente. Segredos não entram no build.
4. Manter gravação e SFU desabilitadas. Consentimento individual persistido/revogável e controle SFU server-side são marcos separados. A disponibilidade das classes de adapter não autoriza ativar essas opções.
5. Conferir destino e imagem anterior imutável, Azure Files montado em `/app/data`, modo de revisão `Single`, exatamente uma réplica e um worker. Inspecionar o inventário de gravações: documentos corrompidos ou lojas secundárias pendentes impedem considerar a retenção saudável. O gate de carga comprova 100 conexões de sinalização, não capacidade ilimitada de mídia. O lançamento fixa 25 chamadas/100 sockets e mesh de até 6 participantes, no workspace principal.
6. Drenar chamadas e gravações e reservar janela de manutenção para mudanças de revisão/configuração. O armazenamento JSON não permite distribuir tráfego entre revisões/réplicas simultâneas. A alteração de variáveis Azure reinicia o runtime; não há garantia de chamada ininterrupta durante deploy.

O workflow bloqueia publicação por `validate`, `team-call-quality` e `team-call-release`. O scan de segredos é obrigatório, inclusive quando a ferramenta falha por autenticação/licença/rede. O deploy verifica a imagem `sha-<commit>`, saúde, Chromium e protocolo de duas sessões em produção. Não disparar workflow nem atualizar `main` para contornar pré-requisitos ausentes.

## Rollout por equipe

Se todos os cenários de mídia expirarem na entrada enquanto a sinalização/carga
passa, conferir o canal e a versão do navegador no resumo e os estados enumerados
em `call-states.json`. Reproduzir primeiro `group_media --repeat 1` usando o mesmo
Chromium completo do CI; não aumentar timeouts nem substituir silenciosamente o
navegador. Se o Gitleaks falhar com `unknown revision`, verificar que o checkout tem
histórico completo. Não considerar uma varredura parcial como aprovação. Os
artefatos agregados de qualidade são preservados também quando os testes passam.

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

## Recepção seletiva de vídeo (Fase B)

O cliente informa quais blocos de vídeo estão visíveis, reage à mudança de tamanho, layout e visibilidade da aba e pausa vídeo recebido ao minimizar. Áudio de microfone e da apresentação continua independente dessa preferência. Restaurar a chamada ou a aba solicita novamente o vídeo. Um participante sem faixa assinada continua com bloco de presença para permitir a retomada.

No Mesh, `CALL_VIDEO_INTEREST` é direcionado apenas ao participante da mesma chamada que envia a mídia. Não altera a captura local, o vídeo recebido por outras pessoas ou o estado de câmera informado à sala. Na apresentação, a tela usa o perfil escolhido pelo apresentador; câmeras laterais usam até 250 kbit/s, 15 FPS e escala 2 quando o navegador aceita os parâmetros. Essa qualidade não é simulcast no Mesh.

O adaptador LiveKit usa `autoSubscribe: false`, assina áudio continuamente e aplica a preferência às publicações de vídeo, inclusive publicações tardias e reconexões. Os elementos de vídeo são ligados ao SDK para `adaptiveStream`, mantendo `dynacast`. A ativação de SFU permanece sujeita aos gates descritos neste runbook e no ADR 0002; testes locais do adaptador não comprovam operação no provedor.

Verificar a retomada com `video_interest` no harness de navegador. `scripts/measure_team_call_video.py` mede três participantes sintéticos por dez minutos; preserva contadores agregados, sem mídia, SDP ou credenciais. Comparação de sinalização/carga do backend não substitui essa medição de mídia.

## Smoke de produção

`infra/azure/team_call_smoke.py <URL> --expected-revision <SHA completo>` verifica a revisão servida por `/health` antes do login e após a limpeza, HTTPS/SPA, login de duas contas na equipe indicada, flags, credenciais ICE sem cache, tickets, INVITE/ACCEPT/heartbeat, recusa de encerramento pelo não anfitrião, proteção das métricas e remoção da chamada. Revisão ausente ou antiga interrompe o smoke. O encerramento roda em `finally`, incluindo perda do ACK. Saída contém apenas nomes dos checks, revisão, status, duração ou classe do erro. A execução cria dois eventos sintéticos de ciclo no chat da equipe de teste.

Esse smoke valida o protocolo publicado e não declara RTP em produção. A evidência de RTP/TURN TLS vem do gate de navegador externo obrigatório antes da publicação; homologação em redes corporativas/CGNAT e compatibilidade mobile continuam exigindo infraestrutura/dispositivos representativos. Não executar testes contra equipes reais de clientes.
