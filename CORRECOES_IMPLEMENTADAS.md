# Correções implementadas — etapa parcial

Data de corte: 17/09/2026. Esta entrega registra somente mudanças implementadas e testadas localmente. O veredito geral continua **NO-GO** enquanto os demais achados e as dependências externas não forem concluídos.

## AUD-01 — leitura de persistência não pode apagar dados

**Estado:** implementado e testado no escopo dos stores JSON afetados.

- leitura usa fallback apenas quando a ausência inicial do arquivo é comprovada;
- corrupção, Unicode inválido, permissão, I/O, alteração durante a leitura e schema incompatível geram `PersistenceError`;
- a resposta HTTP é 503 redigida, com `Retry-After`, sem caminho, payload ou exceção bruta;
- stores financeiro, usuários, tarefas e comercial validam o formato antes de normalizar ou gravar;
- campos históricos desconhecidos são preservados nos stores de tarefas e comercial;
- dados inválidos permanecem intactos para investigação e restauração.

**Prova:** cenários vermelhos reproduziram o comportamento anterior; as rodadas verdes específicas executaram 17 e 13 testes sem falhas. A rodada consolidada final também passou.

## AUD-02 — membro normal não recebia acesso funcional ao chat

**Estado:** implementado e testado.

- a capacidade `teamChatEnabled` é derivada do diretório atual, do estado do membro e do plano ativo do proprietário;
- a capacidade não é persistida e não concede administração de equipe;
- remoção, inativação, logout, troca de equipe e perda do plano revogam sessões e sockets existentes;
- o frontend esconde e desmonta chat/chamada quando o acesso deixa de existir;
- acesso cruzado entre equipes e tentativa de elevar papel/permissões permanecem negados.

**Prova:** 11 testes direcionados de autenticação/equipe, 56 testes de regressão de equipe/autorização e 28 testes Vitest passaram.

## AUD-03 — permissões financeiras granulares eram ignoradas

**Estado:** implementado e testado.

- somente o proprietário explícito do sistema pode administrar concessões;
- auxiliares recebem negação por padrão e cada operação consulta a permissão persistida da identidade autenticada;
- todas as rotas administrativas financeiras foram associadas a `view`, gestão específica, importação ou exportação;
- tentativas de autoelevação por ID, papel, equipe ou payload são negadas;
- leitura de permissões negadas não inicializa nem altera o store.

**Prova:** 16 testes, incluindo 59 variantes de autorização e ausência de mutação, passaram. A evidência detalhada está em `docs/evidence/aud03.md`.

## AUD-09 — rate limiting retornava 500

**Estado:** implementado e testado.

- a exceção esperada do limitador é convertida dentro do middleware em HTTP 429;
- `Retry-After`, `X-Request-ID`, cabeçalhos de segurança e `Cache-Control: no-store` são mantidos;
- outras exceções HTTP não são ocultadas por esse tratamento.

**Prova:** o teste vermelho reproduziu a exceção não tratada; a rodada verde passou com 17 testes, incluindo regressão de controle de acesso.

## Achados ainda abertos

AUD-04, AUD-05, AUD-06, AUD-07, AUD-08, AUD-10, AUD-11, AUD-12, AUD-13, AUD-14, AUD-15, AUD-16, AUD-17, AUD-18, AUD-19 e AUD-20. Nenhum deles deve ser considerado corrigido por associação com esta etapa.
