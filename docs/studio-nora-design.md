# Estúdio e espaço da Nora

O módulo Brainstorm passa a se chamar **Estúdio**, com endereço `/app/estudio`. O endereço anterior `/app/brainstorm` e os eventos internos continuam compatíveis. A Nora tem uma página própria em `/app/nora`, acessível pelo menu lateral e pela busca global.

## Referências consultadas

- [Templates de gestão de projetos do Confluence](https://www.atlassian.com/software/confluence/templates/collections/project-management): galeria visual e escolha de uma estrutura antes dos detalhes da sessão, em conjunto com a imagem fornecida pelo usuário.
- [Plano do projeto](https://www.atlassian.com/dam/jcr%3A3acd50e7-56be-4965-8381-d844f3ceca42/Project%20Plan.pdf): objetivos, entregas, responsáveis e riscos.
- [Retrospectiva](https://www.atlassian.com/software/confluence/templates/retrospective/): reflexão da equipe e ações de melhoria.
- [Gestão de conversas do Claude](https://support.claude.com/en/articles/8230524-delete-or-rename-a-conversation): histórico na lateral, retomada, renomeação e exclusão.

O layout usa os tokens, a marca e o avatar existentes do Norium, com ações em azul e ciano. As prévias dos templates são elementos locais em CSS, sem novas dependências ou imagens externas.

## Comportamento

- Os seis templates criam seções e cartões reais no backend: Plano do projeto, Brainstorming, Lista de afazeres, Anotações de reunião, Status do projeto e Retrospectiva. O quadro livre e os modelos antigos continuam disponíveis.
- Itens permitem edição, responsável, prazo, conclusão, comentários, votação e conversão em tarefa. O timer continua sendo iniciado manualmente e mantém as regras de encerramento existentes.
- A Nora reutiliza o chat, streaming, ações, voz e integrações existentes. A página tem histórico por usuário e workspace, busca por título e prévia, nova conversa, renomeação, exportação Markdown e exclusão confirmada.
- O histórico usa arquivos separados por conversa e um índice resumido, no armazenamento persistente configurado do backend. A listagem não transfere todas as mensagens.
- Gravações são serializadas no cliente e verificadas por revisão no servidor. Conflitos podem ser preservados em uma nova conversa. Conversas excluídas não são recriadas por uma janela desatualizada.
- A página visitada permanece montada durante a navegação interna para terminar respostas e salvamentos. Os demais módulos mantêm seu carregamento sob demanda.
- Limites explícitos: 500 conversas por usuário/workspace, 500 mensagens e 4 MB por conversa. Erros de gravação aparecem na interface; dados não são truncados silenciosamente.
