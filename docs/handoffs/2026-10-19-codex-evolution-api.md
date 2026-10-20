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


## Publicação e conferência local

- PR #68 aberto em https://github.com/T-Lucas43/Norium-nora/pull/68.
- Norium local na revisão 819cec1, readiness PostgreSQL pronta, login local e
  provedor Evolution habilitado; evidência sanitizada em
  output/evolution-audit/local-release-evidence.json. Nenhuma instância pareada.
- Gitleaks conferiu os nove commits até 819cec1 e não encontrou segredos.
- CI confirmou o gate das três imagens Evolution e persistência PostgreSQL.
  A validação geral detectou mensagens W-API alteradas e duas fixtures existentes
  desatualizadas para o catálogo/baseline; mensagens preservadas e fixtures alinhadas.
- Contratos existentes do workflow incluem o novo gate, que também passa a ser
  obrigatório no fracionamento/transporte da imagem imutável. Sem novos testes manuais.
- CI da revisão atual, aceite técnico humano, limpeza específica do cache e promoção
  remota continuam pendentes. Não confundir imagem local com a release do Shard.


## Atualização do gate geral

No CI de 5f43d5d passaram os 1.689 testes backend e os 54 testes de release,
PostgreSQL e as auditorias das imagens Norium/Evolution. O gate pip-audit bloqueou
três alertas de aiohttp 3.14.3. Atualizado para 3.14.4, correção indicada nos avisos
GHSA-5wr8-gcqf-gqf3, GHSA-2g87-pp6c-29x5 e GHSA-494j-54xm-rwp3 do fornecedor.

A auditoria local das dependências backend, dependências opcionais Nora e npm
terminou sem alertas. Bandit também passou após substituir três concatenações de
SQL fixo por variantes literais; parâmetros e locks/fencing são preservados.
Sem exceções novas ou redução de severidade. O CI completo precisa passar de novo
na revisão que contém essas correções antes da promoção. O pedido de revisão
anterior mencionava 5f43d5d; o aceite deve identificar a revisão atualizada.


## Relato após pareamento e correção da carga inicial

O usuário aprovou tecnicamente 9ce7525 e a limpeza exclusiva do cache Docker de
build. A limpeza foi executada pelo painel Shard; imagens, containers e volumes
não foram removidos. A revisão 9ce falhou ao resolver dependências: aiohttp 3.14.4
exige yarl>=1.25.1. Alinhado yarl para 1.25.1; resolução completa e auditoria local
passaram. Essa é a dependência transitiva necessária à atualização já solicitada.

O usuário informou que, após conectar, nada apareceu. Diagnóstico minimizado no
ambiente local: gateway conectado, 1.188 contatos, 23 chats e três mensagens;
Norium mantinha sucesso com zero itens. Uma atualização explícita do catálogo
recuperou 1.188 contatos (1.187 expostos após normalização); duas conversas passaram
pelo filtro de recência. Não foram lidos nomes, telefones nem corpos nesta análise.

Correção: janela inicial limitada de atualização, snapshot vazio sem TTL longo,
conversas do catálogo sem mensagem recente visíveis sem timestamps fabricados;
armazenamento do lote inicial recente habilitado no gateway. syncFullHistory segue
false e a retenção por conta segue 30 dias. Nenhum logout/repareamento automático.
Uma sessão cujo lote anterior não foi armazenado pode precisar de novo pareamento
pelo titular; não declarar retroimportação completa. Rebuild local e CI da revisão
com essas alterações ainda precisam terminar antes de promover ao Shard.


Complemento da carga inicial: o normalizador de conversas preserva a marcação
booleana de origem do catálogo; timestamps reais messageTimestamp são mapeados ao
contrato legado, e o índice de atualização em lote permite entregar metadados sem
mensagem também pelo delta. O horário da última mensagem não é inventado. Nova
conferência das contagens locais será feita depois do rebuild desta candidata.

## 20/10/2026 — mídia, reações e continuidade local

O usuário pediu verificar áudio, mídia e reações e manter o projeto local ativo.
Finalidade: corrigir os contratos Evolution usando fixtures sintéticas; leituras
da sessão local retornam somente contagens, status HTTP, tamanho e MIME, sem
nomes, telefones, corpos ou bytes de mídia expostos à IA. Nenhuma mensagem ou
reação real foi enviada. Sessão, credenciais e volumes preservados.

