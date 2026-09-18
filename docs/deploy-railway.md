# Deploy Docker del backend Python

Il servizio è distribuito come immagine Docker del progetto, con PostgreSQL
gestito separatamente dal provider scelto. Il riferimento ufficiale locale è
`docker compose up -d --build`; per un deploy remoto usare lo stesso
`backend-python/Dockerfile` e una variabile `DATABASE_URL` PostgreSQL.

## Variabili

Impostare almeno:

```text
DATABASE_URL=postgresql://...
JWT_SECRET=<segreto-di-almeno-32-caratteri>
FRONTEND_ORIGIN=https://<dominio-frontend>
```

Sono opzionali `GROQ_API_KEY`, `GEMINI_API_KEY`, `METRICS_TOKEN` e le rispettive
impostazioni documentate in `backend-python/.env.example`.

## Migrazioni e catalogo demo

Le migrazioni versionate sono in `backend-python/migrations/` e vengono
applicate all’avvio. Su un database demo isolato si può caricare il catalogo:

```bash
python backend-python/scripts/seed.py
```

Il seed non va eseguito su un database con dati reali senza un backup e una
verifica preventiva dell’ambiente.

## Frontend e storage

Costruire `frontend/Dockerfile.python` e impostare `API_BASE_URL` con l’URL
pubblico che termina in `/api`. Per gli upload impostare
`USER_PREFERENCE_IMAGE_DIR` su uno storage persistente del provider.

## Smoke test

Verificare `/health/ready`, registrazione, chat, generazione, conferma booking,
dashboard, share link e logout. Non inserire token o chiavi nei log o nella
documentazione di consegna.
