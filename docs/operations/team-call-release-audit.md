# Auditoria final e decisão de lançamento — chamadas de equipe

Data local: 2026-09-07; inventário final em 2026-09-08 02:52 UTC. Worktree: `C:\NOrium\deploy-worktrees\team-call-remediation-baseline`. Branch: `codex/team-call-remediation-baseline`. Base da etapa: `d6147431a73c8436aa9707e7d4b55ba095fdadab`. Na retomada, consulta autenticada e fetch confirmaram `origin/main@1c397e5f2819f3bb8f86bb6bc54a058f8fb8d0e2`, quatro commits novos de propostas/PDFs, sem mudanças no módulo de chamadas. Não foram integrados enquanto o lançamento está bloqueado; antes de publicar será necessário sincronizar essa base e repetir os gates afetados. Nenhuma alteração de arquivos foi feita no checkout principal ou nos demais worktrees.

**Decisão: lançamento bloqueado por pré-requisitos externos ausentes. Nenhuma imagem foi publicada, nenhum deploy foi executado e nenhum smoke foi executado em produção.** Os testes locais não substituem a validação externa obrigatória.

## Destino e bloqueios externos específicos

O destino não é ambíguo: GitHub `T-Lucas43/Norium-nora`, Azure Container App `norium-xb7456ymrz6d6`, resource group `rg-norium-dev`, URL `https://norium-xb7456ymrz6d6.blacksky-cd0b62be.eastus2.azurecontainerapps.io`. IDs OIDC, assinatura, tenant e destino estão configurados em GitHub Variables. A consulta foi somente de leitura; não foram obtidos valores de segredos.

| Bloqueio | Evidência | Condição para remover |
| --- | --- | --- |
| TURN/TLS externo não configurado | Ausência de `TEAM_CALL_TURN_URLS` no host e no fluxo; segredo `TEAM_CALL_TURN_SHARED_SECRET` ausente da lista GitHub; gate relay externo termina com código 2 | Responsável de infraestrutura disponibilizar TURN REST com certificado confiável/TLS 443, quota e segredo runtime; aprovar 3/3 execuções do gate externo |
| Coleta autenticada de métricas não configurada | Segredo `TEAM_CALL_METRICS_TOKEN` e os três atestados operacionais ausentes; sem evidência de coletor/receptor instalado | Configurar segredo, scrape HTTPS e receptor/plantonista; comprovar entrega de alerta de teste e registrar referência HTTPS/atestados. As 10 regras passaram no promtool local |
| Contas/equipe de smoke e coorte interna ausentes | Ausentes `NORIUM_SMOKE_EMAIL`, `NORIUM_SMOKE_PASSWORD`, `NORIUM_SMOKE_PEER_EMAIL`, `NORIUM_SMOKE_PEER_PASSWORD`; equipe/lista interna não configuradas | Provisionar duas contas exclusivas de teste na mesma equipe, configurar `TEAM_CALL_SMOKE_TEAM_ID`/`TEAM_CALL_INTERNAL_TEAMS` |

Registro vigente, sem valores de segredos: `output/team-call-release/resume-deployment-inventory.json`. Confirma o destino e lista os pré-requisitos ausentes no GitHub. Os relatórios `deployment-inventory.json`, `github-preflight.json` e `preflight.json` são da sessão anterior. Inventário de nomes não valida conteúdo de credenciais nem runtime Azure. O gate externo retomado também falhou antes de iniciar o navegador: `resume-external-turn/summary.json`, código 1, ausência de configuração no ponto `start_services`. A execução histórica que retornava código 2 não é a evidência vigente.

Não foi provisionado serviço pago, criado segredo, alterado ambiente Azure nem acionado workflow remoto. O host não dispõe de Docker/Azure CLI no PATH; a imagem de produção e os jobs Linux continuam sem execução nesta etapa. O build frontend de produção foi executado localmente. A falta de TURN já é suficiente para impedir publicação; não se tentou um deploy parcial para obter evidência.

## Auditoria por área

