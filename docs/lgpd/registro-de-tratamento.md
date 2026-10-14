# Registro de tratamento (ROPA) — minuta

Responsável por aprovação jurídica: a designar pela organização. Registro
operacional técnico, a revisar antes de lançar. Bases legais abaixo são hipóteses
de avaliação, não decisões automáticas do software.

| Tratamento | Finalidade | Categorias | Papel e base a validar | Guarda / exclusão |
|---|---|---|---|---|
| Conta e sessões | Autenticar, autorizar e revogar acesso | Cadastro, hash de senha, metadados de sessão | Norium para conta; execução do contrato e segurança a validar | Exclusão autenticada elimina conteúdo; tombstone opaco fence impede sessão antiga |
| Conteúdo do workspace | Executar funcionalidades solicitadas | Documentos, tarefas, financeiro, arquivos | Cliente controlador / Norium operador; instruções e contrato | Exclusão por titular ou workspace; exceções fiscais dependem de decisão jurídica |
| Mensageria e agenda | Comunicações autorizadas | Mensagens, destinatários, eventos, anexos | Organização cliente define finalidade e base | OAuth/instância revogáveis; envios dependem de aprovação exata |
| IA e pesquisa | Assistência e conhecimento solicitado | Trechos minimizados, embeddings e consultas | Cliente instrui finalidade; base e transferência a validar | Limites por tenant, guarda configurável; provedor aprovado |
| Logs e auditoria | Segurança, diagnóstico e prova de ação | IDs opacos, ação, status, duração; dados pessoais mascarados | Interesse legítimo/obrigação/defesa a avaliar | Retenção configurável e acesso restrito |
| Backup e ledger de exclusões | Recuperação e impedir ressurreição de dados | Cópia criptografada e IDs opacos de exclusão | Necessidade e prazo a validar | Ledger atual reaplicado após restore; cópia não pode reabrir titular excluído |

Fluxos do titular: Configurações > Privacidade, exportação ZIP com hashes;
exclusão exige senha atual e frase de confirmação; conta bloqueada antes da
purga, falhas mantêm estado pendente. Canal de suporte já adotado:
`suporte@norium-ai.com`; encarregado formal deve ser confirmado pelo responsável.

## Fontes para a revisão responsável

- [LGPD, texto compilado no Planalto](https://www.planalto.gov.br/ccivil_03/_ato2015-2018/2018/lei/l13709compilado.htm): avaliar bases dos arts. 7 e 11, direitos do art. 18, registro de operações do art. 37 e encarregado do art. 41 conforme o caso concreto.
- [ANPD — guia dos agentes e encarregado](https://www.gov.br/anpd/pt-br/centrais-de-conteudo/materiais-educativos-e-publicacoes/guia-orientativo-para-definicoes-dos-agentes-de-tratamento-de-dados-pessoais-e-do-encarregado): apoio à definição dos papéis, sem substituir contrato ou avaliação jurídica.

Controladora (razão social/CNPJ/endereço), responsável pelo ROPA, encarregado e
contato formal, finalidade/base de cada organização, destinatários e período legal:
a preencher e validar por responsável humano. Integração disponível no código
não prova tratamento efetivo; habilitação/contratos/região dependem do runtime.
