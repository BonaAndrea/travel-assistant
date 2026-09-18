# Operations

## Avvio

```powershell
docker compose up -d --build
docker compose ps
```

Verificare:

```powershell
Invoke-RestMethod http://localhost:4001/health/ready
```

Frontend: <http://localhost:8081>.

## Seed demo

Il seed è distruttivo per catalogo, conversazioni, itinerari, job e booking.
Eseguirlo solo su un database demo:

```powershell
docker compose exec backend-python python -m scripts.seed
```

Utenti e refresh token vengono preservati; fare comunque un backup prima di
operazioni su ambienti condivisi.

## Stop e log

```powershell
docker compose logs --tail=100 backend-python
docker compose down
```

## Test

```powershell
backend-python\.venv\Scripts\python.exe -m pytest backend-python\tests -q
```

## Configurazione

Le variabili sono documentate in `backend-python/.env.example`. Le chiavi
Groq/Gemini sono opzionali; senza provider il parser deterministico mantiene il
flusso principale operativo.
