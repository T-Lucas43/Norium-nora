# Retrospecto — piloto Codex + Muse até a PR #31

Data: 22/09/2026
Escopo: tarefas de agenda, notificações e PDF/Nora; preparação e publicação da tarefa 3.
Resultado observado: PR #31 integrada com 14 arquivos da tarefa 3; seus checks foram verdes. Uma execução posterior de `main` falhou no gate de qualidade e não fez deploy, conforme E10. Não há falha de produto em produção atribuída à tarefa 3 nesta análise.
Decisão do usuário: assinatura Muse Code cancelada em 22/09/2026; piloto encerrado por exigir mais maturidade da ferramenta.

## Resumo

O piloto funcionou tecnicamente, mas gastou mais revisão e intervenção do que deveria. As causas foram independentes: escopo inicial grande, contratos sensíveis incompletos, contexto acumulado, prompts de retomada não autossuficientes, descumprimento de instruções operacionais pelo Muse e defeitos no conjunto Zed/ACP/sandbox. Misturar essas causas produziria correções erradas; cada uma recebe ação e verificação próprias abaixo.

Comportamento positivo a preservar: quando o ambiente impediu testes, o Muse registrou a limitação e não declarou verde sem evidência.

## Achados e correções

| ID | O que ocorreu | Classe e causa | Correção | Verificação/estado |
|---|---|---|---|---|
| W0 | O checkout limpo baseado em `origin/main` não continha `docs/workflows/codex-muse.md`, `muse.md` nem o handoff da tarefa 3; o `AGENTS.md` rastreado apontava para outra máquina. | Empacotamento: regras atualizadas existiam apenas como arquivos locais/não rastreados no checkout antigo. | Versionar `AGENTS.md`, workflow e entrada genérica do Muse em uma mudança documental separada; validar sua existência no checkout alvo antes de delegar. | Gate adicionado; correção documental preparada separadamente. |
| W1 | Um único `muse.md` reuniu três resultados independentes; a tarefa 3 terminou com 14 arquivos e 6.170 adições. | Planejamento: unidade maior que o fluxo de “um resultado verificável”. | Um resultado por handoff; dividir fluxo sensível entre extração, consulta, estados da Nora, geração de proposta e release. | Regra adicionada ao fluxo; aplicar na próxima tarefa. |
| W2 | Testes de helpers e endpoints passaram antes de a jornada natural da Nora, confirmação, auditoria e privacidade estarem corretas. | Especificação: aceite por peças em vez de jornada pública. | Antes de editar, traçar entrada pública, autorização, estado, persistência, auditoria, saída e ausência de efeitos indevidos; exigir teste ponta a ponta dessa jornada. | Modelo do handoff ampliado. |
| W3 | “Seis suítes verdes” foi lido como pré-condição para começar uma correção. | Prompt: condições de entrada e conclusão estavam misturadas. | Nomear explicitamente condições de entrada e portões de conclusão; teste vermelho conhecido orienta a correção. | Regra e campos adicionados. |
| W4 | A entrega precisou de várias rodadas para privacidade fail-closed, idempotência, cancelamento, troca de tenant, concorrência, valores monetários e fidelidade do corpo. | Contrato: invariantes de estado e consistência não estavam todos materializados antes do código. | Para fluxos sensíveis, escrever tabela de estados/transições e matriz de casos concorrentes e ambíguos antes da implementação. | Próxima tarefa deve anexar essa matriz ao handoff. |
| W5 | O ciclo passou de duas rodadas pelo mesmo conjunto de invariantes. | Orquestração: regra de redução de escopo não foi aplicada. | Na segunda rejeição pelo mesmo invariante, parar, reproduzir minimamente e devolver diagnóstico ao Codex. | Regra reforçada no fluxo. |
| W6 | O handoff acumulou muitas rodadas e referências antigas, levando a citações de arquivos que não continham o defeito atual. | Contexto: sedimentação e leitura indiscriminada. | Manter uma seção “Rodada atual” curta no topo; Muse lê apenas essa seção e fontes citadas. Rodadas encerradas ficam como histórico. | Regra adicionada; reorganizar handoffs futuros. |
| W7 | Uma retomada em conversa nova referiu-se ao “prompt anterior” e a um handoff ausente no checkout limpo. O Muse parou pedindo a lista. | Prompt do orquestrador: dependência de contexto inexistente; a parada do Muse foi correta. | Pacote de retomada autossuficiente com caminhos, estado, arquivos e próximo comando. | Modelo de retomada adicionado. |
| W8 | Mesmo instruído a usar uma chamada por vez, o Muse executou Git bruto e agrupou vários comandos com `;`. | Interpretação do Muse: ignorou restrição operacional explícita. | Fornecer o próximo comando exato, wrapper e critério de conclusão; um checkpoint por turno; manter regra ACP de um comando. | Regra adicionada; violação futura encerra o checkpoint. |
| W9 | O Muse criou/amendou commit antes de executar o gate solicitado em uma rodada. | Interpretação do Muse e ordenação do prompt. | Escrever “editar → verificar → revisar diff → commit” como etapas com portões; commit só depois do gate nomeado. | Release atual seguiu a ordem corrigida. |
| W10 | Um prompt tentou cobrir transferência, testes, commit, PR, checks, merge e deploy em um turno. | Prompt: passos posteriores incentivaram pressa e aumentaram duração/risco. | Separar release em seis checkpoints e emitir um prompt por checkpoint. | Regra adicionada. |
| W11 | O workflow Azure aceitava `workflow_dispatch` em qualquer ref e os jobs de release/publicação excluíam apenas PRs. Um disparo manual de branch poderia chegar à publicação. | Configuração de release: faltava restringir jobs de publicação a `main`. | Exigir `refs/heads/main` nos jobs de preflight de release e publicação; confirmar também a restrição externa da credencial Azure, pois uma branch pode alterar seu próprio YAML. | Condições corrigidas em `.github/workflows/azure-container-apps.yml`; configuração efetiva da credencial Azure ainda não verificada. |
| E1 | Sandbox Windows relatou `wfp_ready=false`; GitHub falhou via proxy `127.0.0.1`. | Ambiente: suporte WFP incompleto e postura fixada no início do host. | Executar setup oficial, confirmar `status=ready`/`wfp_ready=true` e reiniciar agente após mudar postura. | Corrigido e documentado no runbook. |
| E2 | Workspace e worktrees deram `dubious ownership` entre N4N e contas `muse-sbx-*`. | Ambiente: identidades Windows diferentes. | Registrar apenas repositórios/worktrees necessários em `safe.directory` para a identidade leitora. | Corrigido nos worktrees da tarefa 3. |
| E3 | Muse não podia ler a configuração pessoal do GitHub; depois o Git falhou com `SEC_E_NO_CREDENTIALS`. | Segurança/ambiente: perfil e Schannel não compartilháveis com sandbox. | Perfil Git/GitHub isolado em `.muse-runtime`, autenticação própria, wrappers e OpenSSL com verificação TLS ativa. | `auth status` e `fetch` passaram. |
| E4 | Python do venv apontava para instalação no perfil privado. | Ambiente: conta sandbox sem leitura/execução. | Conceder acesso somente à instalação Python necessária ou usar runtime do projeto. | Python e testes passaram. |
| E5 | O host acusou aprovação pendente sem mostrar popup e rejeitou follow-up com `approval replay failed`. | Adaptador: o log registrou falhas do ledger de aprovação e uma resolução humana não persistida; não foi omissão do usuário. | Cancelar sessão, verificar disco e retomar em sessão nova; nunca usar mensagem como ping; coletar bundle redigido. | Seis falhas de replay e quatro de durabilidade ocorreram antes do restart; nenhuma imediatamente depois. |
| E6 | Um turno ficou cerca de sete horas após um comando trivial, sem novos eventos. | Adaptador/host: deadlock; processos vivos não significavam progresso. | Watchdog humano: cinco minutos para comando curto; reiniciar agente; segunda ocorrência usa Muse CLI direto. | Processos foram encerrados; worktree permaneceu íntegro. |
| E7 | Suíte `unittest -q` pareceu travar; stack mostrou `NamedTemporaryFile` repetindo após negação de escrita no `TEMP` do sandbox Codex. | Ambiente de teste, não produto. | Capturar stack/CPU; executar suíte sintética fora desse sandbox com autorização. | 167 testes passaram em 23,281 s. |
| E8 | Antivírus bloqueou/segurou binário do Muse durante instalação e execução inicial. | Ambiente local: heurística/arquivo em uso. | Verificar assinatura, hash e fonte; encerrar processo antes de reinstalar; criar exceção somente após validação. | Não reduziu controles do projeto; registrar se reincidir. |
| E9 | `muse-acp` 0.4.5 iniciou com Muse 1.3.0 sem decisão de compatibilidade registrada; o self-test lista hosts 1.0.2 e 1.2.1. | Integração: combinação atual não validada pelo adaptador. A relação causal com replay/deadlock é plausível, mas não comprovada. | Tratar como risco, anexar bundle ao reporte e preferir uma combinação testada ou Muse CLI quando houver reincidência. | Pendente de correção upstream. |
| E10 | Na [execução de `main` 35764542603](https://github.com/T-Lucas43/Norium-nora/actions/runs/35764542603), `validate` e `publish-image` passaram, mas `team-call-quality` falhou: p95 de controle de chamada 778,478 ms acima do limite de 750 ms; o deploy foi pulado. | Gate de qualidade: regressão de desempenho ou variação do runner ainda não distinguida por evidência suficiente. Não há prova de que a tarefa 3 ou o Muse causaram a falha. | Examinar o artefato da execução, repetir a medição em condições equivalentes e corrigir a causa antes de promover a imagem; manter o limite de 750 ms até haver decisão técnica baseada em dados. | Falha confirmada; causa e correção de produto pendentes em investigação separada. |

## Regras de prompt resultantes

1. Declare um resultado único, condições de entrada, portões de conclusão e ponto de parada.
2. Em fluxo sensível, exija evidência da jornada pública e dos efeitos persistidos, não apenas helpers.
3. Dê ao Muse somente a rodada atual e os arquivos necessários.
4. Uma sessão nova recebe todo o estado indispensável; referências a conversas anteriores são inválidas.
5. Dê um checkpoint e o próximo comando exato. No ACP, um comando por chamada e sem separadores.
6. Teste vermelho é evidência para corrigir; teste verde é condição para entregar ou integrar.
7. Commit sucede verificação e revisão do diff.
8. Após duas falhas iguais, mude a abordagem ou devolva diagnóstico; não repita.
9. Atualização de progresso precisa conter evidência e próximo passo.
10. Falha de ferramenta não autoriza afrouxar autenticação, sandbox, aprovação ou TLS.

## Ações duráveis

- [x] Corrigir WFP, rede do sandbox e confiança do workspace.
- [x] Isolar Git/GitHub e manter TLS verificado.
- [x] Dar acesso mínimo ao Python necessário.
- [x] Confiar especificamente nos worktrees para o Zed.
- [x] Adicionar regras de checkpoint, retomada e jornada ao fluxo.
- [x] Restringir os jobs de release/publicação do Azure a `main`.
- [x] Criar runbook de diagnóstico Windows/Zed/ACP.
- [x] Ignorar `.muse-runtime/` no Git rastreado e podar aprovações persistentes de mutação.
- [x] Preparar o pacote documental correto sobre `origin/main` em PR separada.
- [ ] Restringir/recriar os arquivos antigos da credencial local e rotacionar o token após a release.
- [ ] Conferir no Azure a credencial federada efetiva e seu `subject` para `refs/heads/main`.
- [ ] Diagnosticar o p95 do gate `team-call-quality` na execução 35764542603 antes de declarar o último commit de `main` publicado.
- [ ] Se houver novo piloto autorizado, usar um handoff por resultado.
- [ ] Reportar o replay de aprovação e o deadlock ao mantenedor do `muse-acp` com logs redigidos.
- [ ] Se houver novo piloto autorizado, medir rodadas de correção, intervenção humana, duração e uso observado.

## Critério para eventual retomada

Não retome o Muse com base neste documento. Uma nova tentativa exige pedido explícito do usuário e evidência de melhora da ferramenta e do adaptador: nenhuma aprovação invisível, nenhum turno travado e uma tarefa pequena concluída com no máximo duas rodadas por invariante, sem depender da memória de outra conversa. Compare a intervenção total antes de decidir por nova assinatura.
