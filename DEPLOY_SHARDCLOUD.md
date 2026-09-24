# Deploy do Norium no ShardCloud

Este arquivo e o procedimento obrigatorio para qualquer publicacao do Norium no
ShardCloud. Um deploy nao esta concluido quando a imagem termina de compilar: ele
so esta concluido depois que dados, autenticacao, APIs, WebSockets e fluxos
criticos forem verificados no endereco publicado.

## Regras que nao podem ser quebradas

1. O PostgreSQL e a fonte autoritativa em producao. Nenhum modulo pode testar a
   existencia de um arquivo local antes de passar pelo repositorio de
   persistencia (`read_json_file`, `read_user_db` ou o repositorio especializado).
2. Nao substituir, zerar ou inicializar documentos PostgreSQL por causa da
   ausencia de arquivos locais no container.
3. O runtime imutavel fica em `/opt/norium`; `/app/data` e reservado para dados
   persistentes. O volume do ShardCloud nao pode encobrir `main.py`, `app/` ou o
   frontend compilado.
4. Executar uma unica instancia do Uvicorn (`--workers 1`). Presenca, sinalizacao
   WebSocket e coordenacao de chamadas ainda dependem do processo unico.
5. Nunca reutilizar um pacote de deploy antigo. O ZIP deve ser gerado do commit
   exato que foi validado e enviado para `origin/main`.
6. Nao considerar `/health` suficiente. Ele prova apenas liveness. O aceite
   exige `/health/ready`, PostgreSQL e os smokes autenticados abaixo.
7. Se qualquer gate falhar, o deploy e considerado com falha. Corrigir a causa
   ou restaurar a imagem anterior; nunca declarar sucesso parcial.

## Pre-flight obrigatorio

- Confirmar que o checkout esta no commit esperado e registrar o SHA completo.
- Preservar alteracoes preexistentes e impedir arquivos locais/secrets no commit.
- Executar `git diff --check`.
- Executar os testes backend afetados e a suite de regressao de persistencia.
- Executar os testes frontend afetados e `npm.cmd run build`.
- Confirmar que `Dockerfile.shard` mantem:
  - `NORIUM_DATA_DIR=/app/data`;
  - `NORIUM_SPA_DIR=/opt/norium/static`;
  - runtime em `/opt/norium`;
  - `--workers 1` e suporte WebSocket;
  - certificado PostgreSQL empacotado e validado.
- Confirmar que os documentos essenciais existem no PostgreSQL antes da troca:
  usuarios, equipes, vinculos de membros e stores dos modulos criticos.
- Fazer backup antes de migracao de dados ou schema. Deploy de codigo nao e
  permissao para recriar uma base vazia.

## Como gerar o pacote

O pacote precisa conter somente o snapshot versionado do commit aprovado. Na
raiz temporaria do pacote, copiar `Dockerfile.shard` como `Dockerfile`; manter o
restante da arvore com `norium-back-end/` e `norium-front-end/`.

Exemplo em PowerShell, substituindo o SHA e os caminhos pelos valores reais:

```powershell
$releaseSha = git rev-parse HEAD
git archive --format=zip --output norium-source.zip $releaseSha
Expand-Archive norium-source.zip norium-release
Copy-Item norium-release\Dockerfile.shard norium-release\Dockerfile -Force
Compress-Archive norium-release\* "norium-$releaseSha-shard.zip"
```

Antes do upload, conferir que o ZIP contem `Dockerfile`,
`norium-back-end/main.py`, `norium-back-end/app/` e
`norium-front-end/package-lock.json`. O build deve usar a imagem
`norium-fullstack` e o arquivo `Dockerfile` da raiz do pacote.

## Publicacao no painel do ShardCloud

1. Abrir **Containers** e atualizar a imagem `norium-fullstack` com o ZIP novo.
2. Aguardar o build terminar com status de sucesso. Se falhar, ler o log e
   corrigir a causa; nao reiniciar a aplicacao com uma imagem incompleta.
3. Abrir a aplicacao Norium e reiniciar/reimplantar somente depois que a nova
   imagem estiver pronta.
4. Aguardar o boot e acompanhar os logs. Um `502` logo apos o restart pode ser
   inicializacao; ele nao e aceite nem falha definitiva ate o readiness ser
   repetido.
5. Registrar SHA, horario, imagem publicada e resultado dos gates.

## Validacao pos-deploy obrigatoria

### Infraestrutura e dados

- `GET /health` retorna `200`.
- `GET /health/ready` retorna `200`, `ready=true` e
  `persistence.driver=postgresql`.
- O login real funciona e `/api/auth/me` devolve o usuario correto.
- A equipe do usuario continua com os mesmos membros e vinculos.
- Tarefas, documentos e clientes carregam sem criar stores vazios.

### Chat da equipe e chamadas

- `POST /api/auth/websocket-ticket` retorna um ticket valido.
- O WebSocket `/api/team-chat/ws` conecta, recebe `CONNECTED`, `PRESENCE` e
  `CALLS_STATE`, e reconecta sem duplicar convite.
- Validar com duas sessoes de teste da mesma equipe: presenca dos dois usuarios,
  envio e recebimento em tempo real, recarga do historico e recibo de leitura.
- Validar inicio, aceite, heartbeat, saida e encerramento de chamada; ao recarregar
  a pagina, uma transmissao/chamada ativa deve ser reconciliada pelo snapshot.
- Com a camera desligada, o participante deve exibir a foto de perfil.
- Confirmar um unico som de entrada, um unico som de saida e um som diferente ao
  iniciar transmissao.
- Nao usar contas reais para mensagens ou chamadas de smoke sem autorizacao;
  manter duas contas exclusivas de teste na mesma equipe.

### Interface e modulos pedidos

- Verificar o layout de Documentos em desktop e viewport estreita.
- Verificar compartilhamento de Clientes e preferencia de notificacao por
  usuario.
- Verificar tarefas, reunioes agendadas, mencoes, contas a pagar e demais eventos
  de e-mail com isolamento por usuario.
- Conferir console do navegador e logs do backend sem erros novos.

## Criterio de aceite

O deploy so pode ser comunicado como concluido quando todos os itens aplicaveis
acima tiverem evidencia. Build verde sem smoke funcional e apenas uma imagem
construida, nao uma entrega validada. Se nao houver duas contas de teste ou um
pre-requisito externo (por exemplo TURN) estiver ausente, registrar claramente o
bloqueio e nao afirmar que chamadas foram validadas ponta a ponta.

## Rollback

Se readiness, login, dados, chat, chamadas ou um modulo critico falhar:

1. interromper o aceite;
2. preservar logs e o SHA com falha;
3. restaurar a ultima imagem conhecida como funcional;
4. confirmar novamente `/health/ready`, login, dados e WebSocket;
5. corrigir em novo commit e gerar outro pacote, sem sobrescrever a evidencia do
   incidente.

Trocar a imagem nao reverte dados. Para migracoes incompatíveis, a restauracao do
backup e a migracao reversa precisam estar preparadas antes da publicacao.
