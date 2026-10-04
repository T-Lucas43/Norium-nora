# Plano de ação: sessões persistentes e dispositivos conectados

Data: 03/10/2026. Estado: correções independentes em implementação e validação; sessões e publicação completa pendentes dos requisitos abaixo. O usuário autorizou corrigir os achados, implementar o recurso e publicar em homologação.

## 0. Plano integrado de correção e homologação

Os achados de [varredura e prontidão](../security/reviews/2026-10-03-varredura-e-prontidao.md) passam a ser pré-requisitos deste plano. A autorização de publicação destina-se à homologação em `https://norium.shardweb.app`; produção não existe e não integra este deploy.

| Ordem | Item e arquivos principais | Entrega e aceite | Estado da execução |
| --- | --- | --- | --- |
| 1 | REL-01: repositório, candidato e fluxo Shard | Conferir main atual, preservar mudanças, SHA/digest, pacote/pipeline e rollback | Git/Shard recuperados; candidato baseado em main 56ece8e e PR #45 em rascunho; imagem validada/deploy pendentes |
| 2 | QA-01/QA-02: `FinanceDashboard.test.tsx`, `index.css` | Relógio estável, detecção CSS restrita à UI, manter limites e suíte/build verdes | 769 testes e build aprovados na pasta original; 780 testes e build Node 24 aprovados no candidato |
| 3 | SEC-DEP-01: requirements e lockfiles | Atualizar dependências afetadas com regressões; SCA/SBOM da imagem candidata | pypdf 6.19.0, urllib3 2.8.0, DOMPurify 3.4.16 e oauthlib 4.0.0 aplicados; SCA frontend e 67 dependências travadas backend sem alertas conhecidos; imagem/revisão de release pendentes |
| 3a | SEC-CI-01: `.gitleaks.toml`, workflow e `check_secret_scanner.py` | Carregar regras padrão, provar detecção/redação de canário sintético e examinar histórico | Configuração antiga não detectava canário; correção e histórico ancestral aprovados localmente, gate CI atualizado para impedir regressão |
| 4 | SEC-FILE-01: `persistence/files.py`, `postgres_store.py`, `storage_limits.py` | Quota cumulativa de binários por workspace/global, substituições sem dupla contagem, verificar antes de gravar | 9 regressões e PostgreSQL 16 real descartável no CI aprovados, incluindo duas conexões concorrentes; caminhos restantes/volume remoto pendentes |
| 5 | SEC-WS-01: Inbox/Brainstorm e consumidores de sessões | Revogação/expiração em leitura, broadcasts e escritas, também entre réplicas | Aguarda participação especializada em autenticação |
| 6 | SEC-SECRET-01: Gmail e persistência de tokens | Segredo do cliente no secret manager; tokens recuperáveis protegidos e migração segura | Aguarda especialista em criptografia e acesso de configuração |
| 7 | HOM-OAUTH-01: `_redirect_uri`, Google Cloud | Comparar URI efetiva e cliente correto; callback HTTPS autorizado, state/scopes preservados | Cliente correto localizado; callback HTTPS salvo no Google Cloud após confirmação específica, persistência verificada; consentimento/callback real pendentes |
| 8 | SEC-RUNTIME-01/SEC-SSRF-01: Dockerfile/runtime/fetch | Identidade sem privilégio, browser isolado, conexão ao IP validado, sem abrir rede privada | Transporte HTTP corrigido para páginas, gateway de modelos e mídia WhatsApp; testes sintéticos aprovados. Browser e imagem/topologia real ainda pendentes |
| 9 | Sessões e dispositivos: etapas 1–8 deste documento | Modelo transacional, cookie protegido, CSRF, rotação, revogação e UI próprios | Política de persistência e participação especializada precisam ser resolvidas |
| 10 | Validação de homologação e lançamento | Duas contas de teste, restore PostgreSQL, rollback, integrações, revisão legal e evidências | Conta B/acessos/aceites externos pendentes |
| 11 | Publicação autorizada em homologação | Um candidato conhecido, backup quando houver migração, readiness, login, dados, sockets e recurso autenticados | Não publicar pacote parcial ou atribuir testes locais à versão remota |

