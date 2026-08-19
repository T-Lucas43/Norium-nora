## Mudanca

Descreva o resultado, o risco e como foi validado.

## Checklist de seguranca e IA

- [ ] Autenticacao, autorizacao e isolamento entre usuarios/equipes foram testados.
- [ ] Nenhum segredo, dado pessoal real ou log de producao foi enviado a uma IA ou commitado.
- [ ] Codigo gerado por IA foi revisado por uma pessoa e os trechos criticos possuem testes.
- [ ] Dependencias novas foram verificadas quanto a origem, licenca e vulnerabilidades.
- [ ] Entradas externas foram validadas; URLs remotas possuem allowlist e limite de tamanho.
- [ ] Logs, eventos, WebSockets, arquivos e caches carregam o tenant autenticado.
- [ ] Existe rollback seguro para migracoes, integracoes e alteracoes de infraestrutura.
- [ ] `compileall`, testes, lint, build, SAST, SCA e secret scan passaram.
