# Report completo di conformità alla `Richiesta`

Data report: 15 settembre 2026  
Progetto: Travel Assistant

Questo documento confronta il brief originale `Richiesta` con l'implementazione presente nel repository. Il file `Richiesta` è riservato e non viene modificato né incluso nei commit.

Legenda:

- **Implementato**: requisito coperto dal codice e/o da test mirati.
- **Implementato con limite dichiarato**: comportamento presente, ma volutamente demo o con una limitazione documentata.
- **Parziale / da completare**: esiste una base, ma manca una garanzia o una copertura richiesta.
- **Opzionale**: non blocca la conformità al nucleo obbligatorio.

## 1. Obiettivo

> “Sviluppare un assistente virtuale conversazionale per il settore travel & experiences, in grado di comprendere le esigenze dell’utente e generare itinerari personalizzati completi, fino alla prenotazione.”

**Stato: implementato.**

L’applicazione realizza il flusso completo:

1. autenticazione;
2. raccolta requisiti in chat;
3. riepilogo e conferma;
4. generazione asincrona di voli, hotel e attività;
5. scelta della proposta;
6. prenotazione transazionale;
7. dashboard e storico.

Punti principali:

- `backend/src/routes/chat.js`
- `backend/src/services/requirementsService.js`
- `backend/src/services/itineraryService.js`
- `backend/src/services/bookingService.js`
- `frontend/chat.html`
- `frontend/dashboard.html`

## 2. Input utente

> “L’assistente deve raccogliere e gestire i seguenti dati:”

> “Budget totale”  
> “Nazione di interesse”  
> “Aeroporto o città di partenza”  
> “Preferenze sulle attività (es. cultura, sport, relax, nightlife, ecc.)”  
> “Periodo di viaggio (espresso come mese)”  
> “Durata indicativa del viaggio e numero di partecipanti”

**Stato: implementato.**

I requisiti vengono estratti e persistiti come stato della conversazione. Sono gestiti budget, destinazione, aeroporto/città di partenza, preferenze, mese/date, durata e partecipanti.

Punti principali:

- `backend/src/services/requirementsService.js`
  - normalizzazione e validazione dei requisiti;
  - riconoscimento di mesi italiani e inglesi;
  - riconoscimento di date e intervalli;
  - calcolo deterministico della durata quando sono indicate due date.
- `backend/src/routes/chat.js`
  - aggiornamento dello snapshot dei requisiti;
  - mantenimento del contesto multi-turno.
- `backend/src/services/locationNormalization.js`
  - risoluzione di città, nazioni, codici ISO, aeroporti e codici IATA.

Esempio di comportamento deterministico: `22 novembre - 6 dicembre 2026` produce partenza 22/11, ritorno 06/12 e durata di 14 giorni, indipendentemente da un’eventuale interpretazione incoerente del modello.

> “Le informazioni possono essere fornite anche in momenti diversi della conversazione. In presenza di dati mancanti, ambigui o incompatibili tra loro, l’assistente deve richiedere chiarimenti all’utente.”

**Stato: implementato.**

La macchina a stati della conversazione conserva i requisiti raccolti e identifica i campi mancanti o incoerenti. Le correzioni non sostituiscono gli altri dati già acquisiti.

Punti principali:

- `backend/src/routes/chat.js`
- `backend/src/services/requirementsService.js`
- `backend/prisma/schema.prisma` — conversazioni, messaggi e snapshot.

## 3. Funzionalità principali — Conversazione intelligente

> “Interazione via chat in linguaggio naturale”

**Stato: implementato.**

La chat frontend invia messaggi al backend; il backend orchestra il modello linguistico, il parser deterministico e gli aggiornamenti di stato.

Punti principali:

- `frontend/chat.html`
- `frontend/api.js`
- `backend/src/routes/chat.js`
- `backend/src/services/llmService.js`
- `backend/src/services/geminiService.js` — fallback opzionale.

> “Comprensione del contesto e delle richieste utente”

**Stato: implementato.**

La cronologia viene persistita e ripassata al servizio conversazionale. Le informazioni già raccolte vengono inoltre mantenute in uno snapshot strutturato, senza affidarsi soltanto alla memoria del modello.

