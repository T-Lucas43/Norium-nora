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
NORIUM_OWNER_PASSWORD=uma-senha-segura
GROQ_API_KEY=...
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REDIRECT_URI=https://SEU_DOMINIO/api/integracoes/google/callback
GMAIL_CLIENT_ID=...
GMAIL_CLIENT_SECRET=...
GMAIL_REDIRECT_URI=https://SEU_DOMINIO/api/auth/callback/gmail
```

Adicione tambem as credenciais de WhatsApp, Telegram e boletos presentes em
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