| Área | Resultado e controles / limites da evidência |
| --- | --- |
| Autorização | HTTP usa sessão autenticada e permissão de equipe; WebSocket usa ticket curto de uso único. Corrigida admissão de usuário já revogado antes do próximo tick. Diretório de chamadas agora exclui quem perdeu permissão do módulo; publicação/tick verificam status, equipe e `sessionVersion`. Host, participante, clientId e connectionId são verificados nas operações sensíveis. Testes cobrem conta revogada, equipe divergente, sessão invalidada, host e aba antiga |
| Isolamento entre equipes/conversas | Identidade da equipe deriva do usuário autenticado. Sinalização dirigida a participantes ativos; estado e quotas por equipe, admissão global atômica. Conversa direta/subequipe exige elegibilidade. Auditoria de gravação privada passou a usar destinatários da gravação, evitando exposição ao proprietário da equipe que não participa da conversa |
| Privacidade e consentimento | Captura explícita, modos somente escuta/silenciado e indicador de gravação. O consentimento existente é uma confirmação do anfitrião no navegador, sem aceite individual persistido e revogável dos demais. O lançamento bloqueia novas gravações; não declara esse mecanismo suficiente para ativá-las. Sem assessoria jurídica ou certificação de conformidade nesta etapa |
| Retenção | Default 24 h; manutenção periódica, limite de duração, abortos, exclusão de órfãos e acesso ao arquivo autorizado. Corrigida exclusão sem retry: `filesDeletedAt` confirma o delete, e falhas são tentadas novamente. Download expirado é recusado mesmo se a manutenção falhar; subequipe é revalidada. Diretórios persistidos continuam sujeitos à limpeza após retirada das contas. Uma equipe com erro não impede tentativas nas demais. Backups/snapshots do provedor ainda precisam de política externa de expurgo |
| Recursos | Mesh default 6, configuração limitada a 2–12; contagem autoritativa e capacidade persistida por chamada. Limites por equipe/processo para chamadas e sockets, orçamento fixo por conexão e amostra de telemetria, filas/gravação limitadas. Imagem fixa 1 worker, frames 120 kB e fila WebSocket de 8; lançamento limita 25 chamadas/100 sockets. Mais réplicas exigem persistência/pub-sub compartilhados |
| Ciclo de vida | ACK antes do transporte, compensação idempotente, encerramento explícito, lease/heartbeat, transferência de aba, expiração, tracks/timers/socket com proprietário único. Corrigida espera indevida de 8 s quando o último socket já fechou por revogação. Uma nova imagem/revisão pode interromper chamadas; runbook exige drenagem/manutenção |
| Reconexão | Reconciliação periódica não pode mais ser adiada indefinidamente por mensagens constantes. Tolerância de transporte preservada, snapshot autoritativo, eventos de sessão antiga rejeitados. Testes reais cobrem offline temporário, reabertura, múltiplas abas, fechamento e crash |
| Acessibilidade | Diálogos com foco inicial, Escape/Tab, nomes de controles, estados em `status`/`alert`, indicação visual de toque/autoplay e avisos de falha. Testes frontend e browser exercitam esses contratos. Não foi executada homologação com leitor de tela físico ou certificação WCAG |
| Compatibilidade | Chromium real no Windows com WebRTC/MediaRecorder e RTP; detecção de permissão, dispositivos, speaker selection e suporte MIME preservados. Mesh/TURN local comprovados. Firefox, Safari/WebKit, mobile, seletor real de tela do SO, NAT corporativo/CGNAT e rede regional não são comprovados pela suíte headless; exigem homologação representativa antes de ampliar suporte |
| Segredos no frontend | Backend emite somente credenciais efêmeras sem cache; nenhum segredo TURN/LiveKit/métricas em VITE, build args, snapshot público ou persistência do cliente. SDK SFU com logs silenciosos. Scan dedicado examina fonte de chamadas e bundle completo; Gitleaks examina snapshot de arquivos versionados e novos, com valores redigidos |
| SFU | Adapter LiveKit existe, porém seleção de produção permanece mesh. JWT curto não revoga mídia já conectada. Sem controle administrativo de remoção/encerramento e webhooks reconciliados, `SFU_ENABLED` obrigatoriamente falso; o preflight recusa ativação |

