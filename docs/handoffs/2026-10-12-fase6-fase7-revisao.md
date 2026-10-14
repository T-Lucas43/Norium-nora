# Revisão individual das fases 6/7 — 12/10/2026

## Sequência e limites

Deploy inicial concluído: PR #55, homologação 022ddfc3. Usuário confirmou Gmail
com corpo completo. Direção vigente: Codex individual, sem agentes. Correções
posteriores de agendamentos/fotos foram isoladas no PR #56 para outro deploy,
sem incorporar nem ativar as fases 6/7.

## Implementado na branch local

- Etapa 0: login/cadastro/recuperação/ações de e-mail/modos; logo oficial,
  claro/escuro/375px; lógica de autenticação preservada.
- Fase 1/WIP: verbos/alvos financeiros por palavra, digest/dono/workspace,
  WhatsApp por preparação exata, filtro de mensagens system, DLP central,
  padrões internos sem dono fixo e política de provedores por tenant.
- 6.1: import correto do repositório, PostgreSQL local e worker real; ensaio
  de interrupção sem duplicação, com modelos/identidade/ferramentas sintéticos.
- 6.2–6.4: uma operação por aprovação; ledger durável anterior ao provedor,
  reconciliação por recibo/cabeçalho/eco, ausência não prova não-envio; ferramentas
  de financeiro, tarefas/projetos, agenda, automações, equipe, brainstorm,
  Conhecimento e pesquisa; memória unificada. Com cérebro opt-in, /natural
  direciona ao executor; caminho anterior permanece disponível.
- 6.5–6.6: Meter central, plano/pessoa/franquia compartilhada, chamadas/tokens,
  alertas 80/95, renovação de ciclo, cache limitado por pessoa/workspace e resumo
  minimizado. Interface de Consumo e limites do plano integrada.
- 6.7: dataset sintético pt-BR com 30 casos; avaliação real Groq opt-in, com
  leitura exclusiva de GROQ_API_KEY e banco de consumo sintético separado.
  Corrigida sobreposição integer|number em schema, resposta estruturada do Groq,
  nome de ferramenta validado, catálogo limitado ao domínio explícito e recusa
  de afirmação de ação sem execução comprovada. Aprovação nunca vem do modelo.
- 6.8: embeddings OpenAI mascarados em PG por tenant/usuário/workspace, citações,
  fallback lexical e acentos. Brave oficial, minimização e consumo atribuídos.
- 6.9–6.10: Gmail incremental opt-in por historyId, IDs apenas, checkpoint após
  último lote, intervalo adaptativo/cota e inventário de modelos. Constructor
  falho não pode gravar o checkpoint na conta anterior do loop.
- 7.1–7.2: quota de anexos legados/novos por dono/workspace; retenção opt-in/zero
  desativa categoria; catálogo de exportação/exclusão relacional/SQLite/uploads,
  tombstones/caches/logs; Google revogado antes de remover credencial; ledger
  atual de exclusões fora de dados/backups em ambiente compartilhado; unknown
  store pessoal bloqueia a cobertura, sem exclusão silenciosa.
- 7.3–7.4: minutas de subprocessadores/ROPA/retenção e LegalPage; CPF/telefone/
  e-mail minimizados no logging; auditoria criada no servidor e paginada.
- 7.5: dump e volume criptografados, restore PG/Docker isolado, comparação de
  hashes/contagens/SQLite, reaplicação de exclusões e documentação Shard/rollback.

## Evidências reais

- Backend final 1.465/1.465 na regressão fase67-aceite-final-20261012, zero
  falhas/erros/skips, 821,937 s, cópia temporária sem credenciais/rede externa.
- Frontend final 880/880 em fase67-aceite-final-2-20261012.json. TypeScript,
  lint (warnings existentes, zero erros), Vite/bundle passaram. A primeira
  regressão teve um timeout na interação de personalização; recorte 16/16 e
  repetição completa com dois workers passaram, sem remover teste/gate.
- Planner/cérebro após correções: 64/64 no recorte fase67-planner-final-2.
- Groq real final: 27/30 (90%) em nora-ptbr-real-20261012-p.json, dataset completo
  e argumentos validados no schema. Três falhas recusadas sem efeitos: contratos
  calendar-update/compound-finance e formato de resposta em injection. Não é
  100% nem aceite de todos os fluxos.
- Backup/restauração final: fase7-backup-restore-20261012-2.json. PostgreSQL com
  três conjuntos de duas linhas, três arquivos de volume/um SQLite; hashes e
  contagens iguais após restore, exclusão de uma conta reaplicada e vizinho
  preservado. Restauração 0,875s; total 6,312s; fixture removido.
