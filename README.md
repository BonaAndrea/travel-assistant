# Travel Assistant

Assistente conversazionale per creare e prenotare itinerari personalizzati.
Il backend operativo del branch `codex-backend-python` è esclusivamente Python
con FastAPI e PostgreSQL; il frontend è HTML/CSS/JavaScript vanilla servito da
Nginx.

## Avvio con Docker

Prerequisiti: Docker Desktop avviato.

```powershell
docker compose up -d --build
```

Aprire <http://localhost:8081>.

Endpoint principali:

- API: <http://localhost:4001>
- health: <http://localhost:4001/health>
- readiness: <http://localhost:4001/health/ready>
- documentazione OpenAPI: <http://localhost:4001/docs>

Il database viene migrato all’avvio. Per ricreare il catalogo demo in modo
distruttivo, dopo aver verificato di usare un database dedicato:

```powershell
docker compose exec backend-python python -m scripts.seed
```

Il seed Python ricrea destinazioni, aeroporti, voli, hotel, disponibilità,
attività e indice RAG. Non elimina utenti e token di autenticazione.

## Avvio locale

```powershell
cd backend-python
py -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
Copy-Item .env.example .env
uvicorn app.main:app --reload --port 4001
```

È necessario un PostgreSQL raggiungibile tramite `DATABASE_URL`.

## Test

```powershell
cd backend-python
.\.venv\Scripts\python.exe -m pytest tests -q
```

La suite copre parsing e validazione requisiti, health/readiness, RAG locale,
risoluzione catalogo, vision opt-in e fallback Gemini.

## Architettura

- PostgreSQL è la fonte autorevole per utenti, catalogo, disponibilità,
  conversazioni, itinerari e prenotazioni.
- `backend-python/data/vector-index.json` è un indice locale separato per il
  retrieval di descrizioni, categorie e target di attività/hotel. Non viene
  usato per decidere disponibilità o prezzi.
- Groq è il provider conversazionale opzionale; Gemini è un fallback opzionale.
  Parser deterministico, validazione e vincoli transazionali restano autorevoli.
- Le prenotazioni usano transazioni PostgreSQL, lock advisory, controlli
  condizionati di disponibilità, verifica prezzo e idempotenza.
- I job di generazione sono asincroni e vengono ripresi dopo il riavvio.
- Le immagini sono private, validate per magic bytes e analizzate solo se i
  flag e le credenziali vision sono esplicitamente abilitati.

## Configurazione provider

Copiare `backend-python/.env.example` in `.env` e configurare solo ciò che
serve. Senza chiavi LLM il sistema continua a funzionare con estrazione e
risposte deterministiche. `METRICS_TOKEN`, se impostato, protegge
`GET /api/metrics`.

## Stato del branch

Il compose principale avvia esclusivamente `backend-python` e
`frontend-python`. Il branch non usa un proxy intermedio per le API.
