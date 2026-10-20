# Fase 6 — configuração no ShardCloud

## Conferência em 19/10/2026

Consulta somente de presença, no contêiner ativo `norium-api`:

| Configuração | Resultado |
|---|---|
| `OPENAI_API_KEY` | Ausente |
| `BRAVE_SEARCH_API_KEY` | Ausente |
| `NORA_KNOWLEDGE_EMBEDDINGS_ENABLED` | Desativado |
| `NORIUM_BRAVE_ENABLED` | Habilitado, sem a chave necessária |

A configuração local do backend também não contém as duas chaves. Não foram
feitas chamadas aos provedores nem alteradas as variáveis do servidor.
Evidência fora do Git: `output/expansao-20261019/shard-key-presence.json`.

## Onde configurar

- No **web**, cadastrar diretamente no ambiente privado da aplicação:
  `OPENAI_API_KEY` e `BRAVE_SEARCH_API_KEY`. Não salvar valores em código,
  screenshots, comandos de histórico ou descrição de PR. A chave deve ser
  inserida pelo responsável em mecanismo privado, nunca nesta conversa.
- Após revisar finalidade, provedor e franquia, habilitar embeddings com
  `NORA_KNOWLEDGE_EMBEDDINGS_ENABLED=1`. Manter PostgreSQL e busca textual
  disponíveis. `NORIUM_BRAVE_ENABLED=1` permite pesquisas solicitadas quando a
  chave estiver presente; não agenda pesquisas automáticas.
- No **executor separado**, configurar a credencial Groq aprovada e os modelos
  definidos no inventário. O web não precisa receber a chave do modelo desse
  executor. Banco dedicado, segredo HMAC, ponte interna e escritor único
  continuam obrigatórios; seguir `nora-brain-runbook.md`.
- Gmail incremental depende de OAuth da própria conta e das permissões atuais,
  não das chaves Brave/OpenAI. A ativação é independente:
  `NORIUM_GMAIL_INCREMENTAL_ENABLED=1`, somente após revisão operacional.

## Aceite antes da ativação

1. Conferir o diagnóstico administrativo em Configurações → Consumo da Nora.
2. Provar executor saudável por consulta sintética, sem ferramentas de escrita.
3. Conferir limitação de tokens, isolamento, minimização e histórico do Gmail.
4. Revisar o pacote concreto e os gates antes do deploy; preservar a imagem,
   dados e rollback. Não tratar este documento como autorização para ativar.

O diagnóstico comprova configuração, não validade da chave, conectividade,
qualidade do modelo ou operação contínua do worker.
