# Controle operacional: carregamento e persistência

## Problemas identificados

- O painel esperava o resumo agregado, que consultava tarefas, financeiro, eventos, aprovações, auditoria, comprovantes, modelos, acompanhamentos, memória e configurações.
- A verificação de propriedade da integração W-API usa locks de processo e SQLite. Sua leitura síncrona dentro da coroutine podia bloquear outras requisições.
- O financeiro percorria todos os diretórios de contas, embora não ofereça compartilhamento entre contas.
- A lista de tarefas carregava a mesma coleção duas vezes. Mutações regravavam todos os workspaces carregados, e a descoberta dos arquivos ignorava o ambiente selecionado.
- Após timeout, a interface interpretava ausência de resposta como zero itens e mostrava mensagens de sucesso.

## Correção

O painel usa cinco consultas independentes em `/api/operacao/painel/{section}`: `summary`, `approvals`, `history`, `integrations` e `memory`. Indicadores, aprovações e histórico não dependem da integração. Cada seção tem estado de carregamento, tentativa de recuperação e snapshot com expiração própria de 60 segundos. As solicitações são canceladas ao sair da tela e não se sobrepõem durante a atualização automática.

As leituras de integração executam fora do event loop. Consultas repetidas do painel reutilizam a leitura de integração ainda em andamento, com prazo de oito segundos por espera. Um lock lento permanece restrito a essa seção. As verificações de propriedade continuam aplicadas. O endpoint agregado anterior permanece disponível para os consumidores existentes.

O financeiro acessa somente o arquivo do usuário e ambiente solicitados. Tarefas continuam respeitando compartilhamentos explícitos de projetos, reutilizam a leitura já feita e gravam somente o proprietário alterado. Leituras em outro ambiente não importam o ambiente principal.

A persistência JSON usa codificação compacta (`separators=(",", ":")`) nas novas gravações, preservando estrutura, Unicode e escrita atômica. Não há regravação em massa dos arquivos existentes nem migração de banco nesta entrega. Arquivos existentes continuam compatíveis e tornam-se compactos quando atualizados. O cache de leitura é limitado por quantidade/tamanho, usa o caminho completo e verifica tamanho, modificação e identidade do arquivo antes de reutilizá-lo. Consumidores recebem cópias independentes, e alterações externas ou exclusões invalidam a versão anterior.

Referência do formato: [documentação oficial de JSON do Python](https://docs.python.org/3/library/json.html#basic-usage).

## Medições controladas locais

| Cenário | Antes | Depois |
| --- | ---: | ---: |
| Dados úteis do painel, com oito segundos de atraso simulado na integração | 8.111 ms | 515 ms |
| Arquivos consultados pelo financeiro, com 200 contas sintéticas | 201 | 1 |
| Consulta financeira com 2 ms adicionais simulados por leitura de arquivo | 1.580,9 ms | 14,7 ms |
| Tamanho dos mesmos JSONs sintéticos após gravação compacta | 1.361.600 bytes | 829.400 bytes |

A redução de tamanho foi de 39,1%, com igualdade dos documentos após decodificação. As duas versões retornaram os mesmos 40 lançamentos da conta consultada. Essas medições demonstram os gargalos removidos; não representam latência ou percentual de compressão de todas as contas de produção.

## Validação

- Testes de carregamento parcial, falha com recuperação e cancelamento ao sair da tela.
- Testes de cache sem compartilhamento de objetos, invalidação por alteração/exclusão e separação por caminho.
- Testes de separação entre usuários e ambientes e preservação do acesso aos projetos compartilhados.
- Histórico do painel sem snapshots completos de undo; o backend continua consultando o registro original ao desfazer.
- Aprovações pendentes posteriores aos primeiros 50 registros continuam visíveis.
- Comparação visual em 1.440 e 390 px sem erros JavaScript ou rolagem horizontal.

A descoberta inicial de projetos compartilhados ainda percorre os arquivos de tarefas. O cache reduz releituras e parsing, mas esta entrega não substitui esse mecanismo por um índice relacional.