> “Gestione di conversazioni multi-turno, mantenendo lo stato e consentendo all’utente di modificare i requisiti già comunicati”

**Stato: implementato.**

Il tool `update_requirements` aggiorna i requisiti, mentre le guardie deterministiche gestiscono casi sensibili come:

- cambio della data di ritorno;
- ricalcolo della durata;
- mesi italiani;
- intervalli di date;
- destinazioni non presenti nel catalogo;
- modifica dopo un errore di generazione.

Punti principali:

- `backend/src/routes/chat.js`
- `backend/src/services/requirementsService.js`
- `backend/src/services/conversationService.js`
- `frontend/chat.html` — aggiornamento della UI e scarto dei risultati obsoleti.

## 4. Funzionalità principali — Raccolta requisiti

> “Estrazione e validazione dei dati utente (budget, destinazione, partenza, attività, periodo, durata e partecipanti)”

**Stato: implementato.**

La validazione è divisa tra normalizzazione del testo, risoluzione del catalogo e controlli di coerenza.

Punti principali:

- `backend/src/services/requirementsService.js`
- `backend/src/services/locationNormalization.js`
- `backend/src/routes/chat.js`

> “Gestione dei dati mancanti o non validi tramite domande di chiarimento”

**Stato: implementato.**

La route non avvia la generazione se mancano requisiti obbligatori, se la destinazione non è risolvibile o se le date sono incoerenti. Restituisce una risposta strutturata e mantiene la conversazione nella fase corretta.

> “Conferma riepilogativa dei requisiti prima della generazione dell’itinerario”

**Stato: implementato.**

Quando i requisiti sono completi, il backend produce un riepilogo deterministico e richiede conferma esplicita. La conferma finale restituisce `generationReady: true` e un’azione successiva esplicita per creare il job.

Punti principali:

- `backend/src/routes/chat.js`
- `backend/src/routes/itineraryJobs.js`
- `frontend/chat.html`

## 5. Funzionalità principali — Generazione itinerario

> “Creazione di un itinerario completo che includa:”

> “Volo di andata e ritorno”

**Stato: implementato con catalogo demo.**

`itineraryService` ricerca una tratta di andata e una di ritorno compatibili con origine, destinazione, date/mese e durata.

Punto principale:

- `backend/src/services/itineraryService.js`

> “Albergo per ogni notte”

**Stato: implementato.**

La generazione richiede disponibilità alberghiera per tutte le notti dell’intervallo. Se una notte non è coperta, la proposta non viene considerata completa.

> “Attività per ogni giorno”

**Stato: implementato dopo hardening.**

La proposta espone:

- `coveredDays`;
- `uncoveredDays`;
- `activityCoverage.complete`.

Una proposta con giornate scoperte assume lo stato `activity_coverage_incomplete` e non è prenotabile come proposta completa. Se non esiste una soluzione completa, il sistema restituisce un errore esplicito con le giornate mancanti.

Punto principale:

- `backend/src/services/itineraryService.js`

> “Rispetto dei vincoli di: Budget, Disponibilità, Preferenze utente, Coerenza temporale tra voli, pernottamenti e attività”

**Stato: implementato.**

Il solver combina:

- disponibilità dei voli;
- disponibilità delle camere;
- capacità delle attività;
- budget e costo totale;
- preferenze;
- date di partenza e ritorno;
- assenza di sovrapposizioni tra attività;
- copertura giornaliera.

Punti principali:

- `backend/src/services/itineraryService.js`
- `backend/src/services/activitySolver.js`
- `backend/src/services/requirementsService.js`

Il breakdown deterministico espone costi di voli, hotel, attività, totale, budget e `budgetDelta`.

> “Presentazione di almeno una possibile alternativa quando non è possibile rispettare tutti i vincoli, indicando chiaramente quali compromessi sono stati applicati”

**Stato: implementato.**

Gli errori funzionali come `no_return`, budget insufficiente o copertura attività incompleta espongono il motivo e le alternative catalogate. La UI distingue l’errore funzionale dal cooldown del provider e mostra i compromessi in modo leggibile.

Punti principali:

- `backend/src/services/itineraryService.js`
- `backend/src/services/itineraryJobService.js`
- `backend/src/routes/itineraryJobs.js`
- `frontend/chat.html`