Confirmado no gateway: áudios, imagens, vídeos, documentos, figurinhas e reações
recebidos. Antes da correção, a conferência local mostrou reações como bolhas no
histórico e downloads de imagem/figurinha/documento rejeitados; um áudio baixou
17.129 bytes `audio/ogg`. Corrigido: referência completa de mídia e renovação pelo
gateway; alias LID validado na conversa/instância; resposta de reação exige ID
confirmado sem repetição automática; atualização por autor e sem bolha separada;
metadados de duração/nome e cache de histórico versão 3.

Os novos casos sintéticos reproduziram as falhas. A rodada final selecionada
passou 174 testes backend sem erros, falhas ou skips, em ambiente descartável sem
dotenv ou sockets externos. Bandit dos arquivos alterados sem alertas médios/altos;
lint/tipos frontend passaram. A suíte frontend completa detectou fixtures antigas
das novas consultas de visões/etiquetas/clientes arquivados e um caso assíncrono de
relatórios; ajustes e nova execução estão em andamento. Resultados em
`output/pos-correcao/evolution-candidate.json` e `output/evolution-audit/`.

Docker local estava saudável em `http://localhost:8765/`, com reinicialização
`unless-stopped`. O próximo rebuild e a conferência dos downloads ainda precisam
concluir. A candidata não foi promovida ao Shard; o aceite anterior identifica
9ce7525 e os gates da nova revisão precisam passar antes da promoção.

Conferência adicional: após alinhar também etiquetas vinculadas e relações da
ficha de clientes, os 136 testes frontend dos 27 arquivos afetados passaram,
incluindo WhatsApp, mídias, clientes, etiquetas e relatórios. A falha anterior de
relatórios não se reproduziu isoladamente nem nessa execução; seu log foi mantido.
A suíte completa anterior registrou 951 sucessos e sete falhas antes desses ajustes;
o CI completo da candidata ainda é obrigatório. Nenhum limite de teste foi reduzido.

Conferência de mídia recebida na revisão local 7a61d92: 23 conversas, sem bolhas
separadas de reação; áudio Ogg, imagem JPEG, vídeo MP4 e figurinha WebP baixaram
com sucesso. O documento inicialmente rejeitado foi identificado somente por
MIME como APK, já bloqueado pela política existente. PDFs e ZIPs serão conferidos
separadamente; o alias ZIP `application/x-zip-compressed` passa a usar o tipo
canônico já permitido. A lista de formatos permitidos não foi ampliada.

A referência completa enviada ao downloader conserva a chave real e limita sua
URL a `https://mmg.whatsapp.net` com directPath validado, impedindo origem
arbitrária indicada no conteúdo da mensagem. Novo teste sintético cobre esse caso.
O Compose vigente é `compose.local.yaml`; o arquivo antigo em
`output/docker-local/compose.yaml` não deve ser usado. A aplicação foi reconectada
ao Compose vigente após identificar esse arquivo histórico; volumes e gateway
foram preservados. Não usar `--remove-orphans`.

### Complemento solicitado: nomes, grupos e perfil

Leituras minimizadas em 20/10: 1.229 contatos no Norium, dos quais 1.202 com
nome disponível e 472 com foto; cache com apenas 12 grupos. O endpoint do gateway
retornou 237 grupos, 236 com assunto e 131 com foto, mas levou 90,2 segundos.
O timeout curto anterior impedia essa hidratação. O perfil ao vivo tinha nome,
número e foto, enquanto a rota de cache usada pela interface devolvia só o número.
Não foram expostos nomes, telefones, fotos ou conteúdo das conversas nesta leitura.

Correções: grupos completos carregados em segundo plano, limite de 150 segundos
e uma única tentativa para essa consulta longa; cache por 15 minutos, renovado
pela ação explícita de atualizar. O perfil é gravado assim que chega, antes dos
grupos, e consultado em cache enquanto sua tela estiver aberta. Eventos autenticados
de contatos/chats/grupos mantêm nomes e fotos, com vínculo atual comprovado antes
da escrita; nenhuma ação externa é acionada por conteúdo recebido.

IDs LID/grupo não são telefones nem se associam somente por dígitos iguais. Um
número real só é compartilhado por aliases explicitamente vinculados. Grupos não
herdam o nome/foto de uma pessoa; itens sem atividade têm ordenação estável por
nome. Lotes de delta incompletos recuperam o snapshot completo para não perder
grupos ao avançar o cursor. Reação removida é distinta de campo ausente.

