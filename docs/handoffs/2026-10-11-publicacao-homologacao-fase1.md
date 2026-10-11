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

- Gitleaks 8.24.3: 16 commits do incremento escaneados, zero segredos encontrados.
- Frontend: 837 testes e 136 arquivos de teste passaram com Node 24.19.0; TypeScript, Vite e orçamento do bundle passaram. Oxlint: zero erros, avisos existentes registrados no log.
- npm audit após instalação do lockfile: zero vulnerabilidades reportadas.
- Regressão financeira: 13 testes, zero falhas, erros ou skips. Antes da correção, dois casos reproduziram a falha.
- `git diff --check` dos arquivos runtime passou. O patch arquivado contém espaços de contexto próprios do formato unified diff; não foi alterado para não corromper o artefato.
- Suíte backend completa e CI da revisão final: em andamento, sem aceite antecipado.

## Gates para homologação

1. CI completo da revisão final: backend, frontend, persistência PostgreSQL, chamadas, scanner de segredos, imagem e pacote determinístico.
2. Revisão humana técnica do incremento crítico, exigida por `docs/AI_GOVERNANCE.md`; registrar o aceite no PR antes da promoção.
3. Pacote do SHA exato publicado, recibo/hashes, imagem imutável e controles do runtime preservados.
4. Backup fresco e prova de restauração/inventário antes de qualquer migração de dados/schema; nenhuma inicialização vazia autorizada.
5. Preservar configuração, dados e imagem anterior para rollback. Confirmar readiness PostgreSQL, identidade do release, login, dados e WebSocket após a troca.

## Etapa posterior autorizada

Após o aceite de homologação, reconciliar o restante do patch na fonte correspondente, concluir Fase 1 e executar Fases 6/7 conforme os dois documentos fornecidos. Ativar o cérebro primeiro no PostgreSQL local. Chaves Brave/OpenAI e efeitos externos reais dependem dos limites descritos no plano e de autorização específica de credenciais/contas; usar mocks nos testes. As demais fases e novas funcionalidades são backlog e não fazem parte desta publicação.