> “Indicazione del costo totale e della relativa suddivisione tra voli, albergo e attività”

**Stato: implementato.**

Il breakdown è presente nello snapshot dell’itinerario e viene mostrato nella proposta e nella dashboard.

## 6. Funzionalità principali — Prenotazione

> “Possibilità di prenotare l’intero itinerario tramite chat”

**Stato: implementato.**

La proposta selezionata viene confermata tramite il flusso chat e trasformata in prenotazione tramite API REST.

Punti principali:

- `frontend/chat.html`
- `backend/src/routes/bookings.js`
- `backend/src/services/bookingService.js`

> “Richiesta di conferma esplicita prima della prenotazione”

**Stato: implementato.**

La conferma dell’itinerario e la conferma del booking sono due passaggi distinti. Il backend non considera sufficiente un messaggio generico di preparazione.

> “Verifica finale della disponibilità e del prezzo prima della conferma”

**Stato: implementato.**

Durante la transazione il servizio:

1. rilegge le disponibilità correnti;
2. confronta i prezzi correnti con quelli dello snapshot;
3. restituisce `PRICE_CHANGED` con HTTP 409 se un prezzo è cambiato;
4. annulla la transazione in caso di differenza.

Punto principale:

- `backend/src/services/bookingService.js`, `assertCurrentPrices`.

> “Salvataggio dello stato delle prenotazioni”

**Stato: implementato.**

Le prenotazioni vengono salvate con utente, itinerario, stato, chiave di idempotenza e data di creazione.

Punti principali:

- `backend/prisma/schema.prisma`
- `backend/src/routes/bookings.js`
- `backend/src/services/bookingService.js`

> “Gestione coerente di eventuali prenotazioni parzialmente fallite, evitando che l’utente visualizzi come confermato un itinerario incompleto”

**Stato: implementato.**

La prenotazione usa una transazione. Se una risorsa fallisce:

- il booking diventa `failed`;
- l’itinerario non diventa `confirmed`;
- le risorse già aggiornate vengono ripristinate tramite rollback;
- la UI non mostra un successo parziale.

Punto principale:

- `backend/src/services/bookingService.js`, `confirmBooking`.

> “Prevenzione di prenotazioni duplicate in caso di invio ripetuto della stessa richiesta”

**Stato: implementato.**

Il modello contiene una chiave univoca:

```prisma
idempotencyKey String @unique
```

La conferma prima cerca una prenotazione con la stessa chiave e gestisce anche la race condition sul vincolo univoco del database.

Punti principali:

- `backend/prisma/schema.prisma`
- `backend/src/services/bookingService.js`

## 7. Architettura — Database principale

> “Deve contenere almeno le seguenti entità/tabelle:”

> “Utenti”

**Stato: implementato.** `User` in `backend/prisma/schema.prisma`.

> “Alberghi (date disponibili e costo per notte)”

**Stato: implementato.** Modelli hotel e disponibilità con date, camere e prezzi.

> “Attività (date disponibili, capacità e costo)” 

**Stato: implementato.** Modelli attività e disponibilità con data/fascia, capacità e costo.

> “Voli (aeroporto di partenza e arrivo, date, posti disponibili e costo)”

**Stato: implementato.** Modelli voli, aeroporti e disponibilità.

> “Itinerari (componenti selezionati, costo totale e stato)”

**Stato: implementato.** Itinerario con componenti/snapshot, breakdown, totale e stato del ciclo di vita.

> “Prenotazioni (utente, itinerario, stato e data di creazione)”

**Stato: implementato.** Modello `Booking` con relazioni, stato, timestamp e idempotenza.

> “Conversazioni o sessioni, qualora necessarie per la soluzione adottata”

**Stato: implementato.** Conversazioni e messaggi persistiti con stato e snapshot requisiti.

Schema e migrazioni:

- `backend/prisma/schema.prisma`
- `backend/prisma/migrations/`

> “Il sistema deve gestire correttamente l’aggiornamento delle disponibilità, considerando anche il caso in cui due utenti tentino di prenotare contemporaneamente la stessa risorsa.”

**Stato: implementato.**

