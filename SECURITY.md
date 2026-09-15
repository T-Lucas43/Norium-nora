# Seguranca do Norium

## Como reportar

Nao abra uma issue publica para vulnerabilidades. Envie o relato de forma privada ao responsavel pelo repositorio, incluindo impacto, rota afetada e passos minimos de reproducao. Nao inclua dados pessoais ou segredos reais.

## Controles obrigatorios

- Toda rota de dados privados exige sessao autenticada e resolve o tenant pelo token; `user_id` do cliente nunca concede acesso.
- Eventos, WebSockets, notificacoes, arquivos, OAuth e caches devem ser isolados por usuario ou equipe autorizada.
- Webhooks exigem segredo quando o provedor o suporta e nunca escolhem o tenant a partir de um campo livre do payload.
- URLs remotas usam HTTPS, allowlist de host, sem redirecionamento e com limite de tamanho.
- Segredos ficam apenas no ambiente/Azure secrets. Tokens de sessao ficam em `sessionStorage`, nao em armazenamento persistente. Tokens de instância W-API recuperáveis são persistidos somente com criptografia autenticada e chave dedicada do secret manager.
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
