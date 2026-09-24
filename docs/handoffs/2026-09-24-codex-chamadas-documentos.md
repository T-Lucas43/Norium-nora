# Handoff Codex — chamadas de equipe e Documentos

Data: 2026-09-24
Executor: Codex direto (sem Muse)
Estado: implementado e validado localmente

## Escopo

- Exibir a foto de perfil de participantes remotos com a câmera desligada, mantendo iniciais como fallback.
- Preservar a sessão da chamada em recarregamentos e impedir que um F5 acidental encerre uma transmissão local ativa.
- Tocar um único som de entrada, um único som de saída e um som distinto no início do compartilhamento de tela, sem toque contínuo.
- Corrigir o layout responsivo da barra de filtros de Documentos.
- Entregar em `main` sem deploy.

## Implementação

- `TeamCallOverlay.tsx`: avatar remoto usa `profilePhoto`, trata erro de imagem e diferencia o placeholder de compartilhamento de tela.
- `useTeamCall.ts`: deduplicação dos sons por sessão do participante; convite silencioso; alerta de `beforeunload` durante compartilhamento local; reconexão existente continua usando a sessão salva.
- `CommercialDashboard.tsx` e `workspace.css`: classe específica e grade mobile com controles de 40 px, sem crescimento vertical indevido.
- `AGENTS.md`: Codex passa a ser o executor padrão; Muse somente quando solicitado explicitamente.

## Limite técnico do navegador

Uma captura criada por `getDisplayMedia` não pode atravessar um recarregamento confirmado da página. Por isso, durante uma transmissão local o navegador agora bloqueia o F5 acidental com aviso. Se o usuário confirmar o recarregamento, a chamada é restaurada e a superfície precisa ser selecionada novamente. Para espectadores, a reconexão não encerra a transmissão do apresentador.

## Evidências

- Testes direcionados: 3 arquivos, 51 testes aprovados.
- Build de produção do frontend: aprovado, incluindo limites de bundle.
- Lint: concluído sem erros; apenas avisos preexistentes fora do escopo.
- QA visual de Documentos:
  - 455 x 1750: controles de 40 px, grade responsiva e ausência de overflow horizontal.
  - 1440 x 900: controles de 40 px, barra em uma linha e ausência de overflow horizontal.
- `git diff --check`: aprovado.

## Segurança operacional

- Nenhum deploy manual foi executado.
- O commit de entrega deve usar `[skip ci]` para que o push em `main` não acione o workflow de deploy.
