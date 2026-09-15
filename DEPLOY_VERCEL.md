# Deploy do Norium no Vercel

O repositorio esta configurado como um projeto Vercel Services com dois servicos:

- `norium_frontend`: React, Vite e fallback de SPA para rotas internas.
- `norium_backend`: FastAPI exposto pelo mesmo dominio em `/api/*` e `/health`.

## Criar o projeto

1. Importe o repositorio `T-Lucas43/Norium-nora` no Vercel.
2. Mantenha o Root Directory na raiz do repositorio.
3. Se o painel solicitar um preset, selecione **Services**. O arquivo `vercel.json` define os dois servicos.
4. Cadastre as variaveis de ambiente de producao antes do primeiro deploy.

## Variaveis obrigatorias

```text
ENVIRONMENT=production
FRONTEND_URL=https://SEU_DOMINIO
BACKEND_PUBLIC_URL=https://SEU_DOMINIO
NORIUM_AUTH_SECRET=uma-chave-longa-e-aleatoria
NORIUM_BOOTSTRAP_ADMIN_EMAIL=admin@seu-dominio
NORIUM_BOOTSTRAP_ADMIN_USER_ID=norium-admin
NORIUM_BOOTSTRAP_ADMIN_NAME=Administrador Norium
NORIUM_BOOTSTRAP_ADMIN_PASSWORD=uma-senha-segura-apenas-para-o-primeiro-acesso
GROQ_API_KEY=...
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REDIRECT_URI=https://SEU_DOMINIO/api/integracoes/google/callback
GMAIL_CLIENT_ID=...
GMAIL_CLIENT_SECRET=...
GMAIL_REDIRECT_URI=https://SEU_DOMINIO/api/auth/callback/gmail
```

As quatro variaveis de bootstrap devem ser configuradas em conjunto. Elas criam o primeiro proprietario somente quando `usuarios_db.json` ainda nao existe; um arquivo existente, mesmo vazio ou invalido, nao reabre o bootstrap. Depois do primeiro acesso, remova `NORIUM_BOOTSTRAP_ADMIN_PASSWORD` do ambiente. A identidade administrativa passa a depender de `systemOwnerId` e das flags persistidas: mudar o e-mail, ID, nome ou senha no ambiente nao promove cadastros comuns nem substitui o proprietario.

O armazenamento `/tmp` do Vercel pode desaparecer e voltar a ficar ausente, portanto esse bootstrap nao transforma a configuracao atual em persistencia de producao. Use-o apenas em uma inicializacao controlada/preview; para usuarios reais, conclua antes a migracao para o armazenamento duravel descrito abaixo. A recuperacao de uma instalacao persistente deve parar todas as instancias, preservar um snapshot verificavel e restaurar backup conhecido ou aplicar manutencao offline revisada. Nao exclua um armazenamento com usuarios para forcar novo bootstrap. Somente uma instalacao comprovadamente nova e sem dados pode colocar um arquivo vazio/invalido em quarentena recuperavel e repetir a inicializacao com os quatro valores. Esta alteracao de codigo nao executa migracao sobre dados reais.

Adicione tambem as credenciais de WhatsApp e boletos presentes em
`norium-back-end/.env.example` quando essas integracoes forem usadas. Nao defina
`VITE_API_URL` ou `VITE_WS_URL` no deploy de dominio unico; o front-end usa a
origem atual automaticamente.

No Google Cloud Console, cadastre exatamente os dois enderecos de callback de
producao acima em **URIs de redirecionamento autorizados**. Mantenha tambem os
callbacks de localhost para o desenvolvimento local.

## Validacao depois do deploy

1. Abra `https://SEU_DOMINIO/health` e confirme uma resposta JSON.
2. Abra `https://SEU_DOMINIO/login` e recarregue a pagina para validar o fallback da SPA.
3. Entre no sistema e teste Perfil, Gmail e Agenda.
4. Reconecte as contas Google usando os callbacks de producao.
5. Teste os canais em tempo real em apenas uma instancia antes de habilitar escala horizontal.

## Persistencia e tempo real

O Vercel permite gravacao apenas no diretorio temporario `/tmp`. Por isso, quando
`VERCEL=1`, o Norium usa `/tmp/norium` para conseguir iniciar e operar em previews.
Esse armazenamento pode desaparecer entre invocacoes, reinicios ou novas
instancias. Os bancos JSON, anexos e tokens atuais nao sao persistencia adequada
para um SaaS em producao no Vercel.

Antes de liberar usuarios reais, migre os registros para PostgreSQL e os anexos
para um object storage persistente. Os gerenciadores WebSocket atuais mantem as
conexoes em memoria da instancia; para broadcast confiavel entre varias
instancias, use Redis ou outro servico de pub/sub.

O desenvolvimento local continua inalterado:

```powershell
cd norium-back-end
.\venv\Scripts\python.exe -m uvicorn main:app --host 127.0.0.1 --port 8000

cd ..\norium-front-end
npm.cmd run dev
```