Estado durável e resultados atualizados: [handoff de implementação](../handoffs/2026-10-03-seguranca-sessoes-homologacao.md). O relatório de auditoria mantém o retrato anterior às correções e receberá somente uma seção adicional de progresso; não apagar as evidências históricas.

Na integração com a main atual surgiram dois bloqueios adicionais: o teste de compatibilidade não reconhecia a ampliação de status do Kanban, e o catálogo de ajuda da Nora não cobria Modelos de mensagens. Foram corrigidos no candidato, mantendo a aceitação de todos os status históricos e a proteção contra estreitamento do contrato. Doze testes focados passaram; a suíte completa posterior do candidato passou com **1.133 testes**, sem falhas/erros/skips. O frontend desse candidato passou com **780 testes**. Esses resultados não encerram os requisitos especializados e remotos restantes.

## 1. Objetivo e limite da mudança

Permitir que o usuário reabra o Norium e recupere o login enquanto sua sessão estiver válida. Oferecer, no perfil, uma lista das sessões da própria conta e ações para encerrar uma sessão, as demais ou todas.

Introduzir o recurso preservando autorização por usuário/workspace, hierarquia administrativa, validação de senha, rate limits, CSP, TLS, CORS restritivo, proteção dos WebSockets e regras de governança. Uma sessão persistente necessariamente muda o ciclo de autenticação; não é possível prometer ausência de qualquer impacto. O requisito deste plano é não enfraquecer controles ou alterar indiscriminadamente configurações globais.

A regra de `SECURITY.md` hoje proíbe armazenamento persistente de tokens de sessão. O pedido posterior do usuário exige preservar as políticas existentes. Portanto, este plano não autoriza criar uma exceção nem alterar essa regra: a arquitetura de cookie persistente permanece uma proposta bloqueada até avaliação humana especializada da sua compatibilidade com a política. O token de acesso continuará temporário; não se propõe gravá-lo em `localStorage`.

Sequência solicitada: primeiro varredura, diagnóstico e plano priorizado; depois implementação compatível com as políticas. Implementação de autenticação exige revisão humana especializada, conforme `docs/AI_GOVERNANCE.md`, que proíbe implementá-la ou aprová-la sozinho sem especialista. Publicação em homologação foi autorizada no pedido posterior; seus gates de segurança e aceite continuam obrigatórios. A varredura e os bloqueios atuais estão em [varredura e prontidão](../security/reviews/2026-10-03-varredura-e-prontidao.md).

## 2. Evidências do código local

O diagnóstico considera os arquivos presentes nesta workspace, inclusive alterações preexistentes e não commitadas. Não representa confirmação da versão em produção.

| Componente | Situação examinada | Consequência para o plano |
| --- | --- | --- |
| `src/app/hooks/useAuthSession.ts` no frontend | Grava o token em `sessionStorage`, remove cópias em `localStorage` e restaura a identidade por `/api/auth/me` | Acrescentar restauração pelo servidor ao reabrir o navegador |
| `app/modules/auth/router.py` no backend | Login emite token; validade configurada de sete dias; autenticação confere status, `sessionVersion` e revogação por `jti` | Aproveitar os controles e acrescentar identificação estável de sessão |
| Logout atual | Registra o `jti` revogado até sua expiração | Evoluir para revogar a sessão inteira, incluindo tokens renovados |
| Troca/redefinição de senha e mudanças relevantes da conta | Incrementam `sessionVersion` em caminhos existentes | A credencial de renovação também deverá conferir essa versão |
| Registro de sessões | Não há registro completo das sessões ativas com metadados de navegador | Criar persistência transacional específica |
| `app/bootstrap.py` | CORS usa origens delimitadas e `allow_credentials=False`; a idempotência genérica já exclui `/api/auth/` | Preferir mesma origem e manter essa configuração; renovação terá concorrência própria |
| Equipe/WebSockets | Há verificações de versão e `jti` em conexões de equipe | Acrescentar `sid`, validade e revogação da sessão |
| Inbox/WebSockets | O `broadcast` examinado envia diretamente às conexões registradas | Revalidação e encerramento fazem parte obrigatória desta entrega |
| PostgreSQL | Existe infraestrutura compartilhada e comportamento de falha fechada em produção | Usar esse banco; não depender de locks apenas em memória |

