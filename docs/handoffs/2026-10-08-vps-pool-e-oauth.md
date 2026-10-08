# Continuidade da publicação na VPS

## Base e limite de publicação

Base aprovada: `0cc537912f88e0eb4c701f7671142675a35b9164`, PR #45.
O incremento desta rodada corrige a qualidade das conexões PostgreSQL;
precisa de revisão humana crítica e dos gates antes da promoção.
O checkout original permanece preservado. Não ativar workflows Azure.

## Evidência observada

- A imagem exata da base passou no sandbox real da VPS com UID10001,
  capabilities zeradas, seccomp, no-new-privileges e rootfs somente leitura.
- O novo subdomínio de homologação está com DNS e certificado HTTPS válidos.
  Responde manutenção enquanto os gates continuam.
- Backup atualizado foi restaurado numa cópia isolada. A migração OAuth
  protegeu dez seções, foi idempotente e preservou os valores lógicos dos
  duzentos documentos e os bytes/metadados dos vinte e dois blobs.
- A readiness e a identidade do release passaram no boot isolado. Workers
  de envio foram mantidos desligados somente nesse boot de teste.
- O login real da conta designada retornou 500. A análise minimizada indicou
  OperationalError ao consumir a conexão PostgreSQL no read_document.
  Conexão inválida reaproveitada após ociosidade é a hipótese a comprovar.

## Incremento proposto

- Usar `ConnectionPool.check_connection` no checkout, conforme o mantenedor,
  antes de entregar a conexão ao corpo da operação.
- Classificar queda durante operação como armazenamento indisponível; queda
  em commit/rollback tem resultado desconhecido. Nenhuma escrita é repetida.
- Preservar erros de negócio, TLS verificado, timeout, limite de espera,
  quotas, isolamento, sessões, cookies e permissões.
- Dez testes focados de qualidade de conexão/TLS e a suíte completa de 1.330
  testes passaram, sem falhas, erros ou skips.
- Preview na VPS, sem alterar o servidor nem sua imagem: o módulo proposto
  descartou o socket TLS fechado pelo próprio processo, verificou uma nova
  conexão e executou o corpo uma única vez. O arquivo de teste tem SHA256
  `84de6200c6d090034b1f09b19f8005152ee79cddef73a7c7acace08b5034a396`.
  Isso não constitui validação de uma nova imagem imutável.
- O gate PostgreSQL existente ganhou uma regressão que termina somente a
  própria conexão descartável, limitada por banco/PID/application_name,
  antes do próximo checkout. Ela será executada no novo CI.

## OAuth e ferramenta de navegador

O responsável aprovou os callbacks Gmail e Agenda no novo HTTPS, mantendo
os anteriores. Eles ainda não foram salvos: o navegador falhou repetidamente
na inicialização do ambiente Windows. Há espaço livre; o diagnóstico antigo
disponível não descreve a falha atual. Não desativar sandbox nem extrair
cookies/credenciais do navegador como alternativa. O responsável pediu que
o Codex realize a alteração; recuperar o acesso normal antes de fazê-la.
As tentativas de reset e reconexão também falharam. Diagnósticos disponíveis
não explicam a causa; a orientação oficial indica reiniciar o aplicativo
quando o sandbox antes funcional deixa de operar. Não mudar para uma proteção
mais fraca nem reiniciar as demais conversas/processos do usuário sem seu pedido.

## Gates restantes

1. Comprovar e revisar o incremento concreto do pool; suíte/CI da mesma revisão.
2. Salvar e validar os callbacks aprovados sem alterar escopos ou URLs anteriores.
3. Exercitar recuperação/rollback compatível com revogação, epoch e OAuth.
4. Pausar todos os writers antigos, repetir backup/inventário, migrar offline
   o banco ativo e comparar integridade antes de iniciar um único writer novo.
5. Readiness, identidade, login real, cookie persistente, dispositivos,
   revogação, sockets e jornadas autorizadas, com evidência remota.
6. Registrar o parecer de lançamento: produção ainda não existe, falta a prova
   entre duas contas distintas e permanecem requisitos operacionais de lançamento.

Identificadores de infraestrutura, recibos privados e detalhes operacionais
ficam somente nos arquivos ignorados de output/pos-correcao. Não há promoção
da base como aplicação funcional publicada nem avanço da main nesta rodada.
