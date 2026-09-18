# Guida di consegna

## Avvio

Dalla root del repository:

```powershell
docker compose up -d --build
docker compose exec backend-python python -m scripts.seed
```

Aprire `http://localhost:8081`. Le API Python rispondono su
`http://localhost:4001`; OpenAPI è disponibile su `/docs`.

## Avvio senza Docker

Creare un virtual environment Python, installare
`backend-python/requirements.txt`, impostare `DATABASE_URL` e avviare:

```powershell
uvicorn app.main:app --app-dir backend-python --port 4001
```

Il database deve essere PostgreSQL. Le migrazioni versionate sono applicate
all’avvio; il seed è destinato solo a database demo isolati.

## Funzionalità consegnate

La soluzione include autenticazione e refresh token, chat con memoria e
modifica requisiti, riepilogo e conferma, generazione asincrona di itinerari,
voli A/R, alloggio per ogni notte, attività giornaliere, costi e breakdown,
alternative con compromessi, booking transazionale, idempotenza, storico,
share link, modifica/cancellazione, upload immagini, RAG locale, logging,
OpenAPI, readiness, metriche e rate limiting.

## Test

```powershell
python -m pytest backend-python/tests -q
python -m compileall -q backend-python/app backend-python/scripts
docker compose config
```

Il percorso manuale da verificare nel browser è: registrazione, login, nuova
chat, generazione, scelta proposta, conferma booking, dashboard, share link e
logout. I messaggi di errore devono restare visibili senza esporre segreti.

## Configurazione

Usare `backend-python/.env.example` come elenco delle variabili disponibili.
Groq e Gemini sono opzionali; senza chiavi il backend mantiene un fallback
deterministico. Per la produzione impostare `JWT_SECRET`, `FRONTEND_ORIGIN`,
un database PostgreSQL persistente e storage persistente per gli upload.

## RAG e trade-off

Il RAG locale è separato dalle tabelle relazionali e contribuisce al ranking
delle destinazioni, degli hotel e delle attività. È stato scelto per rendere
la consegna riproducibile senza account o costi esterni; un vector service
gestito può essere introdotto in seguito mantenendo l’interfaccia del modulo
`backend-python/app/rag.py`.
