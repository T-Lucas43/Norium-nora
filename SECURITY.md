# Seguranca do Norium

## Como reportar

Nao abra uma issue publica para vulnerabilidades. Envie o relato de forma privada ao responsavel pelo repositorio, incluindo impacto, rota afetada e passos minimos de reproducao. Nao inclua dados pessoais ou segredos reais.

## Controles obrigatorios

- Toda rota de dados privados exige sessao autenticada e resolve o tenant pelo token; `user_id` do cliente nunca concede acesso.
- Senhas de login são persistidas somente como hash lento com sal aleatório por senha, usando PBKDF2-HMAC-SHA256 com pelo menos 600.000 iterações na emissão atual. Cadastro, bootstrap, troca administrativa, troca pelo titular e recuperação usam a mesma primitiva; hashes legados aceitos são atualizados após autenticação válida. Senha original e hash nunca devem aparecer em respostas, logs, exportações ou artefatos. O método foi confirmado e incluído no escopo por solicitação do responsável técnico em 04/10/2026. A senha permanece protegida por TLS em trânsito e não possui mecanismo de decifragem.
- Eventos, WebSockets, notificacoes, arquivos, OAuth e caches devem ser isolados por usuario ou equipe autorizada.
- Webhooks exigem segredo quando o provedor o suporta e nunca escolhem o tenant a partir de um campo livre do payload.
- URLs remotas usam HTTPS, allowlist de host, sem redirecionamento e com limite de tamanho.
- Segredos ficam apenas no ambiente/secret manager. Tokens Bearer de acesso ficam somente em `sessionStorage`, nunca em `localStorage` ou outro armazenamento persistente acessível ao JavaScript. É permitida exclusivamente uma credencial opaca de renovação em cookie `__Host-`, `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/` e sem `Domain`, limitada ao prazo absoluto de sete dias desde a autenticação. O servidor persiste apenas o hash da credencial e valida sessão, revogação, versão do usuário, inatividade, CSRF e Origin antes de renovar; rotação não prolonga o prazo absoluto. Essa regra foi aprovada especificamente pelo responsável técnico em 03/10/2026 e não libera autenticação de rotas de negócio diretamente por cookie, CORS, TLS ou isolamento de dados. Tokens recuperáveis de integrações são persistidos somente com criptografia autenticada e chave dedicada do secret manager.
- O bootstrap administrativo e de uso unico: so pode criar o primeiro proprietario quando `usuarios_db.json` ainda nao existe e as quatro variaveis de identidade e senha estao completas. Configuracao de ambiente nunca promove contas durante cadastro, leitura ou gravacao comum.
- A autoridade administrativa e resolvida por evidencia persistida. `systemOwnerId` tem precedencia; flags administrativas legadas legitimas sao normalizadas e persistidas sem promover contas comuns.
- Conteudo externo exibido ou enviado a IA e tratado como nao confiavel e passa por minimizacao de dados.

## Bootstrap administrativo e recuperacao

O bootstrap inicial exige, em conjunto, `NORIUM_BOOTSTRAP_ADMIN_EMAIL`, `NORIUM_BOOTSTRAP_ADMIN_USER_ID`, `NORIUM_BOOTSTRAP_ADMIN_NAME` e `NORIUM_BOOTSTRAP_ADMIN_PASSWORD`. Ele roda somente na criacao de um armazenamento realmente ausente. Um `usuarios_db.json` existente, ainda que vazio ou invalido, nao reabre o bootstrap; mudar e-mail, ID, nome ou senha no ambiente tambem nao substitui o proprietario persistido.

O bootstrap nao e um mecanismo de recuperacao para uma instalacao que ja possui dados. Se o acesso administrativo for perdido, interrompa todas as replicas, preserve um snapshot verificavel do volume e restaure um backup conhecido ou execute uma intervencao offline revisada que mantenha usuarios e trilha de auditoria. Nao apague o armazenamento nem altere variaveis esperando que uma conta existente seja promovida.

Somente para uma instalacao nova que tenha sido inicializada por engano sem qualquer dado de usuario: com todas as replicas paradas, preserve e inspecione uma copia do `usuarios_db.json`; mova o arquivo vazio/invalido para uma quarentena recuperavel; configure os quatro valores; inicie uma unica replica; valide o ID, o e-mail e o `systemOwnerId` criados; e remova imediatamente a senha de bootstrap do ambiente. Se houver qualquer registro valido, use recuperacao por backup ou manutencao administrativa auditada em vez desse procedimento.

## Resposta a incidentes

1. Conter: desabilitar a integracao/rota afetada e revogar chaves ou tokens.
2. Preservar evidencias: IDs de requisicao, revisao, usuario e horarios, sem copiar conteudo sensivel.
3. Corrigir e testar isolamento com pelo menos dois usuarios distintos.
4. Fazer deploy imutavel, validar remotamente e monitorar reincidencia.
5. Documentar causa, alcance, dados afetados e acoes preventivas.

## Validacao continua

O pipeline executa testes, lint, build, `pip-audit`, Bandit, `npm audit`, secret scanning, SBOM e proveniencia da imagem. Alertas nao devem ser ignorados sem justificativa registrada e aprovacao humana.
