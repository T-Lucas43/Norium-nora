# Nova chamada — Fase D iniciada

Data: 13/10/2026. Estado: **núcleo local testado; integração pendente**.

## Implementado

`meeting_intelligence.py` seleciona resumo, decisões, tarefas e perguntas em aberto. Modelo injetado recebe janela minimizada de 20 kB/200 segmentos, a cada 60 s ou 12 falas, com serialização contra duplicação concorrente. Falas são dados não confiáveis; nenhuma ferramenta é oferecida.

Cada fato deve apontar segmento e trecho literal existente. Resultado extrativo, sem paráfrases livres. Responsável/prazo entram como sugestões somente se constarem no mesmo trecho; nomes ambíguos são recusados. Campos de execução ou fatos/IDs inventados são recusados.

`task_proposals` prepara dados para revisão, sem criar tarefa. `MeetingMinutesBuilder` gera ata preparada com ID determinístico por chamada, gravação opcional e propostas. Isso não prova unicidade persistida: a transação ainda não foi conectada.

## Evidência

Cinco testes pt-BR: fatos literais, responsável/prazo ausentes, ambiguidade, limiar/concorrência, mascaramento e rejeição de efeito por prompt injection. Incluídos nos 16 aprovados de `output/pos-correcao/nova-chamada-de-core.json`.

## Pendências

- Gateway/modelo rápido e consumo real de tokens; hoje modelo é callback e testes usam resposta sintética.
- Painel Agora/Transcrição/Perguntar, busca privada com permissão atual/fontes, `@Nora` limitada à reunião e legendas.
- Criar/editar/ignorar com aprovação exata e destino autorizado. A ponte `nora/brain/task_bridge.py` exige projeto privado `default`; não serve para atribuir tarefas compartilhadas silenciosamente ao solicitante.
- Ata única persistida, conversa/gravação/transcrição ligadas, consumo e envio ao cliente com aprovação existente.

Nenhuma tarefa, mensagem ou e-mail foi executado. A Fase D não está concluída.

Suítes gerais da continuidade aprovadas: 1.176 backend, 803 frontend, 51 Chromium; detalhes e escopo no [handoff C](2026-10-13-codex-nova-chamada-fase-C.md). Esses números não comprovam gateway/busca/ações D em produção.

## Continuidade aprovada — integrações locais

`meeting_intelligence_bridge.py` conecta o analisador ao `NoraIAService`, com janela comum à audiência atual, cancelamento por revisão de consentimento e pausa de tentativas após falha. Teste com o gateway real e transporte HTTP substituído comprovou registro de 100 tokens de entrada/50 de saída no usuário correto, com fonte opaca da reunião. Provedor real não foi chamado.

Painel Agora/Transcrição/Perguntar e pergunta privada estão integrados. A rota usa somente transcrições autorizadas da chamada, revalida usuário/permissões/sessão antes e depois do processamento e exige fontes presentes. Busca em outros dados do Norium ainda não existe. Não há publicação automática de resposta privada, chamada pública por `@Nora`, criação de tarefas ou envio de e-mail.

Pendências atuais: busca autorizada em dados externos à reunião; criar/editar/ignorar com aprovação e destino compartilhado; ata persistida única e vínculo conversa/gravação; apresentação de consumo por reunião. O núcleo de ata/propostas não comprova transação persistente. Fase D permanece parcial.
