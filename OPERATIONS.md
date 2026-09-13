# Runbook operativo

## Avvio locale/demo

1. Copiare `backend/.env.example` in `backend/.env` e impostare un `JWT_SECRET` lungo e
   `GROQ_API_KEY` senza committare il file.
2. Avviare PostgreSQL: `docker compose up -d postgres`.
3. Applicare lo schema: `docker compose run --rm backend npm run prisma:migrate:deploy`.
4. Avviare backend/frontend: `docker compose up -d backend frontend`.
5. Eseguire il seed solo su database demo vuoto: `docker compose exec backend npm run seed`.

Gli upload di preferenze sono privati e persistono nel volume Compose `preference_uploads`,
montato su `/app/uploads` con ownership dell’utente non-root `node`; non esporre quella
directory tramite frontend/static hosting.

## Staging/produzione

Usare `npm ci`, `npm run prisma:migrate:deploy`, poi `npm start`. Il container non applica
migrazioni automaticamente. Impostare `NODE_ENV=production`, `DATABASE_URL`, `JWT_SECRET` da
secret manager, `FRONTEND_ORIGIN` esplicito e `GROQ_API_KEY`.

## Health e incidenti

- `/health/live`: processo raggiungibile, senza dipendenze esterne.
- `/health/ready`: `SELECT 1` su PostgreSQL, 503 se il DB non è pronto.
- `/health`: alias compatibile del check base.
- `GET /api/metrics`: solo con `METRICS_TOKEN`, dati aggregati.

In caso di provider LLM degradato, circuit breaker e fallback mantengono la chat utilizzabile;
controllare gli eventi JSON senza cercare payload nei log. In caso di DB indisponibile, rimuovere
il backend dal traffico tramite readiness e risolvere la causa prima del riavvio.

## Audit dipendenze

`npm audit --omit=dev` rileva attualmente 5 advisory transitive (4 high, 1 critical):
`protobufjs` (catena `onnx-proto -> onnxruntime-web -> @xenova/transformers@2.17.2`)
e `sharp` (stessa catena). L’aggiornamento automatico disponibile richiede
`npm audit fix --force`, che sostituisce `@xenova/transformers` con `1.4.2` e introduce
un downgrade breaking. Non viene applicato: interromperebbe il contratto RAG/vision senza
una verifica funzionale del modello. Non risultano fix non-breaking applicabili nello stato
attuale dell’albero; rieseguire l’audit dopo un rilascio compatibile di Transformers/ONNX.

## Backup/rollback

Le migrazioni sono forward-only e versionate. Fare backup PostgreSQL prima di migrazioni rischiose;
non usare `db push` o `--accept-data-loss` su staging/produzione. Per rollback usare un’immagine
precedente e una migrazione correttiva, senza modificare manualmente `_prisma_migrations`.
