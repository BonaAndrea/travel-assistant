# Stato progetto — 9 settembre 2026

Audit del README e del codice, con modifiche locali preesistenti conservate.
Le prime due iterazioni chiudono resilienza LLM, coerenza temporale/geografica,
snapshot delle proposte, consenso esplicito e ripristino chat; restano le evoluzioni sotto.

## Distribuzione del lavoro (4 agenti incluso il coordinatore)

| Responsabile | Ambito | Risultato |
| --- | --- | --- |
| Coordinatore | Integrazione, booking, documentazione | Garanzie booking, aggiornamento atomico fase conversazione, verifica finale e backlog |
| Agente LLM/itinerari | Resilienza e vincoli | Retry/circuit breaker; ritorno esatto UTC, destinazione coerente, budget esatto; test anche su DB reale |
| Agente integrazione | Snapshot e consenso | Requisiti immutabili nel job/draft, blocco proposte obsolete, consenso esplicito, fallback provider; verifica concorrenza JSON su PostgreSQL |
| Agente audit/frontend | Ripristino e regressioni UI | Booking idempotente, dashboard ricaricabile; transcript e job recuperati dopo refresh, polling obsoleto ignorato |

## Verifica

- Baseline: 40 test in 9 suite superati.
- Dopo la seconda integrazione: `npm test -- --runInBand` da `backend`, **84 test in 14 suite superati**.
- Docker ora attivo: `npm run test:integration`, **20 test in 3 suite superati**.
  Verificati booking, vincoli itinerari e snapshot job con PostgreSQL reale. Il runner
  ha rimosso container e rete di test; il database applicativo non è stato utilizzato.
- I test frontend simulano il DOM; non sostituiscono una prova end-to-end nel browser.

## Correzioni completate nella seconda iterazione

- **B01/B02:** ritorno nel giorno UTC esatto e dallo stesso aeroporto d'arrivo;
  hotel/attività nella stessa destinazione, copertura delle notti. Convenzione mantenuta:
  `durationDays` conta i pernottamenti (5 notti = ritorno al giorno 6).
- **B03/B04:** snapshot dei requisiti alla creazione del job, invalidazione delle proposte
  dopo modifiche, HTTP 409 sui draft obsoleti; completamento job con controllo atomico
  dello stato JSON. «Non confermo» e «ok ma siamo 3» non sono consensi alla generazione.
- **B05:** test PostgreSQL eseguiti con successo.
- **B06:** transcript e job ripresi dopo refresh, stessa chiave in caso di risposta persa,
  risultati obsoleti ignorati.
- **B07:** fase `booking_confirmed` aggiornata nella transazione di booking e sulla nuova
  conversazione in caso di modifica; una raccolta con requisiti diversi non viene sovrascritta.
- **B08:** se la prima coppia non ha hotel compatibili o non rientra nel budget, il servizio
  prova una fascia hotel più economica e poi le altre coppie volo reali; ogni destinazione ha
  una sola ricerca hotel in memoria. L'alternativa espone il compromesso applicato.
- **Fallback LLM:** errore provider/circuito aperto restituisce un messaggio esplicito e
  ripetibile senza alterare i requisiti né avviare la generazione.

Le proposte precedenti senza `requirementsSnapshot` richiedono rigenerazione prima di
salvare un nuovo draft. Nessuna modifica allo schema DB in questa seconda iterazione.

## Backlog ordinato ancora aperto

P1 indica correzioni delle garanzie funzionali, P2 completamento dei flussi,
P3 evoluzioni. Gli ambiti sotto sono una proposta per il prossimo ciclo, non agenti
ancora in esecuzione. Tenere al massimo un'attività in corso per responsabile.

| ID | Priorità / ambito | Attività e criterio di accettazione |
| --- | --- | --- |
| B08 | P2 / itinerari | Completato: esplora alternative reali volo/hotel, evita ricerche hotel duplicate per destinazione e dichiara il compromesso economico. |
| B09 | P2 / frontend | Modificare una prenotazione selezionando un draft dell'utente, senza incollare manualmente un ID. |
| B10 | P2 / verifica | Test browser/API per login, raccolta, conferma, polling, prenotazione e cancellazione; provider LLM simulato per riproducibilità. |
| B11 | P3 / catalogo | Completato: codici paese ISO alpha-2, seed Spagna multi-città e test di selezione coerente per nazione/città. |
| B12 | P3 / prestazioni | Cache ricerche voli/hotel con TTL, limite memoria e invalidazione dopo booking/modifica/cancellazione; non riutilizzare disponibilità obsolete per la conferma. |
| B13 | P3 / ottimizzazione | Completato: fasce orarie nel dominio, solver multi-slot con budget/assenza sovrapposizioni, booking sullo slot e limite di 250 ms documentato. |
| B14 | P3 / retrieval | Completato: filtro destinationId/città prima del ranking e topK, con test su attività locali e indice legacy. |

