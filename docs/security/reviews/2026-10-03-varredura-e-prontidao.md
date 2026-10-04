# Varredura de segurança e prontidão de lançamento — Norium

Data: 03/10/2026. Resultado desta rodada: **NO-GO para lançamento público**. Varredura inicial concluída dentro dos acessos disponíveis; validação integral de lançamento permanece pendente.

Escopo: código local, arquivos, dependências, testes isolados e homologação autorizada. O usuário confirmou que não existe produção; validação em produção depende da criação desse ambiente e não será apresentada como executada.

## Resumo executivo

O erro Gmail enviado pelo usuário foi registrado abaixo como HOM-OAUTH-01. O login do Norium com a conta de teste corrigida funcionou, e recarregar a aba restaurou a sessão. Isso não demonstra persistência depois de fechar e reabrir o navegador.

Não foi confirmada SQL Injection nos caminhos examinados. Strings como `DROP DATABASE`, `DROP TABLE` e aspas em nomes foram tratadas como dados em testes isolados; tentativas de autenticação por injeção foram recusadas. Esses testes usaram captura de parâmetros, sem executar comandos destrutivos ou acessar um banco real. Aceitar essas palavras em um nome não é uma vulnerabilidade por si só: o critério é não interpretá-las como SQL.

Há achados de segurança no código: revogação incompleta em WebSockets de Inbox/Brainstorm, gravações sem quota acumulada central, credenciais Gmail persistidas sem criptografia de aplicação e configuração de container que termina como root. Dependências declaradas também possuem alertas conhecidos. A possível troca de endereço DNS entre validação e conexão precisa de reprodução controlada.

O frontend não concluiu os critérios locais de entrega: um teste falha com a data atual e o comando de build termina com erro no limite de CSS. Backend verde e HTTPS válido não encerram esses achados nem certificam o lançamento.

## Versão, método e limites

- Checkout: `C:\Users\Tarcisio Lucas\norium`, branch `codex/fix-fast-scheduling-whatsapp`, HEAD `5f7430e84575da14ae4c31cc9614fd784d95869c`, com alterações preexistentes preservadas.
- Referência local `origin/main`: HEAD estava 6 commits à frente e 20 atrás. Não houve fetch; a comparação não representa o estado atualizado do servidor Git.
- `/health` da homologação retornou somente `status=ok`, sem SHA. Não foi possível vincular o código local à imagem publicada. GitHub CLI sem autenticação e ausência de acesso administrativo impediram conferir imagem, SBOM e execução de pipeline.
- Inventário AST: 203 arquivos Python, nenhum erro de sintaxe, 516 declarações de rotas e 215 chamadas candidatas de execução. São contagens de inventário, com falsos positivos; não significam 215 consultas SQL vulneráveis. OpenAPI remoto: 414 caminhos.
- Revisão de autenticação/autorização, isolamento, SQL, arquivos, uploads, HTML, fetch remoto, WebSockets, integrações, segredos, dependências, container, persistência, políticas e requisitos operacionais. Foram usados testes existentes e provas sintéticas adicionais.
- Homologação: navegação autenticada com a conta designada e requisições GET/OPTIONS não destrutivas. Sem enumeração de contas reais, exclusão, carga agressiva, envio de e-mail/WhatsApp ou SQL destrutivo.
- Testes adicionais usam dados sintéticos, armazenamento temporário, adaptadores capturadores e sockets simulados. O driver PostgreSQL está ausente no venv local; readiness remoto não substitui integração transacional real.
- Não foi executada uma auditoria dinâmica de todas as rotas, nem exame administrativo de ACLs, secret manager, rede, banco, volumes ou imagens. Secret scanning histórico completo não foi executado nesta rodada; a presença de Gitleaks no workflow não prova que ele passou.
- Uma varredura ampla reduz risco, mas não garante descobrir toda falha existente. Achados abaixo distinguem confirmação local, observação remota e hipótese a validar.

## Evidências automatizadas desta rodada

Artefatos privados em `output/security-review-2026-10-03/`, ignorados pelo Git. Não contêm a senha de teste nem tokens reais.

