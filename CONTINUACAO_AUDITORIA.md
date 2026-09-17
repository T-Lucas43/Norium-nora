# Retomada da correção da auditoria

Ponto de retomada em 17/09/2026. Branch `main`. As mudanças desta etapa foram preparadas para commits locais, sem push e sem deploy. Por orientação do usuário, continuar sem Astra e economizar tokens com buscas dirigidas, leitura de trechos afetados e testes agrupados.

## Estado confirmado

- AUD-01, AUD-02, AUD-03 e AUD-09: implementados e testados localmente;
- validação consolidada: 104 testes backend, zero falhas/erros/skips;
- frontend: 28 testes Vitest passaram e `npm.cmd run build` concluiu;
- AUD-20 continua aberto porque o build informa chunks acima de 500 kB;
- veredito geral: **NO-GO** até concluir os demais achados e registrar dependências externas;
- os documentos `CORRECOES_IMPLEMENTADAS.md` e `RESULTADOS_DOS_TESTES_POS_CORRECAO.md` são parciais e devem ser ampliados, nunca substituídos por alegações sem prova.

## Próxima ordem de trabalho

1. AUD-08: introduzir lease e estado de resultado incerto na idempotência, com concorrência e reconciliação comprovadas.
2. AUD-05: aplicar checkpoints duráveis às automações e provar, com fake, que falha após envio não duplica o efeito.
3. AUD-04: quota por arquivo/tenant/global, validação de tipo/extensão e coleta sem apagar referências.
4. AUD-10 e AUD-06: separar liveness/readiness e provar backup/restore integral com dados sintéticos, hashes e `SQLite integrity_check`.
5. AUD-07 e AUD-14: validar relações financeiras e unificar catálogo/direitos sem reprecificar legado.
6. AUD-12, AUD-18 e AUD-19: ciclo de exclusão, formulários públicos e tokens de assinatura com workspace explícito.
7. AUD-11 e AUD-16: reconstrução reproduzível, SCA/SBOM, rollback local, métricas e alerta fake.
8. AUD-13, AUD-17 e AUD-20: política de sessão, segredo de webhook fora da URL/logs e redução real de bundles/dívida frontend.
9. AUD-15: restringir formalmente a topologia a uma réplica/worker e validar concorrência dentro desse limite.
10. Executar suíte completa, lint, build, verificações de segredo/dados temporários e `git diff --check`; atualizar plano/checklist, emitir `AUDITORIA_POS_CORRECAO.md` e só então gerar/renderizar/inspecionar o PDF.

## Comandos de retomada

```powershell
git status -sb
git log --oneline -5
Get-Content CONTINUACAO_AUDITORIA.md
Get-Content CORRECOES_IMPLEMENTADAS.md
Get-Content RESULTADOS_DOS_TESTES_POS_CORRECAO.md
```

Para testes de backend, use exclusivamente o runner isolado:

```powershell
& .\norium-back-end\venv\Scripts\python.exe scripts/run_backend_audit_tests.py --label <rotulo> <modulos unittest>
```

Não acessar produção, provedores/dados/segredos reais, nem executar push/deploy sob esta autorização.
