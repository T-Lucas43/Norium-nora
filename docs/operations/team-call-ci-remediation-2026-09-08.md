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

## Retomada do deploy pela conta N4Nando-A

O run `34227664235`, em `a44d265`, aprovou a validação geral e a carga,
mas falhou nas três repetições de `tab_close_and_crash`. A reprodução isolada
no GitHub (`34236038665`) mediu rejeição da navegação em 0,010 s e evento real
de crash em 9,198 s no Ubuntu 24.04. A comparação no Ubuntu 26.04
(`34236276090`) também excedeu a espera interna de cinco segundos: 7,575 s.
Ambos os runners usam um coletor de core dump via pipe. O cenário completo
local passou no Windows e no Ubuntu/WSL, cujo coletor não usa esse pipe.
Isso confirma o atraso do evento no ambiente hospedado; não comprova por si
só qual etapa interna do coletor consome o tempo.

A versão 1.62.0 do [teste oficial do Playwright](https://github.com/microsoft/playwright/blob/v1.62.0/tests/library/page-event-crash.spec.ts)
registra a limitação do evento de crash no Ubuntu 24.04. A correção local
mantém o runner e exige o evento real, mas compartilha o prazo existente de
18 segundos entre a confirmação do crash e a remoção do participante.
O cenário continua descontando o tempo já consumido e conferindo o total;
nenhum cenário, verificação de RTP ou limite de remoção foi desativado.

A regressão do helper falhou em 5,011 s antes da mudança e passou após ela.
Os 14 testes do harness e dos gates de release passaram. Os diagnósticos
temporários ficam somente na branch `codex/team-call-linux-crash` e nos
artefatos ignorados; não fazem parte da entrega. A versão servida pela Azure
antes desta retomada era `cbdf3a3481b98a75dc7d135af971107258a86367`.
O pipeline [34244849151](https://github.com/T-Lucas43/Norium-nora/actions/runs/34244849151)
publicou `1dc6dc94f41c8f402da672a61ccc2e31cb06a22f` com os cinco jobs aprovados,
39/39 cenários de navegador e confirmação da revisão servida. O commit também
espera a troca de revisão na entrada da Azure antes de iniciar o smoke.

## Inspeção e conclusão com recursos existentes

A inspeção agregada [34271324913](https://github.com/T-Lucas43/Norium-nora/actions/runs/34271324913)
passou sem persistir conteúdos de bancos nem segredos. O deploy de
`2e77f6fd2abcd2b950d11417a69f1712181a2d09`, run
[34271324990](https://github.com/T-Lucas43/Norium-nora/actions/runs/34271324990),
também aprovou os cinco jobs. Resultados da inspeção e limites externos estão na
lista de abertura ao público.

O run anterior `34270172183` revelou outra corrida no harness: em uma das 39
execuções, `join_call` enumerou os botões antes da chegada do convite. A entrada
agora aguarda um dos dois controles visíveis pelo prazo já existente de 15 s.
Uma reprodução em Chromium, com convite inserido após 400 ms, falhou com o
helper antigo e passou com o novo para ambos os controles. Não foram alterados
cenários de mídia, limites de remoção ou critérios de RTP.

O primeiro ajuste desse seletor (`5e8f7d6`, run `34298593090`) revelou que o
cartão de chamada continua visível atrás da janela do convite. Escolher o
primeiro botão visível fazia o clique aguardar um cartão coberto. O seletor
agora exclui dinamicamente esse cartão enquanto o convite está visível,
preservando a prioridade da janela e a espera pela chegada do convite. A
regressão local cobre também a sobreposição do cartão pelo convite.
Depois dessa correção, 12/13 cenários passaram na execução local; o restante
falhou ao aguardar a carga inicial do fixture, antes de testar a negação de
permissão, e passou 3/3 vezes na verificação isolada. Os 39 cenários continuam
obrigatórios no pipeline Linux; a verificação isolada não substitui esse gate.

A preparação do smoke interno permite exigir duas sessões sem abrir métricas
nem declarar os requisitos externos atendidos. O teste manual do canal de
e-mail reaproveita a configuração SMTP do aplicativo, usa um único destinatário
e impede duplicação por ID de execução. A aceitação SMTP não equivale a entrega
confirmada na caixa nem à instalação de monitoramento externo.
