# Inventário técnico preparado — Nora em reuniões

Estado: implementação parcial local, sem tratamento real de áudio de clientes nesta entrega. Documento técnico para revisão; não constitui parecer jurídico, aprovação contratual ou certificação LGPD.

| Fluxo | Finalidade/dados mínimos | Destino | Estado |
| --- | --- | --- | --- |
| STT por fonte de microfone | Trecho mono 16 kHz de 5–10 s com fala | Groq Whisper Turbo, escolhido pelo usuário | Adapter testado com MockTransport; nenhum envio real |
| Texto compartilhado | Autor, início/fim e texto mascarado | Participantes autorizados da chamada | Entrega interna WebSocket e memória volátil com audiência por segmento; persistência operacional pendente |
| Entendimento | Janela de texto mascarado, IDs opacos | Modelo rápido já aprovado para o tenant | Gateway existente integrado e medição testada com transporte substituído; sem provedor real |
| Pergunta privada | Pedido minimizado e dados autorizados do solicitante | Somente solicitante | Rota privada com permissões atuais/fontes da chamada; busca em outros dados pendente |
| Voz pública | Texto autorizado/minimizado | ElevenLabs Alice e sala | Adapter testado; ID, tarifa, perfil RTC/publicação pendentes |
| Contadores | Usuário, workspace, equipe, chamada, unidade, tarifa, estado | Banco central ai_costs | Segundos/caracteres/reservas; sem áudio/texto/segredos |

O aviso explica que áudio bruto vai ao Groq. Mascaramento textual posterior não remove palavras do áudio antes de STT. Só microfone participa; áudio de tela fica excluído. Consentimento não é inferido da presença ou do badge; há retirada e pausa por revisão/sessão/audiência.

Retenção proposta igual a `TEAM_RECORDING_RETENTION_HOURS` (24 h padrão). Persistência, associação à gravação, download após expiração, expurgo físico, exportação e exclusão da transcrição ainda precisam de implementação/revisão. Não ativar retenção sem expurgo demonstrado. Groq/ElevenLabs são referências de provedores existentes no código; não foi verificada a situação contratual, região, DPA ou retenção do fornecedor. Confirmar com o responsável de privacidade antes de tratamento real.

Responsáveis pela aceitação operacional/privacidade devem ser designados na revisão. [Pontos preparados](../security/reviews/2026-10-13-nora-em-reunioes.md). Chaves ficam no backend; nenhum valor real foi lido/configurado nesta tarefa.

## Continuidade aprovada — integrações locais

Transcrição permanece somente em RAM, limitada por bytes/segmentos e prazo da gravação. O prazo expirado não é reiniciado por leitura. Encerramento descarta o estado volátil da chamada; isso não implementa expurgo de dados permanentes. Entrada tardia acessa somente os segmentos de cuja audiência participou. Entendimento compartilhado usa a interseção da audiência atual.

Recibos privados: até 64 escopos e 16 recibos por escopo; expiração vinculada à fonte. Verificação de usuário ativo, equipe, permissão Nora e sessão ocorre antes/depois do modelo. Contadores duráveis armazenam unidades e identificadores, sem áudio/texto; fontes de tokens são opacas. Não há novos fluxos de exportação/exclusão permanente.
