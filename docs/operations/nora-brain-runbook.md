# Operação do cérebro durável da Nora

O cérebro permanece desativado até que o piloto, o banco e os segredos sejam aprovados. A aplicação não faz chamadas de modelo e não cria o executor apenas por receber este código.

## Topologia

- O aplicativo web autentica o usuário, mantém uma única réplica enquanto os módulos legados ainda usam JSON e executa as gravações legadas por uma interface interna HMAC.
- Um Container App separado executa `python -m app.modules.nora.brain.worker`, com uma réplica mínima e sem montar o Azure Files dos módulos legados.
- PostgreSQL guarda trabalhos, eventos, aprovações, posses e orçamento. SQLite é aceito somente em ambiente local/teste explícito.
- A credencial do modelo existe somente no executor. O web recebe apenas a URL PostgreSQL e o segredo da interface interna.

## Pré-requisitos para ativar

1. Provisionar PostgreSQL gerenciado com TLS e verificação de certificado (`verify-full`), backup e rede definidos para o ambiente. A infraestrutura não cria um SKU automaticamente porque dimensionamento, rede, RPO e RTO ainda precisam de aprovação.
2. Criar um banco e usuário exclusivos da Nora, sem acesso às bases ou ao armazenamento JSON dos módulos.
3. Definir no `.env` usado pelo script de implantação:
   - `NORA_BRAIN_DATABASE_URL`, no formato PostgreSQL;
   - `NORA_BRAIN_INTERNAL_SECRET`, aleatório e com pelo menos 32 caracteres;
   - `OPENAI_API_KEY`, credencial exclusiva do executor.
4. Validar os modelos e o tratamento de dados da organização antes de habilitar dados reais.

O deploy explícito usa `infra/azure/deploy.ps1 -EnableNoraBrain`. Sem essa opção, nenhum executor é criado e nenhum segredo do cérebro é injetado.

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

A restauração é humana. Mantenha web e executor parados, restaure em ambiente isolado, reaplique a retenção, invalide posses, expire revisões vencidas e reconcilie operações externas posteriores ao ponto restaurado. Só então libere leitura e, após revisão dos trabalhos, o executor. Um registro ausente no backup não prova ausência de efeito externo.
