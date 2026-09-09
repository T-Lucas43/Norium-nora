# Pendências antes de abrir chamadas ao público

Em 2026-09-08, o responsável pelo projeto informou que o sistema é usado somente para testes e autorizou adiar os três pré-requisitos externos. A exceção é explícita e temporária: `TEAM_CALL_RELEASE_PROFILE=internal-test`. O perfil padrão continua `public`, com todas as exigências de lançamento.

## Antes da abertura ao público

- [ ] Provisionar TURN REST externo com TLS, certificado confiável e TCP/443; guardar o segredo somente no backend/GitHub Secrets. Executar relay-only externo três vezes com RTP real.
- [ ] Gerar/configurar o token dedicado de métricas, instalar coleta HTTPS e as regras de alerta, definir receptor e confirmar entrega de um alerta de teste. Registrar os três atestados e a referência HTTPS de evidência.
- [ ] Criar duas contas e uma equipe exclusivas para smoke; configurar os quatro segredos das contas e a coorte interna; executar o smoke autenticado de duas sessões contra a revisão publicada.
- [x] Inspecionar o volume Azure para documentos corrompidos, lojas secundárias pendentes e política de expurgo de backups. Inspeção somente de leitura em [34271324913](https://github.com/T-Lucas43/Norium-nora/actions/runs/34271324913): 123 bancos, zero arquivos ilegíveis/corrompidos, zero lojas secundárias, seis registros de gravação, zero snapshots, exclusão recuperável do compartilhamento por sete dias e nenhum cofre de backup no grupo do projeto. O relatório contém somente agregados e expira em cinco dias.
- [ ] Mudar `TEAM_CALL_RELEASE_PROFILE` para `public`, definir coorte/percentual inicial e executar novamente o pipeline completo. Respeitar as etapas graduais do runbook.

## O que fica ativo nos testes internos

O responsável limitou esta conclusão aos recursos existentes e confirmou que não há outro serviço TURN ou de monitoramento contratado. O inventário do grupo `rg-norium-dev` não encontrou VM, ACI ou grupo de ação. TURN externo e coleta/alertas externos permanecem bloqueados por essa restrição. A existência de configuração SMTP permite testar o canal de e-mail, mas não comprova coleta nem entrega de um alerta produzido pelo monitor.

O runtime hospedado continua `ENVIRONMENT=production`; não são desativados autenticação, autorização, isolamento entre equipes, retenção, limites, scans de segurança ou testes automatizados. Uma réplica e um worker continuam obrigatórios. Gravação e SFU permanecem desligadas.

As chamadas mesh ficam disponíveis às contas de teste autenticadas já existentes, sem exigir criação das duas contas dedicadas. Sem TURN externo, a conexão pode falhar em NATs e redes restritas. Métricas agregadas continuam nos logs do backend; o endpoint de scrape fica fechado sem token. Não existe monitoramento externo ou entrega de alertas comprovados nesse perfil.

O deploy de testes verifica revisão exata em `/health`, frontend, endpoints de chamada protegidos, métricas privadas e saúde do navegador empacotado. Após provisionar as duas contas, configurar `TEAM_CALL_AUTHENTICATED_SMOKE_REQUIRED=true` para exigir também login, convite, aceite, heartbeat, autorização de encerramento e limpeza da chamada. Credenciais ausentes passam a bloquear o smoke; o endpoint de métricas permanece fechado. Esse teste não mede RTP no ambiente publicado. Os testes de mídia/multissessão e carga continuam obrigatórios no CI local ao runner.

O workflow manual `team-call-email-probe.yml` usa o SMTP já configurado no contêiner e o destinatário de `TEAM_CALL_ALERT_EMAIL`. Não exporta credenciais SMTP, não cria serviço e não instala monitoramento. Cada execução tem uma chave persistente para impedir reenvio em tentativas repetidas. `smtpAccepted=true` comprova aceitação pelo servidor SMTP; a confirmação na caixa do destinatário e os atestados do monitor continuam separados e não são preenchidos automaticamente.

## Voltar a fechar as chamadas

Definir `TEAM_CALL_ENABLED=false` e `TEAM_CALL_ROLLOUT_PERCENT=0` e publicar uma nova revisão conforme o runbook. Voltar ao perfil `public` sem preencher as pendências bloqueia novas publicações; não altera retroativamente o ambiente já publicado.