La conferma utilizza una transazione Prisma, aggiornamenti condizionati e advisory lock PostgreSQL. Esempio per attività:

```sql
UPDATE "ActivityAvailability"
SET booked = booked + participants
WHERE id = activityId
  AND booked + participants <= capacity;
```

Se l’aggiornamento condizionato non modifica una riga, la risorsa non è disponibile e la transazione fallisce. Il lock transazionale serializza inoltre il controllo delle date sovrapposte tra prenotazioni concorrenti.

Punto principale:

- `backend/src/services/bookingService.js`

Test principali:

- `backend/tests/integration/bookingService.test.js`
- test di due conferme concorrenti sull’ultima disponibilità;
- test di due utenti con date sovrapposte;
- test di rollback;
- test di cancellazioni concorrenti.

## 8. Architettura — Database vettoriale

> “Utilizzato per supportare un approccio RAG.”

**Stato: implementato con soluzione locale semplice.**

Il progetto usa un indice vettoriale JSON separato da PostgreSQL, con embeddings locali. PostgreSQL rimane autorevole per disponibilità e consistenza transazionale.

Punti principali:

- `backend/src/services/vectorStore.js`
- indice RAG sotto `backend/data/`.

> “Descrizioni testuali delle attività”

**Stato: implementato.** Presenti nei documenti indicizzati.

> “Informazioni sui target ideali (es. famiglie, giovani, sportivi)”

**Stato: implementato.** I documenti contengono caratteristiche e target utili al ranking.

> “Eventuali caratteristiche delle strutture ricettive o delle destinazioni”

**Stato: implementato.** Le informazioni di destinazioni e strutture sono indicizzate separatamente dal catalogo relazionale.

> “Il recupero delle informazioni deve contribuire concretamente alla selezione o alla motivazione delle attività proposte.”

**Stato: implementato.**

Il retrieval viene filtrato per destinazione, ordinato semanticamente e il `matchScore` viene propagato alle attività selezionate. I test di `vectorStore` e `itineraryService` verificano l’influenza del retrieval.

## 9. Architettura — Backend

> “Tecnologie suggerite: A scelta (Node.js, Django, Flask, Ruby on Rails)”

**Stato: implementato.** È stato scelto Node.js con Express e Prisma.

> “Esposizione di API REST”

**Stato: implementato.** Endpoint sotto `/api`, organizzati per autenticazione, chat, itinerari, job, booking, immagini e condivisione.

Punti principali:

- `backend/src/server.js`
- `backend/src/routes/`
- `backend/openapi.yaml`.

> “Implementazione delle logiche di business”

**Stato: implementato.** Le logiche sono separate in servizi dedicati:

- `requirementsService.js`;
- `itineraryService.js`;
- `bookingService.js`;
- `activitySolver.js`;
- `vectorStore.js`;
- `itineraryJobService.js`.

> “Gestione dell’autenticazione e delle autorizzazioni”

**Stato: implementato.** JWT, refresh token opaco hashato, bcrypt, cookie HttpOnly e controlli di ownership.

Punti principali:

- `backend/src/routes/auth.js`
- `backend/src/middleware/auth.js`
- `backend/src/middleware/ownership.js`.

> “Validazione degli input e gestione strutturata degli errori”

**Stato: implementato.** Validazione Zod, errori con codice/status/messaggio e gestione distinta di errori funzionali, provider, conflitti e disponibilità.

Punti principali:

- `backend/src/schemas/`
- `backend/src/middleware/errorHandler.js`
- route e servizi di dominio.

> “Orchestrazione delle chiamate al modello linguistico e al database vettoriale”

**Stato: implementato.** Il backend coordina LLM primario Groq, fallback Gemini opzionale, parser strutturato e retrieval locale.

Punti principali:

- `backend/src/services/llmService.js`
- `backend/src/services/geminiService.js`
- `backend/src/services/vectorStore.js`
- `backend/src/routes/chat.js`.

> “Garanzia di consistenza durante il processo di prenotazione”

**Stato: implementato.** Transazioni, lock, aggiornamenti condizionati, rollback, controllo overlap, controllo prezzi e idempotenza sono in `bookingService.js`.

> “Logging essenziale delle operazioni rilevanti, evitando di registrare dati sensibili”