Prossimo ciclo proposto: agente frontend B09; agente verifica B10; coordinatore integra e
aggiorna gli esiti. B08 e B11/B13/B14 sono stati completati nel ciclo corrente; B09/B10
restano aperti.

## Chiusura tecnica B08: alternativa economica - 9 settembre 2026

- La prima combinazione viene valutata una sola volta. Se il soggiorno non e vendibile o il
  totale supera il budget, il servizio considera prima una fascia hotel piu economica e poi
  le successive coppie di voli gia trovate dalla query, con inventario della destinazione
  memorizzato per evitare ricerche minime ripetute.
- L'output valorizza `alternative` con voli, hotel, costo totale, `withinBudget` e messaggi
  espliciti sui compromessi applicati.
- Test: unita su coppia alternativa/hotel piu economico e PostgreSQL reale su prima
  destinazione senza hotel e seconda destinazione compatibile.

## Completamento backend B11/B13/B14 — 9 settembre 2026

- B11: `Destination.countryCode` ISO alpha-2 opzionale per compatibilitÃ  con righe legacy;
  seed con Barcellona e Madrid, selezione per nome/codice nazione o cittÃ  e test PostgreSQL.
- B13: `ActivityAvailability` supporta `startMinute`/`endMinute`; il solver seleziona piÃ¹ slot
  per giorno solo se non sovrapposti e dentro il budget, con limite di 250 ms. Il booking
  riserva/rilascia `availabilityId`, mantenendo il fallback per snapshot precedenti.
- B14: il retrieval filtra per destinazione prima del ranking e di `topK`, con fallback cittÃ 
  per indici legacy; i test includono 20 risultati nazionali che non escludono l'attivitÃ  locale.
- Verifica locale: suite backend `npm test -- --runInBand`, 19 suite e 114 test superati;
  test mirati B11/B13/B14, 4 suite e 29 test superati.

## Conversazioni lazy e DELETE — 9 settembre 2026

- `POST /api/chat/conversations` restituisce un UUID transitorio senza scrivere una
  `Conversation`; il GET dello stesso UUID espone lo stato vuoto senza materializzarlo.
- Il primo `POST /api/chat/conversations/:id/messages` crea Conversation e messaggio utente
  nella stessa transazione. Lo storico filtra le righe legacy prive di messaggi.
- DELETE resta autenticato per `userId`, restituisce `204` per la conversazione proprietaria
  e rimuove messaggi/job in modo atomico preservando gli itinerari scollegati.
- Verifica: unit test backend **21 suite / 131 test**; integrazione PostgreSQL **4 suite /
  25 test**; prova API reale apertura senza invio, primo invio e DELETE superata. Dopo
  modifiche alle route è necessario riavviare o ricostruire il container backend.

## Chiusura tecnica B10 — 9 settembre 2026

- `backend/tests/integration/b10ApiJourney.test.js` verifica sull’app API reale con PostgreSQL
  e provider conversazionale deterministico: login, due turni chat, conferma, job/polling,
  proposta, due draft, booking idempotente, lista, modifica e cancellazione.
- Smoke test sul Compose applicativo: `/health` restituisce `ok`, endpoint protetto senza token
  restituisce `401`; il healthcheck PostgreSQL usa esplicitamente `travel_assistant` ed è `healthy`.
- La prova browser manuale su viewport, tastiera/focus e rendering non è stata eseguita in questa
  console; resta l’unica evidenza B10 da accettare manualmente. Non è stato usato QA Bot.

## Riferimenti per riprendere

- `backend/src/services/itineraryService.js`: ricerca combinazioni e alternativa economica.
- `backend/src/routes/itineraries.js`: validazione snapshot proposta.
- `backend/src/routes/chat.js`: riconoscimento conferma e transizioni conversazionali.
- `frontend/chat.html`: inizializzazione conversazione/job dopo refresh.
- `backend/src/services/bookingService.js`: lifecycle e fase conversazionale.

Il percorso completo nel browser e le risposte di un provider LLM reale non sono coperti
dalle verifiche automatiche svolte; B10 rimane aperto.

## Catalogo voli e diagnosi no-flight — 9 settembre 2026