## 3. Arquitetura proposta

Usar uma sessão registrada no PostgreSQL, um cookie opaco para renová-la e tokens de acesso curtos para as APIs existentes. O cookie não concede autenticação diretamente às rotas de negócio.

Fluxo:

1. O usuário entra com e-mail/senha pelas validações atuais.
2. O servidor cria uma sessão e uma credencial aleatória de renovação. Persiste somente o hash dessa credencial.
3. A resposta define um cookie protegido e retorna um token de acesso curto, associado a `sid`, `jti`, `sessionVersion` e validade.
4. O frontend mantém o token de acesso em `sessionStorage` e chama as APIs com Bearer, como hoje.
5. Ao reabrir o aplicativo, o frontend obtém a proteção CSRF e solicita restauração. O servidor valida cookie, sessão, usuário, versão e prazos; então rotaciona a credencial e emite novo acesso.
6. Ao encerrar a sessão, o banco a revoga. Renovação, tokens de acesso e conexões vinculadas deixam de ser autorizados.

O cadastro, seleção de plano e troca de senha hoje também retornam tokens. Todos esses caminhos deverão usar o serviço central de emissão e preservar a associação com a sessão. A troca de senha revogará as sessões anteriores; poderá criar uma nova para quem comprovou a senha atual, preservando a experiência vigente.

### Cookie e origem

