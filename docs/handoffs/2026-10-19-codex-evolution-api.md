# Evolution API no WhatsApp — 19/10/2026

## Pedido e limites

Implementar diretamente com Codex, sem agentes, uma alternativa temporária à W-API
usando Evolution API. O usuário autorizou uma instância no ShardCloud se necessária.
Preservar os vínculos, históricos, segredos e volumes existentes. Nenhum envio real,
pareamento ou migração de conta é automático. Chaves permanecem no backend.

## Fontes e decisões

- Documentação: https://docs.evolutionfoundation.com.br/evolution-api
- Fonte oficial: https://github.com/evolution-foundation/evolution-api, tag `2.3.7`,
  commit `cd800f2976e1e5b682fbf86a01ee4d85ae61f370`.
- Imagem oficial `evoapicloud/evolution-api:v2.3.7`, índice imutável
  `sha256:1bd8afc4a6cf48822e6cf02469aeae7bd35a12a6b616eacd1291926307f4d339`.
- Não usar a versão 2.4 RC em homologação. Exibir a identificação Evolution API nas
  configurações, conforme condições adicionais da licença; não copiar o painel.
- Seleção de provedor no servidor, isolamento dos vínculos por provedor, mesma
  autorização por conta, aprovação de ações e tratamento de resultado incerto.

## Entrega planejada

1. Adaptador de conexão, QR, mensagens, catálogo e eventos, com erros sanitizados.
2. Separar os armazenamentos W-API/Evolution; manter caminho de retorno à W-API.
3. Informar o provedor no frontend e não oferecer planos comerciais W-API ao usar Evolution.
4. Docker local isolado, com PostgreSQL/Redis e API sem portas públicas.
5. Preparar instalação Shard com segredos próprios, volumes, limites e rollback.

## Estado inicial e critérios

Em 19/10 a VPS tem 5.925 MB de RAM, 4.865 MB disponíveis e apenas 686 MB de disco
livre (99% ocupado). Não instalar a imagem antes de resolver capacidade. Não apagar
dados, backups ou imagens de rollback para liberar espaço sem avaliar o conteúdo.

Aceite exige build local, prontidão da API e isolamento das configurações. Conexão
WhatsApp e envio/recebimento real dependem do QR lido pelo titular e de validação
funcional posterior. Nenhuma suíte de testes será criada ou executada nesta entrega
sem pedido do usuário. Promoção de alterações críticas exige revisão humana de
`docs/AI_GOVERNANCE.md`; implementação não significa deploy concluído.

## Resultado da implementação

- Adaptador e seleção backend em `app/services/evolution_client.py` e
  `whatsapp_provider.py`; conexão, mensagens, referências com autoria confirmada,
  catálogo, grupos, download e eventos adaptados ao pipeline existente.
- Registros/documentos/histórico/cache de cada provedor separados; chave Fernet
  própria, novo consentimento e inventário de privacidade/retencão atualizados.
- UI identifica Evolution e dispensa seleção LITE/PRO. Configuração do gateway
  contém atribuição ao fornecedor. W-API continua como padrão do código.
- Perfil Docker local preparado; Evolution respondeu HTTP 200 autenticado, com
  zero instâncias, e ficou healthy. Não houve QR, mensagens ou dados reais.
- Compose/gerador privados para o Shard preparados, mas não executados.
- Sintaxe Python, TypeScript e lint dos arquivos frontend conferidos. Não foram
  executadas suítes de testes nem validação funcional com WhatsApp pareado.

## Bloqueio de ativação

Trivy 0.75.0 reportou 11 ocorrências CRITICAL e 254 HIGH no digest oficial.
`baileys@7.0.0-rc.9` está na faixa afetada por CVE-2026-48063, confirmada no aviso
revisado https://github.com/advisories/GHSA-qvv5-jq5g-4cgg. O relatório completo
está em `output/docker-local/evolution-vulnerabilities.json`; conta ocorrências,
não vulnerabilidades distintas. Não foi criada exceção no scanner.

`EVOLUTION_CONNECTIONS_ENABLED=0` impede provisionamento/QR. A configuração local
e a configuração preparada para o Shard mantêm esse bloqueio. A documentação
`docs/operations/evolution-api.md` distingue contratos implementados, limites,
retenção/eliminação no fornecedor ainda não integradas e ativação pendente.

Corrigir/validar a imagem e o ciclo de vida dos dados no fornecedor antes de usar
contas reais. Não promover a imagem vulnerável nem pedir aceite para ignorar os
achados. Espaço do Shard também continua pendente: 8,69 GB recuperáveis de cache de
build foram identificados, mas nenhuma limpeza foi feita.

## Evidência da execução local

- Código em execução: `5134978d0236b70e4819142a1c93f945a5892088`, versão
  `2026.10.19`, ambiente `local`, URL `http://localhost:8765/`.
- Build Docker concluído, incluindo TypeScript, Vite e limites de bundle; AST
  Python, lint do frontend e `git diff --check` sem erros.
- Gitleaks conferiu os arquivos alterados e o commit exato: nenhum segredo encontrado.
- `/health/ready` retornou pronto, persistência PostgreSQL; página HTTP 200;
  containers Norium, PostgreSQL e Evolution healthy. Redis em execução.
- Configuração efetiva: `provider=evolution`, `connectionsEnabled=false`;
  presença das duas chaves confirmada somente como booleano, sem mostrar valores.
- Evidência sanitizada: `output/docker-local/evolution-runtime-evidence.json`.
  Testes funcionais/suítes não executados, pareamento e envio real não realizados.
- Sem push, PR novo ou alteração na VPS. Commits posteriores só de documentação
  não representam outra imagem em execução.


## Correção solicitada e publicação — atualização de 19/10

O usuário pediu corrigir/publicar o WhatsApp e também fazer o deploy do Norium.
Isso autoriza push/deploy do conjunto; a revisão técnica humana do novo diff ainda
é exigida pelo item 5 de AI_GOVERNANCE. As evidências anteriores acima representam
a imagem original; o estado atual e o procedimento estão em operations/evolution-api.md.

- Runtime reconstruído: Baileys rc14, bases mantidas, lock de produção, UID1000,
  FFmpeg do Alpine; PG auxiliar sem gosu, UID70; Redis com correções Alpine.
- As três imagens corrigidas passaram Trivy 0.75.0 sem HIGH/CRITICAL e sem ignores.
- Inicialização normal local e listagem autenticada HTTP200, zero instâncias;
  57 migrações verificadas. Conta WhatsApp real não pareada nem usada.
- Exportação, desconexão/exclusão e retenção do banco privado integradas ao ciclo
  por conta; falhas de purga preservam o vínculo para retomada.
- CI passa a auditar/exportar as três imagens auxiliares imutáveis junto ao gate
  do Norium. Compose Shard exige IDs provenientes do recibo auditado.
- AST/YAML, TypeScript e lint conferidos; sem suítes manuais nesta correção.
- Shard ainda sem mudanças: espaço insuficiente exige limpeza específica de cache
  de build sem uso, mediante confirmação; imagens/volumes/backups ficam preservados.
- Próximo: commit/PR, CI, revisão técnica humana da revisão exata, importação dos
  artefatos GitHub e promoção preservando backup/rollback. Não declarar deploy
  concluído antes de verificar a release e readiness no Shard.
