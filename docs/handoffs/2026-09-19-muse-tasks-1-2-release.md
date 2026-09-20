# Release do piloto Muse — tarefas 1 e 2

- Estado: integrado e validado localmente; publicação pendente.
- Pedido: publicar o card da agenda de hoje e a deduplicação das notificações.
- Base atual: `origin/main` em `81c06a4`; branch `codex/muse-tasks-1-2-release`.
- Escopo: agenda do dashboard, identidade e leitura de notificações, testes e correções necessárias para passar os gates de publicação.
- Outras alterações do checkout original do Muse não foram incluídas.

## Integração

- Os conflitos com o `main` atual foram resolvidos preservando tarefas, finanças e chamadas de equipe existentes.
- O feed recebe atualizações materiais de eventos com o mesmo ID sem recriar notificações.
- Uma recarga imediata da agenda cancela a consulta adiada que teria ficado redundante.
- A proteção do parser de XML de DOCX da Nora chegou ao `main` durante a preparação; esta branch mantém o teste de regressão para XML malicioso.
- A base atual também contém a correção do gate de chamadas de equipe, que passou no `main` antes da atualização deste PR.
- O teste de Relatórios usa a data local, evitando falha dependente do fuso horário.
- O job de validação do backend define um diretório de dados temporário e desativa o `.env`, conforme exigido pelos testes de auditoria.

## Verificações observadas

- Frontend: `npm test` — 712 testes passaram; `npm run build` — passou; `npm run lint` — passou com avisos preexistentes; `npm audit --omit=dev --audit-level=high` — zero vulnerabilidades.
- Backend: `python -m unittest discover -s tests -q` com `NORIUM_DATA_DIR` isolado e `PYTHON_DOTENV_DISABLED=1` — 876 testes passaram; teste de XML malicioso — 1 passou; `compileall` e `pip check` — passaram.
- Segurança: `bandit -q -r app -x tests -ll` e `pip-audit -r requirements.txt` — passaram, sem achados bloqueantes.
- `git diff --check` — passou. Após atualizar a base: 38 testes direcionados de frontend e 11 testes de agenda no backend passaram.

## Publicação

- Fluxo esperado: PR contra `main`, validação no GitHub Actions e merge; o push em `main` publica imagem imutável no Azure Container Apps e verifica `/health`.
- Após o deploy, verificar no produto: card apenas com eventos de hoje; evento alterado atualiza o card; reconexão e releitura não repetem toast ou contador; alerta novo ainda aparece.
- Reversão: redeploy da imagem imutável anterior se houver regressão.
