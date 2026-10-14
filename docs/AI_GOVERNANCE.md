# Governanca de IA e vibe coding

## Escopo

Esta politica vale para codigo, prompts, documentos, logs, dados de clientes e automacoes criados ou revisados com IA. Ela reduz risco; nao constitui certificacao de conformidade LGPD.

## Dados permitidos

- Preferir dados sinteticos, anonimizados ou minimizados.
- Nao enviar senhas, chaves, tokens, cookies, dumps, dados financeiros completos, CPF/CNPJ, prontuarios ou logs de producao a ferramentas de IA.
- Conteudo de e-mails e chats so pode ser processado pelo provedor aprovado para a finalidade solicitada, no tenant autenticado e no menor trecho necessario.

## Processo obrigatorio

1. Definir finalidade, dados usados, impacto e criterio de aceite.
2. Gerar ou alterar em branch controlada.
3. Revisar autenticacao, autorizacao, validacao, dependencias e isolamento multitenant.
4. Executar testes e scans automatizados.
5. Exigir aprovacao humana para codigo critico e para acoes irreversiveis.
6. Publicar artefato imutavel com rollback e monitoramento.

## Uso proibido sem especialista

- Implementar ou aprovar sozinho autenticacao, criptografia, pagamentos, saude, decisoes legais, exclusao de dados ou infraestrutura critica.
- Confiar em pacote, trecho ou recomendacao de IA sem verificar fonte, manutencao e vulnerabilidades.
- Permitir que conteudo de e-mail, pagina, anexo ou chat altere instrucoes do sistema ou acione ferramentas.

## Controles do Norium

- DLP local mascara segredos, CPF e sequencias financeiras antes do provedor de IA.
- Prompts tratam conteudo externo como nao confiavel e ignoram prompt injection.
- A Nora diferencia preparado, confirmado e executado; envios e exclusoes sensiveis exigem confirmacao.
- Chaves permanecem no backend e erros do provedor nao devolvem detalhes internos ao cliente.
- PRs registram uso de IA, revisao humana, testes e risco residual.

## Auditoria e revisao

Revisar esta politica trimestralmente e apos incidentes, mudanca de provedor, novo tipo de dado ou alteracao de lei/contrato. Manter inventario de modelos, finalidade, responsavel, base de dados, retencao, subprocessadores e mecanismo de desligamento.

## Inventário de modelos e pesquisa — 11/10/2026

Responsável operacional: administrador do Norium; aprovação de novos provedores por tenant/workspace
em `NORIUM_AI_PROVIDER_POLICY`. Padrão autorizado: endpoints oficiais de Groq, OpenAI e Google.
Chaves ficam somente no backend; alterações de configuração do usuário não autorizam um novo host.
Todo conteúdo externo é dado não confiável, sem autoridade sobre ferramentas ou aprovações.

| Serviço/modelo padrão | Finalidade | Dados enviados | Registro e desligamento |
|---|---|---|---|
| OpenAI `gpt-5.6-luna` | Conversa, classificação, resumo e planner rotina | Contexto limitado e mascarado do usuário/workspace; sem senha/token/CPF/cartão | `ai_costs` medido; `NORA_PROVIDER`/política por tenant; `store:false` |
| OpenAI `gpt-5.6-sol` | Elaboração de documento e planner documento | Trechos solicitados e mascarados, limite por perfil | Mesma medição; `NORA_OPENAI_DOCUMENT_MODEL` / `NORA_BRAIN_DOCUMENT_MODEL` |
| Groq `openai/gpt-oss-20b` | Rotina e planner local quando escolhido | Dados sintéticos no ensaio; conteúdo mínimo mascarado no uso autorizado | `Meter`; `NORA_PROVIDER` / `NORA_BRAIN_PROVIDER`; sem fallback entre provedores no cérebro |
| Groq modelos de fallback configurados | Recuperação de indisponibilidade do modelo | Mesma finalidade, uma reserva por tentativa | Catálogo e `NORA_FALLBACK_MODELS`; política oficial do provedor permanece obrigatória |
| Google Gemini configurado no catálogo | Modelo alternativo escolhido pelo usuário | Mensagens minimizadas autorizadas | Gateway com política do tenant e medição central; provedor pode ser desabilitado |
| OpenAI `text-embedding-3-small`, 256 dimensões | Recuperação semântica no Conhecimento | Somente chunks/query mascarados, até 8.000 caracteres por trecho | Vetor e digest no PostgreSQL por tenant/usuário/workspace; `NORA_KNOWLEDGE_EMBEDDINGS_ENABLED=0` mantém lexical |
| Brave Web Search | Fontes públicas com links e trechos limitados | Query mascarada, máximo 300 caracteres; sem conteúdo privado ou credencial | Chamada atribuída ao usuário no ledger; `NORIUM_BRAVE_ENABLED=0`; chave backend |

