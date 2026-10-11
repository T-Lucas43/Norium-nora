# Nora: retrato e layout inicial

## Pedido e escopo

Corrigir a sobreposição dos atalhos com o compositor, mostrar a imagem existente
da Nora acima da saudação e atualizar somente o deploy na VPS de homologação.
Base: `3fe718bffa1e367aadaae8bdfbac786ef9b73c00`. Checkout original preservado.

## Implementação

- Página vazia usa fluxo vertical com altura real, margens automáticas e rolagem
  quando a janela é baixa; remove offsets absolutos concorrentes.
- Retrato reutiliza NoraAvatar e nora-brand.png acima da saudação.
- Atalhos ficam após o compositor na página vazia, inclusive na ordem do teclado.
- Conversas existentes mantêm o compositor abaixo da lista de mensagens.
- Não há alteração de autenticação, permissões, integrações, dados ou dependências.

## Aceite e publicação

Regressão da identidade e da ordem no teste existente NoraWorkspace. Pipeline
completo obrigatório, scans e imagem imutável com controles preservados na VPS.
Validar imagem carregada acima do texto e ausência de interseção entre saudação,
compositor e atalhos em desktop, celular e janela baixa após publicação.
Recibos, hashes, resultado do pipeline, rollback e prova visual em output/ ignorado.

## Lançamento público

O pedido autoriza apenas esta correção e publicação. Pendências de lançamento
serão informadas a partir dos documentos atuais, distinguindo implementação,
validação em homologação e aceite operacional externo; não remediar por associação.
