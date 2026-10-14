# Subprocessadores e integrações — minuta para revisão

Inventário técnico de 11/10/2026. Não constitui parecer jurídico, contrato,
certificação ou confirmação de residência dos dados. A empresa e o encarregado
devem validar finalidade, contrato/DPA, região, subcontratados e mecanismo de
transferência internacional antes de habilitar cada integração em produção.

| Serviço | Finalidade e dados mínimos | Habilitação / desligamento |
|---|---|---|
| Shard Cloud + PostgreSQL | Hospedagem do runtime, documentos, anexos e metadados necessários à aplicação | Operador administra VPS, banco, volume e backup |
| Google | Gmail/Agenda autorizados, identificadores, metadados e conteúdo solicitado | OAuth por conta; revogação no provedor na exclusão; desconexão nas integrações |
| W-API | WhatsApp da empresa, destino/conteúdo aprovado e recibos | Instância e credencial backend; permissão live por empresa |
| Groq / OpenAI / Google Gemini | Conversa, planejamento/documentos e embeddings com minimização local antes da saída | Política por tenant; provedor não aprovado bloqueado |
| Brave Search | Termos de pesquisa minimizados | Chave backend e ferramenta autorizada; sem chave fica indisponível |
| ElevenLabs | Texto necessário à síntese e/ou áudio solicitado | Integração opcional, segredo backend |
| Provedor de e-mail configurado | E-mail transacional de conta/notificações | Nome contratual depende do runtime; confirmar com operador |
| TURN / SFU configurados | Transporte de mídia e metadados de chamada | Endpoint e operador definidos no runtime; não inventar fornecedor |

Contato de suporte já adotado no produto: `suporte@norium-ai.com`. Identidade
jurídica da controladora/operadora e contato formal do encarregado: **pendentes de
confirmação humana**. Não publicar identidade ou garantia contratual inventada.

Fonte técnica de revogação: [Google OAuth 2.0 — revogação](https://developers.google.com/identity/protocols/oauth2/web-server#tokenrevoke).

Disponibilidade no código não prova uso efetivo. Consultar configuração autorizada
do ambiente sem expor secrets; IA/pesquisa/voz só transferem dados quando o recurso
é habilitado e solicitado. Região, entidade contratada e DPA: a preencher.
Referência de papéis para revisão: [ANPD — guia dos agentes e encarregado](https://www.gov.br/anpd/pt-br/centrais-de-conteudo/materiais-educativos-e-publicacoes/guia-orientativo-para-definicoes-dos-agentes-de-tratamento-de-dados-pessoais-e-do-encarregado).
