# Pendências antes de abrir chamadas ao público

Em 2026-09-08, o responsável pelo projeto informou que o sistema é usado somente para testes e autorizou adiar os três pré-requisitos externos. A exceção é explícita e temporária: `TEAM_CALL_RELEASE_PROFILE=internal-test`. O perfil padrão continua `public`, com todas as exigências de lançamento.

## Antes da abertura ao público

- [ ] Provisionar TURN REST externo com TLS, certificado confiável e TCP/443; guardar o segredo somente no backend/GitHub Secrets. Executar relay-only externo três vezes com RTP real.
- [ ] Gerar/configurar o token dedicado de métricas, instalar coleta HTTPS e as regras de alerta, definir receptor e confirmar entrega de um alerta de teste. Registrar os três atestados e a referência HTTPS de evidência.
- [ ] Criar duas contas e uma equipe exclusivas para smoke; configurar os quatro segredos das contas e a coorte interna; executar o smoke autenticado de duas sessões contra a revisão publicada.
- [ ] Inspecionar o volume Azure para documentos corrompidos, lojas secundárias pendentes e política de expurgo de backups.
- [ ] Mudar `TEAM_CALL_RELEASE_PROFILE` para `public`, definir coorte/percentual inicial e executar novamente o pipeline completo. Respeitar as etapas graduais do runbook.

## O que fica ativo nos testes internos

O runtime hospedado continua `ENVIRONMENT=production`; não são desativados autenticação, autorização, isolamento entre equipes, retenção, limites, scans de segurança ou testes automatizados. Uma réplica e um worker continuam obrigatórios. Gravação e SFU permanecem desligadas.

As chamadas mesh ficam disponíveis às contas de teste autenticadas já existentes, sem exigir criação das duas contas dedicadas. Sem TURN externo, a conexão pode falhar em NATs e redes restritas. Métricas agregadas continuam nos logs do backend; o endpoint de scrape fica fechado sem token. Não existe monitoramento externo ou entrega de alertas comprovados nesse perfil.

O deploy de testes verifica revisão exata em `/health`, frontend, endpoints de chamada protegidos, métricas privadas e saúde do navegador empacotado. Isso não comprova uma chamada entre duas contas no ambiente publicado. Os testes de mídia/multissessão e carga continuam obrigatórios no CI local ao runner.

## Voltar a fechar as chamadas

Definir `TEAM_CALL_ENABLED=false` e `TEAM_CALL_ROLLOUT_PERCENT=0` e publicar uma nova revisão conforme o runbook. Voltar ao perfil `public` sem preencher as pendências bloqueia novas publicações; não altera retroativamente o ambiente já publicado.
