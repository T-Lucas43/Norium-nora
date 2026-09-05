# Central: pendências disponíveis durante falhas de uma fonte

O erro observado era da Central (`/api/operacao/pendencias`). A publicação anterior havia dividido o Controle Operacional, mas a Central ainda aguardava uma única consulta agregada. Ela lia sete coleções e depois esperava a verificação de propriedade W-API, que pode aguardar locks de processo e SQLite. Mover essa verificação para uma thread não removia a dependência da resposta agregada.

## Alterações

- A Central consulta cinco fontes independentes em `/api/operacao/pendencias/fontes/{source}`: atividade (aprovações, acompanhamentos e erros de automações), tarefas, financeiro, mensagens e integrações.
- Cada resultado é exibido assim que chega. Contadores parciais usam `+`, as fontes mostram seu estado e uma fonte indisponível não apaga os resultados das outras. Uma falha não é interpretada como ausência de pendências.
- Atualizar uma fonte com erro não refaz as demais consultas. Respostas antigas são ignoradas e solicitações são canceladas ao sair da tela.
- O backend limita a espera por fonte a cinco segundos. Requisições simultâneas reutilizam a mesma leitura em andamento somente quando processo, diretório de dados, conta, workspace e fonte coincidem. Não há cache de resultados compartilhado entre usuários.
- O endpoint agregado continua disponível para consumidores existentes, com `complete` e `sources` explícitos quando uma fonte não terminou.
- Cards recebem títulos, descrições curtas e referências para abrir o registro. Corpos de e-mail, anexos e metadados completos não são transmitidos na lista de prioridades.
- Leituras demoradas geram registros de duração por fonte, sem conteúdo privado ou credenciais. As verificações de propriedade da integração permanecem aplicadas.

## Verificação

- Regressão HTTP com o lock real do serviço W-API retido em outra thread: tarefas continuam acessíveis enquanto a requisição de integrações espera.
- Concorrência com contas e workspaces diferentes, limite de espera do agregado, autenticação, validação da fonte e mensagens sem detalhes privados.
- Uma mensagem sintética com dois megabytes em corpo/anexos e descrição longa retorna menos de quatro quilobytes na consulta de prioridades, preservando a referência de abertura.
- Testes de interface para fonte lenta, fonte indisponível, recuperação independente, contagens parciais, resultados vazios incompletos, cancelamento e respostas fora de ordem.
- Conferência visual com o componente real e uma API local com dados fictícios: a lista permanece disponível durante 30 segundos de bloqueio da integração; a recuperação atualiza essa fonte. Layout conferido em desktop e 390 px, sem transbordamento horizontal.

Essa reprodução local não substitui a conferência autenticada com a conta afetada em produção. A sessão de produção disponível ao agente apresentou a tela de login; o usuário foi solicitado a entrar pelo navegador, sem compartilhar a senha na conversa. Saúde pública e presença de novos arquivos/endpoints confirmam a publicação, mas não demonstram a latência dos dados dessa conta.
