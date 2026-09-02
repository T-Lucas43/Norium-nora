# Central de Documentos

## Objetivo

A Central de Documentos amplia o antigo modulo de propostas sem quebrar seus fluxos. Propostas, contratos, aprovacoes, assinaturas, modelos, arquivos importados e ferramentas de PDF continuam isolados por tenant e workspace na API `/api/comercial`.

## Persistencia e isolamento

- Metadados permanecem no repositorio JSON `comercial`, com as colecoes `proposals`, `contracts`, `templates`, `uploadedDocuments`, `processingJobs` e `publicLinks`.
- Arquivos binarios ficam no diretorio privado `documents` ao lado do banco do tenant/workspace. O caminho fisico nunca e retornado ao navegador.
- Download exige autenticacao e resolve novamente o tenant/workspace atual.
- Nome, extensao, MIME, assinatura magica e tamanho sao validados antes da persistencia. Os arquivos importados ficam marcados para revisao de seguranca enquanto um antimalware nao estiver configurado.

## Processamento de PDF

Os trabalhos sao persistidos com os estados `queued`, `processing`, `completed`, `failed` e `cancelled`, progresso, tentativas, tempo limite e IDs dos resultados. A resposta HTTP nao precisa manter o processamento aberto.

Operacoes nativas: combinar, separar, reorganizar, excluir e girar paginas, comprimir streams, converter imagens, marca d'agua, editar com sobreposicao de texto posicionada, numeracao, adicionar/remover senha autorizada, extrair texto, remover metadados, sanitizar e comparar texto.

Ao abrir `Ferramentas PDF`, o frontend troca a Central por um workspace completo do
`Norium PDF Studio`: catalogo pesquisavel por categoria, importacao multipla,
selecao de documentos, visualizacao autenticada, editor de texto/cor/posicao,
opcoes de conversao, fila e historico. A organizacao segue o padrao de suites de
PDF conhecidas, mas usa componentes, cores e identidade do Norium. A interface so
exibe operacoes confirmadas pelo endpoint de capacidades; nenhum card simula uma
funcao ausente no backend.

O adaptador Stirling PDF e opcional e somente backend. Quando `STIRLING_PDF_URL` esta configurada, o Norium consulta `/v3/api-docs` e so anuncia ou chama uma operacao confirmada pela instancia. A chave global, quando usada, fica em `STIRLING_PDF_API_KEY` e segue no header `X-API-KEY`. Sem instancia disponivel, as operacoes nativas continuam funcionando; OCR nao aparece como disponivel.

## Seguranca e operacao

- Nenhuma URL arbitraria e aceita pelo navegador ou pelos endpoints de processamento.
- A URL do Stirling e configuracao de servidor e passa por validacao de esquema, host e transporte em producao.
- Senhas de PDF sao usadas apenas durante o trabalho e nao sao copiadas para os documentos de saida, logs ou respostas.
- Jobs e arquivos ativos nao podem ser apagados de forma concorrente.
- Para escala horizontal, a fila em processo deve ser substituida por worker/queue duravel e o armazenamento local por blob storage compartilhado. A colecao persistida ja desacopla o contrato de API do executor.

## Limites atuais

A assinatura interna existente registra consentimento, ordem, hash de e-mail, data, IP e user-agent, mas nao substitui uma assinatura qualificada por provedor certificado. O Stirling PDF nao e embarcado na imagem principal nem recebe acesso ao banco do Norium; sua ativacao em producao exige uma instancia isolada, versao fixada e revisao operacional separada.
