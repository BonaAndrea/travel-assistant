# Demo con backend Node.js e Python

Il branch `codex/demo-dual-backend` contiene entrambi i backend e un solo frontend.
Il frontend mostra la scelta dell'implementazione prima del login e salva la scelta
nel browser.

## Servizi Render

Il blueprint `render.yaml` definisce:

- `travel-assistant-backend-node`
- `travel-assistant-backend-python`
- `travel-assistant-frontend`

Nel servizio frontend configurare:

- `NODE_API_URL`: URL pubblico Node.js con suffisso `/api`;
- `PYTHON_API_URL`: URL pubblico Python con suffisso `/api`.

Configurare `FRONTEND_ORIGIN` su entrambi i backend con l'URL pubblico del frontend.
Per una demo isolata è consigliato usare un database Render distinto per ogni backend;
così seed e migrazioni di un'implementazione non modificano l'altra.

La scelta del backend cancella il token locale precedente: l'utente deve quindi
autenticarsi separatamente quando passa da Node.js a Python.
