# E-mail do sistema — 5 de setembro de 2026

O Norium possui uma integração transacional com a caixa `suporte@norium-ai.com`, sem chamadas a modelos de IA. A ativação depende da configuração protegida da caixa de e-mail da Hostinger no servidor.

## Ativação

1. Entre no modo administrativo e abra a aba **E-mails → E-mail do sistema**.
2. Confira o endereço HTTPS público do Norium. Ele é usado nos links das mensagens.
3. Informe a senha da caixa de suporte e ative os envios. O servidor armazena a senha criptografada; a API nunca a devolve ao navegador.
4. Use **Enviar teste para minha conta** e **Atualizar status dos envios**. “Aceito pelo servidor” confirma aceitação SMTP, não garante a caixa de entrada do destinatário.
5. O botão **Enviar boas-vindas aos cadastrados** dispara o texto apresentado no próprio painel para cada conta ativa, respeitando a preferência geral de notificações. Endereços repetidos entram apenas uma vez. Abrir a página não dispara mensagens.

O envio em massa foi solicitado explicitamente pelo proprietário durante esta tarefa. Não ocorre automaticamente em novos deployments. O registro permanente da campanha evita novo disparo ao repetir o comando ou reiniciar o servidor. Ao corrigir a senha SMTP, mensagens com falha e ainda válidas podem voltar à fila.

A aba **E-mails** também permite escrever um assunto e uma mensagem, buscar usuários, selecionar os destinatários, pré-visualizar e enviar manualmente. O servidor recebe identificadores dos usuários e resolve seus endereços cadastrados, sem aceitar destinatários externos arbitrários. Cada disparo possui identificador estável para retentativas e respeita contas inativas e preferências de notificação. Conteúdo é texto, com HTML escapado e parágrafos preservados; não há execução de HTML enviado pelo administrador.

## Comportamento

- Todo evento persistido pela central do sistema pode enfileirar um aviso para seu usuário: agenda, tarefas, financeiro, equipe, automações, estúdio, relatórios e sistema. As fontes `gmail` e `whatsapp` são excluídas no servidor, além de não aparecerem nas preferências.
- Mensagens e gravações do chat de equipe usam os participantes autorizados da conversa; o proprietário da equipe não é incluído automaticamente em conversas privadas.
- Contas verificadas recebem avisos conforme suas preferências em **Perfil → Notificações por e-mail**. Usuários antigos podem solicitar a confirmação nesse painel; novos cadastros recebem a confirmação quando o envio está configurado.
- O servidor verifica a cada minuto tarefas com vencimento no dia, compromissos da agenda local próximos dos próximos 10 minutos e reuniões agendadas da equipe. Os avisos são deduplicados por usuário, espaço de trabalho e evento. Reuniões da equipe também geram o lembrete existente da central, inclusive sem navegador conectado. A verificação usa dados locais, sem sincronizar provedores externos a cada ciclo; eventos do Google geram avisos quando sincronizados pelo módulo de agenda.
- **Esqueci minha senha** envia uma resposta pública uniforme para endereços existentes/inexistentes. Os links de recuperação valem 30 minutos; os de confirmação, 24 horas. Ambos são aleatórios, de uso único, com hash armazenado. O token fica no fragmento da URL e é consumido por POST explícito. Redefinir a senha revoga as sessões anteriores da conta.
- SMTP usa conexão TLS validada na porta 465 e um destinatário por envelope. Não há CC/BCC coletivo. Mensagens trazem link autenticado para o módulo; os corpos privados de WhatsApp, e-mail e conversas não são copiados para notificações.
- As versões HTML e texto incluem a assinatura oficial da Nora. O HTML reutiliza a assinatura responsiva aprovada, com a foto da Nora e a marca Norium incorporadas e sem dependência de imagens externas; a versão textual mantém nome, função, remetente e domínio. O cabeçalho `Date`, o remetente visível e o envelope SMTP permanecem consistentes; mensagens manuais não são marcadas como respostas automáticas.
- A fila persiste em `NORIUM_DATA_DIR/system_email_db.json`, usando o repositório transacional do Norium com gravação atômica, exclusão mútua no processo, payload criptografado, tentativas graduais (até cinco) e SMTP em executor próprio. Isso evita o bloqueio observado ao usar SQLite sobre o volume Azure Files. O deployment mantém uma única réplica; falha de envio não cancela a operação original. Cópias de segurança precisam preservar o diretório de dados e o segredo estável de autenticação usado na criptografia.

Em 5 de setembro de 2026, a zona pública de `norium-ai.com` apresentou o SPF oficial da Hostinger, os três CNAMEs DKIM `hostingermail-a/b/c`, os dois MX da Hostinger e DMARC publicado. Esses registros autenticam o domínio, mas a classificação final entre caixa de entrada e spam também considera reputação do domínio, conteúdo, volume e decisões do provedor de destino.

## Limites verificáveis

O sistema distingue enfileirado, enviando, aceito pelo SMTP, falha, ignorado e expirado. Como SMTP não fornece transação distribuída, uma interrupção após a aceitação externa e antes da gravação local pode repetir uma tentativa; o Message-ID é mantido estável. A deduplicação da campanha evita reenvio por cliques repetidos, mas não promete entrega exatamente uma vez pelo provedor.

## Referências

- [Configuração oficial do e-mail Hostinger](https://www.hostinger.com/br/support/1575756-como-encontrar-os-detalhes-de-configuracao-de-e-mail-no-hpanel-hostinger/): servidor SMTP e transporte.
- [OWASP: recuperação de senha](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html): resposta uniforme, tokens temporários e de uso único, HTTPS e revogação de sessões.

## Validação

Os testes novos cobrem segregação por usuário e workspace, exclusão de WhatsApp/Gmail, participantes do chat, preferências, deduplicação, envelope individual, TLS, criptografia, expiração/replay, revogação de sessões, autorização administrativa e ações do frontend. A aceitação real pela Hostinger e o disparo de boas-vindas dependem da ativação acima; não foram assumidos como enviados.

Validação local concluída: 477 testes de backend, 472 testes de frontend, build de produção, lint (avisos preexistentes), compilação Python, `pip check` e Bandit sem achados de severidade média/alta. As telas de confirmação e configuração foram inspecionadas no navegador; o formulário administrativo também foi conferido em 390 px, sem rolagem horizontal. O SMTP foi simulado na suíte; os testes não dispararam mensagens reais.
