# Capacidades de inteligencia empresarial

Esta nota registra a arquitetura publicada para o Agente Navegador, Conhecimento,
Marketplace interno e roteamento multi-modelo. As quatro capacidades compartilham
autenticacao, isolamento por usuario/workspace, permissoes granulares e trilha de
estado, mas permanecem modulos independentes.

## Fronteiras de seguranca

- O Agente Navegador usa Playwright e Chromium headless reais em um contexto
  isolado por execucao. Ele navega, pesquisa, clica, preenche, seleciona, pressiona
  teclas, extrai texto/tabelas/links, envia e baixa arquivos e captura evidencias.
- URLs com credenciais embutidas, localhost, IP privado/reservado, portas nao-web
  ou protocolos nao HTTP(S) sao bloqueadas. A resolucao DNS e todas as requisicoes
  do contexto passam pela politica anti-SSRF, inclusive redirecionamentos.
- Cada execucao preserva plano editavel, risco, progresso, resultado, erro, linha do
  tempo e artefatos. Cliques, teclas, formularios, credenciais e transferencias de
  arquivo exigem confirmacao imediatamente antes da acao externa.
- Perfis limitam dominios, duracao e quantidade de etapas e liberam separadamente
  formularios, downloads, uploads e retencao de sessao. Cookies persistidos sao
  criptografados e credenciais so entram no DOM pela referencia ao cofre; o segredo
  nao e devolvido no plano, resultado ou log.
- A fila possui pausa, retomada, cancelamento, limite de concorrencia e timeout. A
  recuperacao nao repete automaticamente uma acao externa ja concluida. Para mais
  de uma replica, o executor em processo deve migrar para fila e lock distribuidos.
- A imagem roda como usuario Linux sem privilegios. O build abre o Chromium e clica
  em um elemento DOM; apos o deploy, `/health/browser` navega e clica em um destino
  publico fixo, provando o motor da revisao ativa.

## Conhecimento empresarial

- Bases possuem visibilidade (`private`, `team`, `workspace`), descricao e tags.
- Fontes de texto e URL sao normalizadas, divididas em trechos sobrepostos e
  deduplicadas por SHA-256.
- A busca lexical retorna base, fonte, URL, trecho, posicao, relevancia, data de
  indexacao e indicador de desatualizacao. A permissao da base e aplicada antes
  de qualquer trecho entrar no resultado.
- A abstracao de fonte permite adicionar PDF, Google Drive, crawler e conectores
  empresariais depois, sem acoplar a tela a um provedor de embeddings.
- A implementacao atual nao chama um banco vetorial externo nem apresenta busca
  lexical como embeddings. Isso evita status ficticio quando nenhum provedor foi
  configurado.

## Marketplace interno

- O catalogo contem metadados de tipo, autor, versao, verificacao, permissoes e
  dependencias.
- Instalar exige confirmacao explicita e cria um recurso real: perfil de navegador,
  automacao, base ou politica.
- Recursos instalados nascem desativados. Desinstalar preserva historico e
  configuracao, desativando o recurso associado.
- Atualizacoes preservam o identificador da instalacao e adotam a versao atual do
  catalogo somente depois de nova confirmacao.

## Gateway de IA e modelos

- Adapters cadastraveis: Groq, OpenAI, Anthropic e APIs OpenAI-compatible.
- Chaves sao criptografadas no backend e nunca retornam pela API. A Nora Runtime
  continua usando `GROQ_API_KEY` do ambiente.
- Politicas podem exigir capacidades (`text`, `vision`, `tools`, `json`),
  privacidade, provedor preferido e teto de custo.
- O roteador filtra indisponibilidade, credencial, capacidade, privacidade e custo;
  depois ordena por preferencia, custo e janela de contexto.
- Fallback e bloqueado quando `externalActionCommitted=true`, evitando repetir uma
  acao externa que talvez ja tenha sido concluida.
- Respostas gerais da Nora podem usar selecao automatica ou manual. Chamadas
  efetivas registram provedor, modelo, tokens e custo estimado. A simulacao de rota
  nao consome tokens.

## Integracao com Automacoes e Nora

- O construtor oferece `Executar tarefa no navegador`, com URL, objetivo, perfil,
  modo assistido/automatico, formato do resultado, limite de etapas e timeout, e
  `Executar IA com roteamento`, com politica e nivel de privacidade.
- A execucao da automacao usa os mesmos servicos do modulo: nao existe um caminho
  paralelo que ignore permissoes, aprovacao ou auditoria.
- A Nora reconhece pedidos explicitos com URL e cria um plano do navegador. Ela nao
  executa o plano no mesmo turno; o operador revisa a tela e autoriza quando
  necessario.
- O seletor de modelo da Nora lista somente provedores habilitados e configurados.

## Referencias tecnicas

Os projetos abaixo foram estudados como referencias de arquitetura, sem copiar
codigo nem substituir os modulos nativos do Norium:

- [Playwright para Python](https://playwright.dev/python/) — motor atual do adapter
  Chromium, instalado com o navegador e dependencias fixados na imagem (Apache-2.0).
- [Browser Use](https://github.com/browser-use/browser-use) — referencia de
  orquestracao e experiencia para agentes de navegador; nao e dependencia (MIT).
- [Dify](https://github.com/langgenius/dify) — pipelines, conhecimento e operacao
  de apps de IA; possui licenca propria, portanto e referencia, nao dependencia.
- [Crawl4AI](https://github.com/unclecode/crawl4ai) — extracao e crawling para LLMs;
  candidato a adapter de fontes web (Apache-2.0).
- [Langflow](https://github.com/langflow-ai/langflow) — editor visual de fluxos e
  componentes; referencia para os blocos de automacao (MIT).
- [Open WebUI](https://github.com/open-webui/open-webui) — experiencia multi-modelo;
  referencia visual com ressalvas de licenca/marca.
- [Maxun](https://github.com/getmaxun/maxun) — automacao visual de navegador;
  referencia de produto sob AGPL-3.0.

O inventario detalhado de repositorios, licencas e decisoes permanece em
[`docs/research/instagram-open-source-repositories.md`](../research/instagram-open-source-repositories.md).
