# Operação do cérebro durável da Nora

O cérebro permanece desativado até que o piloto, o banco e os segredos sejam aprovados. A aplicação não faz chamadas de modelo e não cria o executor apenas por receber este código.

## Topologia

- O aplicativo web autentica o usuário, mantém uma única réplica enquanto os módulos legados ainda usam JSON e executa as gravações legadas por uma interface interna HMAC.
- Na Shard, um contêiner separado executa `python -m app.modules.nora.brain.worker`, com um executor e sem montar os dados dos módulos legados. A aplicação web continua sendo o escritor único desses dados.
- PostgreSQL guarda trabalhos, eventos, aprovações, posses e orçamento. SQLite é aceito somente em ambiente local/teste explícito.
- A credencial do modelo existe somente no executor. O web recebe apenas a URL PostgreSQL e o segredo da interface interna.

## Pré-requisitos para ativar

1. Provisionar PostgreSQL gerenciado com TLS e verificação de certificado (`verify-full`), backup e rede definidos para o ambiente. A infraestrutura não cria um SKU automaticamente porque dimensionamento, rede, RPO e RTO ainda precisam de aprovação.
2. Criar um banco e usuário exclusivos da Nora, sem acesso às bases ou ao armazenamento JSON dos módulos.
3. Definir no `.env` usado pelo script de implantação:
   - `NORA_BRAIN_DATABASE_URL`, no formato PostgreSQL;
   - `NORA_BRAIN_INTERNAL_SECRET`, aleatório e com pelo menos 32 caracteres;
   - `NORA_BRAIN_PROVIDER=groq` e `GROQ_API_KEY` para o piloto aprovado, com `NORA_BRAIN_ROUTINE_MODEL=openai/gpt-oss-20b`;
   - `NORA_BRAIN_INTERNAL_URL`, acessível somente na rede privada do web;
   - `NORA_LEGACY_WRITER_SINGLETON=1` no web e `NORA_BRAIN_EXECUTOR_ENABLED=1` somente no executor;
   - `NORA_BRAIN_ALLOW_MODEL_CALLS=1` somente após revisão da finalidade e do provedor. Credenciais dos provedores não devem entrar no frontend.
4. Validar os modelos e o tratamento de dados da organização antes de habilitar dados reais.

O GitHub é a fonte da revisão e da imagem imutável. Na Shard, promover apenas a imagem auditada, preservando os dados, segurança do contêiner e rollback. A implantação do web não ativa o cérebro: `NORA_BRAIN_ENABLED`, chamadas de modelo e executor têm opt-in independente. O script Azure é histórico e não é o procedimento de homologação atual.

## Evidência do piloto local em 12/10/2026

- PostgreSQL dedicado em Docker, sem reutilizar dados de homologação. `scripts/nora_brain_smoke.py` confirmou aprovação exata, interrupção/reinício, estado `unknown` e ausência de duplicação com ferramentas sintéticas.
- Ensaio adicional de HTTP com bootstrap/login sintéticos, web Uvicorn e worker real: `/api/nora/brain/health` retornou PostgreSQL; consulta Groq percorreu `queued -> running -> completed`, sem ferramentas/efeitos. Recibo: `output/brain-local/authenticated-928143eb0f8f/receipt.json` (15,047 s). Não prova sessão real de homologação.
- `scripts/eval_nora_ptbr.py`: 27/30 casos (90%), modelo real Groq e argumentos validados; recibo `output/pos-correcao/nora-ptbr-real-20261012-p.json`. Três casos falharam sem execução: dois contratos do provedor e um formato de resposta. OpenAI embeddings e Brave permanecem simulados, pois suas chaves não foram autorizadas.
- Gmail incremental permanece desativado fora do piloto; sua cobertura inicial é limitada a 100 IDs, não uma sincronização completa do acervo.

## Verificação depois de uma implantação autorizada

1. Confirmar uma única réplica do web e uma única réplica do executor.
2. Autenticar no Norium e consultar `GET /api/nora/brain/health`; o retorno deve indicar `driver: postgresql`.
3. Criar um trabalho sintético de consulta e conferir a transição `queued -> running -> completed`.
4. Criar uma operação sintética de revisão e conferir que nenhum efeito ocorre antes da aprovação exata.
5. Reiniciar o executor durante uma ferramenta simulada e comprovar estado `unknown`/reconciliação, sem segundo efeito.
6. Conferir logs sanitizados e ausência de conteúdo, credenciais ou argumentos integrais.

## Pausa e rollback

Escalar o executor para zero interrompe novas etapas sem apagar trabalhos. Não remover o banco nem liberar a fila em massa. Em rollback de imagem, mantenha o banco, confira a versão do esquema e deixe operações `unknown` pendentes de reconciliação.

## Restauração

A restauração é humana. Mantenha web e executor parados, restaure em ambiente isolado e reaplique o registro atual de exclusões, armazenado fora do volume e dos backups. Não substituir esse registro por uma cópia antiga. Reaplique a retenção autorizada, invalide posses, expire revisões vencidas e reconcilie operações externas posteriores ao ponto restaurado. Só então libere leitura e, após revisão dos trabalhos, o executor. Um registro ausente no backup não prova ausência de efeito externo. Veja `backup-and-restore.md` e `release-rollback.md`.
