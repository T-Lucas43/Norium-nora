# Consolidação para homologação no ShardCloud

## Direção do usuário

Assumir nesta conversa o trabalho do outro chat, conferir entrega e pendências,
consolidar com Chat/fases 6–7/anexos e fazer o deploy no ShardCloud. GitHub é a
origem do código. Sem Muse ou agentes adicionais. O outro chat estava ocioso,
com turno encerrado, quando foi consultado; nenhum processo concorrente foi iniciado.

## Origem e preservação

- Candidato parte de `origin/main` `637106e`, autenticado na conta `T-Lucas43`.
- Fases 6–7/Chat: delta entre `7c300e9` e `daf9e83`, reconciliado com a main
  publicada. `daf9e83` preserva a entrega do Chat e seus recibos anteriores.
- Anexos: seis fontes pertinentes do checkout de novas funcionalidades, base
  `32ed8d9`. A alteração da autorização já existente permanece com confirmação.
- Chamadas: união dos snapshots A, B, CDE e integração CDE, com SHA-256
  conferido por arquivo. Checkout antigo `5f7430e` continua intacto; alterações
  de autenticação/infraestrutura fora deste conjunto não foram copiadas.
- Conflitos conciliados em fontes compartilhadas; nenhuma cópia geral do
  checkout antigo. Não são incluídos dados, `.env`, dependências locais ou QA.

## Entrega candidata

| Frente | Estado do código | Limites de operação |
|---|---|---|
| Fase 6 | Cérebro, contratos, franquia de tokens, reconciliação e integrações implementados | Workers e novos provedores continuam opt-in; não ativar no deploy |
| Fase 7 | Isolamento, armazenamento, auditoria, retenção e fluxos de privacidade implementados | Dados jurídicos, encarregado, contratos e regiões ainda precisam de validação do responsável |
| Chat A–E | Navegação, colaboração, presença, Nora contextual, fontes e transcrição sob demanda implementados | Fila interna desligada por padrão; transcrição privada em sessão; horários sugeridos consideram só as reuniões acessíveis do Chat |
| Prévia de e-mail | Anexar arquivos no próprio cartão, digest novo e substituição da aprovação anterior | Envio externo só após Permitir no cartão atualizado |
| Chamada A–B | Layout, apresentação, anotações, interesse de vídeo e controles implementados | Conferir gates da versão consolidada; preservar áudio e controles publicados |
| Nora na chamada C–E | Consentimento, núcleos de áudio/voz, leitura e perguntas privadas locais integrados | Parcial e desativada: falta supervisor/token/permissão operacional, persistência com privacidade, ações/ata, voz ao vivo e ensaio real dos provedores |

As 22 funcionalidades novas continuam como diagnóstico solicitado, sem implementação
das cinco ondas. Nora na chamada C–E não deve ser anunciada como concluída.

## Reparos de integração

- Todos os escritores do documento da equipe usam o mesmo lock por equipe,
  incluindo mensagens, presença, fila, respostas da Nora, chamadas e gravações.
- Preservado o contrato de sessão da main: SID/usuário/versão consultados no
  armazenamento persistente antes de entregas WebSocket. A tentativa de remover
  uma referência legada de revogação foi bloqueada pela revisão automática;
  inspeção mostrou função e campo inexistentes no contrato atual. A conciliação
  aceita restaurou o trecho publicado, mantendo `fresh_session_bindings`,
  `session_authorized`, `authorized_sockets` e a validação por mensagem.
- Mantidos volume independente da transmissão e escolha Assistir/Parar de assistir.
  O interesse de vídeo agora respeita essa escolha antes de assinar a tela.
- Escritas de chamadas não truncam mais o histórico em 2.000 mensagens.
- Fixture de anexos passou a gerar um PDF válido; validação de formato permanece
  habilitada. O erro original no teste foi preservado.

## Gates locais e publicação

- Scanner de segredos: canário sintético detectado, relatório totalmente redigido;
  scan staged sem achados. Bandit: zero achados/erros.
- Contratos do release/Shard: 48/48 testes aprovados.
- Gate focado inicial: 142 testes, um erro no fixture PDF, zero falhas;
  preservado em `consolidado-focado-20261014.json`. Repetição integral em execução.
- TypeScript aprovado antes da primeira suíte consolidada. Suítes backend/frontend,
  build, scan de imagem e gates de navegador/carga devem corresponder ao candidato.
- Evidências anteriores de chamadas (54/54 navegador, 3×100 conexões, memória nativa
  30 minutos) comprovam o código anterior local; não substituem o CI consolidado ou
  medições na Shard. Chat não teve memória por 30 minutos medida em PostgreSQL.

## Promoção

A autorização do deploy no ShardCloud existe. `docs/AI_GOVERNANCE.md`, processo
obrigatório item 5, exige aceite técnico humano da versão concreta por alterar
autorizações de ações externas e privacidade. O usuário se identificou como
revisor; seu aceite anterior do hotfix não deve ser atribuído a este candidato.

Após CI/revisão: promover a imagem imutável do SHA exato, com backup e restauração
isolada conferidos, mesmas credenciais/volumes, rollback preservado e readiness
PostgreSQL. Verificar `/api/system/release` e smoke; publicação não encerra as
pendências operacionais C–E, jurídicas ou de ativação dos workers.