- Causa individuata: il seed precedente aveva una sola finestra di 15 giorni e lasciava senza
  voli quasi tutti i mesi richiesti dal chatbot. Le query richiedono inoltre un ritorno nello
  stesso aeroporto di partenza esattamente dopo `durationDays` notti.
- Il seed ora copre 12 mesi consecutivi, 4 origini italiane (`FCO`, `MXP`, `BLQ`, `NAP`) e 6
  destinazioni (`BCN`, `MAD`, `LIS`, `CDG`, `ATH`, `PRG`), con andata/ritorno a +5 notti e
  inventari hotel/attività per le date coperte.
- La ricerca distingue `unknown_origin_airport`, `unknown_destination`, `no_outbound` e
  `no_return`; gli ultimi due errori includono alternative realmente presenti nel catalogo.
  Le chiavi cache includono rotta, destinazione, date e partecipanti; il seed invalida la cache
  prima e dopo la ricostruzione dell’indice.
- Evidenza: test unit mirati seed/query **20/20**; integrazione PostgreSQL **5 suite / 27 test**;
  `node --check src/db/seed.js` superato. La rigenerazione del seed sul DB applicativo non è stata
  eseguita per non cancellare dati runtime; va eseguita esplicitamente in fase di deploy/demo.

## Upload immagini preferenze utente — 9 settembre 2026

- Endpoint autenticati: `POST /api/chat/conversations/:conversationId/preferences/images`,
  `GET .../:imageId/content` e `DELETE .../:imageId`.
- Accetta un solo file multipart `image`, JPEG/PNG/WebP fino a 5 MiB. Il backend verifica MIME
  e magic bytes, usa un nome UUID, permessi file restrittivi e storage privato configurabile con
  `USER_PREFERENCE_IMAGE_DIR`; i file non sono esposti da Express come statici.
- `PreferenceImage` collega utente, conversazione, hash SHA-256 e metadati. I metadati entrano nel
  contesto chat/RAG; con vision abilitata si aggiungono descrizione e tag come segnali non
  confermati, mai come requisiti automatici. Cancellazione immagine e conversazione rimuovono
  anche il file associato.
- Test dedicati coprono MIME/magic bytes, limite 5 MiB, isolamento per utente, download/rimozione
  e passaggio dei metadati al contesto conversazionale.

## Analisi vision immagini — 9 settembre 2026

- Verifica reale dell'account Groq: `GROQ_MODEL=openai/gpt-oss-20b` è disponibile ma testuale;
  risultano disponibili per vision `qwen/qwen3.6-27b` e `qwen/qwen3.8-27b`. Il primo è il default
  di `GROQ_VISION_MODEL`.
- L'analisi è opt-in con `GROQ_VISION_ENABLED=true` e `GROQ_VISION_FREE_TIER_CONFIRMED=true`;
  il secondo flag impedisce invii se l'ambiente non ha esplicitamente confermato il piano gratuito,
  dato che l'API non espone in modo affidabile il piano di billing. Usa `chat.completions` con
  immagine base64, JSON mode, timeout dedicato e retry/circuito esistenti. Output non valido,
  provider irraggiungibile o modello non disponibile lasciano l'upload riuscito in `metadata_only`.
- I tag e la descrizione sono segnali non confermati inseriti nel contesto chat, non requisiti
  utente automatici. Le immagini vengono inviate a Groq solo con vision esplicitamente abilitata.
- Test aggiunti per modello, JSON strutturato, filtraggio tag, errori/fallback, upload API e
  integrazione PostgreSQL. Restano da gestire in deployment consenso/privacy, costi e storage
  persistente; il modello vision è preview e può cambiare disponibilità.

## Diagnosi runtime Groq — 9 settembre 2026

- Nel container applicativo `GROQ_API_KEY` è presente senza essere esposta nei log,
  `GROQ_MODEL=openai/gpt-oss-20b` è restituito dall'endpoint modelli Groq e una chiamata SDK
  reale, seguita da una `chatTurn` reale, è riuscita. Il seed non modifica la configurazione LLM.
- L'incidente osservato era una sequenza di errori transitori che ha aperto il circuit breaker
  in memoria; dopo il cooldown di 30 secondi è stata completata una chiamata API reale 201/201/200
  (registrazione, conversazione, primo messaggio) con `retryable=false`. Il backend è stato
  riavviato senza ricreare database o rieseguire il seed.
- `llmResilience` ora registra status HTTP, codice/tipo e messaggio troncato e sanificato per
  retry, apertura circuito e fallback; bearer token e chiavi `gsk_` vengono oscurati. Sono stati
  aggiunti test di redazione. Il circuito resta attivo: non viene disattivato silenziosamente.
