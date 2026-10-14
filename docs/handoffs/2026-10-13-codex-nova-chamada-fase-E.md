# Nova chamada — Fase E iniciada

Data: 13/10/2026. Estado: **núcleo de voz local testado; publicação pendente**.

## Implementado

`meeting_voice.py`: voz/wake desligados por padrão, configuração pelo organizador presente. `Nora, ...` no início da fala prepara solicitação identificada, sem executar ação. Participante presente pode interromper; revisão de consentimento invalida áudio e exige limpar saída.

Pergunta privada usa callback por usuário e devolve texto ao solicitante, sem TTS/publicação. Sessão substituída/encerrada durante processamento recusa resposta. Campos de broadcast/execução produzidos pelo modelo são descartados.

`meeting_tts.py`: ElevenLabs streaming PCM16 mono 16 kHz, frames de 20 ms, dois minutos por resposta, timeout, sem redirecionamento/retentativa, erro genérico. Chave/voz somente no backend; ID Alice ausente impede construir adapter. `ai_speech_costs.py` mede caracteres/reservas e tentativas incertas; tarifa real ainda precisa de política administrativa.

## Divergência da referência

O anexo cita `abrir_audio_elevenlabs_stream`, inexistente neste checkout. `gerar_audio_elevenlabs` gera MP3 completo; streaming atual de `/voz` é Edge TTS. A voz global não foi verificada como Alice. Novo adapter exige ID Alice confirmado no catálogo da conta; não assume ID antigo. Fonte do endpoint: [ElevenLabs Stream speech](https://elevenlabs.io/docs/api-reference/text-to-speech/stream).

## Evidência e pendências

Cinco testes de controle de voz e três de streaming passaram com fontes sintéticas/MockTransport. Não houve ElevenLabs real nem reprodução na sala.

Faltam perfil do agente publicando somente microfone, faixa RTC Nora/AudioSource e limpeza real, Alice confirmada/tarifário, estado Falando/ondas/destaque, Parar Nora e push-to-talk/Alt+N privado. Não montado no processo operacional ou UI. A revisão do [handoff C](2026-10-13-codex-nova-chamada-fase-C.md) continua necessária.

Fase E não concluída; nenhum segredo, serviço pago ou flag de produção configurado.

Suítes gerais da continuidade aprovadas: 1.176 backend, 803 frontend, 51 Chromium; detalhes e escopo no [handoff C](2026-10-13-codex-nova-chamada-fase-C.md). Não comprova Alice, publicação RTC ou experiência push-to-talk reais.

## Continuidade aprovada — integrações locais

`meeting_speaker.py` publica PCM mono 16 kHz em sala já conectada, exigindo identidade Nora e permissões de publicação somente de microfone, sem publicação de dados. AudioSource tem fila de 200 ms, frames de 20 ms, invalidação por época, limpeza e encerramento. Testes recusam perfil humano amplo e verificam limpeza/unpublish. Descritores e AudioSource do SDK nativo foram verificados offline.

Não há emissão de token, entrada real na sala, publicação RTC real, ID Alice confirmado, tarifário contratado ou montagem de voz/wake no supervisor/UI. Falando/ondas, Parar Nora e push-to-talk/Alt+N privados permanecem pendentes. Fase E permanece parcial; nenhuma flag/credencial de produção foi alterada.