**Stato: implementato.** I log usano request ID, metodo, status e campi tecnici whitelistati; non registrano prompt, token, chiavi API o immagini private.

Punti principali:

- middleware di logging in `backend/src/`
- configurazione osservabilità/metriche.

> “Documentazione delle API, anche tramite una specifica OpenAPI/Swagger o una collection equivalente”

**Stato: implementato.** Specifica in `backend/openapi.yaml`, inclusi endpoint di condivisione:

- `GET /share/itineraries/{itineraryId}`;
- `GET /share/public/{token}`.

La struttura YAML è stata verificata manualmente; nel progetto non è presente un validator automatico OpenAPI dedicato.

## 10. Architettura — Frontend

> “Registrazione e autenticazione utente”

**Stato: implementato.** `frontend/index.html`, `frontend/api.js`.

> “Interfaccia chat con assistente”

**Stato: implementato.** `frontend/chat.html`, inclusi stati di caricamento, allegati, conferma e nuova chat.

> “Visualizzazione degli itinerari proposti, dei costi e degli eventuali compromessi applicati”

**Stato: implementato.** La UI mostra proposta, breakdown, alternative, motivazione dei compromessi, copertura attività e messaggi di errore.

> “Prenotazione tramite chat”

**Stato: implementato.** Il flusso parte dalla chat e conduce alla conferma del booking.

> “Dashboard con visualizzazione delle prenotazioni effettuate e del relativo stato”

**Stato: implementato.** `frontend/dashboard.html` e `frontend/history.html` mostrano prenotazioni, dettagli, stato, modifica, cancellazione e condivisione.

> “Gestione chiara degli stati di caricamento e degli errori principali”

**Stato: implementato.** Sono distinti:

- caricamento job;
- errore funzionale;
- provider rate-limited;
- timeout;
- conflitto date;
- prezzo cambiato;
- upload fallito;
- disponibilità esaurita.

## 11. Qualità e verifica — opzionale

> “È consigliato sviluppare un set essenziale di test automatici relativo almeno alle logiche di business più importanti”

**Stato: implementato.** Sono presenti test per:

> “Validazione dei requisiti”

**Stato: implementato.** Test in `backend/tests/requirementsService.test.js` e test chat.

> “Calcolo del costo totale”

**Stato: implementato.** Test in `backend/tests/itineraryService.test.js`.

> “Rispetto del budget”

**Stato: implementato.** Test di vincolo e breakdown in `itineraryService`.

> “Verifica delle disponibilità”

**Stato: implementato.** Test di voli, hotel, attività, capacità e concorrenza in `backend/tests/integration/bookingService.test.js`.

> “Conferma e salvataggio della prenotazione”

**Stato: implementato.** Test di conferma, rollback, idempotenza, cancellazione e modifica.

La suite backend principale è ampia; la suite d’integrazione richiede PostgreSQL/Docker attivi. Alcuni test frontend storici dipendono da fixture DOM/VM e non rappresentano un fallimento del percorso browser reale: vanno comunque distinti e, idealmente, ripuliti prima della consegna finale.

## 12. Altre funzionalità opzionali

> “Upload di immagini da parte dell’utente per indicare preferenze su attività o strutture”

**Stato: implementato.**

- upload privato JPEG/PNG/WebP;
- massimo 5 MiB per immagine;
- controllo MIME e magic bytes;
- associazione a utente e conversazione;
- analisi vision opzionale;
- fallback `metadata_only` se vision non disponibile.

Punti principali:

- `backend/src/routes/preferences.js`
- `backend/src/services/visionService.js`
- `frontend/chat.html`.

> “Modifica o cancellazione di itinerari già prenotati, con verifica delle disponibilità e gestione delle conseguenze”

**Stato: implementato come extra.**

La cancellazione rilascia le disponibilità in modo condizionato. La modifica esegue rilascio e nuova prenotazione nella stessa transazione, con rollback in caso di errore.

Punto principale:

- `backend/src/services/bookingService.js`.

> “Storico delle conversazioni utente”

**Stato: implementato.**

- `frontend/history.html`;
- API conversazioni;
- transcript persistito;
- ripresa dopo refresh.

> “Sistema di caching per le ricerche più frequenti”

