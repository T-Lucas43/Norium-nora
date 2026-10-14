# Novas funcionalidades — execução individual do Codex

## Autorização e escopo

- Em 12/10/2026, o usuário autorizou implementar o diagnóstico com “faça isso”.
- Executor individual, sem agentes/Muse. Preservar todos os fluxos e dados.
- Executar a consolidação, Onda 0 e demais ondas em sequência, com gates por onda.
- Sem autorização nova para push, merge, deploy, envio real, exclusão ou ativação de workers na Shard.
- Referência: `prompt-codex-novas-funcionalidades.md` e PDFs claro/escuro em Downloads.
- Diagnóstico: `output/novas-funcionalidades-20261012/DIAGNOSTICO-E-PLANO.md` no checkout principal.

## Isolamento e base

- Branch: `codex/novas-funcionalidades-20261012`.
- Checkout: `output/novas-funcionalidades-20261012/source` no projeto principal.
- Base local: `7c300e9`, árvore `1510154d91b9343fe8b10ae98f5b820ebe715aef`.
- Main GitHub conferida por conector: `9176971e572e9a8d2d9834c1bf7fd3332cf39775`, mesma árvore.
- `git fetch origin main` falhou com Repository not found na credencial do Git local; não alterou a base.
- Checkout principal e branches anteriores preservados. Dependências frontend reutilizadas por junction.

## Consolidação local validada

- Incorporados os commits locais `7d5786d`, `b5189b0`, `43bbc30`, `a4203df` das fases 6/7.
- Resolvido conflito de importação Gmail preservando limitação de leitura e identidade explícita.
- Registros de backlog/changelog/homologação combinados sem remover a documentação do admin.
- Admin, service worker e recuperação de carregamento publicados permanecem como base.
- Alteração estrutural de planos integrada ao formulário financeiro atual, sem recuperar o layout antigo.
- Regressão backend isolada: 1.494/1.494 testes aprovados; `output/pos-correcao/novas-consolidacao-20261012.json`.
- Frontend completo final: 899/899 aprovados; `norium-front-end/output/consolidacao-tests-final.json`.
- TypeScript aprovado, lint sem erros, Vite e orçamento de bundles aprovados.
- Formulário do admin atual integra `callsLimit`, preserva zero/null e mantém compatibilidade com respostas antigas sem esse campo.
- Campos do formulário em portal receberam estilos próprios e grade de uma coluna em celular.
- Conferência local: consumo, armazenamento e limites com dados sintéticos, gravações bloqueadas, claro/escuro, desktop/375px, foco e Escape.
- Dependências reutilizadas do checkout do hotfix publicado. Uma primeira tentativa de teste foi impedida por EPERM no sandbox; uma primeira tentativa de build usou junction com dependências antigas. Corrigida a execução/junction e repetidos os gates, sem alterar testes nem limiares.

## Decisões de implementação

- Envios novos exigem prévia e aprovação exata por operação; automação de resumos/satisfação/convites não é ativada implicitamente.
- Atendente WhatsApp: permissões delegadas separadas, desligadas por padrão, com limites e auditoria.
- Empresa/workspace/ator/dono do recurso são distintos; nenhum clientId ou nome do navegador define a autorização.
- Relacionamentos legados não vinculados são preservados; nenhuma associação automática por nome autoriza dados públicos.
- Cérebro, retenção, Gmail incremental e provedores novos continuam opt-in. Testes com dados sintéticos e providers simulados.
- Não alterar limiares dos gates, excluir testes ou usar mocks permissivos como prova de contrato.

## Sequência e critérios

1. **Consolidação**: contrato do admin/consumo, backend e frontend completos, build/lint e regressões anteriores.
2. **Onda 0**: aprovação genérica/ledger; escopo e relações; etiquetas; links públicos; presença; notificações com opt-out e PDF reutilizável.
3. **Onda 1**: Catálogo, atalhos em Gmail/WhatsApp/equipe, etiquetas/lote/visões e importação idempotente.
4. **Onda 2**: Funil, orçamento público, renovações, recibos, pedidos de documentos e portal.
5. **Onda 3**: Caixa omnicanal extra, Atendente, widget de site, lembretes/NPS/horários/espera.
6. **Onda 4**: Agora, rotinas, metas, datas importantes e resumo semanal por cliente.

Cada onda deve registrar arquivos, migrações aditivas, testes de tenant/workspace/permissão/concorrência/approval, build, navegador claro/escuro/375px e risco residual antes da seguinte. Commits locais pequenos. Publicação será uma etapa separada quando autorizada.

## Pendências do diagnóstico a resolver

- Metas: payload camelCase/period incompatível com API strict; coexistência com localStorage; período/direção dos indicadores.
- Importação: CSV atual gera IDs novos sem idempotência/merge; ampliar a XLSX/vCard e catálogo.
- Aprovações: contrato genérico e executor registrado reutilizando controles das fases.
- Links/uploads: finalidade, validade, uso máximo, revogação, isolamento, scan/quarentena/cota.
- Resumos: clientId explícito, janela Brasília, destinatários/ACL, opt-out e envio conciliável.
- Presença: recurso autorizado, expiração/pausa, múltiplas abas e atribuição exclusiva distinta do estado online.

## Estado

Implementação autorizada e em execução. Nenhuma onda nova declarada concluída. Nenhuma publicação ou ativação externa realizada nesta tarefa.

## Demandas urgentes durante a execução

- **Voz, concluída em homologação:** o usuário pediu corrigir a ElevenLabs e forneceu uma chave. O servidor estava em Edge e sem chave. Chave transportada cifrada, somente em configuração Docker; nenhuma chave no código/recibo/Git. Mesma imagem e revisão publicadas, volumes e segurança preservados; HTTPS/PostgreSQL prontos. O handler publicado gerou áudio pela ElevenLabs e o usuário confirmou “funcionou”. Recibo externo ao checkout em `../voz-elevenlabs-homologacao.json`. Não houve promoção do código destas ondas.
- **Franquia/agente de e-mail, em diagnóstico:** usuário informou conta específica e determinou consumo por tokens, sem bloqueio por dólar. Consulta autorizada somente dessa conta confirmou permissão Nora e 5.000 tokens livres, zero consumo/reservas, ciclo ativo. Verificar contexto do polimento de e-mail e preservar erros de quota no endpoint; não enviar as mensagens das imagens, não alterar arbitrariamente a franquia nem liberar envio sem aprovação exata.
- As novas ondas permanecem pendentes enquanto estas correções urgentes são tratadas.