Proposta de cookie: `__Host-norium-refresh`, com `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, sem `Domain` e com `Max-Age` limitado ao prazo absoluto restante. O prefixo `__Host-` exige `Secure`, ausência de `Domain` e `Path=/`; `HttpOnly` impede leitura por JavaScript. [Referência MDN](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie).

`Lax` é a escolha inicial para compatibilidade com navegação por links e retornos de integrações. Será acompanhado de defesa CSRF explícita. Não adotar `SameSite=None` como solução automática para problemas de origem.

Frontend e `/api` deverão estar na mesma origem HTTPS. Manter `allow_credentials=False`, a lista atual de origens, headers de proteção, certificados e verificação TLS do banco. Se o ambiente publicado estiver separado por origem, avaliar um proxy da aplicação antes de qualquer mudança de CORS; essa topologia precisa ser confirmada na fase inicial.

O desenvolvimento atual utiliza `127.0.0.1:8000`. Planejar proxy Vite para `/api` e HTTPS local para validar os atributos de produção. Essa adaptação será explícita e restrita ao desenvolvimento; não desabilitar `Secure` em produção.

### Prazos iniciais propostos

| Parâmetro | Proposta | Observação |
| --- | --- | --- |
| Token de acesso | 15 minutos | A renovação será transparente quando permitida |
| Sessão persistente | Máximo absoluto de sete dias desde a autenticação | Mantém o teto atual; renovação não reinicia esse prazo |
| Inatividade | 24 horas sem atividade elegível | Valor proposto, sujeito à revisão de produto e segurança |
| Autenticação recente para ações sensíveis | Cinco minutos | Exigir senha atual novamente quando necessário |
| Atualização de último acesso | No máximo uma gravação por minuto por sessão | Reduz carga; horário exibido será aproximado |
| Encerramento de socket ocioso revogado | Até cinco segundos em condição saudável | Antes de cada envio/escrita também conferir autorização |

Prazos são propostas de política, não controles já implementados. Não prolongar a sessão somente porque uma aba está aberta ou um heartbeat automático está ativo. Definir quais requisições autenticadas contam como atividade; leituras automáticas em segundo plano não devem renovar indefinidamente a inatividade. Reautenticação e prazos no servidor são medidas recomendadas pela [OWASP](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html).

Persistência será o comportamento padrão dos novos logins. Incluir a opção visível “Não manter conectado neste navegador” para computadores compartilhados. Sem persistência, usar cookie sem `Max-Age`/`Expires` e aplicar os mesmos prazos no servidor; restauração de abas pelo navegador pode preservar cookies de sessão, portanto fechar o navegador não será apresentado como garantia de logout.

## 4. Persistência e concorrência

Criar tabelas próprias e migração aditiva, usando a infraestrutura PostgreSQL existente:

- `auth_sessions`: `id`, `user_id`, versão de segurança no login, criação, autenticação recente, último acesso, prazo de inatividade, expiração absoluta, persistência, revogação/data/motivo e rótulo opcional.
- `auth_refresh_credentials`: identificador, `session_id`, hash único, criação, expiração, consumo e geração da rotação. Manter histórico mínimo de hashes consumidos para detectar reutilização até o fim da sessão.
- `auth_session_events`: eventos minimizados de criação, renovação anômala, revogação e falha relevante; sem tokens, cookies, senhas ou payloads privados.

Identificadores exibidos à interface serão diferentes dos segredos de autenticação. Gerar credenciais com CSPRNG e ao menos 32 bytes aleatórios; usar primitivas existentes e bibliotecas mantidas, sem criar algoritmos criptográficos próprios. O hash de uma credencial aleatória de alta entropia não equivale ao armazenamento de senha; manter o algoritmo de senha atual.

Índices: sessões por usuário/status/último acesso, hash de renovação único, credenciais por sessão/geração e índices para limpeza por validade.

Rotação e revogação devem ser transacionais, com lock de linha ou atualização condicional. O consumo da credencial anterior, a emissão da próxima e a conferência da sessão acontecem atomicamente. Revogação global e criação de sessão devem compartilhar uma ordem consistente de locks/versão da conta para que um login concorrente não escape da revogação.

Concorrência de renovação entre abas exige tratamento específico: coordenar solicitações no frontend; a coordenação não substitui a transação no banco. Não aceitar novamente credencial consumida nem criar tolerância irrestrita de replay. Projetar e homologar conflitos legítimos, resposta perdida após commit e queda do servidor. Até existir uma solução revisada para recuperar esses casos, a saída segura será exigir novo login, com mensagem clara. Não esconder essas situações como “sessão expirada” genérica.

Banco indisponível: retornar indisponibilidade temporária e bloquear renovação e acesso que dependam da validação de sessão. Não recorrer a JSON, cache permissivo ou emissão sem registro. Limitar frequência das gravações e duração das conexões; não ampliar pool de produção para acomodar uma implementação ineficiente.

## 5. Contratos de API propostos

Os nomes abaixo são contratos de planejamento; definir schemas e códigos estáveis antes de implementar.

| Endpoint | Autenticação e defesa | Comportamento |
| --- | --- | --- |
| `POST /api/auth/login` | Senha, rate limit atual, origem e proteção contra login CSRF | Cria sessão; define cookie; retorna acesso curto e dados seguros |
| `GET /api/auth/session-context` | Mesma origem; resposta não cacheável | Fornece desafio CSRF vinculado ao contexto; não emite acesso nem rotaciona sessão |
| `POST /api/auth/refresh` | Cookie, CSRF, origem e rate limit específico | Restaura/renova com rotação atômica |
| `GET /api/auth/sessions` | Bearer válido da própria conta | Lista sessões não expiradas/revogadas; marca a atual pelo `sid` |
| `PATCH /api/auth/sessions/{id}` | Bearer; propriedade da sessão | Altera apenas rótulo, com limite de tamanho e saída escapada |
| `DELETE /api/auth/sessions/{id}` | Bearer; propriedade da sessão | Revoga a sessão inteira; resposta idempotente |
| `POST /api/auth/sessions/revoke-others` | Bearer e autenticação recente | Revoga todas as sessões da conta exceto o `sid` atual |
| `POST /api/auth/sessions/revoke-all` | Bearer e autenticação recente | Revoga todas, inclusive a atual, e limpa o cookie presente |
| `POST /api/auth/reauthenticate` | Bearer, senha atual e rate limit | Registra autenticação recente na sessão; não muda senha |
| `POST /api/auth/logout` | Bearer; prever variante somente com cookie protegida por CSRF | Revoga a sessão atual mesmo com acesso expirado; limpa o cookie |

Nenhuma rota aceitará `user_id` do cliente como prova de propriedade. Um usuário não verá sessões de membros da equipe, nem mesmo por ser dono da equipe. Gestão administrativa de sessões de terceiros fica fora da primeira entrega.

Erros previstos: sessão expirada/revogada, conta inativa, autenticação recente necessária, CSRF inválido, renovação concorrente, rate limit e indisponibilidade. Respostas de autenticação terão `Cache-Control: no-store`; não guardar corpos com acesso ou `Set-Cookie` no cache de idempotência, CDN, service worker ou logs. Preservar a exclusão atual de `/api/auth/` do cache genérico de idempotência.

## 6. Defesas específicas

- Aplicar token CSRF vinculado ao contexto e validação de `Origin` nas operações que aceitam cookie, incluindo login e logout. Usar header próprio e exigir JSON nas mutações correspondentes. GET não altera sessão.
- Implementar emissão do contexto CSRF sem abrir CORS ou retornar credenciais; verificar origem/Fetch Metadata quando disponíveis e documentar o tratamento de ausência desses headers. `SameSite` é defesa complementar, conforme [OWASP CSRF](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html).
- Revalidar estado da conta, `sessionVersion`, `sid`, expiração e revogação em cada API protegida. Revogar sessão deve bloquear também acessos curtos ainda não expirados.
- Continuar validando workspace e permissões atuais; o cookie não carrega privilégios nem substitui essas verificações.
- Encerrar todas as credenciais da sessão na troca de senha, recuperação de senha, desativação e demais eventos de segurança existentes.
- Preservar tickets WebSocket curtos e de uso único; vinculá-los ao `sid` e não transportar cookie/token permanente na URL.
- Para sockets de Inbox, Equipe, Brainstorm e chamadas, verificar sessão antes de autorizar leitura/envio/escrita e periodicamente quando ociosa. Interromper também a mídia e as tracks locais de chamadas revogadas. Bloqueio de HTTP sozinho não satisfaz esse requisito.
- Ao reativar/reiniciar serviço, consultar o estado persistido; restauração não deve ressuscitar sessões revogadas. Restauração de backup do banco deverá invalidar as sessões restauradas ou aplicar uma época de segurança fora do snapshot, com procedimento revisado.
- Preservar CSP e sanitização. `HttpOnly` evita leitura do cookie por JavaScript, mas não elimina os efeitos de XSS; acesso temporário no frontend continua exigindo esses controles.

## 7. Tela “Sessões e dispositivos”

Adicionar ao perfil uma seção de segurança integrada ao visual do Norium. Exibir:

- Nome opcional atribuído pelo usuário.
- Navegador, sistema operacional e categoria aproximada: computador, celular ou tablet.
- Data de criação e último uso aproximado, com horários localizados.
- Identificação “Este navegador” para a sessão usada naquela aba.
- Ação “Encerrar sessão”, confirmação e feedback de sucesso/falha.
- Ações “Encerrar outras sessões” e “Sair de todos os dispositivos”, com reautenticação quando necessária.

Exemplo: “Chrome · Windows · Computador — Este navegador — Último uso há 2 minutos”.

Explicar que a lista representa sessões em perfis de navegador: dois navegadores no mesmo computador podem aparecer separados. O sistema não consegue comprovar o aparelho físico pelo navegador. Não apresentar a lista como presença online exata; não usar fingerprinting invasivo, localização precisa ou identificação de hardware.

Na primeira entrega, coletar apenas metadados normalizados do User-Agent, com tamanho limitado e tratamento como dado não confiável. IP não será critério rígido de autenticação, pois redes móveis, NAT e VPN mudam. Exibição/geolocalização por IP fica fora do escopo; qualquer armazenamento futuro de IP exige finalidade, retenção e revisão de privacidade próprias.

Prever carregamento, lista vazia, atualização manual, falha de conexão, confirmação acessível, navegação por teclado, layout mobile e seleção clara da sessão atual. Sessões expiradas/revogadas saem da lista ativa; histórico, se necessário, terá tela e retenção próprias.

## 8. Abas, caches e recuperação de rede

Criar um serviço único de renovação usado pelo hook e cliente HTTP. Uma renovação em andamento por aba será compartilhada pelas requisições daquela aba; coordenar abas por Web Locks quando disponível e comunicação de estado por `BroadcastChannel`, sem distribuir credenciais pelo canal.

Rotação de token de acesso não equivale a troca de identidade. Adaptar `sessionScope.ts`, hoje baseado no token, para usar uma revisão estável de usuário/sessão/workspace. Assim, a renovação não descarta toda resposta em andamento, enquanto troca de usuário/workspace continua invalidando respostas antigas.

Em um mesmo perfil de navegador, o cookie é compartilhado entre abas. Definir uma conta persistente por perfil. Se outra aba fizer login em outra conta, as abas anteriores devem limpar identidade, caches, sockets e dados privados antes de restaurar a nova sessão. Nunca restaurar B mantendo a interface e caches de A.

Só renovar automaticamente quando o erro indicar acesso expirado e a sessão puder ser recuperada. Não renovar diante de conta inativa, revogação, erro de permissão ou workspace. Separar erro de rede/503 de credencial inválida para não apagar uma sessão válida por indisponibilidade temporária.

Uma mutação de negócio só poderá ser reenviada após uma rejeição comprovadamente anterior à execução, preservando a mesma chave de idempotência. Timeout/resultado incerto não autoriza repetição automática. Fluxos binários, uploads e chamadas com `fetch` direto deverão integrar a mesma regra.

## 9. Arquivos e áreas de trabalho

| Área | Arquivos existentes a revisar | Novos componentes previstos |
| --- | --- | --- |
| Autenticação | `norium-back-end/app/modules/auth/router.py`, `email_router.py`, `app/core/security.py`, fachada `app/routers/auth_router.py` | Serviço de sessões, repositório PostgreSQL e schemas de sessão |
| Infraestrutura HTTP | `norium-back-end/app/bootstrap.py` e rate limits pertinentes | Proteção CSRF/contexto e configuração delimitada do novo recurso |
| Banco | `norium-back-end/app/infrastructure/persistence/postgres_store.py` | Migração versionada, tabelas/índices e manutenção de sessões |
| WebSockets | Módulos `inbox`, `team`, `brainstorm` e coordenação de chamadas | Validação compartilhada de sessão e encerramento por revogação |
| Login/restauração | `norium-front-end/src/app/hooks/useAuthSession.ts`, `components/auth/AuthScreen.tsx`, `types/auth.ts` | Serviço de renovação e coordenação entre abas |
| HTTP frontend | `src/core/api/client.ts`, `fetchAuth.ts`, `config.ts`, `sessionScope.ts`, `sessionExpiry.ts`, `src/utils/authApi.ts` | Tratamento central de expiração/renovação |
| Interface | `src/components/profile/ProfileSettings.tsx` e navegação de perfil | Seção de sessões, serviço, tipos e confirmação/reautenticação |
| Ambiente local | `norium-front-end/vite.config.ts` | Proxy de API e instrução de HTTPS local |
| Política e operação | `SECURITY.md`, `docs/SECURITY_CONTROLS.md`, documentação de privacidade/rollback e `.env.example` | ADR de sessões, runbook e evidências de aceitação |

Os caminhos de novos arquivos serão confirmados na fase de desenho. Não alterar configurações de provedores Gmail/W-API, segredos existentes, TLS do banco, hierarquia de papéis ou regras de negócio para acomodar o recurso.

## 10. Etapas, dependências e entregas

| Etapa | Ação e entrega | Condição para avançar |
| --- | --- | --- |
| 1. Desenho e inventário | Confirmar topologia publicada, consumidores de tokens, fluxos OAuth/cadastro/senha, política de prazos e modelo de ameaça; produzir ADR e contratos | Revisão de arquitetura e segurança por pessoa habilitada |
| 2. Persistência | Migração aditiva, repositório transacional, índices e limpeza; implementar versão e revogação global de forma consistente | Concorrência e falha do banco demonstradas em ambiente isolado |
| 3. Autenticação | Cookie, CSRF, emissão/rotação, restauração, logout e validação de `sid` em HTTP | Ciclo de sessão e proteção contra replay/CSRF aprovados |
| 4. Frontend | Renovação central, sincronização de abas, estado de sessão, caches e opção para navegador compartilhado | Sem mistura de identidade e sem duplicação de mutações |
| 5. Dispositivos e sockets | Listagem, rótulos, revogação individual/global e revogação em todos os WebSockets/chamadas | Revogação alcança acesso, renovação, dados em tempo real e mídia |
| 6. Homologação e revisão | Testes de segurança, navegador real, integração, scans e relatório de evidências | Revisão humana aceita; nenhuma falha alta deste recurso aberta |
| 7. Publicação autorizada | Migração, artefato imutável, ativação gradual e verificação remota | Readiness do banco, cookies e jornadas autenticadas comprovadas |
| 8. Observação e encerramento | Acompanhar falhas/latência, limpar dados conforme retenção e registrar resultado | Critérios de aceite atendidos e rollback operacional documentado |

Estimativa preliminar de planejamento: 8–12 dias úteis de engenharia e revisão, variando com compatibilidade entre navegadores, correções necessárias nos sockets e acesso a homologação. Não é compromisso de prazo nem substitui o dimensionamento após a etapa 1.

## 11. Migração, lançamento e rollback

1. Preservar alterações preexistentes; desenvolver em branch controlada a partir de uma base claramente registrada.
2. Criar migrações compatíveis com a versão anterior, sem apagar dados de usuários ou sessões antigas.
3. Instalar o código e o schema inicialmente com emissão persistente desativada. Validar em homologação e contas controladas.
4. Planejar uma reautenticação dos usuários na ativação completa. Tokens legados não contêm metadados suficientes para uma lista fiel de dispositivos; não inferir dispositivos nem converter Bearers existentes em cookies persistentes.
5. Durante uma janela de transição limitada, caso seja necessária, indicar que sessões legadas não estão listadas e continuar aplicando as revogações existentes. A entrega completa só estará aceita após encerrar a aceitação de tokens legados e registrar todos os novos logins.
6. Inventariar consumidores não browser antes de exigir `sid`; não interromper integrações silenciosamente nem criar exceção geral de segurança para elas.
7. Adotar chave de ativação específica para emissão/restauração persistente. Desativar o recurso não poderá desativar a validação de `sid`/revogação em tokens já emitidos.
8. No rollback, suspender novas renovações, invalidar sessões atingidas e limpar cookies quando o navegador retornar. Manter a camada de validação de revogação; não voltar diretamente a um binário que aceite tokens revogados. Se for necessário voltar a versão anterior, preparar uma invalidação por versão da conta antes da troca e comprovar rejeição dos tokens emitidos.
9. Manter schema e registros para investigação; não fazer rollback destrutivo de tabelas. Reautenticação é preferível a restaurar credenciais inseguras.

Os controles de ativação serão específicos ao novo subsistema, sem editar segredos existentes ou diminuir proteção global. Deploy deverá seguir o fluxo GitHub Actions autorizado para o projeto, com artefato imutável e evidência da revisão ativa. Não atribuir sucesso de produção apenas a `/health`.

## 12. Validação e critérios de aceite

Usar contas, senhas, cookies e bancos sintéticos/isolados; não enviar credenciais ou logs privados a ferramentas de IA.

| Grupo | Evidência obrigatória |
| --- | --- |
| Persistência | Entrar, fechar navegador, reabrir e recuperar a mesma conta; confirmar expiração absoluta/inatividade e navegador compartilhado |
| Cookie | `HttpOnly`, `Secure`, `SameSite`, escopo e prazo corretos; não legível por JS; ausência de token persistente em `localStorage` |
| CSRF | Login/refresh/logout rejeitam origem externa e desafio ausente/inválido; GET não renova; OAuth legítimo preservado |
| Rotação | Credencial consumida rejeitada; acesso anterior bloqueado ao revogar sessão; resposta perdida e duas abas sem resultado permissivo |
| Isolamento | A não lista, renomeia ou revoga sessão de B; mudar `user_id`/ID não concede acesso; permissões/workspaces não mudam |
| Abas e identidade | Login A→B, logout, renovação e troca de workspace não mantêm caches/respostas/sockets da conta anterior |
| Operações | POSTs de negócio não duplicados na expiração, timeout, reconexão ou renovação |
| Eventos críticos | Troca/recuperação de senha e desativação bloqueiam renovação, acessos e sockets anteriores |
| Tempo real | Inbox, Equipe, Brainstorm e chamadas não recebem/enviam dados após revogação; mídia é encerrada; sockets ociosos fecham no prazo definido |
| Banco e concorrência | Restart mantém sessões/revogações; banco fora do ar bloqueia sem fallback; refresh/logout/revoke-all concorrentes consistentes |
| Navegadores | Chrome, Edge, Firefox e Safari/mobile representativos; bloqueio de cookies e modo privado recebem mensagem compreensível |
| Regressão | Login, cadastro, senha, perfil, Gmail OAuth, upload, respostas binárias e autorização atual preservados |
| Código/segurança | Testes pertinentes, lint/build, scans/dependências e revisão humana documentada; riscos residuais explícitos |

Teste de navegador comprova a experiência. Teste de backend comprova os contratos. Uma evidência não substitui a outra. Resultado local não será apresentado como validação remota.

Aceite final: login persistente recuperado somente dentro dos prazos; lista correta de sessões registradas; revogação efetiva e isolamento entre contas; nenhuma flexibilização de CORS/CSP/TLS/permissões; revisão humana especializada concluída; evidência remota após publicação autorizada.

## 13. Operação, privacidade e manutenção

Registrar métricas agregadas de restauração, renovação, conflito, CSRF rejeitado, revogação, indisponibilidade do banco e latência. Não usar usuário, cookie, token, IP ou rótulo de dispositivo como dimensão das métricas. Logs terão códigos e IDs de correlação seguros, sem headers de autenticação.

Proposta de retenção: remover material de renovação no fim da validade; manter registros mínimos de sessões encerradas por até 30 dias e eventos minimizados por até 90 dias, sujeitos à política de privacidade aprovada. Limpeza será paginada, idempotente e integrada ao ciclo operacional existente. Excluir conta deve remover metadados conforme as obrigações de retenção aplicáveis.

Criar runbook para encerramento em massa, suspeita de replay, falha do banco, perda de cookie, retorno de backup e regressão após deploy. Não interpretar mudança de IP/navegador como prova automática de ataque.

## 14. Decisões e riscos que a execução deverá resolver

- Confirmar mesma origem em produção e estratégia de HTTPS local antes de ativar cookie.
- Revisar prazos propostos, opção para dispositivo compartilhado e reautenticação de ações sensíveis.
- Resolver rotação concorrente/resposta perdida antes de afirmar renovação transparente entre abas.
- Revisar os consumidores existentes do Bearer e os caminhos que emitem tokens para assegurar cobertura completa.
- Garantir a revogação dos WebSockets e chamadas; as verificações atuais de equipe não comprovam cobertura dos demais módulos.
- Reconhecer que a identificação do dispositivo é aproximada e que persistir login aumenta a exposição em computadores compartilhados; prazos e opção explícita limitam esse risco, sem eliminá-lo.

Este documento entrega o desenho e a ordem de execução. Não altera autenticação, configurações de segurança ou estado de produção.
