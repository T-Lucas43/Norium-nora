# A desconexão do WhatsApp é local

O comando público de desconexão remove somente o Binding e o estado derivado
do Norium; ele nunca encerra a Instância WhatsApp remota. Escolhemos essa
semântica porque o logout remoto também derrubaria o telefone e outros
aparelhos, um efeito muito mais amplo e difícil de desfazer; se necessário,
esse comportamento deverá ser uma operação administrativa separada, explícita
e confirmada.
