# Handoff — Fase 1 (segurança/LGPD da Nora) e voz em tempo real

Data: 10/10/2026 · Branch: `feat/fase1-seguranca-voz` (a partir de `origin/main` 3fe718b) · Sem push nem deploy.

## Regra permanente
Nenhuma tela ou funcionalidade pode ser removida, escondida ou mascarada. As correções só acrescentam permissão, confirmação ou aprovação.

## Entregue
| Item | Arquivos principais | Testes |
|---|---|---|
| Voz ElevenLabs em streaming (Alice, `eleven_flash_v2_5`) com fallback Edge | `app/modules/nora/router.py` (`abrir_audio_elevenlabs_stream`, `/voz`), `app/bootstrap.py` | `tests/unit/test_nora_voice_elevenlabs.py` |
| Aprovação exata para excluir/alterar no financeiro | `app/modules/finance/router.py`, `app/modules/operations/service.py` (`create_exact_finance_approval`) | `tests/unit/test_finance_agent_approval.py` |
| Controle envia `expectedDigest` ao aprovar | `norium-front-end/src/components/operations/OperationsDashboard.tsx` | suíte frontend |
| Permissões no envio do rascunho de WhatsApp | `app/modules/nora/router.py` (`/agentes/mensagens/enviar`) | `tests/unit/test_nora_agent_send_route.py` |
| Mensagens “system” do navegador | `app/modules/nora/router.py` (`client_messages_for_model`) | `tests/unit/test_nora_system_role.py` |
| Mascaramento LGPD no gateway de modelos e regex CPF/cartão | `app/core/ai_guardrails.py`, `app/modules/intelligence/service.py` | `test_ai_guardrails.py`, `test_intelligence_module.py` |
| Memória de equipe só por gestores | `app/modules/operations/service.py`, `operations/router.py`, `nora/router.py` | `tests/unit/test_team_memory_permissions.py` |
| Fim do fallback `lucas123` (65 pontos, 19 arquivos) | `app/core/identity.py` + módulos | `tests/unit/test_identity_required.py` |

## Desvios do plano (decididos para não remover funções)
- `/agentes/mensagens/enviar`: continua enviando direto, porque é o botão “Enviar” que a própria pessoa clica após revisar o rascunho. Ganhou checagem de permissão, conexão e confirmação.
- Mensagens “system” no `/chat`: a tela de E-mails depende delas; viraram orientação comum em vez de serem rejeitadas.
- Provedores de IA próprios (etapa 8): não bloqueados por padrão, pois hoje são uma função usada. Requer decisão de política do administrador.
- Digest nas aprovações de WhatsApp: adiado; exigiria bloquear a edição do texto no Controle.
- `lucas123` mantido apenas em valores padrão de campos de formulário e na compatibilidade com arquivos antigos (não é usado como identidade).

## Pendente / próximos passos
- Homologação (Shard): definir `NORA_TTS_PROVIDER=auto`, `ELEVENLABS_API_KEY` e opcionalmente `ELEVENLABS_MODEL_ID` — somente com autorização.
- Ativar o cérebro da Nora com `NORA_BRAIN_DATABASE_URL` no PostgreSQL da Shard (Fase 6).
- Fase 2 (base visual) em seguida.

## Ambiente local
PostgreSQL 16 em Docker (`norium-postgres-local`, porta 5433, bancos `norium` e `norium_brain`).
