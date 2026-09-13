# Seguranca do Norium

## Como reportar

Nao abra uma issue publica para vulnerabilidades. Envie o relato de forma privada ao responsavel pelo repositorio, incluindo impacto, rota afetada e passos minimos de reproducao. Nao inclua dados pessoais ou segredos reais.

## Controles obrigatorios

- Toda rota de dados privados exige sessao autenticada e resolve o tenant pelo token; `user_id` do cliente nunca concede acesso.
- Eventos, WebSockets, notificacoes, arquivos, OAuth e caches devem ser isolados por usuario ou equipe autorizada.
- Webhooks exigem segredo quando o provedor o suporta e nunca escolhem o tenant a partir de um campo livre do payload.
- URLs remotas usam HTTPS, allowlist de host, sem redirecionamento e com limite de tamanho.
- Segredos ficam apenas no ambiente/Azure secrets. Tokens de sessao ficam em `sessionStorage`, nao em armazenamento persistente. Tokens de instância W-API recuperáveis são persistidos somente com criptografia autenticada e chave dedicada do secret manager.
- Conteudo externo exibido ou enviado a IA e tratado como nao confiavel e passa por minimizacao de dados.

## Resposta a incidentes

1. Conter: desabilitar a integracao/rota afetada e revogar chaves ou tokens.
2. Preservar evidencias: IDs de requisicao, revisao, usuario e horarios, sem copiar conteudo sensivel.
3. Corrigir e testar isolamento com pelo menos dois usuarios distintos.
4. Fazer deploy imutavel, validar remotamente e monitorar reincidencia.
5. Documentar causa, alcance, dados afetados e acoes preventivas.

## Validacao continua

O pipeline executa testes, lint, build, `pip-audit`, Bandit, `npm audit`, secret scanning, SBOM e proveniencia da imagem. Alertas nao devem ser ignorados sem justificativa registrada e aprovacao humana.
