# Segurança, sessões e homologação — estado de implementação

Data: 03/10/2026. Execução direta Codex, sem Muse. O usuário autorizou incorporar os achados no plano, corrigir, implementar e publicar em homologação, mantendo as políticas existentes. Este registro não equivale a aceite de lançamento.

## Contexto preservado

- Homologação: `https://norium.shardweb.app`. Produção inexistente, conforme usuário.
- Usar a conta de teste designada no diálogo. Não registrar senha, token ou cookie neste arquivo.
- Checkout possui numerosas alterações preexistentes, preservadas. Branch `codex/fix-fast-scheduling-whatsapp`; HEAD inicial `5f7430e84575da14ae4c31cc9614fd784d95869c`.
- A primeira tentativa de fetch via helper GitHub CLI respondeu Repository not found. Uma tentativa posterior com o Git Credential Manager Windows já configurado concluiu o fetch, sem mudar configuração permanente ou mostrar credenciais. Main confirmada: `56ece8e102144a4ad9777d374f471a7199824dff`.
- Candidato separado em `output/security-remediation-2026-10-03/candidate`, branch `codex/security-session-homologacao`, baseado nessa main. Integração preservou diferenças de upstream (incluindo o teste de reações da equipe) e não copiou as demais modificações preexistentes. Commits locais `5654e04` (frontend) e `fa349ce` (backend); não publicados.
- `DEPLOY_SHARDCLOUD.md` e `Dockerfile.shard` existem na referência local origin/main, mas não no checkout atual. Procedimento consultado exige snapshot do commit exato validado/enviado, dados preservados, readiness PostgreSQL e smokes autenticados.

## Correções iniciadas

- QA-01: relógio Date fixado em setembro/2026 no teste financeiro, sem trocar os timers assíncronos reais.
- QA-02: Tailwind detecta fontes apenas em src e exclui testes; orçamento original de CSS/JS preservado. CSS principal passou de 427.092 para 397.390 bytes na cópia de validação.
- SEC-DEP-01: pypdf 6.19.0 no requirements e lock; urllib3 2.8.0 no lock; DOMPurify 3.4.16 transitivo no package-lock, única alteração de pacote npm. Instalados para regressão. Driver psycopg declarado também instalado; instalação não prova integração com PostgreSQL real. Lock backend passou de 12 para 1 registro (oauthlib 3.3.1, revisão de migração para 4.0.0 pendente); frontend produção zero alertas.
- SEC-FILE-01: limites cumulativos na camada compartilhada de binários. PostgreSQL toma lock transacional e verifica uso/variação na mesma conexão antes de gravar; local usa lock do processo e substituição atômica. Primário não inclui workspaces irmãos; substituir arquivo desconta tamanho anterior. Defaults: global 4 GiB, workspace 512 MiB; variáveis documentadas em .env.example.
- Arquivos de sistema sem prefixo de usuário recebem limite global; a quota por workspace é aplicada às chaves cujo caminho identifica o workspace. Gravações diretas fora dessa camada precisam de reconciliação adicional. Não afirmar cobertura de todos os bytes do sistema.

## Validação até agora

- Teste financeiro focado: aprovado.
- Build completo da cópia de fontes: aprovado, incluindo check:bundle.
- 9 testes novos de quota, incluindo concorrência local; temporários e PostgreSQL capturado. Isso não é prova de concorrência real entre réplicas. Lock PostgreSQL possui timeout de espera de 5 segundos.
- Primeira suíte pós-correção: 1.127 testes, 19 erros por fixtures de upload fora da raiz configurada. Fixtures foram alinhadas com a raiz sintética, mantendo rejeição fora da raiz. Regressão focada: 92 testes aprovados; suíte completa posterior: 1.128 testes, zero falhas/erros/skips.
- Frontend pasta original/copied sources: 769/769 aprovados, lint sem erros, build aprovado. Candidato main: 780/780 aprovados com Node 24.19.0; TypeScript, Vite e orçamento próprios da main aprovados. Main já possuía limite CSS de 410 KB, preservado; CSS resultou em 402.301 bytes. A pasta original mantém limite de 400 KB, com CSS 397.390 bytes.
- Bandit pós-correção: 23 LOW, nenhum MEDIUM/HIGH.
- Primeira suíte backend do candidato main: 1.130 testes, 2 falhas adicionais herdadas da main (compatibilidade do schema de status customizados do Kanban e ajuda ausente para Modelos de mensagens). Correções limitadas ao candidato: comparador valida todos os valores antigos contra o padrão atual, preserva nullable e rejeita estreitamento; ajuda descreve a tela real, sem prometer envio automático. 12 testes focados aprovados. Suíte completa posterior: **1.133 testes, zero falhas, erros ou skips**, 313,682 segundos totais. Evidência: `candidate/output/pos-correcao/security-candidate-final.json` e `.log`.
- Evidências: `output/security-remediation-2026-10-03/`, `output/pos-correcao/security-remediation-*`, e arquivos `*-remediation.*` em `output/security-review-2026-10-03/`.

## Requisitos pendentes

1. Participação especializada: `docs/AI_GOVERNANCE.md` proíbe implementar/aprovar sozinho autenticação, criptografia e infraestrutura crítica. A pergunta sobre responsável foi enviada ao usuário; ainda sem resposta.
2. Política de sessão: `SECURITY.md` proíbe persistência de tokens. Cookie persistente não será introduzido como exceção silenciosa. Resolver compatibilidade com responsável habilitado antes de implementar.
3. Git recuperado; painel Shard e cliente OAuth Google ainda indisponíveis. Inventário do navegador contém apenas a aba Norium autenticada. Pergunta de acesso enviada, sem solicitar segredos no chat.
4. Segunda conta designada para isolamento A/B e smokes de equipe; provas locais não substituem jornadas remotas.
5. Gates operacionais: imagem identificada, backup/restauração PostgreSQL, preservação de dados, rollback, alertas, privacidade e verificação pós-deploy.

Nenhum push ou deploy foi executado até este registro. Mudanças críticas de sessão/criptografia e configuração remota permanecem pendentes. Não comunicar tudo corrigido nem homologação atualizada sem evidências.

## Próxima retomada

- Continuar pelo candidato `output/security-remediation-2026-10-03/candidate`, não fazer merge/reset da pasta original suja.
- A configuração temporária Vitest da cópia de validação foi removida após o teste; dependências estão num junction local ignorado. Artefatos do frontend ficam na pasta `output/security-remediation-2026-10-03/`, fora do candidato versionado.
- Obter as respostas pendentes sobre especialista e sessões dos painéis Shard/Google; não solicitar senhas no chat e não tratar tempo sem resposta como aprovação.
- Antes do deploy completo, resolver todos os gates críticos listados. Os commits atuais são correções parciais e **não** um release aprovado de sessões persistentes.
