# Resultados dos testes pós-correção — etapa parcial

Data: 17/09/2026. Todos os testes de backend abaixo foram executados pelo runner `scripts/run_backend_audit_tests.py`, que copia somente o código-fonte para um diretório temporário, cria `NORIUM_DATA_DIR` sintético, desativa dotenv e bloqueia sockets externos.

| Verificação | Resultado | Contagem |
| --- | --- | ---: |
| AUD-01, persistência base | PASS | 17 |
| AUD-01, stores consumidores | PASS | 13 |
| AUD-02, autenticação e acesso de membro | PASS | 11 |
| AUD-02, regressão de autorização/chat/chamadas | PASS | 56 |
| AUD-03, matriz financeira | PASS | 16 |
| AUD-09 e regressão de acesso | PASS | 17 |
| Consolidação final de todos os módulos acima | PASS | 104 |
| Vitest: navegação, tabs e chamada | PASS | 28 |
| Build TypeScript/Vite | PASS com aviso | build concluído; chunks acima de 500 kB confirmam AUD-20 pendente |
| `git diff --check` antes dos commits | PASS | sem erro de whitespace |

## Evidência vermelho → verde

- AUD-01: a prova anterior à correção falhou; após a correção, corrupção, falha de I/O/permissão, schema inválido e restauração passaram sem sobrescrever bytes.
- AUD-02: a prova anterior à correção negava o fluxo normal e não cobria toda revogação; a prova verde valida criação, login, chat, chamada, isolamento, revogação e ausência de gestão indevida.
- AUD-03: 492 subcasos vermelhos mostraram rotas liberadas sem as flags correspondentes; a matriz verde passou integralmente.
- AUD-09: o segundo login sintético gerava exceção no middleware; depois da correção retorna 429 com os cabeçalhos esperados.

Os resumos estruturados e logs locais estão em `output/pos-correcao/`. Esse diretório é evidência de execução local e não precisa ser versionado.

## Limites desta etapa

- a suíte completa do repositório ainda não foi executada;
- não houve teste em produção, provedor real, dado real, segredo real, push ou deploy;
- backup/restore integral, imagem final, SCA/SBOM, navegador desktop/mobile e observabilidade externa continuam pendentes;
- o PDF pós-correção ainda não foi criado porque a auditoria não está concluída.