Os 164 testes backend da rodada de metadados passaram; os 133 testes frontend
afetados passaram após corrigir também as expectativas antigas que apresentavam
LID como telefone. Lint/tipos passaram. A bateria abrangente WhatsApp/W-API/Evolution,
o rebuild local da candidata e a conferência final estão em andamento. Não declarar
nomes que o WhatsApp não forneceu nem envio/reação real validado por testes sintéticos.

Consolidação da validação: todos os 276 testes dos 19 módulos WhatsApp/W-API/
Evolution passaram, sem falhas, erros ou skips. Os 133 testes frontend afetados
passaram, e o teste adicional de troca de conta confirmou que uma resposta antiga
de perfil não sobrescreve o perfil atual. Bandit sem alertas médios/altos; lint e
tipos passaram. Recibos: `output/pos-correcao/whatsapp-all.json`,
`output/evolution-audit/frontend-metadata-final.log` e `frontend-profile-final.log`.
O resultado operacional da candidata fica em `output/evolution-audit/local-final-evidence.json`;
conferir a revisão desse recibo e `/api/system/release` antes de afirmar qual versão
está em execução. A promoção remota continua condicionada ao CI completo e ao aceite
humano da candidata atual; não reaproveitar o aceite específico de 9ce7525.

### Fechamento de nomes, grupos e perfil — 20/10

A configuração do webhook retornava 400 porque o enum publicado pelo gateway
usa `GROUP_UPDATE`, embora a constante de origem se chame `GROUPS_UPDATE`.
Corrigido o literal e coberto por regressão; nenhuma permissão foi ampliada.
O catálogo da interface agora incorpora todos os grupos do endpoint em cache,
além das 50 conversas recentes. O fallback de um delta maior que 100 recupera
também esse catálogo; o limite legado de histórico recente foi preservado.
Respostas antigas de contatos, grupos e conversas são descartadas após troca
de conta. O teste sintético confirma que um grupo da conta anterior não reaparece.

Validação desta correção: 277 testes backend (19 módulos), 135 testes frontend
(28 arquivos), lint, TypeScript e Bandit passaram. Recibos em
`output/pos-correcao/whatsapp-metadata-final.json` e
`output/evolution-audit/frontend-catalog-final.log`. Na revisão local anterior,
áudio, imagem, vídeo, figurinha e PDF recebidos baixaram com HTTP 200. O ZIP
recebido excedia o limite vigente e foi corretamente bloqueado com 413; não
ampliar esse limite para tornar o recibo verde. A conferência operacional após
o rebuild da revisão final deve identificar seu SHA e o resultado de sincronização.

Na execução local `d3acec4`, a sincronização terminou em 100%: 1.252 contatos
(1.227 com nome disponível), 237 grupos distintos (236 com assunto), perfil próprio
com nome, telefone e URL de foto. As cinco modalidades de mídia permitida recebida
baixaram com 200; o ZIP permaneceu bloqueado por tamanho. A presença da URL não
comprovou o carregamento da foto: o proxy rejeitou `pps.whatsapp.net` com 400.
Corrigido para aceitar somente esse host exato adicional quando Evolution está
ativo. Registro prévio por usuário, HTTPS, DNS público, bloqueio de redirects,
MIME e limite de tamanho continuam obrigatórios. W-API não ganha esse host por
padrão. Casos sintéticos cobrem isolamento do registro e rejeição de outras origens.
Também corrigida a recuperação visual quando a URL de uma foto que falhou é trocada.

Rodada final: 279 testes backend passaram; 135 frontend afetados passaram e os
cinco casos de catálogo/perfil/foto passaram após o complemento visual. Lint,
TypeScript e Bandit passaram. A confirmação HTTP das fotos na versão com o host
corrigido ainda deve constar do recibo operacional antes de declarar esse item validado.
O CI de `d3acec4` completou os 1.717 testes backend e os 160 arquivos frontend,
mas o wrapper Gitleaks consultou o head novo `62404f1` depois do checkout antigo
e falhou por intervalo Git inexistente. Essa falha não é aprovação de segurança;
a candidata final deve ficar congelada e passar em todos os gates normalmente.
