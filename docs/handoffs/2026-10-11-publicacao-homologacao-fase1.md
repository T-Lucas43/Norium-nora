# Publicação em homologação e continuidade — 11/10/2026

## Pedido e sequência

O responsável pediu conferir a máquina, publicar no GitHub e atualizar a homologação. Depois da homologação, executar o plano de Fases 6/7 e concluir as pendências dos arquivos entregues. Produção não foi solicitada.

## Fontes e preservação

- Fonte commitada: `feat/fase1-seguranca-voz`, SHA local `6cb948bd`, árvore `ad4012cd5a7370d5ece39c8671fbd797a475896d`.
- A main remota observada é `758277fd1a4b77b9b7ad28cea6fd2515047286ca`; seu incremento de layout `1878aa7` já foi incorporado à fonte local por merge.
- A cópia de publicação está no branch `codex/homologacao-fase1-20261011`.
- Os checkouts originais e suas alterações não commitadas foram preservados. A aplicação ativa da VPS estava saudável no SHA `1878aa7`.
- O Git do terminal não autentica no repositório privado. A publicação usa o conector GitHub, preservando as árvores e mensagens dos commits por assunto. Os novos SHAs e a correspondência com os commits locais ficam no recibo ignorado de output.
- O patch inacabado não foi aplicado ao runtime. Somente a correção financeira necessária para a publicação foi antecipada, por uma falha reproduzida durante a revisão.

## Achado e correção antes da promoção

O executor de `financeExact` aceitava o `ownerId` do payload sem conferir o usuário autenticado. A rota pública de criação de aprovações permite preparar esse payload; um digest fornecido pelo cliente não prova autorização sobre outra conta. Dois testes sintéticos reproduziram a preparação e exclusão indevidas.

A execução agora exige usuário/dono coincidentes, workspace atual, digest obrigatório recomputado sobre a prévia, ação exata e permissão vigente de gastos. A preparação interna também recusa dono diferente. Os testes mantêm os dados da outra conta e o estado anterior quando conteúdo ou permissão mudam. As demais partes do patch permanecem para a etapa posterior.

## Evidência local desta rodada

- Gitleaks 8.24.3: 17 commits do incremento com a correção financeira escaneados, zero segredos encontrados.
- Frontend: 837 testes e 136 arquivos de teste passaram com Node 24.19.0; TypeScript, Vite e orçamento do bundle passaram. Oxlint: zero erros, avisos existentes registrados no log.
- npm audit após instalação do lockfile: zero vulnerabilidades reportadas.
- Regressão financeira: 13 testes, zero falhas, erros ou skips. Antes da correção, dois casos reproduziram a falha.
- `git diff --check` dos arquivos runtime passou. O patch arquivado contém espaços de contexto próprios do formato unified diff; não foi alterado para não corromper o artefato.
- Backend completo: 1.397 testes, zero falhas, erros ou skips; 573,625 s, fonte/dados temporários, sem dotenv ou sockets externos.
- Workflow, empacotamento e transporte: 37 testes passaram (23,412 s); SSH/deploy são mocks. A limitação de acesso a temporários no sandbox exigiu rodar com diretório temporário da tarefa e autorização do ambiente.
- CI GitHub da revisão final e aceite remoto: pendentes.

## Primeira execução GitHub e correção da imagem

PR #53, head `0acf64d`, CI `38159730141`: build, identidade e DOM com sandbox passaram; o gate Trivy bloqueou três HIGH no arquivo `usr/bin/pebble`, stdlib Go `v1.26.7`: CVE-2026-78667, CVE-2026-78669 e CVE-2026-97031. O relatório aponta versões corrigidas 1.26.9/1.27.2; a [fonte oficial Go](https://go.dev/doc/devel/release#go1.26.9) confirma atualização de segurança de 08/10/2026. Evidência no artifact `11708989282`, vinculada à imagem/revisão.

O relatório da imagem confirma entrypoint nulo e CMD com `exec uvicorn`; o projeto não usa Pebble. A proposta remove somente esse binário opcional do filesystem final e explicita `ENTRYPOINT []`; preserva FFmpeg, Chrome, metadados de pacotes, sandbox e scanners sem ignores. Nova execução da revisão corrigida precisa comprovar zero HIGH/CRITICAL; o relato local não antecipa esse gate.

Consulta pública atual: `/api/system/release` confirma homologação `1878aa7`, versão `2026.10.08`; `/health/ready` retorna `ready`. A UI GitHub mostrou somente environments Preview/Production e nenhuma credencial `SHARD_VPS_*` nos nomes dos secrets do repositório (valores não lidos). A configuração do novo fluxo continua pendente.

## GitHub como padrão de deploy

O responsável reiterou que o deploy deve usar GitHub Actions. O workflow anterior só validava e gerava ZIP. A proposta acrescenta dispatch explícito em main, com `deploy_homologacao`, depois de todos os gates, e transporte da mesma imagem Docker auditada (sem rebuild no host). A VPS é acessada via SSH com known_hosts previamente conferido; credenciais não entram no PR, recibo ou conversa.

`infra/shard/DEPLOY_GITHUB.md` descreve a configuração e o protocolo separado do executor host. **O executor ainda precisa ser implementado/provisionado e revisado**, e os secrets/environment precisam ser confirmados. Nenhum deploy foi executado por este workflow, nem pelo console Shard nesta rodada. O transporte nega publicação sem preflight e recibo completos. Não tratar os mocks como prova de backup/restore, sandbox, login, WebSocket ou deploy remoto.

## Gates para homologação

1. CI completo da revisão final: backend, frontend, persistência PostgreSQL, chamadas, scanner de segredos, imagem e pacote determinístico.
2. Revisão humana técnica do incremento crítico, exigida por `docs/AI_GOVERNANCE.md`; registrar o aceite no PR antes da promoção.
3. Pacote do SHA exato publicado, recibo/hashes, imagem imutável e controles do runtime preservados.
4. Backup fresco e prova de restauração/inventário antes de qualquer migração de dados/schema; nenhuma inicialização vazia autorizada.
5. Preservar configuração, dados e imagem anterior para rollback. Confirmar readiness PostgreSQL, identidade do release, login, dados e WebSocket após a troca.

## Etapa posterior autorizada

Após o aceite de homologação, reconciliar o restante do patch na fonte correspondente, concluir Fase 1 e executar Fases 6/7 conforme os dois documentos fornecidos. Ativar o cérebro primeiro no PostgreSQL local. Chaves Brave/OpenAI e efeitos externos reais dependem dos limites descritos no plano e de autorização específica de credenciais/contas; usar mocks nos testes. As demais fases e novas funcionalidades são backlog e não fazem parte desta publicação.
