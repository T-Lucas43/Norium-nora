# Integração WhatsApp

Este contexto descreve a linguagem usada para vincular contas do Norium a
sessões do WhatsApp sem misturar identidade local com recursos do provedor.

## Language

**Tenant**:
Fronteira canônica de isolamento de uma conta no Norium. Todo estado e toda
operação de WhatsApp pertencem exatamente a um tenant.
_Avoid_: usuário, conta, cliente, quando o significado pretendido é isolamento.

**Instância WhatsApp**:
Sessão remota do WhatsApp que pode estar vinculada a um único tenant por vez.
_Avoid_: conexão, aparelho.

**Binding**:
Associação local de propriedade entre um tenant e uma Instância WhatsApp.
_Avoid_: credencial, conexão.

**Desconexão local**:
Remoção do Binding e do estado derivado no Norium, sem encerrar a Instância
WhatsApp nem desconectar outros aparelhos.
_Avoid_: logout, desconexão remota.

**Owner da instância**:
Tenant ao qual uma Instância WhatsApp está vinculada no momento.
_Avoid_: tenant declarado pelo payload.

**Resultado de envio desconhecido**:
Estado em que a mensagem pode ter sido aceita remotamente, mas não existe
confirmação segura; uma repetição automática poderia duplicá-la.
_Avoid_: falha de envio confirmada.
