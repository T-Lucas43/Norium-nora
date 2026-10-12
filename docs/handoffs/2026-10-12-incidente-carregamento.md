# Incidente de carregamento — homologação

## Pedido e prioridade

O usuário relatou tela branca com ERR_CONNECTION_REFUSED, erros no service
worker e imports de AuthScreen/AccountEmailAction. Correção urgente individual;
layout do admin preservado em outra branch e retomado após a estabilização.
Publicação e deploy em homologação já autorizados; fases 6/7 não entram.

## Evidências

- Probes da máquina: health/release/env/JS/sw sem conexão HTTP.
- VPS: norium-api running/healthy, sem OOM/restarts automáticos; proxy HTTPS
  norium-edge-proxy parado desde 15:58 UTC. API iniciada novamente às 16:41 UTC.
  Não há evidência de quem parou/reiniciou esses contêineres.
- Start do proxy falhou: Address already in use. Inspeção sem expor IPs mostrou
  reserva estática do proxy ocupada pela API; upstream usa DNS norium-api.
- Recuperação: snapshot privado na VPS, religação do mesmo proxy à mesma rede
  com endereço dinâmico; preservar imagem, HostConfig, portas, certificados,
  mounts e restart policy. Registrar confirmação HTTPS/PostgreSQL após concluir.
  Concluído: mesmo contêiner/config/HostConfig/mounts/certificados, reserva
  conflitante removida e proxy running. HTTPS público/PG prontos, revisão
  ccfb058e preservada. A máquina do usuário confirmou health ready, 11,16 ms.
- SW publicado: cache miss + fetch rejeitado devolve undefined; navegação
  também pode devolver undefined. Confirma o TypeError de Response da captura.

## Correção preparada

1. SW sempre retorna Response, com fallback público e falhas de cache tratadas;
   API, Authorization, mídias privadas e URLs assinadas não entram no cache.
2. Mensagem de entrada em HTML antes do JS, para evitar tela vazia se o bundle
   não carregar, e boundary React para import/tela que falhar.
3. Testes sintéticos de rede rejeitada, cache vazio/falho, resposta válida,
   recursos privados e recuperação. CI completo antes de promover a imagem.
4. Depois, incorporar somente esse hotfix como base do admin; contratos e
   handlers administrativos continuam preservados.

## Validação do código

TypeScript passou. Testes focados 12/12: cache/rede rejeitados, Response válido,
API/recursos privados/assinados, cache pessoal preservado e boundary de import.
Lint sem erros, warnings preexistentes mantidos. Regressão completa/build e CI
ainda em andamento; não declarar a correção de frontend já em homologação.
