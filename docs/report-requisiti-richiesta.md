# Verifica requisiti di `Richiesta`

Questo report descrive il branch Python. Le implementazioni citate sono sotto
`backend-python/app`, i test sotto `backend-python/tests` e le migrazioni sotto
`backend-python/migrations`.

| Area | Stato | Implementazione Python |
|---|---|---|
| Input e chat multi-turno | Implementato | conversazioni persistenti, contesto, modifica requisiti, chiarimenti |
| Estrazione e validazione | Implementato | parser requisiti, normalizzazione destinazioni, validazione budget/date/partecipanti |
| Conferma requisiti | Implementato | riepilogo e stato confermato prima della generazione |
| Itinerari | Implementato | volo A/R, alloggio per ogni notte, attività giornaliere, costo e breakdown |
| Vincoli e alternativa | Implementato | selezione per budget/disponibilità/preferenze; alternativa con compromessi espliciti |
| Booking completo | Implementato | conferma esplicita, ricontrollo prezzo/disponibilità, transazione, idempotenza |
| Fallimenti parziali | Implementato | rollback e stato coerente senza falso booking confermato |
| Concorrenza | Implementato | transazioni PostgreSQL, lock advisory/row-level e decrementi condizionati |
| Persistenza relazionale | Implementato | utenti, catalogo, disponibilità, itinerari, componenti, booking, chat e job |
| RAG | Implementato | indice locale separato dal catalogo SQL; ranking usato nella selezione |
| REST e sicurezza | Implementato | FastAPI/OpenAPI, JWT, refresh rotation, ownership, rate limiting, errori strutturati |
| Logging e operatività | Implementato | request id, readiness/liveness, metriche protette, recovery job |
| Frontend | Implementato | auth, chat, proposte, costi/compromessi, booking, dashboard, storico e share |
| Funzionalità opzionali | Implementato | immagini preferenze, modifica/cancellazione, history, async jobs, metrics |

## Prova riproducibile

```powershell
docker compose up -d --build
docker compose exec backend-python python -m scripts.seed
python -m pytest backend-python/tests -q
```

La suite automatica Python verifica autenticazione, requisiti, generator,
booking, sicurezza, rate limiting, RAG e recovery. La verifica manuale deve
coprire anche il flusso browser su `http://localhost:8081`.

## Scelte e limiti dichiarati

Il catalogo demo e il RAG sono locali e deterministici, così il progetto è
eseguibile senza account esterni. Groq/Gemini sono integrazioni opzionali con
fallback; un vector service esterno è un’evoluzione infrastrutturale, non un
requisito per il comportamento applicativo richiesto.
