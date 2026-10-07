# Integração do release para VPS Shard — 07/10/2026

## Finalidade e autorização

O responsável autorizou a VPS Ubuntu 24.04 com 4 GB, realocação de memória,
adicional de IPv4 de R$ 12,90/mês e publicação do sistema com as últimas
alterações. Pediu também conferir o Git local. O endereço solicitado permanece
`norium.shardweb.app`. Produção não foi criada; este release é de homologação.

## Fontes consolidadas

- Candidato de sessões/segurança: `b9134221120ce6b2c6b3e5c97874098db8c2cacd`.
- Main atual, incluindo PR #46: `7075b65325b5b03217866ca55c33b275b7f50584`.
- Checkout local: HEAD `5f7430e84575da14ae4c31cc9614fd784d95869c`, com
  alterações anteriores preservadas. Seus arquivos não foram sobrescritos.
- Das 57 alterações locais rastreadas, 13 já aplicavam em reverso no candidato,
  17 patches de produto foram incorporados com SHA-256 conferido e as demais
  foram conciliadas com implementações mais recentes ou mantidas como fontes
  inativas Azure/Muse. A classificação detalhada é evidência local ignorada.

## Decisões da integração

- Mantidos SID/SV/JTI, registro autoritativo de sessões, revogação e eventos
  vinculados à sessão. A implementação antiga de logout por mapa JSON/JTI e
  eventos sem SID não substitui esses controles.
- Mantidos sandbox do navegador, UID10001 e broker de saída. Os fallbacks locais
  `--no-sandbox` não entram no release.
- Incluída a dependência local `postgres_tls.py` usada pela Nora, com verificação
  de certificado obrigatória em runtime compartilhado. O antigo opt-in de TLS
  sem verificação não é aceito; regressões cobrem esse caso.
- Preservadas descoberta PostgreSQL, quota conjunta JSONB/BYTEA, rotas opacas,
  interface de login, avatar de participantes e opt-in para assistir transmissão.
- Integrados os fixes de privacidade de atividades, Tarefas, Financeiro,
  chamadas, readiness e healthcheck da main, além dos patches locais da Nora.
- Teste de transporte privado usa sessões sintéticas realmente válidas no
  registro, sem desligar os guards. Os quatro perfis de autorização continuam.
- Somente o workflow Shard fica ativo. O YAML Azure mais recente da main foi
  arquivado, sem acionar infraestrutura Azure. Muse não foi invocado.

## Evidência local obtida

- 139 regressões backend de integração: zero falhas/erros/skips, em cópia sem
  dotenv, credenciais reais ou serviços externos.
- 827 testes frontend: zero falhas. TypeScript/Vite e orçamento de bundle
  passaram numa cópia isolada, preservando node_modules do checkout original.
- Oxlint: zero erros. npm audit completo: zero vulnerabilidades reportadas.
- 26 testes de workflow/pacote passaram. Gitleaks 8.24.3 encontrou zero achados
  nos 982 arquivos versionados do snapshot escaneado; não leu .env privado.
- A primeira suíte completa executou 1.324 testes e encontrou duas falhas de
  fixtures na integração. Foram corrigidas preservando nullable e a exigência
  de registro de sessões no readiness. As 14 regressões de contrato/readiness
  passaram; nova suíte completa e CI final ainda precisam de resultado.

## Infraestrutura e dados

A VPS foi criada pelo responsável e está online. Docker Engine foi instalado
pelo repositório oficial assinado, com hash da chave pública conferido. Nenhum
serviço do Norium foi iniciado ou promovido nela neste registro.

O perfil em `infra/security/` foi aprovado e testado para o CI. Aplicá-lo no
runtime Shard exige revisão humana crítica e prova de compatibilidade, conforme
seu README e `docs/AI_GOVERNANCE.md`. Não desabilitar sandbox, seccomp ou
AppArmor, nem acrescentar SYS_ADMIN/privileged para passar gates.

O endereço da aplicação gerenciada ainda precisa de procedimento de mapeamento
para a VPS. A consulta preparada ao suporte pede somente viabilidade/requisitos,
sem cortar tráfego. O callback Gmail e os controles HTTPS/Origin/cookies devem
ser preservados. Não presumir que o subdomínio de app está associado à VPS.

Backup PostgreSQL real foi restaurado em cópia isolada na etapa anterior; o
ensaio OAuth preservou documentos/blobs e foi idempotente. Antes de migrar a
database ativa: backup fresco, pausa de todos os writers, prova de restauração,
plano de rollback compatível com SV/epoch e credenciais, inventário agregado e
comparação privada. Nenhuma remediação destrutiva de histórico está autorizada.

## Aceite ainda necessário

Fixar SHA final; CI completo; aprovação humana do incremento crítico concreto;
perfil/volume/sandbox comprovados na VPS; mapeamento HTTPS; migração ativa e
rollback; readiness PostgreSQL; login, persistência, dispositivos/revogação,
WebSockets e Gmail na conta designada. Segunda conta e chamadas ponta a ponta
continuam pendentes. Build ou VPS online não comprovam deploy concluído.
