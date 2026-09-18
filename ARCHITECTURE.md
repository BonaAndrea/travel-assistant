# Architettura

## Runtime

Il compose principale avvia tre servizi:

- `backend-python`: FastAPI/Uvicorn sulla porta `4001`;
- `frontend-python`: Nginx sulla porta `8081`;
- `postgres`: PostgreSQL 16.

Non esiste un proxy applicativo: il frontend chiama direttamente le API
Python sotto `/api`.

## Confini dati

PostgreSQL è autorevole per stato transazionale, catalogo, disponibilità,
conversazioni, itinerari e prenotazioni. L’indice RAG in
`backend-python/data/vector-index.json` contiene solo descrizioni e metadati
testuali per ranking/motivazione; non può confermare disponibilità o prezzi.

## Flusso principale

1. L’utente si autentica con access token JWT e refresh token HttpOnly.
2. La chat persiste messaggi e snapshot dei requisiti; un advisory lock evita
   aggiornamenti concorrenti sulla stessa conversazione.
3. La conferma esplicita crea un job idempotente asincrono.
4. Il generatore seleziona voli, camere e attività coerenti con date, budget,
   disponibilità e preferenze; può produrre un’alternativa con compromessi.
5. Il salvataggio crea uno snapshot immutabile dell’opzione scelta.
6. La prenotazione verifica nuovamente prezzi/disponibilità e usa transazione,
   lock advisory e aggiornamenti condizionati.

## Resilienza

- job `queued/running` ripresi al riavvio;
- retry/backoff e circuit breaker per Groq;
- fallback Gemini opzionale;
- vision opt-in con fallback metadata-only;
- health, readiness, request-id e metrics protette da token.

## Migrazioni e seed

Le migrazioni versionate sono sotto `backend-python/migrations`. Il comando
`python scripts/seed.py` ricrea il catalogo demo e l’indice RAG senza dipendere
da runtime o tool JavaScript.
