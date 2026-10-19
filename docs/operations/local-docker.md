# Norium local com Docker

Na raiz deste checkout, execute no PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/start_local_docker.ps1
```

- URL: `http://localhost:8765` (porta publicada somente em `127.0.0.1`).
- Conta administrativa **local**: `admin@norium.local`, com senha aleatória
  criada em `output/docker-local/access.local.json` na primeira inicialização.
- O script preserva o `.env` local nos próximos usos. Não apague esse arquivo
  mantendo os volumes: ele contém as credenciais do banco e a assinatura local.
- PostgreSQL e arquivos usam volumes próprios do projeto `norium-expansao-local`.
  Não são os dados de homologação nem os volumes de outros projetos.
- Nenhum `.env`, cadastro ou credencial de homologação é copiado. A base começa
  vazia, com a conta de desenvolvimento. Integrações exigem configuração própria.
- O primeiro login local é conferido pelo script. Depois a senha de bootstrap é
  retirada do ambiente do container. O arquivo de acesso permanece somente na
  pasta `output`, ignorada pelo Git e excluída do contexto Docker.
- Os novos workers/provedores de IA, Gmail incremental, busca externa e chamadas
  ficam desligados. O worker de importação interna fica disponível.
- A imagem reutiliza `Dockerfile.shard`, com identidade `local`, um processo
  Uvicorn e o frontend compilado na mesma origem. A conexão PostgreSQL sem TLS
  é exclusiva da rede Docker deste ambiente de desenvolvimento.

Para iniciar novamente sem reconstruir a imagem, use `-NoBuild`. Para pausar,
sem remover dados:

```powershell
docker compose --env-file output/docker-local/.env -f compose.local.yaml stop
```

Não use `down -v` para uma parada normal: ele remove os dados locais.
Alterações críticas continuam sujeitas à revisão antes de publicação remota.

## Preparação do WhatsApp Evolution

Use `-WithEvolution` para preparar e iniciar os serviços privados Evolution,
PostgreSQL e Redis. As chaves são próprias e não substituem as da W-API. Esse
perfil é preservado nas próximas execuções. A API não publica porta no Windows.
O pareamento permanece desligado porque a imagem oficial auditada tem achados
críticos/altos. Veja `evolution-api.md` antes de tentar ativar ou instalar no Shard.
`-PrepareOnly` prepara o ambiente sem recriar serviços. Não apagar `.env`/volumes.
