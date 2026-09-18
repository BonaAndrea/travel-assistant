# Stato del progetto

## Branch Python

Il branch `codex-backend-python` contiene il runtime applicativo Python:

- FastAPI + psycopg + PostgreSQL;
- autenticazione JWT con refresh rotation e autorizzazione per proprietario;
- chat multi-turno con estrazione, validazione, riepilogo e conferma requisiti;
- generazione asincrona di voli, hotel e attività, con alternativa e compromessi;
- booking transazionale con controllo prezzi, disponibilità, idempotenza e rollback;
- storico conversazioni, itinerari, share link, modifica/cancellazione e upload immagini;
- RAG locale separato dal catalogo relazionale;
- OpenAPI, logging con request id, readiness, metriche protette e rate limiting.

## Verifiche

La suite Python è in `backend-python/tests`; il compose avvia solo PostgreSQL,
backend Python e frontend statico. Il percorso Docker documentato è:

```powershell
docker compose up -d --build
docker compose exec backend-python python -m scripts.seed
```

API: `http://localhost:4001`; frontend: `http://localhost:8081`; documentazione:
`http://localhost:4001/docs`.

## Limiti e scelte

Il catalogo demo è locale e deterministico. Groq e Gemini sono provider
opzionali: senza chiavi il sistema mantiene un fallback deterministico. Il RAG
locale privilegia riproducibilità e assenza di costi infrastrutturali; può
essere sostituito da un servizio vettoriale esterno senza cambiare il contratto
di generazione.
