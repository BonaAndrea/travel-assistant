# Backend Python

Backend operativo del progetto, implementato con FastAPI, psycopg e PostgreSQL.
Il servizio espone API REST, OpenAPI, autenticazione, chat conversazionale,
generazione asincrona degli itinerari, booking, condivisione e upload privati.

## Avvio locale

```powershell
py -m venv .venv
.\\.venv\\Scripts\\Activate.ps1
pip install -r requirements.txt
uvicorn app.main:app --reload --port 4001
```

Endpoint principali: `/health`, `/health/live`, `/health/ready`, `/docs` e le
API protette sotto `/api`. Il frontend statico usa la porta 8081 e le API sulla
porta 4001.

## Catalogo demo

```powershell
python -m scripts.seed
```

Il seed ricrea solo il catalogo demo e i relativi dati di disponibilità; non
cancella utenti, conversazioni, itinerari o prenotazioni.

## Test

```powershell
pytest
```
