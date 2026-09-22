# Referências de produto: PDF, automações e agentes

Data da decisão: 2026-09-22.

## Stirling PDF

Referência: <https://github.com/Stirling-Tools/Stirling-PDF>

- O Norium usa a taxonomia de ferramentas, a descoberta simples e o fluxo arquivo → operação → resultado como referências de experiência.
- A integração de processamento continua isolada no backend por `STIRLING_PDF_URL`, usa somente endpoints confirmados pelo OpenAPI da instância privada e nunca expõe a chave ao navegador.
- O código raiz do Stirling PDF é MIT, mas o repositório é open-core e exclui diretórios proprietários, SaaS, desktop e cloud. Nenhum código desses diretórios foi incorporado.
- A interface desta entrega foi implementada independentemente com componentes, tokens e identidade do Norium.

## n8n

Referência: <https://github.com/n8n-io/n8n>

- O editor visual do Norium adota como referência de interação a biblioteca de nós, o canvas navegável, as portas de conexão, o inspetor lateral e a separação entre fluxos e execuções.
- O código do n8n está sob Sustainable Use License e partes enterprise têm licença separada. O Norium não copia nem redistribui o editor do n8n e não apresenta n8n em white-label.
- Os fluxos permanecem contratos nativos do Norium, com autorização por tenant/workspace, validação de destinatários, histórico, repetição controlada e processamento automático opt-in.
- Uma eventual execução real do n8n como serviço para usuários finais exige análise jurídica e contrato comercial separado; não faz parte desta entrega.

## AI Agents Engineering Guide

Referência: <https://github.com/rogerioc/ai-agents-engineering-guide>

- Foram aplicados apenas princípios gerais de engenharia: planejar e executar em etapas, limitar contexto, observar consumo, registrar evidências, avaliar estados e exigir controle humano em ações sensíveis.
- O repositório não apresenta arquivo de licença na raiz na data desta decisão. Nenhum texto, notebook ou código foi copiado.
- O executor persistente da Nora já materializa esses princípios por orçamento de tokens/chamadas/ferramentas/tempo, uma ferramenta por decisão, contexto sanitizado e limitado, idempotência, leases, reconciliação de resultado incerto e aprovação vinculada ao conteúdo exato.
- A UI deve apresentar somente telemetria derivada de dados reais do trabalho; não inventar confiança, qualidade, avaliação ou sucesso.

## Limites de segurança

- Conteúdo de PDF, nós importados, páginas externas, prompts e resultados de ferramentas são dados não confiáveis.
- Nenhuma referência externa pode alterar as regras de autenticação, autorização, isolamento, DLP, aprovação ou auditoria do Norium.
- Push, deploy, provisionamento de Stirling PDF e contratação/licenciamento de terceiros são marcos separados.