**Stato: implementato come extra tecnico.** È presente una cache locale/process-local per ricerche e dati derivati. In produzione distribuita servirebbe uno store condiviso.

> “Esecuzione asincrona delle operazioni più lente”

**Stato: implementato.** La generazione itinerario usa job asincroni, polling, stato persistito e recupero dopo refresh.

Punti principali:

- `backend/src/routes/itineraryJobs.js`
- `backend/src/services/itineraryJobService.js`
- `frontend/chat.html`.

> “Metriche essenziali sull’utilizzo o sulle prestazioni del sistema”

**Stato: implementato come extra.** Sono presenti metriche aggregate e logging tecnico senza contenuti sensibili.

> “Altre funzionalità a discrezione dello sviluppatore, potenzialmente rilevanti per lo use case”

**Stato: implementato come extra dimostrativo.** Sono presenti:

- fallback Gemini;
- condivisione pubblica di itinerari;
- esportazione PDF/ICS tramite browser;
- voto locale sulle attività;
- dettatura vocale tramite Web Speech API;
- toggle unico per le funzionalità extra.

I pulsanti social sono mockup e i voti sono locali al dispositivo: non sono integrazioni social reali né aggregazione server-side.

## 13. Deliverable

> “La repo deve contenere: Codice sorgente”

**Stato: implementato.** Frontend, backend, schema, migrazioni, test e dati demo sono nel repository.

> “Istruzioni per l’esecuzione (README)” 

**Stato: implementato.** `README.md` contiene setup, variabili ambiente, Docker, migrazioni, seed e avvio.

> “Eventuali note architetturali”

**Stato: implementato.** Presenti `ARCHITECTURE.md`, `OPERATIONS.md` e documentazione in `docs/`.

> “Indicazione delle principali scelte tecniche, dei compromessi effettuati e degli aspetti che verrebbero migliorati disponendo di più tempo”

**Stato: implementato.** Documentati catalogo demo, provider gratuiti, RAG locale, limiti process-local e assenza di provider booking reali.

> “Dati di esempio o procedura di inizializzazione necessaria per provare l’applicazione”

**Stato: implementato.** Seed e migrazioni Prisma sono documentati nel README e nei file backend.

> “Istruzioni per l’esecuzione dei test”

**Stato: implementato.** Comandi e prerequisiti sono documentati in README e `docs/guida-consegna.md`.

> “È gradita, ma non obbligatoria, una modalità di esecuzione tramite Docker o uno strumento equivalente.”

**Stato: implementato.** Il progetto include `docker-compose.yml` per PostgreSQL, backend e frontend.

## 14. Limiti da dichiarare durante la consegna

Questi non contraddicono il nucleo della challenge, ma vanno esposti con trasparenza:

- il catalogo di voli, hotel e attività è locale/demo;
- non ci sono integrazioni con GDS, OTA o pagamenti reali;
- cache, job, rate limit e metriche sono principalmente process-local;
- il free tier LLM può produrre rate limit, timeout o indisponibilità indipendenti dal codice;
- la vision è opzionale e dipende da flag e quota del provider;
- i social e i voti sono dimostrativi;
- la validazione OpenAPI è stata controllata manualmente perché manca un validator dedicato;
- l’integrazione end-to-end con provider LLM reali non è completamente automatizzabile in locale;
- i test d’integrazione richiedono Docker/PostgreSQL attivi.

## 15. Valutazione complessiva

Il nucleo obbligatorio della `Richiesta` è implementato: conversazione multi-turno, raccolta e modifica requisiti, generazione con vincoli, alternative, costi, prenotazione esplicita, disponibilità concorrente, rollback, idempotenza, autenticazione, RAG, API REST, dashboard e documentazione.

La parte più delicata — consistenza del booking — è coperta con:

```js
await prisma.$transaction(async (tx) => {
  // lock transazionale
  // controllo overlap
  // verifica prezzi correnti
  // riserva condizionata delle risorse
  // conferma atomica
});
```

Il progetto è quindi adatto alla consegna come challenge tecnica. Le limitazioni rimanenti riguardano soprattutto il carattere dimostrativo del catalogo/provider e la validazione automatica completa del frontend, non l’assenza del flusso funzionale richiesto.

