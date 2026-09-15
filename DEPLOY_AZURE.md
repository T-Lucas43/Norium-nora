# Deploy do Norium na Azure

O ambiente de desenvolvimento usa Azure Container Apps no plano Consumption. O frontend React continua isolado no codigo, mas seu build entra na mesma imagem do FastAPI para que SPA, API e WebSockets usem um unico dominio.

## Arquitetura

- Azure Container Apps Consumption: 0,25 vCPU, 0,5 GiB, escala de zero a uma replica.
- GitHub Container Registry privado: imagem versionada por commit e publicada pelo GitHub Actions.
- Azure Files Standard LRS: volume persistente de 5 GB montado em `/app/data`.
- Bicep: criacao idempotente do ambiente, aplicativo, armazenamento, segredos, probes e limites de escala.
- GitHub Actions com OpenID Connect: deploy sem senha da Azure armazenada no GitHub.

O App Service F1 foi descartado porque a assinatura gratuita atual possui cota de VM igual a zero. Container Apps Consumption nao depende dessa cota e inclui franquia mensal de processamento e requisicoes.

## Primeiro deploy

1. Autentique a Azure CLI e a GitHub CLI.
2. Faça o push do workflow para `main` e aguarde a publicacao da imagem `ghcr.io/t-lucas43/norium-nora:latest`.
3. Execute na raiz do repositorio:

   ```powershell
   .\infra\azure\deploy.ps1 -UploadLocalData
   ```

O script importa somente as variaveis permitidas do `.env`, cria os recursos com Bicep, envia os dados locais ao Azure Files e valida frontend, API e WebSocket. Nos deploys seguintes, omita `-UploadLocalData` para nao substituir dados mais novos da nuvem.

O smoke test autenticado usa `NORIUM_SMOKE_EMAIL` e `NORIUM_SMOKE_PASSWORD` apenas no processo local. Se elas nao estiverem definidas, o script pode reutilizar as credenciais de bootstrap configuradas durante a primeira inicializacao; nenhum desses valores e exibido ou enviado ao bundle do frontend. Depois de remover a senha de bootstrap, mantenha credenciais de smoke dedicadas no ambiente local que executa a validacao.

Em uma instalacao realmente nova, configure `NORIUM_BOOTSTRAP_ADMIN_EMAIL`, `NORIUM_BOOTSTRAP_ADMIN_USER_ID`, `NORIUM_BOOTSTRAP_ADMIN_NAME` e `NORIUM_BOOTSTRAP_ADMIN_PASSWORD` com valores nao vazios antes da primeira inicializacao. O proprietario e criado somente quando `usuarios_db.json` nao existe. Se `-UploadLocalData` enviar esse arquivo, ou se o volume ja contiver um arquivo vazio ou invalido, o bootstrap nao roda. Leituras, gravacoes, cadastros publicos e mudancas posteriores dessas variaveis nunca promovem uma conta nem substituem o `systemOwnerId` persistido. Remova a senha de bootstrap do ambiente imediatamente apos validar o primeiro acesso.

Para recuperar uma instalacao existente, nao tente reativar o bootstrap por configuracao e nao remova um arquivo que contenha usuarios. Pare todas as revisoes, crie um snapshot verificavel do Azure Files e restaure um backup conhecido ou aplique uma manutencao offline revisada, preservando `systemOwnerId`, flags administrativas legitimas e a trilha de auditoria. Apenas se a instalacao for nova e a copia inspecionada confirmar ausencia total de dados, mova o `usuarios_db.json` vazio/invalido para uma quarentena recuperavel enquanto o aplicativo estiver parado, configure os quatro valores, inicie uma unica replica, valide a identidade criada e remova a senha. Esta alteracao de codigo nao executa migracao sobre dados reais.

## CI/CD sem senha

Depois do primeiro deploy, configure a identidade federada e as variaveis do repositorio:

```powershell
.\infra\azure\configure-github-oidc.ps1
```

Cada push para `main` executa testes, cria uma imagem imutavel `sha-<commit>` e atualiza o Container App. Os bancos, anexos, tokens OAuth e arquivos `.env` nunca entram na imagem nem no Git.

## Integracoes externas

Cadastre no Google Cloud as URLs exibidas no final do deploy:

```text
https://SEU-APP/api/auth/callback/gmail
https://SEU-APP/api/integracoes/google/callback
```

O primeiro acesso depois de alguns minutos sem uso pode levar alguns segundos porque a replica escala de zero para um.
