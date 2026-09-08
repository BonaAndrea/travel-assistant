# Travel Assistant — Assistente Virtuale per Viaggi Personalizzati

Coding challenge: assistente conversazionale per generare e prenotare itinerari di viaggio
personalizzati, con raccolta requisiti multi-turno, generazione itinerario (voli + hotel +
attività) rispettando budget/preferenze/coerenza temporale, e booking transazionale.

## Stack scelto

- **Backend**: Node.js + Express + Prisma ORM
- **DB relazionale**: PostgreSQL (stato transazionale: utenti, disponibilità, prenotazioni)
- **DB vettoriale (RAG)**: indice file-based con embeddings calcolati localmente
  (`@xenova/transformers`, modello `all-MiniLM-L6-v2`) — nessuna API key richiesta per questa parte
- **LLM conversazionale**: [Groq](https://console.groq.com) (gratuito, API compatibile OpenAI,
  usato con tool-calling per l'estrazione strutturata dei requisiti)
- **Frontend**: HTML/CSS/JS vanilla (nessun framework, come suggerito dalla challenge)
- **Test**: Jest, sulle logiche di business pure (validazione requisiti, calcolo date)

## Perché queste scelte

- **Vector store separato dal DB relazionale ma senza servizio esterno**: per rispettare il
  vincolo "soluzione semplice, purché il ruolo sia distinguibile", ho evitato di introdurre
  un servizio aggiuntivo (Chroma/Pinecone) e ho usato un indice JSON con similarità coseno
  calcolata in-process. Il ruolo (retrieval semantico su descrizioni/target di attività e hotel)
  è chiaramente separato dalla logica transazionale di Postgres.
- **Groq per la conversazione**: gratuito, veloce, supporta tool-calling nativo utile per
  l'estrazione strutturata dei requisiti senza dover fare parsing manuale fragile.
- **Un'unica tabella `Conversation.state` (JSON) per lo stato della macchina a stati** invece di
  colonne rigide: la conversazione ha fasi (`collecting → confirming → itinerary_proposed →
  booking_confirmed`) e requisiti parziali che cambiano forma nel tempo; JSON è più pragmatico
  qui, con lo svantaggio di perdere un po' di type-safety a livello DB.
- **Booking transazionale con update condizionali**: la conferma prenotazione decrementa
  posti/camere/capacità dentro un'unica transazione Prisma, con `updateMany` condizionati sulla
  disponibilità residua. Se un solo componente non è più disponibile, l'intera transazione va in
  rollback e viene creato un booking con stato `failed` — l'utente non vede mai un itinerario
  "confermato" ma in realtà parzialmente prenotato.
- **Idempotenza**: `idempotencyKey` univoca sul booking, generata lato client (UUID) al momento
  del click "Prenota". Un invio ripetuto della stessa richiesta ritorna la prenotazione già
  creata invece di crearne una seconda.

## Setup

### Opzione A — Docker (consigliata)

```bash
cp backend/.env.example backend/.env
# modifica backend/.env inserendo GROQ_API_KEY (gratuita su console.groq.com)

export GROQ_API_KEY=xxxxx
docker compose up --build
```

Al primo avvio, in un altro terminale:

```bash
docker compose exec backend npx prisma db push
docker compose exec backend npm run seed
```

Poi apri http://localhost:8080 nel browser (il frontend viene servito da un piccolo web server incluso in Docker — necessario perché i moduli JavaScript non funzionano se apri il file HTML direttamente col doppio click).

### Opzione B — locale senza Docker

Richiede PostgreSQL già installato e in esecuzione.

```bash
cd backend
cp .env.example .env   # imposta DATABASE_URL, GROQ_API_KEY
npm install
npx prisma db push       # crea le tabelle a partire dallo schema (senza file di migrazione)
npm run seed
npm run dev
```

Poi apri `frontend/index.html` nel browser (senza Docker, serve un server statico locale, es. `npx serve frontend`, perché i moduli JS non funzionano da file:// — vedi nota sopra).

### Test

```bash
cd backend
npm test
```

Copre: validazione requisiti (campi mancanti, coerenza budget/durata/partecipanti) e la logica
pura di conversione mese → intervallo date. **Non richiedono DB attivo.**

## Scenario di prova consigliato

Il seed (`npm run seed`) popola voli/hotel/attività per **Spagna, partenza da FCO**, nel mese
stampato a console dallo script (di default: due mesi da oggi). Prova in chat qualcosa come:

> "Vorrei andare in Spagna a [mese seedato], budget 1500€ per 2 persone, 5 giorni, partiamo da
> FCO, ci piace cultura e relax"

L'assistente chiederà eventuali dati mancanti, riepilogherà, e alla conferma genererà
l'itinerario (con alternativa se il budget stretto non fosse rispettabile).

## Iterazione 2 — miglioramenti algoritmo ed edge case

- **Coerenza temporale volo/soggiorno**: il volo di ritorno ora viene cercato garantendo
  almeno `durationDays` di distanza dall'andata (prima si accettava qualunque ritorno
  successivo, anche incoerente con la durata dichiarata).
- **Matching case-insensitive** su aeroporto/nazione (`mode: 'insensitive'` + trim), per
  tollerare variazioni nell'estrazione fatta dall'LLM (es. "fco" vs "FCO").
- **Selezione attività più robusta**: una ricerca semantica per ciascuna preferenza (invece di
  una singola query combinata) con merge dei punteggi, così preferenze diverse (es. "cultura" e
  "relax") non si "annacquano" a vicenda; preferenza per varietà giorno-per-giorno (evita di
  riproporre sempre la stessa attività quando ce ne sono altre valide); se nessuna attività è
  compatibile per un giorno, quel giorno resta scoperto invece di far fallire l'intero
  itinerario, e il compromesso viene riportato esplicitamente all'utente.
- **Errori più specifici**: distinzione tra "nessun volo di andata", "nessun ritorno coerente
  con la durata", "nessun hotel con disponibilità continuativa", "hotel troppo costoso anche
  nella fascia economica" — invece di un unico messaggio generico.
- **Concorrenza reale sulle attività in fase di booking**: il decremento di `booked` ora avviene
  con un `UPDATE ... WHERE booked + partecipanti <= capacity` atomico via SQL diretto, eliminando
  la finestra di race condition che c'era tra un `updateMany` e un controllo separato.
- **Niente crash su errori async**: tutte le route sono avvolte in un `asyncHandler` che inoltra
  le eccezioni al middleware di errore centralizzato invece di generare unhandled rejection.

## Compromessi effettuati per i vincoli di tempo

- **Selezione attività**: ottimizzatore multi-giorno a beam search (un'attività "principale" al
  giorno) che valuta combinazioni complete rispettando budget, capacità, disponibilità,
  preferenze e varietà. La ricerca è limitata a un beam per mantenere tempi prevedibili e non
  è un solver matematico esatto. Il modello dati attuale espone disponibilità giornaliere ma non
  fasce orarie: i conflitti tra orari richiederebbero un'estensione dello schema.
- **Modello dati aeroporti/destinazioni**: il dominio è normalizzato con le entità `Airport` e
  `Destination`; i voli referenziano gli aeroporti tramite chiavi esterne e la destinazione
  viene risolta dal paese/città dell'aeroporto di arrivo. I requisiti conversazionali continuano
  ad accettare codice IATA e nome del paese per mantenere un'interazione naturale.
- **Autenticazione**: access JWT breve salvato lato frontend e refresh token opaco ruotato,
  persistito solo come hash e trasmesso in cookie HttpOnly; resta da aggiungere il rate
  limiting sul login.
- **RAG**: l'indice vettoriale va ricostruito manualmente (`buildIndex()`, richiamato nel seed)
  quando cambia il catalogo; in produzione andrebbe fatto in modo incrementale on-write.
- **Gestione errori LLM**: se Groq non risponde o l'estrazione fallisce, la conversazione
  prosegue chiedendo di nuovo i dati mancanti in modo esplicito (fallback su
  `requirementsService`), ma non c'è retry automatico con backoff.
- **Modifica/cancellazione booking**: una prenotazione confermata può essere cancellata con
  ripristino atomico di voli, camere e attività (`DELETE /api/bookings/:id`). La modifica usa
  un nuovo itinerario `draft` dello stesso utente (`PATCH /api/bookings/:id` con
  `newItineraryId`), libera il vecchio snapshot e prenota il nuovo nella stessa transazione.
  Prenotazioni non confermate, itinerari di altri utenti e nuovi itinerari già usati vengono
  rifiutati.

## Cosa migliorerei con più tempo

- Solver di ottimizzazione più solido per la selezione attività (es. knapsack multi-giorno
  esatto con fasce orarie), oltre all'attuale beam search.
- Estendere il catalogo normalizzato con codici paese ISO e più città per la stessa nazione.
- Rate limiting sulle API pubbliche (`/auth/*`).
- Retry/backoff sulle chiamate LLM e circuit breaker in caso di provider non disponibile.
- Test di integrazione end-to-end (con DB Postgres in container per i test, es. via
  `testcontainers`) oltre agli unit test attuali sulla logica pura.
- Rate limiting sulle API pubbliche (`/auth/*`).
- Caching dei risultati di ricerca voli/hotel più frequenti.

## Struttura repository

```
travel-assistant/
├── backend/
│   ├── src/
│   │   ├── routes/        # auth, chat, itineraries, bookings
│   │   ├── services/      # llm, vectorStore (RAG), itinerary, booking, requirements
│   │   ├── middleware/    # auth (JWT)
│   │   └── db/            # prisma client, seed
│   ├── prisma/schema.prisma
│   ├── tests/              # unit test (jest)
│   ├── openapi.yaml
│   └── Dockerfile
├── frontend/               # HTML/CSS/JS vanilla
├── docker-compose.yml
└── README.md
```
