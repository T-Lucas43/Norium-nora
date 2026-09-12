# Retomada de chamada após recarga

Ao recarregar a página, o participante retorna automaticamente à mesma chamada
enquanto ela continuar disponível no servidor. O navegador libera as conexões e
tracks antigas e solicita nova admissão e mídia; pode haver uma breve interrupção
do áudio e do vídeo durante o carregamento.

A causa anterior era a perda do estado local e do identificador do cliente na
recarga. A chamada era apresentada como disponível, mas o participante não
retornava, ficando sujeito à expiração da desconexão no servidor.

No evento `pagehide`, somente uma chamada já admitida gera um registro temporário
no `sessionStorage` da aba. Ele contém usuário, chamada, cliente, instante e estado
do microfone/câmera, sem tokens, conteúdo de mídia ou credenciais TURN. Expira em
60 segundos e só é consumido após `CALLS_STATE` autenticado confirmar que a chamada
ainda existe. O backend continua responsável por autorização e admissão; esse
registro não prolonga o prazo de desconexão do servidor.

Sair, encerrar ou perder acesso remove a intenção de retomada. Uma chamada
encerrada não é recriada. Microfone e câmera mantêm suas opções anteriores;
gravação e compartilhamento de tela não são reiniciados automaticamente.

## Verificação

- Regressão de hook reproduziu a perda do `callId` antes da correção.
- Testes cobrem retomada, montagem estrita, registro inválido/expirado, outro
  usuário, chamada encerrada e saída voluntária.
- Testes do provider cobrem a transição automática para conectado, inclusive
  quando a captura passa pelo estado de convite.
- Cenário Chromium `page_reload`: anfitrião sozinho, anfitrião com participante,
  participante, microfone preservado, RTP real e ausência de retomada após fim.
- Verificação local final: 99 testes dos componentes, build e três repetições
  desse cenário aprovados. Reconexão, múltiplas abas e remoção após fechamento/crash
  também aprovados nas três repetições executadas.
