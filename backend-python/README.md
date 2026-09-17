# Python backend

Questo è il backend operativo del progetto. Il vecchio codice Express sotto
`backend/` resta nel repository solo come riferimento durante la migrazione e
non viene più avviato dal compose principale.

## Avvio locale

```powershell
py -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn app.main:app --reload --port 4001
```

Endpoint iniziali:

- `GET /health` — health compatibile con il backend attuale
- `GET /health/live` — liveness, non richiede il database
- `GET /health/ready` — readiness con probe PostgreSQL
- `GET /api/health` e `GET /api/ready` — alias temporanei per la migrazione
- `GET /docs` — documentazione OpenAPI generata da FastAPI

Autenticazione disponibile sotto `/api/auth`: `register`, `login`, `refresh` e
`logout`. Il contratto usa la stessa risposta `{ error: ... }` e lo stesso
cookie `refresh_token` del backend Express.

Sono disponibili anche i primi endpoint protetti dello storico chat:
`GET/DELETE /api/chat/conversations`, `GET /api/chat/conversations/:id` e la
creazione transitoria `POST /api/chat/conversations`.

La chat, i job di generazione, itinerari, booking, share link e immagini sono
gestiti nativamente da Python. La generazione interroga
il catalogo PostgreSQL per voli, camere e attività, salva uno snapshot immutabile
dei requisiti e aggiorna il job in background.

Per il percorso completo Python:

```powershell
docker compose up -d --build
```

Il frontend Python è disponibile su `http://localhost:8081` e usa
direttamente le API Python sulla porta `4001`.

## Test

```powershell
pytest
```