| Verificação | Resultado | Limite da evidência |
| --- | --- | --- |
| Backend completo isolado | 1.119 testes; zero falhas, erros ou skips | Cópia temporária, dotenv e rede externa bloqueados; não é integração com banco/serviços publicados |
| Provas adicionais | 6 testes; zero falhas/erros | SQL capturado com substituto de Jsonb, HTTP sintético e WebSocket simulado; não executam PostgreSQL real |
| Frontend completo em cópia de fontes | 769 testes; 768 aprovados e 1 falha | Vitest agrega 269 suites, 267 aprovadas e 2 falhas, referentes ao grupo/teste financeiro; somente um arquivo de teste falha |
| Lint frontend | 19 avisos; nenhum erro registrado | Avisos preexistentes, incluindo dependências de hooks e Fast Refresh |
| Build frontend | TypeScript e Vite concluíram; comando final reprovou | CSS 427.092 bytes excede limite de 400.000; `check:bundle` retorna erro |
| Bandit | 23 achados LOW; zero MEDIUM/HIGH | Não equivale a ausência de vulnerabilidades; cobertura de Python conforme ferramenta |
| Dependências backend declaradas | 12 registros de alertas em 3 pacotes | `requirements.lock.txt`; não é SBOM da imagem em homologação |
| Dependências instaladas no venv | 33 registros em 9 pacotes | Há registros duplicados; não são 33 vulnerabilidades únicas. Ambiente diverge do lockfile |
| Dependências frontend de produção | 1 alerta LOW transitivo de DOMPurify | Não foi demonstrada exploração do modo/hook específico no produto |
| Backup/restauração sintéticos | 3 testes de arquivo criptografado + 6 de recuperação aprovados | JSON/SQLite e funções locais; não provam restauração do PostgreSQL remoto |

Arquivos: `source-inventory.json`, `synthetic-probes.json`, `frontend-tests-final.json`, `frontend-tests-final.log`, `frontend-lint.log`, `frontend-build.log`, `bandit.json`, `backend-lock-audit.json`, `python-audit.json`, `frontend-audit.json`, `backup-tests.log`, `restore-tests.log`, `remote-probes.json` e `remote-openapi.json`. Backend: `output/pos-correcao/security-20261003.json` e `.log`.

A primeira execução do frontend teve cinco erros de acesso a fontes PDF fora da cópia de trabalho, pelo junction de dependências. A configuração exclusiva da cópia de auditoria passou a permitir esse diretório e a suíte inteira foi repetida. Esses erros do executor não foram atribuídos ao produto; o resultado final é o da tabela.

## Homologação: o que foi confirmado

| Controle/jornada | Observação | Conclusão permitida |
| --- | --- | --- |
| Login da conta de teste e recarga | Dashboard autenticado, restaurado após reload | Login e recuperação na mesma aba funcionaram |
| `/health/ready` | HTTP 200, persistência pronta, driver `postgresql`, schema 1 | Readiness naquele instante; não prova migração completa, backup ou concorrência |
| `/api/auth/me`, `/api/auth/users`, `/api/clientes`, `/api/auth/privacy/export` anônimos | HTTP 401 | Esses caminhos exigiram autenticação |
| Bearer inválido em `/api/auth/me` | HTTP 401 | Token sintético inválido recusado |
| OPTIONS de origem não autorizada para login | HTTP 400, sem liberação da origem ou credenciais | Origem estrangeira examinada não foi liberada |
| TLS | Certificado validado pelo cliente HTTPS, emissor Google Trust Services | Verificação válida naquela conexão |
| Cabeçalhos | HSTS, CSP, DENY para frames, nosniff, referrer e permissions policy | Controles observados nas respostas consultadas; CSP admite inline em estilos e HTTPS/WSS em conexões |
| OpenAPI | HTTP 200, 414 caminhos | Inventário público; não constitui autorização para dados privados |
| Gmail | Captura do usuário: `400 redirect_uri_mismatch` | Integração falha no consentimento; precisa de diagnóstico de configuração |

Não foi demonstrado isolamento A/B remoto, revogação de sockets remotos, cookies persistentes, todas as jornadas CRUD, chamadas, mídia, OAuth bem-sucedido, webhooks externos ou restauração depois de reinício. Nenhuma dessas pendências deve ser marcada como aprovada.

## Achados registrados durante a execução

Prioridade P1: corrigir ou esclarecer antes de disponibilizar a superfície afetada. P2: corrigir antes da aceitação final ou registrar decisão humana fundamentada. Prioridade é ordem de trabalho, não pontuação CVSS.

### HOM-OAUTH-01 — Conexão Gmail bloqueada por URL de retorno OAuth

- Prioridade: P1 para disponibilizar a integração Gmail no lançamento.
- Confiança: falha observada na captura enviada pelo usuário; causa de configuração ainda a confirmar.
- Ambiente: homologação em `https://norium.shardweb.app`.
- Evidência: Google exibe “Acesso bloqueado: a solicitação desse app é inválida” e `Erro 400: redirect_uri_mismatch` durante a conexão de e-mail da conta de teste.
- Impacto: o fluxo não conclui autorização nem conexão de Gmail. Não é prova de SQL Injection, comprometimento da conta ou vazamento de token.
- Próxima verificação: comparar a `redirect_uri` efetivamente enviada pelo backend com a lista de URIs autorizadas do cliente OAuth correto no Google Cloud, preservando protocolo, domínio, porta, caminho e barra final.
- Limite: não registrar senhas, client secrets, authorization codes ou tokens nos artefatos. Não abrir origens ou remover validações para contornar o erro.
- Aceite: autorização Google conclui o callback esperado no domínio da homologação, conta correta fica conectada, CSRF/state e acesso por usuário são mantidos, envio e leitura só ocorrem em jornada de teste autorizada.
- Evidência visual privada: `output/security-review-2026-10-03/oauth-redirect-mismatch.png` (ignorada pelo Git).

