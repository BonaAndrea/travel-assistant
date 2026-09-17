# Travel Assistant — Assistente Virtuale per Viaggi Personalizzati

Travel Assistant è un assistente conversazionale per raccogliere i requisiti di viaggio,
proporre itinerari personalizzati e accompagnare l'utente fino alla prenotazione.
La conversazione è multi-turno: l'utente può completare o modificare le proprie preferenze,
confermare la proposta e prenotare voli, hotel e attività all'interno dello stesso percorso.

Il progetto è stato realizzato come coding challenge, con un catalogo locale seedato e
un'architettura pensata per rendere espliciti i principali aspetti applicativi: validazione,
RAG, autenticazione, concorrenza, transazioni e gestione degli errori.

## Stack scelto

- **Backend**: Node.js + Express + Prisma ORM
- **DB relazionale**: PostgreSQL (stato transazionale: utenti, disponibilità, prenotazioni)
- **DB vettoriale (RAG)**: indice file-based con embeddings calcolati localmente
  (`@xenova/transformers`, modello `all-MiniLM-L6-v2`) — nessuna API key richiesta per questa parte
- **LLM conversazionale**: [Groq](https://console.groq.com) (gratuito, API compatibile OpenAI,
  usato con tool-calling per l'estrazione strutturata dei requisiti)
- **Frontend**: HTML/CSS/JS vanilla (nessun framework, come suggerito dalla challenge)
- **Immagini**: file selezionati da Wikimedia Commons, con autore e licenza riportati
  accanto a ogni immagine; il catalogo usa URL pubblici e non richiede API key
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

- **Overlap e prezzo al commit**: la conferma acquisisce un advisory lock PostgreSQL
  transazionale, ricontrolla le date contro le prenotazioni confermate e rilegge i prezzi
  correnti di voli, hotel e attività. Un cambio prezzo restituisce `PRICE_CHANGED` e annulla
  l'intera transazione.

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
docker compose exec backend npm run prisma:migrate:deploy
docker compose exec backend npm run seed
```

Il container backend è configurato per dev/demo: non modifica automaticamente lo schema
all’avvio e gira con l’utente non-root `node`. Eseguire `prisma migrate deploy` esplicitamente solo
sul database demo dopo aver verificato `DATABASE_URL`; in produzione usare migrazioni versionate
e un processo di deploy controllato.

Poi apri http://localhost:8080 nel browser (il frontend viene servito da un piccolo web server incluso in Docker — necessario perché i moduli JavaScript non funzionano se apri il file HTML direttamente col doppio click).

### Opzione B — locale senza Docker

Richiede PostgreSQL già installato e in esecuzione.

```bash
cd backend
cp .env.example .env   # imposta DATABASE_URL, GROQ_API_KEY
npm install
npm run prisma:migrate:deploy # applica le migrazioni versionate
npm run seed
npm run dev
```

Poi apri `frontend/index.html` nel browser (senza Docker, serve un server statico locale, es. `npx serve frontend`, perché i moduli JS non funzionano da file:// — vedi nota sopra).

### Seed demo: comando, impatto e precondizioni

Il seed è destinato a un database demo isolato. Prima di eseguirlo verificare che PostgreSQL
sia raggiungibile, che `DATABASE_URL` punti al database corretto e che lo schema sia aggiornato:

```bash
cd backend
npm run prisma:migrate:deploy
npm run prisma:generate
npm run seed
```

`npm run seed` è distruttivo per i dati applicativi del database indicato: elimina messaggi,
booking, itinerari, job, conversazioni e il catalogo voli/hotel/attività con le disponibilità,
poi ricrea il catalogo deterministico multi-città e l'indice RAG. Non eseguirlo su un database
con dati utente senza backup e approvazione esplicita. Dopo il seed va riavviato il backend per
svuotare eventuali cache locali e va verificato che lo storage immagini punti alla directory
prevista. Nel checkout condiviso il comando non è stato eseguito.

### Seed remoto senza Shell Render

Il workflow GitHub Actions **Rigenera catalogo demo** è avviabile solo manualmente e non parte
con il deploy. Per usarlo sul database Neon, aggiungere il secret repository
`NEON_DATABASE_URL` con la stringa di connessione del database demo. In **Actions**, selezionare
il workflow, premere **Run workflow** e scrivere esattamente `RIGENERA-CATALOGO` nel campo di
conferma. Il workflow applica prima le migrazioni e poi esegue il seed; valgono quindi tutte le
avvertenze distruttive riportate sopra. Al termine, avvia un deploy manuale del backend Render
sul ramo `feature/railway-demo`: il backend ricostruisce l'indice RAG al primo itinerario richiesto,
senza bloccare l'avvio o il login sul filesystem effimero del servizio. Se l'indice file non è
disponibile, la selezione attività usa direttamente il catalogo relazionale e non carica il modello
di embedding nell'istanza gratuita.

### Demo rapida

1. Avvia il progetto e crea un account.
2. Apri **Chat** e inserisci una richiesta completa, ad esempio:

   > Vorrei andare in Spagna a [mese disponibile], budget 1500€ per 2 persone,
   > 5 giorni, partenza da FCO, con preferenza per cultura e relax.

3. Conferma i requisiti riepilogati dall’assistente.
4. Attendi la generazione dell’itinerario e confronta proposta e alternativa.
5. Prenota una delle opzioni e verifica il risultato nella sezione **Le mie prenotazioni**.
6. Usa **Storico** per riprendere una conversazione precedente.

**Percorso demo showcase**: utilizza gli stessi flussi autenticati dell’applicazione; non esistono bypass
o dati demo impliciti nel frontend.

### Matrice browser/viewport verificata

| Superficie | 320 | 360 | 390 | 768 | 1440 |
|---|---:|---:|---:|---:|---:|
| Layout/login/chat/drawer da regole CSS e test frontend | ✓ | ✓ | ✓ | ✓ | ✓ |
| Cattura Chrome headless affidabile | — | — | — | ✓ | ✓ |
| Browser interattivo reale end-to-end | residuo P2 | residuo P2 | residuo P2 | residuo P2 | residuo P2 |

Le catture Chrome CLI sotto 500 px non sono state usate come prova visuale: il runner applica un viewport interno minimo e ritaglia l’immagine. Restano da eseguire con un browser interattivo la prova reale dei viewport piccoli, zoom 200%, tastiera mobile, focus/ESC dei drawer e scadenza sessione end-to-end.

### Test

```bash
cd backend
npm test
```

Copre requisiti, date e selezione itinerari, booking, chat e cronologia, job asincroni,
rate limit, media, resilienza LLM e regressioni frontend. **Non richiedono DB attivo**:
le dipendenze esterne sono simulate.

Per i test di integrazione con PostgreSQL reale, avvia Docker Desktop ed esegui:

```bash
cd backend
npm run test:integration
```

Il runner crea un container PostgreSQL effimero con progetto Compose univoco e porta locale
dinamica, applica le migrazioni versionate ed elimina sempre container, rete e volumi al termine (anche in
caso di errore). Non usa il database applicativo. Le suite verificano booking, vincoli degli
itinerari, snapshot dei job e un percorso API autenticato di registrazione, conversazione,
salvataggio itinerario e prenotazione. Il percorso browser/LLM completo resta escluso per non
dipendere da browser o credenziali LLM nella CI.

## Scenario di prova consigliato

Il seed include 7 aeroporti italiani (`FCO`, `MXP`, `BLQ`, `NAP`, `VCE`, `TRN`, `BRI`) e
20 destinazioni europee in 15 paesi, da Barcellona e Madrid a Amsterdam, Berlino, Vienna,
Budapest, Dublino, Istanbul, Dubrovnik e Cracovia. Le rotte andata/ritorno sono distribuite
sui 12 mesi successivi, con partenze ogni 3–4 giorni (1, 4, 8, 11, 15, 18, 22 e 25) e ritorni
a +5 notti. Hotel e attività coprono tutti i giorni reali di ciascun mese.
La ricerca per nazione considera tutte le città del paese; la ricerca per città restringe volo,
hotel e attività alla destinazione scelta.

Il seed (`npm run seed`) ricrea il catalogo deterministico per tutte le rotte e i mesi indicati
in console. Prova in chat qualcosa come:

> "Vorrei andare in Spagna a [mese seedato], budget 1500€ per 2 persone, 5 giorni, partiamo da
> FCO, ci piace cultura e relax"

L'assistente chiederà eventuali dati mancanti, riepilogherà, e alla conferma genererà
l'itinerario (con alternativa se il budget stretto non fosse rispettabile).

## Dettagli tecnici e casi limite gestiti

- **Coerenza temporale volo/soggiorno**: il volo di ritorno viene cercato garantendo
  il giorno UTC esatto dell'andata più `durationDays`, senza lasciare notti scoperte.
  Il modello attuale interpreta `durationDays` come numero di pernottamenti: per esempio,
  partenza il giorno 1 e durata 5 significano cinque notti e ritorno il giorno 6.
  Hotel e attività usano giornate UTC; il catalogo non modella fusi locali o orari delle attività.
- **Coerenza geografica**: il ritorno parte dall'aeroporto di arrivo dell'andata; hotel e
  attività sono filtrati sulla stessa destinazione normalizzata, anche con più città per paese.
- **Matching case-insensitive** su aeroporto/nazione (`mode: 'insensitive'` + trim), per
  tollerare variazioni nell'estrazione fatta dall'LLM (es. "fco" vs "FCO").
- Gli aeroporti accettano anche alias umani controllati: IATA, città e nome parziale
  univoco (es. "Milano Malpensa" → MXP), con normalizzazione di accenti, maiuscole e spazi;
  parziali corti o ambigui non vengono risolti.
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

## Generazione asincrona degli itinerari

La conferma in chat non mantiene aperta la richiesta HTTP durante le ricerche. Il client crea
un job idempotente con `POST /api/itinerary-jobs`, ne consulta stato e avanzamento tramite
`GET /api/itinerary-jobs/:id` e conserva job e conversazione attivi in `localStorage`, così il
polling e la visualizzazione del risultato riprendono dopo un refresh. Gli stati persistiti sono
`queued`, `running`, `completed` e `failed`; risultato ed eventuale errore restano consultabili.

Ogni job conserva i requisiti alla creazione in `result.requirementsSnapshot`. Se i requisiti
cambiano, la proposta precedente viene invalidata e un job già in corso non sovrascrive il
nuovo stato della conversazione. Il salvataggio del draft rifiuta con HTTP 409 proposte obsolete
o precedenti all'introduzione dello snapshot: occorre generarle nuovamente.
Se un job fallisce per un vincolo funzionale del catalogo, lo stato conserva anche `generationIssue`
con requisiti correnti, codice errore e alternative disponibili. Il turno chat successivo può
spiegare il vincolo e chiedere quale requisito modificare; una conferma non avvia un retry cieco.
Il refresh ripristina anche i messaggi; se la risposta di creazione del job è andata persa,
il client recupera il job riutilizzando la chiave persistita. Frasi come «non confermo» e
«ok ma siamo 3» non avviano direttamente la generazione.

La sessione chat è lazy: `POST /api/chat/conversations` restituisce un UUID transitorio senza
creare una riga `Conversation`; il primo `POST /api/chat/conversations/:id/messages` persiste
Conversation e primo messaggio nella stessa transazione. Il GET dello stesso UUID restituisce
lo stato vuoto senza scrivere nel database e lo storico esclude le conversazioni prive di messaggi,
incluse quelle legacy.

Dopo l'aggiornamento dello schema, in sviluppo creare una migrazione con `npm run prisma:migrate`;
staging/produzione applicano solo `npm run prisma:migrate:deploy`. Il backend non esegue migrazioni
automatiche all'avvio.

### Immagini di preferenza utente

Il backend espone `POST /api/chat/conversations/:conversationId/preferences/images` con token
Bearer e `multipart/form-data` nel campo `image`. Sono accettati JPEG, PNG e WebP fino a 5 MiB;
il contenuto viene verificato tramite magic bytes, rinominato con UUID e salvato nella directory
privata configurata da `USER_PREFERENCE_IMAGE_DIR` (default `./uploads/user-preferences`), che non
è servita staticamente. Il download avviene tramite l'URL autenticato restituito dalla risposta;
la rimozione usa `DELETE` sullo stesso percorso con `/:imageId`.

Le immagini sono collegate a utente e conversazione. L'invio richiede sia
`GROQ_VISION_ENABLED=true` sia `GROQ_VISION_FREE_TIER_CONFIRMED=true`; il secondo flag è una
precondizione esplicita dell'ambiente, perché l'API non comunica in modo affidabile il piano di
billing dell'organizzazione. Il backend usa il modello configurabile `GROQ_VISION_MODEL` (default
`qwen/qwen3.6-27b`) con timeout `GROQ_VISION_TIMEOUT_MS` per produrre descrizione e tag controllati.

#### Fallback Gemini opzionale

Groq resta il provider primario. In caso di rate limit o indisponibilità transitoria è possibile
abilitare il fallback REST Gemini senza modificare le API applicative: impostare `GEMINI_ENABLED=true`,
`GEMINI_API_KEY`, `GEMINI_FREE_TIER_CONFIRMED=true` e, per le immagini, anche `GEMINI_VISION_ENABLED=true`.
Il modello è configurabile con `GEMINI_MODEL` (default `gemini-2.5-flash-lite`). L'adapter traduce
messaggi, immagini inline e `update_requirements` nel formato function calling di Gemini e riconsegna
il formato interno compatibile con Groq. Se Gemini non è configurato, il comportamento precedente resta
invariato. Il fallback non può garantire quote, latenza o disponibilità del piano gratuito Google:
queste dipendono dall'account, dal modello e dalle policy correnti; verificare sempre il piano prima di
impostare `GEMINI_FREE_TIER_CONFIRMED=true`. La chiave va mantenuta solo nell'env locale ignorato da Git.
Per il fallback secondario `GEMINI_MAX_RETRIES` vale `1` nell’esempio di configurazione; il parametro resta
configurabile per ambienti che desiderano un retry aggiuntivo.
Se una precondizione, il provider, il modello o l'output non sono disponibili, l'upload resta
valido con analisi `metadata_only`; nessuna preferenza viene inventata e l'assistente chiede una
descrizione testuale quando necessario.
La cancellazione della conversazione elimina anche i record e i file associati. L'immagine viene
inviata al provider configurato solo quando vision e free tier sono esplicitamente confermati. Sebbene Qwen
supporti richieste più grandi, l'applicazione mantiene intenzionalmente un solo file e il limite
locale di 5 MiB per richiesta.
L'analisi vision dell'upload usa un retry Groq (`GROQ_VISION_MAX_RETRIES=1` nell’esempio),
poi passa al fallback Gemini se configurato. Anche il turno chat multimodale usa un retry Groq
(`GROQ_CHAT_VISION_MAX_RETRIES=1` nell’esempio), poi passa al fallback Gemini senza trattenere il lock della conversazione.
Per includere immagini già caricate in un turno, il client invia `imageIds` insieme a `message`:
il backend verifica ownership e conversazione, quindi usa il contenuto visuale solo con vision
esplicitamente attiva; altrimenti conserva il percorso testuale e i metadati restano suggerimenti
da confermare.

## Compromessi effettuati per i vincoli di tempo

- **Media di destinazioni e attività**: il catalogo curato lato server privilegia la pertinenza
  rispetto alla copertura. Le immagini disponibili provengono da Wikimedia Commons e sono
  distribuite con CC0 1.0 o CC BY-SA 3.0, come indicato nell'attribuzione visibile. Le entità
  non catalogate e le immagini che non si caricano mantengono il layout testuale senza placeholder;
  le miniature sono richieste a 960 px e caricate con lazy loading e decoding asincrono.

- **Selezione attività**: ottimizzatore multi-giorno a beam search che valuta combinazioni
  rispettando budget, capacità, disponibilità, preferenze, varietà e assenza di sovrapposizioni.
  La ricerca resta euristica e usa il limite temporale documentato nella voce successiva.
- **Fasce orarie e solver**: `ActivityAvailability.startMinute` è inclusivo e `endMinute` è
  esclusivo, relativi alla mezzanotte UTC. Il solver può scegliere più attività nello stesso
  giorno solo quando le fasce non si sovrappongono e il costo resta nel budget; i record legacy
  senza orari valgono come giornata intera. La beam search usa un limite di **250 ms per
  selezione** (`ACTIVITY_SOLVER_TIME_LIMIT_MS`, sovrascrivibile nei test con `timeLimitMs`),
  registra il compromesso se il limite scatta e il booking usa `availabilityId` per lo slot esatto.
- **Modello dati aeroporti/destinazioni**: il dominio è normalizzato con le entità `Airport` e
  `Destination`; i voli referenziano gli aeroporti tramite chiavi esterne e la destinazione
  viene risolta dal paese/città dell'aeroporto di arrivo. I requisiti conversazionali continuano
  ad accettare codice IATA e nome del paese per mantenere un'interazione naturale.
- **Autenticazione**: access JWT breve salvato lato frontend e refresh token opaco ruotato,
  persistito solo come hash e trasmesso in cookie HttpOnly. Tutte le API `/auth/*` hanno un
  rate limit in memoria per IP; login e registrazione applicano anche un limite per account
  (email normalizzata e conservata solo come hash). I limiti si configurano con
  `AUTH_RATE_LIMIT_WINDOW_MS`, `AUTH_RATE_LIMIT_IP_MAX` e `AUTH_RATE_LIMIT_ACCOUNT_MAX`.
- **Osservabilità**: il backend raccoglie solo metriche aggregate in memoria: richieste HTTP
  (status e durata), blocchi del rate limit, chiamate/errori/durata LLM, esiti booking e hit/miss
  della cache di ricerca. `GET /api/metrics` espone lo snapshot JSON solo con `Authorization:
  Bearer <METRICS_TOKEN>`; con token vuoto l’endpoint resta disabilitato. Le label sono limitate
  a valori tecnici e non includono utenti, email, token o ID. In produzione l’exporter e il registro
  vanno sostituiti o federati verso uno store condiviso per deployment multi-replica.
- **RAG**: l'indice vettoriale va ricostruito manualmente (`buildIndex()`, richiamato nel seed)
  quando cambia il catalogo; in produzione andrebbe fatto in modo incrementale on-write.
  Il filtro `destinationId`/città viene applicato prima del ranking e del `topK`, così le
  attività nazionali più simili non eliminano quelle locali pertinenti.
- **Gestione errori LLM**: timeout di 10 secondi per tentativo e massimo due retry su errori
  transitori (rete, 408, 429, 5xx), con backoff esponenziale e jitter. Dopo tre richieste
  fallite il circuit breaker sospende le chiamate per 30 secondi e permette una sola sonda
  di recupero. I retry SDK sono disabilitati per evitare tentativi duplicati. Rimangono il
  fallback tra modelli non disponibili e quello conversazionale su `requirementsService`.
  Il circuito è in memoria per processo; timeout, retry, backoff, soglia e cooldown sono
  configurabili tramite le variabili `GROQ_TIMEOUT_MS`, `LLM_MAX_RETRIES`,
  `LLM_RETRY_BASE_DELAY_MS`, `LLM_RETRY_MAX_DELAY_MS`,
  `LLM_CIRCUIT_FAILURE_THRESHOLD` e `LLM_CIRCUIT_COOLDOWN_MS`.
- **Modifica/cancellazione booking**: una prenotazione confermata può essere cancellata con
  ripristino atomico di voli, camere e attività (`DELETE /api/bookings/:id`). La modifica usa
  un nuovo itinerario `draft` dello stesso utente (`PATCH /api/bookings/:id` con
  `newItineraryId`), libera il vecchio snapshot e prenota il nuovo nella stessa transazione.
  Prenotazioni non confermate, itinerari di altri utenti e nuovi itinerari già usati vengono
  rifiutati.
  La conferma aggiorna anche la fase della conversazione a `booking_confirmed` nella stessa
  transazione, senza sovrascrivere requisiti successivi diversi da quelli del draft.
- **Turni concorrenti chat**: i messaggi della stessa conversazione sono serializzati da un lock
  advisory distribuito PostgreSQL, mantenuto su una connessione dedicata anche durante la chiamata
  LLM e rilasciato alla chiusura della risposta. `CONVERSATION_LOCK_TIMEOUT_MS` controlla il limite
  di attesa (default 10 s); in test unitari senza DB resta disponibile il fallback in-memory.

## Cosa migliorerei con più tempo

- Solver di ottimizzazione più solido per la selezione attività (es. knapsack multi-giorno
  esatto con fasce orarie), oltre all'attuale beam search.
- Test end-to-end dell'intero percorso browser/API; la suite PostgreSQL del booking è
  disponibile separatamente e richiede Docker attivo.
- Solver esatto e gestione dei fusi orari locali; il solver attuale usa fasce espresse in minuti
  UTC e un limite di 250 ms per mantenere prevedibili i tempi.
- Logging e metriche persistenti/federate tra repliche, invece degli store attualmente locali
  al processo.

L'audit e il backlog prioritizzato dell'iterazione corrente sono in [PROJECT_STATUS.md](PROJECT_STATUS.md).
Per operatività, threat model e limiti vedere [ARCHITECTURE.md](ARCHITECTURE.md) e
[OPERATIONS.md](OPERATIONS.md).

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

### Copertura voli del seed

Il seed corrente include gli aeroporti italiani `FCO`, `MXP`, `BLQ`, `NAP`, `VCE`, `TRN` e
`BRI`, 20 destinazioni europee e 12 mesi consecutivi. Per ogni rotta sono presenti partenze
ai giorni 1, 4, 8, 11, 15, 18, 22 e 25, con ritorno a +5 notti; hotel e attività coprono tutte
le relative date.
L'API distingue aeroporto non riconosciuto, destinazione non catalogata, mese senza partenze e
ritorno incompatibile, proponendo date o mesi alternativi solo quando sono presenti nel catalogo.