## Observabilidade implementada

Implementação: `call_observability.py`, `call_release.py`, instrumentação nos coordenadores/router e `callTelemetry.ts` na sessão de mídia. Há contadores de admissão, conexão, ICE/TURN, reconexão, gravação/quota, limpeza, SFU e limites; gauges de chamadas/participantes/sockets/capacidade; histograma do tempo até primeira conexão. O endpoint de métricas usa bearer dedicado, sem query, sem cache e sem dimensões pessoais. A manutenção emite JSON agregado a cada ciclo. Erro de manutenção deixou de ser silencioso.

Eventos do navegador têm vocabulário fechado e duração limitada, passam por autenticação, associação à chamada/cliente/socket atual e orçamento de amostras. Nunca se envia SDP, candidato completo, endereço, token, mensagem de chat ou mídia para métricas. Logs de acesso HTTP/WS das rotas de equipe são suprimidos para evitar IPs e tickets; diagnóstico do SDK LiveKit é desabilitado. Métricas do cliente continuam sujeitas a perda/forjamento pelo próprio cliente e não são prova de consentimento nem faturamento.

O harness final não grava traces, screenshots ou vídeos, nem preserva logs brutos de serviço: em falha guarda cenários, classes de erro, posições do código, categorias do console e contagens. Isso substitui a política anterior de artefatos da etapa 9; mídia sintética continua sendo transmitida e medida, porém não vira log persistente. A varredura de segredos inicialmente identificou duas constantes sintéticas de teste e um falso positivo atravessando duas linhas vazias de `.env.example`; os fixtures agora declaram sua credencial de teste por composição e o valor vazio está explicitamente entre aspas. Nenhuma regra de detecção foi desabilitada.

## Falha encontrada e corrigida durante os gates

A primeira matriz resultou em 38/39: `user_and_team_revocation` excedeu 7 s ao desativar todos os membros. A repetição isolada confirmou 1 falha em 5. O último socket podia ser fechado pela validação de publicação antes de seu tick de reconciliação; o callback só reconciliava após 8 s. Um teste determinístico na mesma função mostrou `active_calls=1` quando já deveria ser zero, em 0,009 s. Após reconciliar antes da tolerância, o mesmo teste passou e a revogação passou 5/5; a matriz completa seguinte passou 39/39.

A atualização da revalidação de sessão exigiu adaptar o mock de um teste de transporte já fechado ao novo método `socket_authorized`. O teste antigo simulava revogação numa função que deixou de controlar esse caminho e repetia timeout indefinidamente. O mock foi corrigido para autorizar a publicação inicial e recusar o tick seguinte, preservando a asserção de fechamento idempotente.

## Verificações e evidências

Os logs completos ficam nos diretórios ignorados `norium-back-end/artifacts`, `norium-front-end/artifacts` e `output/team-call-release`. Os resultados finais são registrados abaixo ao concluir as execuções sobre o estado final. Falha externa nunca é registrada como skip ou sucesso.