As tarifas são snapshots administrativos, nunca uma promessa de preço futuro. Fontes oficiais:
[Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna),
[Sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol),
[embeddings](https://developers.openai.com/api/docs/models/text-embedding-3-small),
[Groq](https://console.groq.com/docs/model/openai/gpt-oss-20b) e
[Brave](https://api-dashboard.search.brave.com/documentation/pricing).
A tarifa promocional Sol vence em 21/11/2026 e exige revisão posterior.

O executor e os workers novos são opt-in. Implementação não significa ativação em homologação.
O Chat contextual foi autorizado pelo responsável em 13/10/2026: demanda explícita,
até 12 mensagens minimizadas das conversas acessíveis, incluindo privadas/restritas,
somente Groq/OpenAI já configurado e aprovado. Anexos brutos não entram no resumo.
A transcrição foi autorizada separadamente: somente o áudio selecionado, após clique
de quem pode ouvi-lo, ao Groq configurado. Usa Whisper `whisper-large-v3-turbo` ou
`whisper-large-v3`, DLP na saída e uma reserva por tentativa no ledger `ai_costs`.
Segmentos verbose com `tokens` permitem contar a saída do transcritor; tokens de
entrada do áudio não são reportados. Sem esses dados, o consumo é estimado e rotulado.
A reserva inicial é 12.000 tokens, liberada ao registrar o resultado; não equivale
ao desconto final. O custo Whisper é por duração e permanece não precificado em USD
no catálogo de tokens, sem conversão inventada. [Contrato Groq](https://console.groq.com/docs/speech-to-text).
Transcrições do Chat ficam na sessão de quem solicitou, sem publicação automática.
Essa autorização de finalidade/destino não substitui a revisão técnica antes de promoção.
Gmail incremental (`NORIUM_GMAIL_INCREMENTAL_ENABLED=1`) lê IDs/histórico, sem corpos/anexos,
com intervalo 180–900 segundos e orçamento compartilhado das leituras Gmail.
Franquias e consumo contam tentativas medidos pelo provedor; resultado perdido é estimativa conservadora.
Cache de respostas fica apenas na memória do processo, até 30 segundos, por usuário e workspace.
Exportação, exclusão e invalidação dos armazenamentos seguem o catálogo de privacidade da aplicação.

### Avaliação reproduzível

Casos sintéticos pt-BR versionados em `tests/eval/nora-ptbr-v1.json`.
`python scripts/eval_nora_ptbr.py` valida somente catálogo/contratos/minimização;
seu percentual não mede qualidade do modelo. O comando manual
`python scripts/eval_nora_ptbr.py --real-groq --billing-user ID_DA_CONTA`
usa apenas a chave Groq autorizada e registra as chamadas na conta autenticada configurada.
Somente o recibo `mode:real_groq` pode sustentar a meta de qualidade ≥90% do planner real.
Nenhuma chave OpenAI foi usada no teste local; embeddings/planner OpenAI permanecem simulados.

Para repetir sem modificar a franquia de uma conta real, usar uma pasta nova
em `output` com `--synthetic-data-dir output/eval-piloto-novo` e passar o caminho
autorizado com `--groq-env-file CAMINHO_DO_ENV`. Esse argumento lê somente
GROQ_API_KEY; não imprime nem carrega as demais credenciais. O resultado final
de 12/10/2026 foi 27/30 (90%), com argumentos validados pelo schema, em
`output/pos-correcao/nora-ptbr-real-20261012-p.json`. Três falhas foram recusadas
sem efeitos. Não confundir a pontuação de classificação/contrato com a execução
correta de todos os fluxos externos.
