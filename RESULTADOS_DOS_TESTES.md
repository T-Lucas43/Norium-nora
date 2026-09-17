# Resultados dos testes — auditoria pré-lançamento

> Auditoria local de 16/09/2026. Branch `main`, commit `a8196d82620b867692203295e5b35130adbed8a7`. Código de produção: conforme declaração do responsável, igual ao checkout local; configuração, dependências instaladas, dados e operação de produção não foram verificados. Nenhum deploy ou alteração de dados reais foi realizado.

## Método e isolamento

Os probes usaram `ENVIRONMENT=test`, `APP_ENV=test`, `PYTHON_DOTENV_DISABLED=1`, `NORIUM_DATA_DIR` temporário, identidades e anexos sintéticos. Nos probes root, de isolamento e de navegador, a rede externa foi bloqueada; o probe Astra importou apenas módulos com workers desativados e não fez chamadas externas. O navegador usou build compilado, API local e Chromium; workers externos foram desligados nesse smoke. Nenhum segredo ou dado real foi gravado nos relatórios. O teste de matrizes A/B cobriu caminhos específicos, não todos os 482 decorators estáticos.

## Comandos, resultado e limites

| Comando | Resultado | Evidência | Limitação |
| --- | --- | --- | --- |
| `git status --short`, `git rev-parse HEAD` | Passou | Checkout `main` limpo no início e após inspeções; SHA acima. Artefatos de auditoria são novos documentos e dados em `tmp`/`output`. | Sem comparação remota atual por restrição de não acessar produção. |
| `npm.cmd run lint` | Passou com avisos | Exit 0; 3,33 s; 19 warnings (hooks/Fast Refresh e escape). | Warnings não tratados nesta etapa. |
| `npm.cmd run build` | Passou | Exit 0; 37,54 s; 1.627 módulos. Chunks de 1.098,34 KiB `index` e 541,59 KiB `AdminDashboard` sinalizados. | Build não testa integrações. |
| `npm.cmd test -- --pool=threads --maxWorkers=1 --no-file-parallelism` | Passou | Exit 0 conforme `frontend-vitest.log`; 112 arquivos e 667 testes, 465,57 s do wrapper. | JSDOM/mocks não equivalem a provedores ou navegador real. |
| `npm.cmd run audit:interactions` | Falhou por falso positivo | Exit 1; 2 `missing-action` em botões submit implícitos dentro de `<form onSubmit>`. | Scanner exige `type=submit` explícito; não comprovou botão inerte. |
| `python -m unittest discover -s tests -p test*.py -v` | Inconclusivo | Execução isolada foi iniciada e terminou sem output/exit recuperáveis; tentativa de rerun para log foi recusada pelo auto-review por limite de uso. | Não chamar suite backend de aprovada. |
| `python -m pip check` | Passou | Exit 0: sem requisitos instalados quebrados. | Não valida aderência ao requirements nem ausência de CVE. |
| `python -m pip_audit --local --progress-spinner off` | Falhou por avisos | Exit 1; 18 registros em 5 pacotes do venv, 9 CVEs únicos. `cryptography` local 49.0.0 vs manifesto 50.0.0. | Venv não é prova do container publicado nem da alcançabilidade. |
| `python -m bandit -q -r app -x tests -ll` | Passou no limiar usado | Exit 0; 0 resultados de severidade média/alta; 23 avisos baixos nos metadados. | SAST parcial, não substitui auditoria manual. |
| `npm.cmd audit --omit=dev --audit-level=high --json` | Passou em uma consulta | Exit 0; 0 avisos; 213 dependências de produção conforme metadados. | Consulta posterior completa falhou por rede; resultado pontual não certifica releases futuros. |
| `npm.cmd audit --audit-level=high --json` | Inconclusivo | Endpoint do registro npm falhou, exit 1; cache de auditoria em tmp. | Sem resultado confiável de dependências de desenvolvimento. |
| `inventory_scan.py` | Passou com limite | 766 arquivos versionados, 482 decorators de rota, 86 nomes de ambiente, 2.733 blobs históricos em 348 commits e 0 matches em 5 padrões de segredo. | Padrões não cobrem todos os segredos; Gitleaks do CI não foi repetido localmente. Valores nunca foram gravados. |
| `astra_probes.py` | Passou | 4 reproduções sintéticas confirmaram AUD-01/02/03/07. | Conta/teste descartáveis; sem dados reais. |
| `root_checks.py` | Passou | Anonimato: 7 endpoints=401; rate limiter=401/500; health sem storage=200; idempotência ficou processing; ZIP incluiu só perfil. | Cenários provocados localmente, não incidentes observados em produção. |
| `isolation_probe.py` | Passou | 10/10 controles A/B esperados: clientes, anexos, upload Nora, financeiro, workspace, admin e logout. | Matriz amostral; não cobre todos os endpoints/relacionamentos. |
| `browser_smoke.py` | Passou | Chromium real no build servido por API local; senha errada, login e logout; 6 telas×2 larguras sem erro JS/overflow; token em localStorage. | Sem provedores, dados reais, performance de rede ou auditoria WCAG. |
| `astra_integrations_probes.py` | Não executado | Preparado para três uploads mínimos e envio fake seguido de falha/reexecução. | Auto-review recusou execução adicional devido limite de uso; não contornar. |

## Evidência detalhada

- Isolamento: `output/auditoria-20260916/root/isolation.json`; 10/10 resultados esperados. Controles negaram acesso de B a cliente/anexo/Nora/financeiro de A, troca de workspace, admin indevido e token revogado.

- Probes de confiabilidade: `output/auditoria-20260916/root/root_checks.json`.

- Frontend: `output/auditoria-20260916/testes/frontend-vitest.log` e `testes/RESULTADO_AGENTE.md`. O relatório do agente foi produzido antes do fim do Vitest; prevalece o log final com exit 0.

- UI: `output/auditoria-20260916/ui/result.json`; capturas desktop/mobile em `ui/`. Zero `pageerror`, zero overflow nas 12 aberturas de tela; login incorreto e logout foram observados. Três botões sem nome em Tarefas exigem inspeção de acessibilidade antes de virar defeito confirmado.

- Segredos: varredura histórica limitada por cinco expressões regulares resultou em zero matches; nenhum valor foi coletado. O Gitleaks de CI está no workflow, mas seu resultado atual não foi consultado nesta auditoria.

- SCA: venv local tem nove CVEs únicos em cinco pacotes; avisos oficiais de [aiohttp](https://github.com/aio-libs/aiohttp/security/advisories/GHSA-cq5v-8q36-5273) e [cryptography](https://github.com/pyca/cryptography/security/advisories/GHSA-g6cj-pr64-35w5) confirmam versões afetadas. Não há prova de exploração no Norium. O manifesto exige `cryptography==50.0.0`, diferente do venv 49.0.0.

## Falhas e limitações abertas

A suite backend completa carece de saída final. A repetição em modo somente teste foi recusada pela aprovação automática por limite de uso da conta, com instrução para não contornar; por isso o gate permanece aberto. O probe adicional de upload/reexecução de automações sofreu a mesma recusa. A consulta npm completa de dependências dev falhou no endpoint do registro. Sem credenciais de homologação, nenhum envio Gmail/WhatsApp, chamada de IA, assinatura externa ou teste de vulnerabilidade em terceiros foi executado. A informação de que produção usa o mesmo código veio do responsável, sem consulta de produção.
