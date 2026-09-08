# Correção dos bloqueios do CI — 2026-09-08

O run [34182987141](https://github.com/T-Lucas43/Norium-nora/actions/runs/34182987141),
commit `fbadcc4`, não publicou imagem nem executou deploy. Dois gates falharam:

- Gitleaks não resolveu o commit-base porque o checkout tinha histórico raso.
  Todos os cinco checkouts agora usam `fetch-depth: 0`; a varredura continua obrigatória.
- Os 39 cenários de navegador expiraram na entrada. A reprodução local com o
  Chromium 151.0.7922.34 do Playwright 1.62 confirmou `NotSupportedError` na captura
  de mídia pelo headless shell. O Chromium completo da mesma versão passou.
  A suíte agora usa `channel=chromium` e não substitui automaticamente o navegador
  ausente pelo Chrome instalado. Os limites e as verificações de RTP foram mantidos.

Falhas de rede agora guardam apenas categorias, até 256 eventos por sessão.
Não são lidos URL, ticket ou texto da falha. Estados de chamada e permissões
passam por uma lista de valores permitidos antes de serem gravados. O resumo
inclui canal e versão do navegador. O CI preserva evidências agregadas também
no sucesso, por cinco dias.

## Validação local no worktree isolado

| Verificação | Resultado | Evidência em `output/team-call-release/` |
| --- | --- | --- |
| Reprodução antes da correção | Timeout com headless shell; captura `NotSupportedError` | `pending-chromium-repro/summary.json` |
| Multissessão após correção | 39/39, 13 cenários × 3 | `pending-fixed-browser/summary.json` |
| Smoke após atualização dos diagnósticos | 1/1, Chromium completo, RTP nativo | `pending-final-smoke/summary.json` |
| Backend completo | 621 testes aprovados | `pending-backend-tests.log` |
| Frontend completo | 570 testes, 90 arquivos aprovados | `pending-frontend-tests.log` |
| Regressões e release gates | 13 testes aprovados | `tests.unit.test_team_call_browser_harness` e `tests.unit.test_team_call_release_gates` |
| Carga | 25 equipes × 4 sessões × 3; 100/100 conexões | `pending-load/team-call-load.json` |
| Carga: sinal/heartbeat p95 | 7,034 ms / 428,31 ms | mesmo relatório de carga |
| Carga: remoção de desconectados/RSS | máximo 8,158 s / 132,504 MiB | mesmo relatório de carga |
| Build de produção | aprovado; aviso existente de bundle acima de 500 kB | `pending-build.log` |
| Lint | sem erros; avisos existentes fora desta alteração | `npm run lint` |
| Dependências | pip check, pip-audit e npm audit aprovados | execução local |
| Código backend | Bandit sem achados de severidade média/alta | execução local |
| Frontend sem segredos permanentes | 190 arquivos, zero achados | `team_call_frontend_security.py` |
| Segredos no código publicável | 643 arquivos, zero achados | `pending-gitleaks.json`, `pending-source-manifest.json` |
| Configuração | YAML com cinco jobs válido; dez regras de alerta válidas | PyYAML e promtool 3.14.0 |

A contagem de 643 arquivos é do snapshot anterior à inclusão deste documento.
Binários baixados, ambientes virtuais e artefatos ignorados não pertencem ao
snapshot publicável. As execuções locais que não conseguiam iniciar processos ou
acessar seus diretórios temporários no sandbox foram repetidas com autorização.

Esta evidência é local, com Python 3.12 no Windows; não substitui o pipeline Linux
com Python 3.14 nem o smoke da revisão servida pela Azure. O lançamento só pode
ser considerado concluído após esses gates. As três pendências externas seguem
na [lista de abertura ao público](team-call-public-launch-checklist.md), adiadas
exclusivamente para o perfil `internal-test`. Gravação e SFU continuam desligadas.
