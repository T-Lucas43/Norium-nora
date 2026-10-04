# Segurança, sessões e homologação — estado de implementação

Data: 03/10/2026. Execução direta Codex, sem Muse. O usuário autorizou incorporar os achados no plano, corrigir, implementar e publicar em homologação, mantendo as políticas existentes. Este registro não equivale a aceite de lançamento.

## Contexto preservado

- Homologação: `https://norium.shardweb.app`. Produção inexistente, conforme usuário.
- Usar a conta de teste designada no diálogo. Não registrar senha, token ou cookie neste arquivo.
- Checkout possui numerosas alterações preexistentes, preservadas. Branch `codex/fix-fast-scheduling-whatsapp`; HEAD inicial `5f7430e84575da14ae4c31cc9614fd784d95869c`.
- A primeira tentativa de fetch via helper GitHub CLI respondeu Repository not found. Uma tentativa posterior com o Git Credential Manager Windows já configurado concluiu o fetch, sem mudar configuração permanente ou mostrar credenciais. Main confirmada: `56ece8e102144a4ad9777d374f471a7199824dff`.
- Candidato separado em `output/security-remediation-2026-10-03/candidate`, branch `codex/security-session-homologacao`, baseado nessa main. Integração preservou diferenças de upstream (incluindo o teste de reações da equipe) e não copiou as demais modificações preexistentes. Commits `5654e04` (frontend), `fa349ce` (backend), `0c79258` (documentação), `a2a626f` (DNS/OAuth) e `abad297` (gate PostgreSQL). Publicação em branch de revisão está em preparação, sem promoção ou deploy.
- `DEPLOY_SHARDCLOUD.md` e `Dockerfile.shard` existem na referência local origin/main, mas não no checkout atual. Procedimento consultado exige snapshot do commit exato validado/enviado, dados preservados, readiness PostgreSQL e smokes autenticados.

## Correções iniciadas

- QA-01: relógio Date fixado em setembro/2026 no teste financeiro, sem trocar os timers assíncronos reais.
- QA-02: Tailwind detecta fontes apenas em src e exclui testes; orçamento original de CSS/JS preservado. CSS principal passou de 427.092 para 397.390 bytes na cópia de validação.
- SEC-DEP-01: pypdf 6.19.0 no requirements e lock; urllib3 2.8.0 no lock; DOMPurify 3.4.16 transitivo no package-lock, única alteração de pacote npm. Driver psycopg declarado também instalado; instalação não prova integração com PostgreSQL real. Retomada atualizou oauthlib para 4.0.0, com fonte oficial e três regressões de cliente real, sem mudar código da autenticação Norium. Versão 3.3.2 citada no advisory não estava publicada no PyPI consultado; 4.0.0 foi a versão corrigida disponível. Scan atual do lock: 67 dependências, zero alertas conhecidos. Frontend produção zero alertas. Imagem/SBOM remoto ainda pendentes.
- SEC-FILE-01: limites cumulativos na camada compartilhada de binários. PostgreSQL toma lock transacional e verifica uso/variação na mesma conexão antes de gravar; local usa lock do processo e substituição atômica. Primário não inclui workspaces irmãos; substituir arquivo desconta tamanho anterior. Defaults: global 4 GiB, workspace 512 MiB; variáveis documentadas em .env.example.
- Arquivos de sistema sem prefixo de usuário recebem limite global; a quota por workspace é aplicada às chaves cujo caminho identifica o workspace. Gravações diretas fora dessa camada precisam de reconciliação adicional. Não afirmar cobertura de todos os bytes do sistema.
- SEC-SSRF-01: nova camada `public_http.py` conecta somente aos IPs públicos da resolução feita no backend TCP, mantendo Host, SNI e verificação TLS do domínio original. Página pública, teste/gateway de modelos e mídia WhatsApp usam esse transporte. HTTPS, allowlist e bloqueio de proxies de ambiente aplicam as regras existentes. Browser Chromium permanece pendente de proteção no nível de conexão/egress, incluindo subrecursos/WebSockets.
- CI PostgreSQL: ampliado `infra/azure/test_postgres_persistence.py` para provar quotas em duas conexões reais simultâneas, rejeição sem gravar overflow, substituição, isolamento de escopos e limite global. O executável agora rejeita bancos remotos, modo diferente de test e divergência da URL Nora antes de inicializar schemas. Esta prova ainda precisa rodar no serviço PostgreSQL descartável do CI; não foi executada em homologação.

## Validação até agora