O callback no código é `/api/auth/callback/gmail`, definido em `norium-back-end/app/services/gmail_service.py:54`; `_redirect_uri` em linha 603 resolve a configuração. O candidato esperado, se a API usa esse domínio público, é `https://norium.shardweb.app/api/auth/callback/gmail`. A URI efetiva da solicitação e a lista do Google Cloud não foram acessadas; não se afirma que esse candidato é a configuração publicada. A correspondência exata é exigida pela [documentação Google](https://developers.google.com/identity/protocols/oauth2/web-server).

### SEC-WS-01 — Revogação incompleta em conexões abertas

- P1; confirmado por código e observação sintética limitada.
- `app/modules/inbox/router.py:98` envia aos sockets registrados sem lookup de revogação; `:319` autentica o ticket uma vez e o loop continua usando a identidade capturada, inclusive `REGISTER_EVENT`.
- `app/modules/brainstorm/router.py:268` verifica ticket/acesso na abertura; `:297` processa `BOARD_UPDATE` sem revalidar versão/revogação/validade durante o loop. Broadcast também não revalida.
- Prova isolada: o manager de Inbox entregou evento privado sintético sem consultar o armazenamento de usuários. Não houve exploração de socket em homologação.
- Impacto: credenciais revogadas ou vencidas podem não encerrar o acesso de uma conexão já estabelecida. A equipe possui verificações próprias; o achado não é atribuído indistintamente a todos os sockets.
- Ação: revalidar contexto de autorização antes de eventos e escritas, expirar conexões e propagar revogação entre processos. Na proposta de sessões, incluir `sid`.
- Aceite: após logout, troca de senha, expiração e revogação, sockets antigos não recebem nem gravam dados; demonstrar também com duas instâncias e dois usuários.

### SEC-FILE-01 — Quota acumulada não cobre todas as gravações

- P1; lacuna confirmada em código, sem teste de exaustão remoto.
- `app/modules/clients/router.py:93` limita 100 anexos por ficha e o decoder limita 15 MB por arquivo, mas não consulta quota acumulada do workspace/global antes de gravar. Várias fichas multiplicam o armazenamento permitido.
- `app/modules/clients/files.py:90` e `app/modules/commercial/document_files.py:203`/`:728` escrevem pela camada `app/infrastructure/persistence/files.py:16`, sem enforcement central de quota.
- Há quota em `app/infrastructure/storage_quota.py:44`, utilizada em outras superfícies. Não cobre automaticamente toda gravação; locks locais também não demonstram atomicidade entre réplicas.
- Impacto: usuário autorizado pode acumular arquivos acima do orçamento pretendido e pressionar disco/banco. Limite por arquivo é controle positivo, mas não garante capacidade global.
- Ação: reserva/contabilização transacional por workspace e total, incluindo importações e arquivos derivados; liberar reserva em falhas, substituições e exclusões.
- Aceite: concorrência não ultrapassa quota; todos os caminhos relevantes recusam gravação antes de ocupar espaço; tenants permanecem isolados.

### SEC-SECRET-01 — Credenciais Gmail serializadas sem proteção de aplicação

- P1; confirmado no caminho de persistência local. Não houve leitura de segredos reais ou prova de vazamento pela API.
- `app/services/gmail_service.py:548` salva `creds.to_json()` e preserva `refresh_token`; `:1050`/`:1079` gravam a seção no armazenamento da conta. O adaptador PostgreSQL persiste JSONB sem criptografar esses campos.
- Impacto: acesso indevido a documentos do banco ou cópias de dados pode revelar refresh tokens e client secret. Criptografia do volume, se presente, não impede leitura por quem possui acesso lógico ao documento. A proteção da resposta pública de perfil é um controle distinto e não foi apontada como vazamento.
- `SECURITY.md` determina segredos no ambiente/secret manager e já define criptografia autenticada para W-API; não se deve criar uma exceção silenciosa para Gmail.
- Ação: secret manager para segredo do cliente; proteção autenticada dos tokens recuperáveis com chave separada, migração auditada e revogação quando necessário, sob revisão especializada.
- Aceite: nenhum segredo do cliente ou token recuperável em JSON legível, logs, exportações ou frontend; recuperação legítima e isolamento continuam funcionando.

### SEC-RUNTIME-01 — Container termina como root e browser desativa sandbox

- P1; confirmado na configuração local, UID remoto não observado.
- `Dockerfile.azure:46` seleciona `norium`, porém `:54` volta a `root` antes do comando final, sem nova seleção do usuário. `app/modules/intelligence/browser_runtime.py:55` acrescenta `--no-sandbox` quando UID é zero.
- Impacto: maior alcance de uma eventual falha de parser/browser que processa páginas ou anexos não confiáveis. Não foi demonstrada execução remota de código.
- Ação: separar instalação/smoke de build do usuário de execução; validar permissões mínimas e isolamento do browser na imagem efetiva. A aplicabilidade depende de qual Dockerfile gera a imagem publicada.
- Aceite: imagem candidata executa app com UID não privilegiado, browser com sandbox funcional ou isolamento alternativo aprovado pelo especialista, volumes mínimos e smoke sem reduzir segurança.

### SEC-DEP-01 — Dependências declaradas possuem alertas conhecidos

- P1 para tratamento antes do candidato de lançamento; exposição remota ainda depende do inventário da imagem.
- `requirements.lock.txt`: `pypdf==6.16.1` (8 alertas), `urllib3==2.7.0` (3), `oauthlib==3.3.1` (1). Correções indicadas pelo scan atual: pypdf 6.19.0, urllib3 2.8.0 e oauthlib 4.0.0; compatibilidade precisa ser testada, sem atualização cega.
- pypdf é usado em `app/modules/commercial/document_files.py:534`/`:614`, `pdf_editor.py` e extração de texto. Alertas de consumo de CPU/memória por PDF são pertinentes ao processamento de conteúdo não confiável. [Advisory do mantenedor](https://github.com/py-pdf/pypdf/security/advisories/GHSA-5jq2-8x83-x246).
- urllib3: consumo de memória/CPU em streaming de respostas e separação de política TLS em proxy. A presença do pacote não prova que todos esses modos estão acessíveis ao usuário; revisar chamadas e proxies da imagem.
- oauthlib: comparação PKCE no fluxo de servidor de autorização. O Norium usa biblioteca como cliente Google; não se confirmou execução do componente vulnerável. [Advisory do mantenedor](https://github.com/oauthlib/oauthlib/security/advisories/GHSA-xpv3-w29h-x7cv).
- Frontend: DOMPurify transitivo, LOW, `GHSA-p98j-92pf-mc4p`, relativo a modo IN_PLACE e hook específico; exploração não demonstrada.
- Ação: atualizar com regressões, repetir SCA no artefato/SBOM final, documentar aplicabilidade e decisão humana de risco residual. O venv possui outras versões e alertas; reconstruir ambiente reproduzível antes de integrar PostgreSQL real.
- Aceite: nenhum alerta bloqueante sem resolução ou análise formal aprovada; scan/SBOM vinculados ao digest efetivamente publicado.

### SEC-SSRF-01 — Intervalo entre validação DNS e conexão

- P2, hipótese técnica a validar; P1 se reprodução alcançar rede privada.
- `app/modules/intelligence/service.py:75` valida IPs DNS públicos; `:136` abre conexão por hostname, que pode ser resolvido novamente. O route guard do browser também valida e depois continua a requisição.
- HTTPS, bloqueio de IP privado/loopback e recusa de redirects já existem. A lacuna é não demonstrar vínculo do IP validado com o destino efetivamente conectado, inclusive proxies.
- Impacto possível: DNS rebinding/TOCTOU em domínio controlado por atacante. Nenhum serviço privado da homologação foi sondado.
- Ação: teste com resolver/servidor controlados e defesa de saída coerente para HTTP/browser; preservar SNI e verificação de certificado.
- Aceite: mudança DNS entre etapas, IPv6, sub-recursos, proxy e redirects não alcançam destinos privados.

### QA-01 — Teste financeiro depende do calendário real

- P2; falha reproduzida nas duas execuções do frontend.
- `src/components/finance/FinanceDashboard.test.tsx:7` fixa receitas em setembro/2026; `:28` espera vê-las no filtro padrão do mês atual. O componente em `FinanceDashboard.tsx:191` usa a data atual; execução em outubro não inclui setembro.
- É uma falha de determinismo do teste, não uma prova de cálculo financeiro incorreto no produto.
- Ação/aceite: fixar relógio sintético ou usar fixtures relativas e executar o teste em diferentes meses; suíte inteira verde, sem desativar a asserção.

### QA-02 — Build reprova o orçamento de CSS

- P2 e bloqueio objetivo do comando de entrega; observado na cópia das fontes.
- Vite gerou o frontend, mas `scripts/check-bundle-budget.mjs` reprovou `index-DXrHx70W.css` com 427.092 bytes, acima de 400.000.
- Ação/aceite: reduzir CSS e repetir o build completo. Não aumentar o limite silenciosamente nem chamar a execução de sucesso porque a pasta dist existe.

### REL-01 — Candidato e validação operacional ainda não comprovados

- P1 de prontidão, sem afirmar uma falha operacional que não foi observada.
- Código local modificado/divergente, health sem identificação da versão e ausência de prova de digest/SBOM/pipeline impedem afirmar que o que foi testado é o que está publicado.
- Testes locais de recuperação não demonstram backup/restauração do PostgreSQL publicado, preservação dos dados da migração, rollback, alertas externos ou concorrência de workers/réplicas.
- Ação/aceite: fechar esses requisitos em um único candidato imutável, com evidência de contagens, integridade, anexos e login após restauração em ambiente separado; exercitar rollback e alertas antes da abertura pública.

## Controles positivos e cobertura por categoria

| Categoria | Evidência/observação | O que permanece pendente |
| --- | --- | --- |
| SQL Injection | Parâmetros em PostgreSQL/adaptadores; partes SQL dinâmicas da privacidade vêm de mapas internos; nomes ofensivos preservados como dados | Driver/banco real do candidato e privilégios da conta de aplicação; nunca testar DROP real na homologação |
| Autenticação e administração | Validação estrita, campos privilegiados rejeitados no cadastro, senha curta recusada, status/versão/jti em HTTP, regressões de hierarquia e bootstrap aprovadas | Revisão especializada das novas sessões e jornadas completas de senha/OAuth |
| Tenancy/IDOR | Tenant derivado de identidade; suíte cobre controles de equipe, financeiro, arquivos e privacidade | Prova A/B remota com conta de outra equipe/workspace e matriz de permissões |
| Arquivos/path traversal | Identificadores e caminhos delimitados; verificação de extensão/MIME/magic, tamanho e imagens; testes locais aprovados | Quota universal, parsers atualizados, limites CPU/memória e ACLs da imagem/volumes reais |
| XSS/conteúdo externo | Sanitização HTML e URLs no backend, tratamento de dados externos, CSP observada | Exercitar todas as superfícies com fixtures de payload e browser do candidato; ausência de finding no scan não é prova universal |
| CSRF/CORS | APIs atuais usam Bearer e origem estranha foi recusada | Cookie persistente exige CSRF, Origin e SameSite segundo o plano, antes de habilitar renovação |
| SSRF/execução | HTTPS, DNS público, limites e redirects recusados; subprocessos relevantes usam argumentos em lista | Resolver TOCTOU, isolamento do browser e limites do processamento de anexos |
| WebSockets | Tickets e controles de equipe existentes | Fechar SEC-WS-01 e provar revogação entre réplicas |
| OAuth/segredos/webhooks | OAuth usa state; existem mecanismos de segredo e criptografia em outras integrações | Gmail bloqueado, tokens Gmail em claro no armazenamento de aplicação, verificação dos webhooks e serviços efetivos |
| IA/automações | Testes de aprovações e fronteiras de ferramentas, minimização e política de dados | Revisão humana dos efeitos externos, custos e acessos efetivos dos provedores; não disparar mensagens reais como teste implícito |
| Privacidade/operação | Exportação protegida, regressões locais e backup sintético | Aprovação jurídica, retenção/subprocessadores, restauração PostgreSQL, monitoramento e resposta a incidentes no candidato |

Relatórios anteriores são referências históricas, não fechamento automático. Achados antigos de bootstrap/hierarquia/persistência não foram reabertos somente porque constam em documentos antigos; testes atuais e código são a evidência desta rodada. A matriz histórica completa deve ser reconciliada antes do aceite final.

## Plano de correção priorizado e lançamento

| Ordem | Entrega | Responsável/revisão | Evidência necessária para encerrar |
| --- | --- | --- | --- |
| 1 | Fixar candidato: preservar alterações, separar escopo, conciliar branch e referência remota; identificar SHA/digest em homologação | Engenharia | Checkout conhecido + pipeline/artefato imutável vinculados à versão |
| 2 | Fechar revogação dos sockets, armazenamento de segredos e quota | Backend + especialista de segurança | Regressões com duas contas, concorrência, revogação e ausência de segredo em payloads/artefatos |
| 3 | Atualizar dependências e corrigir isolamento do runtime | Backend/infra + especialista | SCA/SBOM da imagem, usuário de execução e smoke do browser aprovados |
| 4 | Reproduzir e resolver hipótese SSRF | Segurança/infra | Servidores/resolver sintéticos e bloqueio de destinos privados antes da conexão |
| 5 | Corrigir callback Gmail no cliente OAuth correto | Responsável Google Cloud/backend | Consentimento/callback bem-sucedidos em homologação com state, scopes e tenant preservados |
| 6 | Tornar teste financeiro determinístico e reduzir CSS | Frontend | Suíte, lint e build completos dentro do orçamento |
| 7 | Validar isolamento e jornadas por perfil no candidato | QA + responsável do produto | Duas contas designadas; CRUD, anexos, permissões, sockets, integrações e restart com dados sintéticos |
| 8 | Provar preservação de dados, backup, restauração e rollback PostgreSQL | Infra/dados | Recibo de migração/contagens, integridade e login/anexos após restauração em ambiente separado; rollback exercitado |
| 9 | Aprovar privacidade, retenção, scopes Google, riscos residuais e alertas | Responsáveis humanos habilitados | Aprovações registradas, alertas externos e procedimento de incidentes demonstrados |
| 10 | Provisionar produção somente após autorização e aceite | Infra/responsável do lançamento | Segredos e bancos separados, artefato aprovado, TLS/readiness e jornadas pós-publicação; rollback disponível |

Não há base para prazo fechado sem responsáveis, acessos e desenho aprovado. O próximo estado útil é um candidato corrigido e validado em homologação; criar produção sozinho não resolve os bloqueios.

## Sessão persistente e dispositivos: implementação ainda pendente

O [plano completo de sessões](../../plans/2026-10-03-sessoes-persistentes-e-dispositivos.md) detalha tabela transacional, cookie opaco HttpOnly/Secure, rotação/replay, CSRF, prazos, listagem das próprias sessões, revogação individual/global, abas/caches e WebSockets.

Há dois limites concretos das políticas existentes:

1. `SECURITY.md` proíbe persistência de tokens de sessão. A proposta de credencial persistente em cookie precisa de avaliação formal de compatibilidade. O pedido de manter políticas não autoriza abrir uma exceção ou editar a regra silenciosamente.
2. `docs/AI_GOVERNANCE.md` proíbe implementar ou aprovar sozinho autenticação sem especialista. A arquitetura e a implementação crítica precisam dessa participação humana.

A auditoria e o planejamento foram produzidos sem alterar o comportamento de autenticação. Sessão persistente e gestão de dispositivos não estão implementadas ou homologadas. O recurso pode entrar no escopo de um candidato posterior após resolver os limites e os achados; não constitui promessa de zero impacto na autenticação.

## Pendências de acesso

- Autenticação e leitura do Dashboard com a conta designada: confirmadas; senha não registrada em arquivo.
- Segunda conta de teste para isolamento A/B remoto: ainda não disponível.
- Produção: inexistente, conforme confirmação do usuário.
- Configuração autorizada do cliente Google, imagem/runtime e pipeline: não acessados administrativamente.
- Especialista responsável por autenticação/segredos e aprovação jurídica: não identificados nesta rodada.

## O que falta para o Norium ser lançado

Fechar os achados P1 e os bloqueios de testes/build, corrigir Gmail se a integração fizer parte da oferta, concluir a prova A/B e as jornadas do candidato, comprovar backup/restauração/rollback e dados migrados, aprovar privacidade e governança, identificar a imagem validada e então criar/validar produção com autorização. Até essas evidências existirem, o parecer desta rodada permanece **NO-GO**.

Nenhum push, deploy, correção de produto ou flexibilização de configuração de segurança foi executado nesta auditoria. Foram escritos o diagnóstico/plano e os executores/artefatos privados de validação.

## Progresso posterior à autorização de implementação

O pedido seguinte autorizou corrigir, implementar e subir em homologação. O retrato de auditoria acima foi preservado; os números posteriores não devem substituí-lo como se os achados nunca tivessem existido.

- QA-01 e QA-02 corrigidos localmente: relógio de teste determinístico e Tailwind limitado às fontes da interface. Suíte original: 769/769; build e lint aprovados. Candidato separado baseado na main atual: 780/780 com Node 24; build dentro dos limites já existentes nessa main.
- SEC-DEP-01 parcial: pypdf 6.19.0, urllib3 2.8.0, DOMPurify 3.4.16 e oauthlib 4.0.0 aplicados. Scan declarado backend: 67 pacotes, zero alertas conhecidos; scan frontend produção: zero. Não são scans da imagem em homologação. DOMPurify corresponde à [versão corrigida pelo mantenedor](https://github.com/cure53/DOMPurify/security/advisories/GHSA-p98j-92pf-mc4p). As [duas mudanças incompatíveis de oauthlib 4.0.0](https://github.com/oauthlib/oauthlib/releases/tag/v4.0.0) afetam o servidor autorizador (revogação JSONP e ordem de validação de grants); Norium usa o cliente Google. Três regressões novas exercitam autorização PKCE S256, troca de código e refresh com biblioteca real e respostas sintéticas. A revisão crítica de release e o fluxo Google real permanecem necessários.
- SEC-FILE-01 parcial: camada compartilhada de binários verifica quota global e workspace derivado do caminho; PostgreSQL combina lock, conta e gravação em uma transação, com timeout de espera. Local usa substituição atômica e lock do processo. 9 regressões específicas; 92 regressões focadas e 1.128 testes completos posteriores aprovados na pasta original. O comportamento real PostgreSQL/múltiplas réplicas e caminhos fora da camada ainda precisam de validação.
- REL-01 parcial: acesso Git recuperado pelo gerenciador existente; main `56ece8e102144a4ad9777d374f471a7199824dff`; candidato `codex/security-session-homologacao` isolado das alterações locais alheias à tarefa. Ainda sem imagem/SBOM publicados ou deploy.
- Integração main: primeira suíte backend com 1.130 testes e 2 falhas, específicas do contrato Kanban e da ajuda de Modelos de mensagens. Ajustes do candidato passaram em 12 testes focados e na suíte completa posterior com **1.133 testes**, zero falhas/erros/skips. Frontend do candidato: **780/780**. Essa evidência é distinta dos 1.128 testes backend e 769 frontend aprovados na pasta original.
- SEC-SSRF-01 parcialmente corrigido: a dupla resolução foi confirmada no código HTTP de páginas/gateway e mídia WhatsApp. `PublicHTTPTransport` usa o backend público do httpcore para validar todos os registros DNS imediatamente antes de conectar e passar apenas IP numérico ao socket. Host/SNI e validação de certificado permanecem no domínio original. O transporte aplica HTTPS, allowlist, ausência de proxy de ambiente e rejeita override de SNI; callers mantêm rejeição de redirects e limites. DNS vazio, malformado, misto público/privado e multicast são recusados. A suíte focada totalizou 91 testes aprovados; a integração WhatsApp posterior passou em 53 testes. Não houve exploração contra redes privadas remotas. Chromium ainda necessita proteção no nível de conexão/egress, incluindo subrecursos e WebSockets; o guard atual continua sujeito à dupla resolução.
- Após o transporte de páginas/gateway e a atualização OAuth: suíte completa com 1.149 testes aprovados. A correção de mídia WhatsApp foi aplicada depois do snapshot dessa suíte e validada nos 53 testes focados citados; a validação completa do snapshot final será registrada no handoff. Bandit do candidato nesse ponto: 23 LOW, nenhum MEDIUM/HIGH. Esses números não demonstram a imagem remota.
- Validação posterior no [CI do PR #45](https://github.com/T-Lucas43/Norium-nora/actions/runs/37167993922), candidato `cfcde43f1b028890c282ab601caaf0ea7e267d6d`: job validate aprovado, **1.153 testes backend**, zero falhas/erros/skips; **780 testes frontend**, lint/build/orçamento aprovados. O SBOM de dependências backend do merge sintético `1eeee2318d56af6cd339e1da868ffc3115cb2f90` foi preservado e o SCA não identificou alertas conhecidos. O resultado inicial do Gitleaks foi posteriormente invalidado por SEC-CI-01, registrado abaixo. Publicação de imagem/deploy é excluída em pull_request.
- Qualidade de chamadas nesse CI **reprovada**: compartilhamento de tela e conflito/quota/aborto de gravação falharam nas três repetições; carga com 100 conexões passou. Foram alinhadas as fixtures à escolha explícita "Assistir transmissão" e à raiz temporária usada pelo armazenamento. Não foram retiradas asserções de mídia, conflito, quota ou traversal. Nova regressão de armazenamento da fixture e 16 testes focados passaram localmente; próxima rodada de CI precisa demonstrar o fechamento. Não apresentar o workflow integral como aprovado.
- SEC-FILE-01: PostgreSQL 16 real e descartável no CI aprovou persistência/migração idempotente e quota em **duas conexões simultâneas com PIDs distintos**, overflow recusado sem gravação, substituição, isolamento de workspace e limite global. Marcadores `postgres_binary_quota_ci_passed` e `postgres_persistence_ci_passed`; job 111334899245. Não é prova de todas as gravações, duas réplicas, restauração ou migração dos dados remotos.
- HOM-OAUTH-01: acesso administrativo recuperado, projeto correto `cohesive-mile-432812-f0`, número 385151241277, cliente "Norium gmail" coincide com GMAIL_CLIENT_ID da homologação. O cliente autorizava somente localhost, incompatível com GMAIL_REDIRECT_URI do Shard. Após confirmação específica do usuário, foi salvo `https://norium.shardweb.app/api/auth/callback/gmail`; Google confirmou "Cliente OAuth salvo" e a URI permaneceu ao reabrir a configuração. Captura privada `output/pos-correcao/gmail-callback-salvo.jpg`. Configuração corrigida; consentimento/callback Google real e aceite ainda pendentes. Cliente antigo Azure pertence a outro projeto e não foi alterado.
- Sessões/dispositivos, SEC-WS-01, SEC-SECRET-01, conclusão de HOM-OAUTH-01, isolamento do runtime/browser e gates operacionais continuam pendentes dos requisitos do plano. Nenhuma política de autenticação foi alterada ou contornada. [PR #45 em rascunho](https://github.com/T-Lucas43/Norium-nora/pull/45), sem merge ou deploy.

Estado detalhado: [handoff de implementação](../../handoffs/2026-10-03-seguranca-sessoes-homologacao.md). O parecer de lançamento permanece NO-GO até o fechamento das pendências.

### SEC-CI-01 — scanner de segredos não carregava regras

- P1, confirmado após a autorização de implementação. `.gitleaks.toml` definia apenas exceções de duas fixtures; não continha regras próprias nem `extend.useDefault=true`. Conforme a [configuração oficial do Gitleaks](https://github.com/gitleaks/gitleaks/tree/v8.24.3/config), essa configuração não herda as regras padrão.
- Reprodução com o binário oficial 8.24.3, checksum verificado: canário temporário de formato PAT não detectado, exit 0. Portanto, o antigo resultado "no leaks found" do CI não era evidência válida de detecção. Não foi demonstrado vazamento real por essa lacuna.
- Correção: carregar regras padrão explicitamente, manter somente as exceções preexistentes e acrescentar gate que exige detecção e redação integral de canário sintético, além de scan do histórico ancestral HEAD. Não usar baseline nova, desabilitar regras ou mascarar falhas do scanner.
- Provas locais: canário detectado, exit 1, REDACTED integral; cinco regressões do gate e 12 testes focados aprovados. Histórico candidato b607501 não shallow: 393 ancestrais, 363 commits com patches examinados, 12.958.506 bytes, **zero alertas**, exit 0. Não abrange outros refs, commits não alcançáveis, arquivos ignorados ou segredos do ambiente remoto.
- Aceite remanescente: CI com configuração corrigida, prova de detecção e SARIF redigido vinculados ao candidato. Se surgirem credenciais reais, a rotação depende do responsável e não será substituída pela simples remoção do arquivo.

## Progresso de 04/10/2026 — candidato crítico

O diagnóstico inicial acima é histórico. O usuário indicou a si próprio como responsável pela revisão e aprovou a exceção específica de cookie persistente registrada em SECURITY.md. Isso resolve a decisão de desenho; não representa revisão/aceite do código crítico ou validação da versão remota.

| Item | Correção preparada | Evidência e limite atual |
| --- | --- | --- |
| Sessões/dispositivos | Registro transacional, cookie opaco 7 dias, acesso 15 min, CSRF/Origin, replay, epoch, lista/rótulos/revokes/reautenticação | Testes isolados aprovados; nova rodada CI e prova HTTPS de fechar/reabrir pendentes |
| SEC-WS-01 | Registro/SID/SV/status/permissões conferidos em Inbox/Brainstorm/Equipe, broadcasts e idle | Regressões de revogação aprovadas; não prova duas réplicas nem sockets da homologação |
| SEC-SECRET-01 | Fernet de token/state Gmail/Agenda com chave dedicada e vínculo conta/finalidade, migração offline JSONB | Chave, inventário de arquivos/backups, restore e migração remota pendentes |
| SEC-RUNTIME-01/SEC-SSRF-01 | Final Docker Shard sem root, sandbox obrigatório, CONNECT 443 com allowlist e DNS público fixado no TCP | Testes de composição/limites; build/runtime/sandbox do Shard ainda não comprovados |
| SEC-FILE-01 | Orçamento compartilhado JSON+binário local/PG, transação/lock, substituição | Quatro testes novos e regressões focadas passaram; novo gate PG misto pendente; não mede todo disco/WAL/tabelas |
| SEC-CI-01 | Regras padrão, canário, histórico redigido | CI 37169870359 aprovado no candidato 4069fda; nova revisão precisa do próprio resultado |
| HOM-OAUTH-01 | Callback HTTPS salvo no cliente Google efetivo | Configuração confirmada; consentimento/callback real ainda pendente |

### SEC-AUTH-02 — input sensível em erros de validação

Confirmado por regressão local: o formato padrão de validação podia devolver input rejeitado de campos, inclusive senha, em HTTP 422. Handler do candidato agora preserva somente `loc/msg/type`, com no-store, sem `input/ctx`. Cadastro/troca/reset e respostas públicas usam hashes PBKDF2 e projeções sem hash/senha; testes sintéticos exercitam os contratos. Isso não é prova de todos os logs/armazenamentos remotos.

### SEC-AUTH-03 — origem da chave de assinatura em ambiente compartilhado

O candidato exige `NORIUM_AUTH_SECRET` do ambiente/secret manager com tamanho mínimo; não utiliza arquivo gerado/persistido como fallback compartilhado. Transferir o valor atual exato sem expor ou regenerar: outros dados criptografados podem depender dessa chave. Presença/origem e compatibilidade no Shard são gate operacional pendente.

### SEC-UI-01 — invalidação e renovação entre identidades

Revisão identificou que comparar Bearer bruto invalidava respostas após uma renovação da mesma sessão, inclusive depois de uma mutação já executada; aviso 401 atrasado também podia limpar o login posterior. O candidato compara sub/SID/workspace, envia invalidação com SID e rejeita identidade explícita divergente antes do envio. Novos testes aprovados; mutações não repetem após resposta incerta. Jornadas de duas contas/abas reais continuam pendentes.

Suíte completa isolada mais recente: **1.220 backend** sem falhas/erros/skips e **793 frontend**; depois foram adicionadas regressões e **83 backend focados, 22 frontend focados e 4 dispositivos** passaram. Build e lint passaram localmente. Esses snapshots não são o SHA final de CI nem a imagem ativa. [Runbook de promoção e revisão](../../operations/sessoes-seguranca-homologacao.md).

Parecer continua **NO-GO**: revisão humana crítica, CI exato, imagem/sandbox, chaves/migração/backup/restore/rollback, conta B, jornadas remotas, operação/privacidade e ambiente de produção ainda precisam de evidência. Não houve deploy desse candidato.
