# Tarefa Codex — PDF Studio, automações visuais e engenharia de agentes

- Estado: verificado localmente pelo Codex
- Pedido e autorização: substituir/evoluir a experiência de edição de PDF com referência no Stirling PDF, aproximar a tela de automações da experiência do n8n e aplicar ao ecossistema de agentes os controles pertinentes do AI Agents Engineering Guide. O usuário pediu explicitamente que o Codex execute sem Muse.
- Resultado esperado e ponto de parada: implementação local revisada e testada, sem push, merge ou deploy.
- Branch e commit-base: `main` em `ce72f7345d67559abb6f28849fe5df73da2a0bbd`.
- Alterações preexistentes que devem ser preservadas: `AGENTS.md`, `docs/operations/codex-muse-zed.md`, `scripts/muse-codex-bridge.mjs`, `scripts/test-muse-codex-bridge.mjs`, `docs/handoffs/MUSE-TASK-TEMPLATE.md` e `docs/workflows/`.
- Fontes pertinentes:
  - `AGENTS.md`
  - `docs/AI_GOVERNANCE.md`
  - `docs/workflows/codex-muse.md`
  - `norium-front-end/src/components/commercial/`
  - `norium-front-end/src/components/automations/`
  - `norium-front-end/src/components/nora/`
  - `norium-back-end/app/modules/commercial/stirling_pdf.py`
  - `norium-back-end/app/modules/nora/brain/`
- Escopo permitido: navegação, UI/UX, integrações já autorizadas do backend, documentação de arquitetura e testes diretamente relacionados.
- Fora de escopo: copiar código n8n sob licença Sustainable Use, copiar conteúdo sem licença explícita, trocar autenticação/tenancy, instalar serviços externos, usar dados reais, push, merge e deploy.
- Contratos e decisões definidos:
  - Stirling PDF permanece um motor privado opcional descoberto por OpenAPI; as ferramentas nativas continuam disponíveis.
  - A tela de automações será implementação independente com identidade Norium e contratos atuais.
  - Agentes preservam orçamento, contexto limitado, aprovação humana, reconciliação e evidência; a UI tornará plano/execução/evidência mais observáveis.
- Critérios de aceite observáveis:
  - atalho navegável e autorizado para `PDF Studio` na barra lateral;
  - biblioteca PDF com navegação por categorias, busca, abertura/importação e retorno claro ao editor;
  - canvas de automações com nós, portas/conexões, biblioteca e inspetor coerentes com o Norium;
  - trabalhos da Nora exibem etapas, cobertura de evidências e limites reais sem inventar telemetria;
  - testes direcionados e build frontend passam.
- Verificações previstas: Vitest dos módulos alterados, testes de navegação, TypeScript/Vite build e diff check.

## Entrega do Codex

- Arquivos alterados e motivo:
  - navegação (`tabs.ts`, `panelModules.ts`, `Sidebar.tsx`, `AppPanels.tsx`) para a rota/atalho `PDF Studio`;
  - `CommercialDashboard.tsx`, `PdfToolsWorkspace.tsx` e `pdfToolsWorkspace.css` para entrada direta, catálogo, busca, categorias, estado do motor e retorno correto a Documentos;
  - `AutomationsDashboard.tsx` e `automationBuilder.css` para portas, estados e leitura visual dos nós;
  - `NoraBrainJobs.tsx` e `noraBrainJobs.css` para controles, sinais, plano e trilha de evidências;
  - testes direcionados e `docs/architecture/pdf-automation-agent-references.md`.
- Decisões de implementação: experiência implementada independentemente; integração Stirling existente preservada; nenhum código n8n ou conteúdo sem licença incorporado; telemetria da Nora derivada somente do trabalho persistido.
- Comandos executados, diretórios e resultados reais:
  - `npm.cmd test -- ...` em `norium-front-end`: 7 arquivos, 29 testes aprovados;
  - `npm.cmd run build` em `norium-front-end`: TypeScript, Vite e orçamento de bundle aprovados;
  - `npm.cmd run lint`: concluído sem erros, com avisos já existentes no repositório;
  - `npm.cmd run audit:interactions`: 3 achados preexistentes fora do escopo em `AccountEmailAction.tsx`, `SystemEmailSettings.tsx` e `PagePreview.tsx`; nenhum em arquivo alterado;
  - `git diff --check`: sem erro de whitespace (somente avisos de conversão LF/CRLF do checkout).
- Verificações não executadas e motivo: fluxo visual autenticado não foi percorrido porque a prévia local abriu a tela de login e nenhum segredo foi usado; publicação e produção não foram autorizadas.
- Riscos e pendências: configuração/deploy de instância Stirling e qualquer licença comercial do n8n permanecem decisões separadas. A QA visual autenticada continua recomendada antes de publicar.

## Revisão do Codex

- Diff e contexto revisados: sim; mudanças preexistentes do fluxo Muse foram preservadas e não integradas ao escopo.
- Aceites atendidos: rota e atalho PDF, catálogo/edição, canvas de automações e observabilidade de agentes implementados com identidade Norium.
- Falhas encontradas, com arquivos e evidências: a primeira versão da rota direta não carregava capacidades PDF; reproduzido pelo teste `CommercialDashboard.test.tsx` e corrigido com carregamento explícito e cancelamento seguro. O retorno da rota direta também foi ligado a `Documentos` e coberto por teste.
- Resultado da nova verificação: 29/29 testes direcionados, build e bundle aprovados.

## Encerramento

- Branch/commit final ou arquivos ainda não commitados: entrega preparada na branch `main`; o SHA será registrado pelo histórico Git do commit.
- Resultado: aceito localmente.
- Motivo: critérios observáveis atendidos e verificações direcionadas aprovadas, sem publicação.
- Próximo marco único: QA visual autenticada e autorização separada para publicação.
