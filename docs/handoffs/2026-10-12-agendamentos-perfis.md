# Correções de agendamentos e fotos — 12/10/2026

## Pedido e limites

Corrigir scroll no PC, diferença/sobreposição da prévia, logo que não aparece,
personalizar a página inteira, acompanhar vencidos e registrar serviço/reunião
realizados. Usar foto e nome em projetos, tarefas e Estúdio, com redução suave.
Executor Codex individual. GitHub é fonte e CI; publicação em homologação já
foi autorizada na conversa. Fases 6/7 permanecem no checkout `source` e não
integram este candidato visual; não ativar workers nem retenção nesta publicação.

## Evidência e implementação

- DOM em homologação: html/body/root com overflow hidden, root de 720px e página
  pública de 1.063px. O conteúdo ficava cortado. Página agora tem altura do
  viewport e overflow auto próprio, sem mudar o scroll do aplicativo privado.
- A prévia antiga tinha markup próprio. Agora monta PublicSchedulingPage com
  dados do formulário e horários explicitamente ilustrativos. Não consulta API
  pública e o botão de reserva fica desativado. Mesmo componente, CSS e campos.
- Painel lateral contém prévia e lista de páginas em áreas separadas. As duas
  áreas têm rolagem limitada; o painel acompanha o formulário sem sobreposição.
  DOM sintético confirmou previewBottom 412,5 < pagesTop 426,5.
- Personalização validada no tema: textos do cabeçalho, calendário, etapas,
  profissionais, formulário, campos básicos, botões, mensagens e confirmação;
  cores de cartões/textos/bordas, fontes permitidas, formato e disposição;
  cabeçalho/rodapé opcionais. Título, descrição e campos adicionais preservados.
  Não aceita CSS/HTML/script arbitrários; cores de texto/fundo exigem contraste.
- Logo própria no cabeçalho e no serviço. URL relativa/absoluta resolvida de modo
  único; versão baseada no SHA evita cache de imagem anterior. Publicação aguarda
  a leitura do arquivo e upload; falha no upload mantém a página criada editável,
  evitando um segundo link em nova tentativa. Formatos PNG/JPEG/WebP existentes.
- Filtros Todos, Próximos, Vencidos, Realizados, Ausência e Cancelados. Vencido
  é derivado de end_at e não conclui automaticamente. Serviço/reunião realizado
  e ausência usam a API autenticada; completion_type aditivo, auditado e isolado
  por tenant/workspace/dono. Migração SQLite/PG idempotente; histórico preservado.
- Foto salva no perfil acompanha o payload já autorizado de usuários. Mesmo
  AvatarImage em projetos/tarefas, responsáveis/comentários do Estúdio e topbar;
  nome permanece visível. ID tem precedência; legado por nome só sem homônimos.
  Fallback de iniciais em erro. Sem reduzir a imagem para 24px; object-fit cover,
  image-rendering auto, suavização alta e JPEG 0,94 em novos uploads (até 720px).
  Fonte previamente pequena não ganha detalhes que não existem no original.

## Verificação

- Fonte das fases: 1.462 testes backend e 879 frontend passaram em uma versão
  intermediária que já continha as correções de agendamento/fotos.
- Interface focada: 44/44 testes; após ajuste do painel, 35/35 agendamentos/foto.
- TypeScript, Vite e orçamento do bundle passaram. Diff sem erro de whitespace.
- Navegador local com componentes reais e dados fictícios: resultado realizado,
  logo carregada duas vezes, prévia sem sobreposição, scroll público no PC.
  Screenshots em `source/output/ui-20261012` no checkout principal.
- Validação do candidato isolado, CI, SHA e publicação serão registrados abaixo.
  Não declarar esta revisão em homologação antes da promoção e conferência viva.

## Publicação

Candidato em preparação. Homologação anterior continua na revisão 022ddfc3,
PR #55, aceita pelo usuário para Gmail. Nenhuma página/reserva real foi criada
ou reconfigurada durante a conferência sintética.

Último candidato: frontend focado 45/45 e TypeScript/Vite/bundle passaram; backend isolado 48/48. Tema alterado na prévia atualiza o modo salvo. Paleta clara/escura separada e atendimento presencial/online/telefone com local/instruções editáveis. Links públicos antigos não sobrescrevem um atendimento realizado/encerrado. Conferência responsiva em documento real de 375px dentro de iframe, conteúdo 1.692px e container de 812px com overflow auto; não é uma captura de telefone físico.

PR #56 e run 38250707695: testes backend/empacotamento e imagem/PG passaram; SAST B608 apontou a construção do sufixo SQL FOR UPDATE na linha 613. Consulta usa apenas sufixo fixo, mas foi reescrita com duas strings literais completas; nenhum scanner/limite foi suprimido. Novos gates são obrigatórios antes do deploy.
