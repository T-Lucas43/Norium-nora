# Deploy Norium no Railway

Este projeto deve ser hospedado como dois servicos Railway no mesmo projeto:

- `norium-back-end`: FastAPI + WebSockets
- `norium-front-end`: React buildado e servido por Nginx

## 1. Backend

Crie um servico Railway apontando para a pasta:

```text
norium-back-end
```

Use Dockerfile. As variaveis recomendadas no Railway sao:

```env
ENVIRONMENT=production
NORIUM_DATA_DIR=/app/data
BACKEND_PUBLIC_URL=https://norium-hub-production.up.railway.app
FRONTEND_URL=https://SEU-FRONTEND.up.railway.app
NORIUM_AUTH_SECRET=troque-por-uma-chave-grande-e-secreta

GMAIL_CLIENT_ID=seu-client-id.apps.googleusercontent.com
GMAIL_CLIENT_SECRET=seu-client-secret
GMAIL_REDIRECT_URI=https://norium-hub-production.up.railway.app/api/auth/callback/gmail

GOOGLE_CLIENT_ID=seu-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=seu-client-secret
GOOGLE_REDIRECT_URI=https://norium-hub-production.up.railway.app/api/integracoes/google/callback
```

Configure um volume persistente no servico do backend montado em:

```text
/app/data
```

Todos os bancos JSON multi-tenant ficam dentro desse volume.

## 2. Frontend

Crie outro servico Railway apontando para a pasta:

```text
norium-front-end
```

Use Dockerfile. As variaveis recomendadas no Railway sao:

```env
VITE_API_URL=https://norium-hub-production.up.railway.app
VITE_WS_URL=wss://norium-hub-production.up.railway.app
```

O container gera `/env.js` em runtime com essas URLs, entao voce pode mudar o backend sem editar o codigo.

## 3. Google Cloud OAuth

No cliente OAuth do Gmail, cadastre:

```text
https://norium-hub-production.up.railway.app/api/auth/callback/gmail
```

No cliente OAuth da Agenda, cadastre:

```text
https://norium-hub-production.up.railway.app/api/integracoes/google/callback
```

Para desenvolvimento local, mantenha tambem:

```text
http://localhost:8000/api/auth/callback/gmail
http://localhost:8000/api/integracoes/google/callback
```

Em origens JavaScript autorizadas, cadastre o dominio do frontend:

```text
https://SEU-FRONTEND.up.railway.app
http://localhost:5173
```

## 4. Ordem de deploy

1. Suba o backend.
2. Gere o dominio publico do backend.
3. Configure `BACKEND_PUBLIC_URL`, `GMAIL_REDIRECT_URI` e `GOOGLE_REDIRECT_URI`.
4. Suba o frontend.
5. Copie o dominio publico do frontend.
6. Atualize `FRONTEND_URL` no backend.
7. Redeploy nos dois servicos.

## 5. Testes rapidos

Backend:

```text
https://norium-hub-production.up.railway.app/docs
```

Frontend:

```text
https://SEU-FRONTEND.up.railway.app
```

Depois teste login, perfil, Gmail, Agenda, WebSocket da Central e Chat interno.