- Worker: smoke-20261012-2/receipt.json. PG real/worker.run; 0 efeitos antes da
  aprovação, digest alterado recusado, 1 efeito aprovado, reinício -> unknown,
  sem novo efeito. 10,562s. Autenticação viva/provedor real não fazem parte desse
  ensaio; a API tem testes isolados próprios.
- HTTP autenticado adicional: authenticated-928143eb0f8f/receipt.json. Login
  sintético real, health PostgreSQL, web e executor separados com ponte HMAC,
  Groq real; queued -> running -> completed; 0 ferramentas/efeitos, 15,047 s.
  Não conferiu a autenticação real do usuário em homologação.
- Docker precisou ser iniciado novamente em 12/10; retomado somente o PG
  sintético desta tarefa. Contêineres e volumes preexistentes preservados.
- Bandit final: zero findings/erros no mesmo limiar -ll do CI, 64.647 linhas.
  A consulta de tombstones usa SQL literal com ID parametrizado; sem novo nosec.
  Regressão de privacidade/cérebro posterior: 47/47 em fase7-sast-final-2.json.
- Conferência visual: componentes reais de Configurações/Consumo/Privacidade,
  login/cadastro/recuperação, temas claro/escuro; respostas inteiramente
  sintéticas e ações externas bloqueadas. Documento de 375px: conteúdo não
  ultrapassou a largura 375, consumo 82%/renovação/cota 90% visíveis. Não é
  telefone físico nem conferência de dados reais. Imagens em output/ui-20261012.

## Correções promovidas separadamente

PR #56 integrado na main ccfb058e9470f92dba3682d16348cb6b9d470cfb; árvore
5054bbf89f8ad30b8cdda0a7d1cc5cd23bb1df25. Cinco gates PR/main passaram, imagem
auditada transferida sem reconstrução; 34 blobs/rootfs/configuração conferidos.
Backup Shard: 38 tabelas e um arquivo de volume restaurados em isolamento,
hashes/contagens iguais. Homologação 2026.10.12, PostgreSQL/HTTPS prontos.
PC público: altura 720/conteúdo 1.063, scrollTop 342; logo personalizada de
569px carregada duas vezes, sem criar reserva. O responsável confirmou
"Sim, funcionando" após Ctrl+F5: opções de personalização, prévia sem
sobreposição e fotos nos projetos/tarefas, na sua sessão autenticada. Esse
aceite é da interface publicada; não é revisão técnica das rotinas críticas
novas. Fases 6/7 não fazem parte dessa imagem.

## Publicação e revisão pendente

Código estrutural ainda local. Nenhuma retenção, exclusão real, embeddings,
Brave ou Gmail worker ativados em homologação. Só Groq foi autorizado para o
ensaio real; OpenAI/Brave continuam com testes simulados conforme o plano.
Minutas não certificam LGPD; identidade jurídica/encarregado/DPA/região exigem
revisão do responsável. docs/AI_GOVERNANCE.md exige revisão humana das rotinas
críticas antes de promover/ativar. Não reutilizar um backup antigo sem reaplicar
exclusões, nem rearmar um envio inconclusivo. Registrar o último hash/testes antes
da conclusão e apresentar o resultado concreto ao responsável.

## Atualização de integração — 13/10/2026

O hotfix validado foi integrado localmente em 13/10 no commit `32ed8d9`; a
conciliação preservou limites de chamadas/cache/plano, franquia em tokens e os
controles de permissão/isolamento do Gmail. A homologação do hotfix foi
confirmada pelo responsável antes desta integração; isso não revisa nem
autoriza a promoção das fases 6/7.

A opção de anexar arquivo dentro da prévia foi adicionada localmente nesta
branch, conforme `docs/handoffs/2026-10-13-anexos-previsualizacao-email.md`.
Ainda depende de revisão técnica humana, CI e publicação própria. As 22
funcionalidades novas e a Onda 0 continuam fora deste escopo.

## Direção de publicação conjunta — 13/10/2026

O usuário pediu reunir esta entrega com o trabalho do outro chat sobre layout
e personalidade das chamadas e fazer um único deploy. Manter a publicação
pendente até consolidar o pacote dos dois trabalhos, revisar os conflitos e
validar a versão final. Os ajustes adicionais de anexos na prévia de e-mail
também fazem parte do pacote local a consolidar.

O código das fases 6/7 está implementado; a entrega publicada ainda não está
encerrada. Permanecem a validação após a integração mais recente, a revisão
humana das rotinas críticas e o preenchimento/validação dos dados jurídicos,
encarregado, contratos e regiões nos documentos LGPD. Não declarar os testes
anteriores como prova da versão final consolidada nem ativar os workers
opt-in antes das condições de aceite correspondentes.
