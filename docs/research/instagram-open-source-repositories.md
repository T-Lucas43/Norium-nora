# Repositórios open source citados no post do Instagram

Pesquisa registrada em 2 de setembro de 2026 para futura avaliação no Norium.

- Post de origem: [Instagram — @guilhermemorais.ia](https://www.instagram.com/p/Db80PSmEbWa/)
- Autor do post: Guilherme Morais (`@guilhermemorais.ia`)
- Data exibida pelo Instagram: 12 de agosto de 2026
- Tema: ferramentas open source que podem substituir ou complementar serviços pagos de IA, backend, automação, deploy, scraping e PDF.

## Observação sobre o conteúdo do post

O carrossel mostra nove repositórios numerados. O décimo, Dify, aparece na legenda, mas não em um card próprio. Os números de estrelas apresentados no post não foram usados como referência porque mudam continuamente e alguns não coincidem com o GitHub na data desta pesquisa.

## Lista validada

| Projeto | Repositório oficial | Função principal | Possível uso no Norium | Licença ou cuidado inicial |
| --- | --- | --- | --- | --- |
| Langflow | [langflow-ai/langflow](https://github.com/langflow-ai/langflow) | Construtor visual de agentes e fluxos de IA, com publicação como API ou servidor MCP. | Prototipar fluxos da Nora, RAG e automações sem acoplar a lógica diretamente à interface. | MIT. Ainda exige avaliação de autenticação, isolamento por tenant, observabilidade e custo dos modelos. |
| Browser Use | [browser-use/browser-use](https://github.com/browser-use/browser-use) | Biblioteca Python para agentes que navegam em sites, clicam, digitam, preenchem formulários e extraem dados. | Automação web assistida pela Nora em tarefas que não possuem API. | MIT. Alto risco operacional: precisa de sandbox, lista de destinos permitidos, confirmação humana, proteção de credenciais e defesa contra prompt injection. |
| Open WebUI | [open-webui/open-webui](https://github.com/open-webui/open-webui) | Interface self-hosted para conversar com Ollama, APIs compatíveis com OpenAI e outros modelos. | Ambiente interno para testar modelos e prompts; não substitui automaticamente a experiência própria da Nora. | Licença própria com componentes sob termos diferentes e exigência de preservação da marca; revisar `LICENSE` e `LICENSE_HISTORY` antes de incorporar ou rebatizar. |
| Supabase | [supabase/supabase](https://github.com/supabase/supabase) | Plataforma Postgres com autenticação, APIs, realtime, funções e armazenamento. | Alternativa de persistência durável e recursos realtime para dados hoje mantidos localmente. | Repositório principal Apache-2.0, mas a plataforma reúne vários componentes. A adoção mudaria autenticação, tenancy, migrações e infraestrutura do Norium. |
| Stirling PDF | [Stirling-Tools/Stirling-PDF](https://github.com/Stirling-Tools/Stirling-PDF) | Plataforma para editar, assinar, ocultar, converter, aplicar OCR e automatizar PDFs, com UI e API privadas self-hosted. | Serviço isolado para ampliar tratamento de documentos e propostas em PDF. | Projeto open-core; conferir a licença do recurso/edição desejado. Arquivos de clientes devem permanecer isolados e ter retenção explícita. |
| Coolify | [coollabsio/coolify](https://github.com/coollabsio/coolify) | PaaS self-hosted para implantar aplicações, bancos e serviços em servidores próprios. | Alternativa futura para operação self-hosted e ambientes de homologação. | Apache-2.0. É decisão de infraestrutura, não uma biblioteca do produto; comparar com o fluxo atual no Azure antes de qualquer migração. |
| Crawl4AI | [unclecode/crawl4ai](https://github.com/unclecode/crawl4ai) | Crawler e scraper Python voltado a gerar conteúdo estruturado para LLMs e pipelines de IA. | Coleta controlada de páginas para pesquisa, base de conhecimento ou RAG da Nora. | Apache-2.0. Exige controles contra SSRF, limites de tamanho/tempo, respeito a regras dos sites, sanitização e tratamento de conteúdo externo como não confiável. |
| OpenHands | [OpenHands/OpenHands](https://github.com/OpenHands/OpenHands) | Ferramenta de desenvolvimento orientado por agentes. Na verificação atual, o README também apresenta o Agent Canvas como central self-hosted para agentes de código. | Uso interno de engenharia para tarefas de código e automações; não é uma função direta do produto Norium. | MIT na versão verificada. Conceder somente acesso mínimo a repositórios, segredos e ambientes. O escopo do projeto evoluiu desde o post. |
| Maxun | [getmaxun/maxun](https://github.com/getmaxun/maxun) | Plataforma no-code para scraping, crawling, busca e extração de dados, transformando sites em APIs estruturadas. | Provas de conceito rápidas para fontes repetitivas ou criação de coletores sem código. | AGPL-3.0. Revisar obrigações da licença antes de modificar, incorporar ou oferecer como serviço. Também requer controles de navegador e conteúdo externo. |
| Dify | [langgenius/dify](https://github.com/langgenius/dify) | Plataforma colaborativa para workflows agentivos, pipelines RAG, modelos e ferramentas, com implantação cloud, VPC ou self-hosted. | Alternativa ao Langflow para orquestrar aplicações e fluxos da Nora. | Dify Open Source License, baseada na Apache-2.0 com condições adicionais; revisar antes de uso comercial ou incorporação. |

## Triagem inicial para o Norium

### Prioridade para prova de conceito

1. **Langflow ou Dify, não os dois inicialmente:** comparar integração por API, autenticação, segregação por tenant, versionamento de fluxos, observabilidade e facilidade de rollback.
2. **Crawl4AI:** avaliar como serviço backend isolado para ingestão de conteúdo público e controlado, nunca como acesso irrestrito à rede.
3. **Stirling PDF:** avaliar a API self-hosted para recursos avançados de PDF que hoje exigiriam implementação própria.
4. **Browser Use:** considerar apenas para casos sem API e depois de definir sandbox, allowlist, confirmação humana e auditoria de cada ação.

### Ferramentas de apoio ou decisões de infraestrutura

- **Supabase:** possível evolução de persistência, autenticação e realtime; requer projeto de migração, não simples instalação de dependência.
- **Coolify:** alternativa operacional ao Azure; só faz sentido após comparação de disponibilidade, backups, monitoramento, custo e responsabilidade de manutenção.
- **Open WebUI:** útil como laboratório interno de modelos e prompts.
- **OpenHands:** ferramenta interna do ciclo de engenharia.
- **Maxun:** útil para prototipagem de scraping no-code, condicionado à revisão da AGPL-3.0 e aos mesmos controles de segurança de automação web.

## Regras antes de adotar qualquer repositório

- Não copiar código ou instalar dependências apenas com base no post.
- Confirmar versão, manutenção recente, política de segurança, vulnerabilidades e licença no momento da adoção.
- Preferir execução como serviço isolado quando a ferramenta processar páginas, arquivos ou comandos não confiáveis.
- Preservar autenticação e isolamento multitenant do Norium; nenhuma integração pode compartilhar dados ou credenciais entre clientes.
- Manter segredos somente no backend e registrar finalidade, dados enviados, retenção, subprocessadores, logs e mecanismo de desligamento.
- Fazer uma prova de conceito pequena, com dados sintéticos, antes de alterar a arquitetura de produção.

## Estado desta pesquisa

O Stirling PDF passou da triagem para uma integracao opcional e desacoplada na Central de Documentos: o backend pode consultar o OpenAPI de uma instancia privada e somente liberar operacoes confirmadas. O servico nao foi incorporado a imagem principal nem habilitado no ambiente de producao; sem ele, o Norium usa suas ferramentas nativas e nao anuncia OCR. Os demais repositorios seguem apenas pesquisados e registrados, sem clone ou instalacao.