- Teste financeiro focado: aprovado.
- Build completo da cópia de fontes: aprovado, incluindo check:bundle.
- 9 testes novos de quota, incluindo concorrência local; temporários e PostgreSQL capturado. Isso não é prova de concorrência real entre réplicas. Lock PostgreSQL possui timeout de espera de 5 segundos.
- Primeira suíte pós-correção: 1.127 testes, 19 erros por fixtures de upload fora da raiz configurada. Fixtures foram alinhadas com a raiz sintética, mantendo rejeição fora da raiz. Regressão focada: 92 testes aprovados; suíte completa posterior: 1.128 testes, zero falhas/erros/skips.
- Frontend pasta original/copied sources: 769/769 aprovados, lint sem erros, build aprovado. Candidato main: 780/780 aprovados com Node 24.19.0; TypeScript, Vite e orçamento próprios da main aprovados. Main já possuía limite CSS de 410 KB, preservado; CSS resultou em 402.301 bytes. A pasta original mantém limite de 400 KB, com CSS 397.390 bytes.
- Bandit pós-correção: 23 LOW, nenhum MEDIUM/HIGH.
- Primeira suíte backend do candidato main: 1.130 testes, 2 falhas adicionais herdadas da main (compatibilidade do schema de status customizados do Kanban e ajuda ausente para Modelos de mensagens). Correções limitadas ao candidato: comparador valida todos os valores antigos contra o padrão atual, preserva nullable e rejeita estreitamento; ajuda descreve a tela real, sem prometer envio automático. 12 testes focados aprovados. Suíte completa posterior: **1.133 testes, zero falhas, erros ou skips**, 313,682 segundos totais. Evidência: `candidate/output/pos-correcao/security-candidate-final.json` e `.log`.
- Evidências: `output/security-remediation-2026-10-03/`, `output/pos-correcao/security-remediation-*`, e arquivos `*-remediation.*` em `output/security-review-2026-10-03/`.
- Retomada: 91 testes focados HTTP/OAuth/gateway/research; 53 testes HTTP/mídia WhatsApp; ambos aprovados. Suíte completa posterior com mídia incluída: **1.151 testes**, zero falhas/erros/skips, 368,002 segundos totais. Evidência: `output/pos-correcao/security-candidate-complete-final.json` e `.log`. Dois testes da trava CI foram acrescentados depois e passaram junto aos nove testes de quota (11/11); a suíte de CI final inclui esses testes. Bandit atual: 23 LOW e nenhum MEDIUM/HIGH. Scans não demonstram ausência universal de vulnerabilidades nem a imagem remota.

## Acesso administrativo recuperado na retomada

- Repositório privado confirmado pelo conector GitHub: `T-Lucas43/Norium-nora`, ID 1315611283. A antiga URL noriumnoraai-ui redireciona; main ainda é 56ece8e. PR executa validação isolada; publicação da imagem/deploy do workflow Azure são excluídos em pull_request. Não enviar esta branch para main enquanto os gates críticos estiverem abertos.
- Shard autenticado pela sessão GitHub já existente, sem novas permissões ou credenciais digitadas. Aplicação de homologação `norium-next`, ID `3fb1c8ed-04ca-41aa-a03e-7d2eab6f598f`; domínio norium.shardweb.app. Imagem ativa observada: `norium-fullstack-a7d339e`, Pronta, 1,7 GB, alteração 25/09/2026 21:17:40. Isso não comprova digest/SHA de release.
- Variáveis públicas verificadas individualmente, sem coletar senhas/tokens/chaves: backend https://norium.shardweb.app; callback Gmail /api/auth/callback/gmail; callback Agenda /api/integracoes/google/callback; dados /app/data; SPA /opt/norium/static; WEB_CONCURRENCY=1. A ocultação foi restaurada após cada leitura.
- OAuth efetivo usa clientes com prefixo de projeto **385151241277**, diferentes dos clientes antigos **172529642176** do projeto Google "Norium Producao". O cliente antigo Gmail tem apenas callbacks Azure; essa ausência não prova a configuração do cliente efetivo. Nenhum callback foi alterado no cliente errado. Busca do projeto correto continua nas sessões administrativas disponíveis.

## Requisitos pendentes

1. Participação especializada: `docs/AI_GOVERNANCE.md` proíbe implementar/aprovar sozinho autenticação, criptografia e infraestrutura crítica. A pergunta sobre responsável foi enviada ao usuário; ainda sem resposta.
2. Política de sessão: `SECURITY.md` proíbe persistência de tokens. Cookie persistente não será introduzido como exceção silenciosa. Resolver compatibilidade com responsável habilitado antes de implementar.
3. Git e Shard recuperados; cliente Google efetivo ainda precisa ser localizado/conferido. O acesso ao projeto antigo não resolve o erro da homologação. A solicitação anterior de login manual no Shard ficou dispensada pela recuperação da sessão existente.
4. Segunda conta designada para isolamento A/B e smokes de equipe; provas locais não substituem jornadas remotas.
5. Gates operacionais: imagem identificada, backup/restauração PostgreSQL, preservação de dados, rollback, alertas, privacidade e verificação pós-deploy.

Nenhum deploy foi executado até este registro. A branch/PR de revisão contém correções parciais; mudanças críticas de sessão/criptografia e configuração remota permanecem pendentes. Não comunicar tudo corrigido nem homologação atualizada sem evidências.

## Próxima retomada

- Continuar pelo candidato `output/security-remediation-2026-10-03/candidate`, não fazer merge/reset da pasta original suja.
- A configuração temporária Vitest da cópia de validação foi removida após o teste; dependências estão num junction local ignorado. Artefatos do frontend ficam na pasta `output/security-remediation-2026-10-03/`, fora do candidato versionado.
- Obter as respostas pendentes sobre especialista e sessões dos painéis Shard/Google; não solicitar senhas no chat e não tratar tempo sem resposta como aprovação.
- Antes do deploy completo, resolver todos os gates críticos listados. Os commits atuais são correções parciais e **não** um release aprovado de sessões persistentes.
