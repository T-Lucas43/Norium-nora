# Recuperacao funcional e migracao PostgreSQL

## Autorizacao e limites

- Usuario autorizou PostgreSQL gerenciado no Azure, custo adicional, uso do Sol e backup local antes de migrar.
- GitHub Actions e o unico caminho de publicacao/provisionamento. Nao usar Muse.
- Preservar alteracoes preexistentes. Nunca publicar dados, credenciais ou backups abertos no Git.
- Nao apagar origem nem trocar producao antes de restauracao comprovada, reconciliacao de dados e revisao de isolamento/transacoes.
- Governanca exige revisao humana/especializada para infraestrutura critica e mudancas de autenticacao/criptografia/exclusao. Autorizacao de custo nao substitui essa revisao.

## Evidencia inicial

- Capturas do usuario: previa de reagendamento e conexao WhatsApp falham com erro generico.
- Workflow anterior verde atesta publicacao, nao valida os fluxos autenticados reclamados.
- Persistencia distribuida entre JSON, agendamentos, W-API, eventos de automacoes e custos SQLite; cerebro Nora ja possui adaptador PostgreSQL.
- Referencias anteriores: Stirling PDF e n8n. A entrega anterior usou implementacoes proprias, nao implantou os produtos de referencia.

## Plano e aceite

1. Backup: snapshot Azure Files, pacote criptografado, download para pasta local ignorada pelo Git, restauracao isolada, hashes e integridade SQLite; sem exibir conteudo.
2. Sol: inventario de todas as fontes persistentes, bypasses por caminhos, isolamento e riscos; registrar plano independente.
3. Diagnostico: erros sanitizados em producao, reproducoes locais e tempos de W-API/agendamento antes de corrigir.
4. Migracao: esquema/versionamento PostgreSQL, importador idempotente, reconciliacao por contagens/hashes, testes reais PostgreSQL e multiplos tenants/workspaces. Nenhum fallback silencioso para arquivos.
5. Infraestrutura: TLS validado, rede restrita, credencial de aplicacao sem privilegio administrativo, pool limitado, restauracao e rollback revisados antes do corte.
6. Produto: testar reagendamento/confirmacao, QR real com consentimento, disponibilidade, PDF e automacoes; manter efeitos externos reconciliaveis.
7. Publicacao: Actions com imagem imutavel, testes e verificacao autenticada dos fluxos alterados. Health verde sozinho nao e aceite funcional.

## Estado

- Em execucao: inventario Sol; preparacao do backup remoto/local e diagnostico de producao.
- PostgreSQL ainda nao provisionado, dados ainda nao migrados, nenhuma nova publicacao realizada.
- Backup inicial online e crash-consistent; corte final exige janela sem escritores e nova reconciliacao. Nao declarar consistencia de negocios entre arquivos apenas por snapshot.
