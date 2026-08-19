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