| Gate | Resultado |
| --- | --- |
| Backend completo final | 586/586 em 26,001 s; `norium-back-end/artifacts/team-call-resume-backend-final.log` |
| Frontend completo | 554/554, 85 arquivos, 21,54 s; `norium-front-end/artifacts/team-call-resume-frontend.log` |
| Multissessão final | 39/39 em 184,955 s; 13 cenários × 3, sem artefatos de falha; `output/team-call-release/resume-browser-final/summary.json` |
| Carga acordada | 3/3, 25 equipes × 4 sessões, 100/100 conexões retidas e zero violações; `output/team-call-release/resume-load/team-call-load.json` |
| Build frontend de produção | TypeScript + Vite aprovados; `team-call-resume-build.log` |
| Lint | Aprovado; avisos preexistentes fora de chamadas; `team-call-resume-lint.log` |
| Dependências Python | `pip check` aprovado; pip-audit sem vulnerabilidade conhecida |
| Dependências frontend de produção | npm audit: 0 vulnerabilidades |
| Fonte Python | Bandit final sem achados médios/altos; `output/team-call-release/resume-bandit-final.json` |
| Bundle e fonte de chamadas | 182 arquivos inspecionados, 0 achados; `resume-frontend-security.json` |
| Segredos | Gitleaks 8.30.1, 615 arquivos versionados/novos, 0 achados; `resume-gitleaks.json`; manifesto SHA-256 em `resume-source-manifest.json` |
| TURN/TLS externo | BLOQUEADO: configuração externa ausente; runner retorna 1 e registra falha de pré-requisito antes de iniciar navegador |
| Workflow / alertas | YAML e dependências de publicação validados; promtool 3.14.0 com checksum verificado: 10 regras aprovadas. Instalação/coleta/entrega externa seguem pendentes |
| Imagem / deploy / smoke em produção | NÃO EXECUTADOS, por bloqueios externos acima |

Carga medida: sinalização p95/p99 10,834/11,289 ms; heartbeat 367,425/400,938 ms; remoção máxima de participante desconectado 8,155 s; expiração silenciosa 30,948 s; pico RSS 132,883 MiB. Nenhum threshold foi alterado. O perfil mede sinalização do backend, não capacidade simultânea de mídia em 25 chamadas.

Uma interrupção do verificador automático por limite de uso impediu temporariamente executar testes; após a instrução do usuário para continuar, a validação foi retomada e os resultados finais acima foram obtidos. Não se tratou de autorização para ignorar os pré-requisitos de produção.

## Handoff e próximo marco único

### Correções adicionais concluídas na retomada

A revisão Standards encontrou dois riscos de retenção: leitura tolerante de JSON corrompido podia tratar arquivos referenciados como órfãos; o corte cego em 200 gravações descartava metadados de mídia retida ou com exclusão pendente. Ambos foram corrigidos, com testes do adaptador real e preservação dos bytes originais do banco. Downloads sem metadados de gravação agora são negados. A limpeza reconhece também arquivos finais órfãos, preservando arquivos referenciados e anexos comuns. A separação de workspaces recebeu proteção explícita: chamadas ficam no principal; inventário secundário pendente impede exclusão global de órfãos e gera erro de manutenção. O volume Azure continua sem inspeção e precisa cumprir esse pré-requisito antes da publicação.

A revisão Spec encontrou três lacunas nos gates: TURN/TLS aceitava `4433` por comparação parcial, alertas não exigiam evidência operacional e o smoke aceitava uma revisão antiga saudável. O preflight agora analisa exatamente porta 443 e transporte TCP, exige os atestados e referência de observabilidade, e o smoke confere o SHA completo realmente servido antes e após a chamada. Sete testes desses contratos passaram. Não houve achado de expansão de escopo.

A revisão de privacidade também removeu logs brutos, URLs de destino e mensagens de exceção do teste de carga e a saída temporária dos serviços de navegador. Dois testes de regressão reproduziram a exposição sintética e passaram após a correção. Nenhum valor de segredo de produção foi obtido ou gravado. O endpoint de métricas recusa query string mesmo com bearer válido.

Resumo das duas revisões: Standards, dois achados centrais de retenção corrigidos e uma limitação de workspace contida; Spec, três achados corrigidos. As limitações externas permanecem explícitas.

Preservado: trabalho não relacionado no checkout principal, branch de protótipo SFU e demais worktrees. Não houve merge/push/publicação nesta etapa. Runbook, rollout, rollback e matriz estão versionáveis neste mesmo worktree.

**Próximo marco:** disponibilizar TURN/TLS, coleta/alertas e equipe/contas de teste; então executar os gates externos do workflow, publicar a imagem imutável, validar o smoke de duas sessões em produção e anexar a imagem/revisão/resultados. Até lá, manter lançamento bloqueado e gravação/SFU desabilitadas. A etapa não deve ser tratada como produção validada.
