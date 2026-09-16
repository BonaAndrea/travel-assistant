# Deploy separato su Railway

Questa guida riguarda esclusivamente il branch `feature/railway-demo`.
Il branch `main` e il deployment locale Docker restano invariati.

## Struttura Railway

Railway non esegue il `docker-compose.yml` come un unico ambiente. Crea invece
tre servizi nello stesso progetto:

1. **Postgres**: database PostgreSQL gestito da Railway.
2. **Backend**: servizio collegato alla cartella `backend`, con il Dockerfile
   già presente.
3. **Frontend**: servizio collegato alla cartella `frontend`, con il nuovo
   Dockerfile Nginx.

Il database gestito sostituisce il container Postgres locale. Non usare il seed
sul database di consegna se contiene dati reali: `npm run seed` ricrea il catalogo
demo e cancella i dati applicativi del database indicato.

## Ordine di configurazione

1. Crea un nuovo progetto Railway.
2. Aggiungi **PostgreSQL**.
3. Aggiungi il servizio backend dal repository GitHub e imposta **Root
   Directory** su `/backend`.
4. Aggiungi il servizio frontend dallo stesso repository e imposta **Root
   Directory** su `/frontend`.
5. Genera un dominio pubblico per backend e frontend dalle impostazioni dei due
   servizi. Il browser userà il dominio frontend.

## Variabili backend

Nel servizio backend imposta le variabili prendendole dal servizio PostgreSQL:

```text
DATABASE_URL=${{Postgres.DATABASE_URL}}
NODE_ENV=production
FRONTEND_ORIGIN=https://<dominio-frontend>.up.railway.app
JWT_SECRET=<segreto-generato-casualmente-di-almeno-32-caratteri>
GROQ_API_KEY=<chiave-Groq>
GROQ_VISION_ENABLED=false
GROQ_VISION_FREE_TIER_CONFIRMED=false
GEMINI_ENABLED=true              # opzionale
GEMINI_FREE_TIER_CONFIRMED=true # solo se si vuole abilitarlo
GEMINI_API_KEY=<chiave-Gemini>   # opzionale
```

Railway fornisce automaticamente `PORT`; il server Express lo legge già da
`process.env.PORT`. `JWT_SECRET` deve contenere almeno 32 caratteri. Per gli
altri valori usare `backend/.env.example` come riferimento, senza copiare
segreti o URL locali.

## Variabili frontend

Nel servizio frontend imposta:

```text
API_BASE_URL=https://<dominio-backend>.up.railway.app/api
```

Il Dockerfile sostituisce il riferimento locale nei file statici all’avvio di
Nginx. In locale, se il frontend è servito dal Compose originale, il fallback
continua a usare `http://localhost:4000/api`.

## Migrazioni e seed demo

Prima del primo test, nella shell/one-off command del servizio backend:

```bash
npm run prisma:migrate:deploy
npm run seed
```

Eseguire il seed solo su un database demo isolato: ricrea il catalogo e cancella
i dati applicativi del database indicato. Per una consegna con dati già presenti
eseguire solo le migrazioni.

## Storage immagini

Il backend salva gli upload nella directory configurata da
`USER_PREFERENCE_IMAGE_DIR` (default sotto `uploads`). Il filesystem del
container Railway non va considerato permanente: per mantenere gli upload dopo
un redeploy bisogna aggiungere un Volume Railway al servizio backend e impostare:

```text
USER_PREFERENCE_IMAGE_DIR=/app/uploads/user-preferences
```

Montare il Volume su `/app/uploads`. Senza Volume gli upload privati si perdono
al redeploy; per una demo senza upload persistenti si può omettere il Volume.

## Smoke test

1. Apri il dominio frontend e registra un utente.
2. Completa una chat con una destinazione presente nel seed.
3. Genera e prenota un itinerario.
4. Verifica dashboard, nuova chat, condivisione pubblica e logout.
5. Controlla `https://<dominio-backend>/health/ready`.

Se la pagina si apre ma le API falliscono, controlla prima `API_BASE_URL` del
frontend e `FRONTEND_ORIGIN` del backend. Se il backend non parte, controlla
`DATABASE_URL`, migrazioni e log di deploy senza condividere token o chiavi.
