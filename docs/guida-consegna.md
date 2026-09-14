# Guida di consegna — Travel Assistant

## 1. Scopo e copertura della challenge

Travel Assistant è un assistente conversazionale che raccoglie requisiti di viaggio in più turni, genera una proposta completa (voli, hotel e attività), presenta un'alternativa quando applica compromessi e consente la prenotazione con conferma esplicita. Il progetto copre inoltre autenticazione, storico conversazioni, dashboard prenotazioni, immagini di preferenza, resilienza dei provider LLM e alcune funzioni Extra/social.

Rispetto al brief `Richiesta`, le funzionalità principali risultano implementate. I gap reali e i limiti sono riepilogati nella sezione 12; le funzioni social e alcuni aspetti production-grade sono volutamente dimostrativi o fuori scope.

## 2. Architettura

### Componenti

- **Frontend:** HTML, CSS e JavaScript vanilla, serviti da Nginx in Docker. Comprende login/registrazione, chat, storico, dashboard e pagina pubblica di condivisione.
- **Backend:** Node.js + Express, API REST sotto `/api`, validazione Zod, autenticazione JWT e Prisma ORM.
- **Database autorevole:** PostgreSQL per utenti, catalogo e disponibilità di voli/hotel/attività, conversazioni, itinerari, job e prenotazioni.
- **RAG:** indice vettoriale JSON locale, separato da PostgreSQL, con embeddings `all-MiniLM-L6-v2` tramite `@xenova/transformers`. Contribuisce al ranking/motivazione di attività e strutture, ma non decide disponibilità o consistenza transazionale.
- **LLM:** Groq è il provider primario per chat ed estrazione strutturata dei requisiti; Gemini può essere attivato come fallback opzionale.
- **Storage immagini private:** filesystem persistente, fuori dalla directory pubblica, con metadati in PostgreSQL.

### Principi di consistenza e sicurezza

- Il booking usa una transazione Prisma e decrementi condizionati/atomici delle disponibilità. Se un componente fallisce, non viene mostrato un itinerario parzialmente confermato.
- Una `idempotencyKey` univoca impedisce prenotazioni duplicate in caso di retry.
- I turni chat concorrenti sono serializzati con advisory lock PostgreSQL.
- Password con bcrypt, access token breve, refresh token opaco hashato e ruotato, cookie HttpOnly e controlli di ownership sulle risorse.
- Upload limitati a JPEG/PNG/WebP, massimo 5 MiB, con verifica MIME e magic bytes.
- Logging e metriche usano campi tecnici whitelistati e non includono prompt, token o dati personali.
- La specifica delle API è disponibile in `backend/openapi.yaml`.

## 3. Setup Docker

### Prerequisiti

- Docker Desktop/Engine con Docker Compose.
- Una chiave Groq gratuita per il percorso conversazionale completo.

### Avvio

```bash
cp backend/.env.example backend/.env
```

Nel file `backend/.env` impostare almeno `GROQ_API_KEY` e sostituire il valore demo di `JWT_SECRET` con una stringa lunga. Quindi:

```bash
docker compose up -d postgres
docker compose run --rm backend npm run prisma:migrate:deploy
docker compose up -d backend frontend
docker compose exec backend npm run seed
```

Aprire `http://localhost:8080`. Il backend risponde su `http://localhost:4000`.

Il seed è **distruttivo** per i dati applicativi del database configurato: usarlo solo sul database demo. Ricrea catalogo e disponibilità deterministiche, conversazioni/itinerari/booking e indice RAG. Dopo un nuovo seed è consigliato riavviare il backend per svuotare la cache in memoria.

Servizi Compose:

- `postgres`: PostgreSQL 16 con volume persistente `pgdata`;
- `backend`: Express/Prisma, porta 4000, volume persistente per upload privati;
- `frontend`: Nginx, porta 8080, frontend montato in sola lettura.

## 4. Flusso chat

1. L'utente si registra o accede.
2. La chat crea una conversazione solo al primo messaggio utile; aprire la pagina senza scrivere non genera storico vuoto.
3. Il modello estrae progressivamente budget, paese/città, aeroporto o città di partenza, preferenze, mese/date, durata e partecipanti.
4. Il backend normalizza aeroporti e destinazioni (IATA, città, nome, accenti e maiuscole), valida i valori e mantiene uno snapshot persistito dei requisiti.
5. Se mancano dati o esistono ambiguità/incompatibilità, l'assistente chiede chiarimenti. I requisiti già dati possono essere modificati in turni successivi.
6. Prima della generazione viene mostrato un riepilogo e richiesta una conferma esplicita.
7. La generazione parte come job asincrono; il frontend esegue polling, mostra avanzamento/errori e può recuperare job e transcript dopo refresh.
8. Se i requisiti cambiano, risultati e polling obsoleti vengono scartati.

## 5. Generazione degli itinerari

La generazione combina dati transazionali e retrieval semantico:

- seleziona andata e ritorno coerenti con origine, destinazione, mese/date e durata;
- richiede un hotel disponibile per tutte le notti;
- seleziona attività per giorno e fascia oraria, senza sovrapposizioni e con varietà rispetto alle preferenze;
- filtra il retrieval per destinazione prima del ranking vettoriale;
- calcola il costo totale e il dettaglio voli/hotel/attività;
- salva snapshot immutabili dei requisiti e della proposta associati al job/draft.

La proposta principale privilegia il rispetto dei vincoli. Quando non è possibile, il sistema produce un'alternativa più economica o esplicita i compromessi, per esempio attività mancanti in alcuni giorni o budget superato. Il solver delle attività ha un limite temporale configurabile (default 250 ms) e segnala il compromesso se interrompe la ricerca.

Il catalogo seed copre FCO, MXP, BLQ e NAP verso Barcellona, Madrid, Lisbona, Parigi, Atene e Praga, su 12 mesi, con partenze ai giorni 1/8/15/22 e ritorno a +5 notti.

## 6. Booking

La prenotazione avviene dalla proposta selezionata e richiede una conferma esplicita che riepiloga destinazione, costo e verifica finale.

Durante la conferma il backend:

- rilegge prezzo e disponibilità;
- riserva voli, camere e slot attività nella stessa transazione;
- esegue rollback completo in caso di conflitto;
- salva lo stato `confirmed` o `failed` senza esporre successi parziali;
- aggiorna la fase conversazionale a `booking_confirmed`;
- riutilizza la stessa prenotazione quando riceve la stessa `idempotencyKey`.

Una prenotazione confermata può essere cancellata con ripristino atomico delle disponibilità. La modifica sostituisce l'itinerario con un nuovo draft dello stesso utente, effettuando rilascio e nuova prenotazione in modo coerente.

## 7. Dashboard e storico

- **Dashboard prenotazioni:** lista delle prenotazioni dell'utente, stato, dettaglio itinerario, costi, immagini e azioni modifica/cancella.
- **Storico conversazioni:** elenco list-first, apertura del transcript, ripresa della conversazione ed eliminazione.
- **Recupero:** transcript, proposta autorevole e job persistito vengono ripristinati dopo refresh; risposte tardive di polling precedenti non devono sovrascrivere lo stato corrente.
- **Responsive/accessibilità:** layout desktop e drawer mobile, target interattivi, gestione focus/ESC, status live e messaggi di errore/riprova.

## 8. Immagini e vision

Il progetto gestisce due categorie distinte:

1. **Immagini editoriali** di destinazioni/attività, selezionate da Wikimedia Commons con autore e licenza visualizzati. Il catalogo ha fallback quando un asset non è disponibile.
2. **Immagini private di preferenza**, caricate dalla graffetta nella chat. Sono associate all'utente e alla conversazione, non pubbliche, eliminabili e persistite nel volume dedicato.

L'analisi vision è opt-in. Per Groq richiede:

```env
GROQ_VISION_ENABLED=true
GROQ_VISION_FREE_TIER_CONFIRMED=true
```

Il modello è configurabile; il default è `qwen/qwen3.6-27b`. L'output produce descrizione e tag controllati. Questi segnali non diventano automaticamente requisiti: devono essere confermati dall'utente. Se l'analisi non è abilitata o fallisce, l'upload resta valido in modalità `metadata_only`.

## 9. Fallback Gemini

Gemini è disabilitato per default. Per abilitarlo:

```env
GEMINI_ENABLED=true
GEMINI_API_KEY=...
GEMINI_FREE_TIER_CONFIRMED=true
GEMINI_VISION_ENABLED=true
```

`GEMINI_VISION_ENABLED` serve solo per il fallback vision. Il modello predefinito è `gemini-2.5-flash-lite`; timeout e retry sono configurabili. L'adapter traduce messaggi, immagini e function calling nel contratto interno già usato da Groq.

Il flusso tenta prima Groq con timeout, retry/backoff, fallback di modello e circuit breaker; passa poi a Gemini se configurato. Se nessun provider è utilizzabile, mantiene i requisiti già estratti e restituisce un messaggio italiano di errore recuperabile. Quote, latenza e disponibilità dei piani gratuiti non sono garantite dall'applicazione.

## 10. Funzioni Extra e social

Un interruttore **Extra** salva la preferenza nel browser e abilita:

- dettatura tramite Web Speech API, se supportata dal browser;
- creazione e copia di un link pubblico a un itinerario;
- pagina condivisa con riepilogo, stampa/esportazione PDF tramite browser e download calendario `.ics`;
- voto locale sulle attività del gruppo.

I pulsanti WhatsApp, Instagram e X sono **anteprime UI**: non effettuano una condivisione reale. Anche i voti sono salvati solo nel `localStorage` del dispositivo, quindi non sono aggregati tra partecipanti. Questi elementi sono extra dimostrativi, non requisiti principali della challenge.

## 11. Test eseguiti

### Suite automatica corrente

Comando eseguito il 14 settembre 2026:

```bash
cd backend
npm test -- --runInBand
```

Esito sul working tree corrente: **34 suite totali, 32 superate e 2 fallite; 221 test totali, 210 superati e 11 falliti**.

Le aree verdi includono validazione requisiti, generazione/vincoli itinerario, RAG, booking service, chat, storico, job asincroni, immagini/vision, resilienza Groq, fallback Gemini, rate limiting, metriche, cache e gran parte delle regressioni frontend.

Le due regressioni correnti sono:

- `frontendRecovery.test.js`: 7 casi falliscono perché il test VM incontra `window` non definito durante l'inizializzazione della Speech Recognition;
- `frontendBooking.test.js`: 4 casi falliscono perché l'estrazione VM del frammento di booking valuta `shareText` senza il parametro `isAlternative`.

Sono difetti reali della suite/compatibilità introdotti dalle funzioni Extra e vanno risolti prima della consegna dichiarata “tutta verde”. Non è corretto presentare l'esito storico 21 suite/131 test o altri conteggi precedenti come stato attuale.

### Integrazione PostgreSQL

Il repository include `npm run test:integration`: avvia un PostgreSQL Compose effimero, applica le migrazioni e verifica health, concorrenza chat, snapshot job, booking/vincoli e percorsi API autenticati. Le esecuzioni documentate nel progetto risultano verdi, ma questa suite non è stata rilanciata durante la stesura della guida.

### Verifiche non coperte integralmente

- percorso browser reale completo con provider LLM e credenziali;
- matrice mobile/manuale completa, zoom 200%, tastiera virtuale e scadenza sessione end-to-end;
- carico, più repliche e failover infrastrutturale.

## 12. Limiti noti e gap reali rispetto a `Richiesta`

Le funzionalità obbligatorie del brief sono sostanzialmente presenti. Restano questi gap/limiti concreti:

- **Suite non completamente verde nel working tree corrente:** 11 regressioni frontend descritte sopra.
- **Provider reali:** voli, hotel, attività e booking usano un catalogo demo; non ci sono integrazioni con GDS, OTA o pagamenti reali.
- **Produzione distribuita:** job, cache, rate limit, circuit breaker e metriche sono process-local; servirebbero coda/store condivisi per più repliche.
- **Operatività production-grade:** non sono inclusi secret manager, WAF, tracing distribuito, replica/failover PostgreSQL e pipeline di backup automatica.
- **Sicurezza dipendenze:** l'audit documenta advisory transitive in `@xenova/transformers`/ONNX; il fix automatico disponibile è breaking e non è stato applicato.
- **Tempo e geografia:** il dominio usa giornate UTC e non modella fusi locali, orari dettagliati dei voli o trasferimenti tra aeroporto, hotel e attività.
- **Vision:** dipende da flag espliciti e disponibilità del free tier; in fallback `metadata_only` non arricchisce semanticamente le preferenze.
- **Social:** pulsanti rete e voti di gruppo non sono integrazioni reali/condivise.
- **E2E:** manca una prova automatizzata browser→API→LLM→PostgreSQL completa.

Questi punti non contraddicono il nucleo della challenge, ma distinguono con chiarezza una demo tecnica robusta da un prodotto pronto per traffico reale.

## 13. Checklist demo

### Prima della demo

- [ ] Verificare che `backend/.env` contenga `GROQ_API_KEY`, `JWT_SECRET` sicuro e `FRONTEND_ORIGIN=http://localhost:8080`.
- [ ] Avviare i tre servizi Docker e verificare che non esistano container duplicati.
- [ ] Applicare le migrazioni e usare il seed soltanto sul database demo.
- [ ] Controllare `http://localhost:4000/health/live` e `http://localhost:4000/health/ready`.
- [ ] Aprire `http://localhost:8080` e verificare login/registrazione.
- [ ] Scegliere un mese effettivamente stampato dal seed.
- [ ] Se si mostra vision, attivare prima i flag Groq/free-tier e provare un'immagine non sensibile valida.
- [ ] Non dichiarare la suite interamente verde finché le 11 regressioni correnti non sono risolte e rieseguite.

### Percorso consigliato

- [ ] Registrare un nuovo utente demo.
- [ ] Inviare: “Vorrei andare in Spagna a [mese seedato], budget 1500 € per 2 persone, 5 giorni, partiamo da FCO, ci piacciono cultura e relax”.
- [ ] Mostrare una domanda di chiarimento modificando o omettendo inizialmente un requisito.
- [ ] Confermare il riepilogo dei requisiti.
- [ ] Attendere il job asincrono e mostrare proposta, alternativa, compromessi e ripartizione costi.
- [ ] Selezionare una proposta e leggere la conferma finale di booking.
- [ ] Confermare una sola volta, quindi mostrare stato e dettaglio in **Le mie prenotazioni**.
- [ ] Aggiornare la pagina per dimostrare persistenza e recupero.
- [ ] Aprire **Storico**, riprendere la conversazione e mostrare il transcript.
- [ ] Facoltativo: caricare/rimuovere un'immagine di preferenza e spiegare `completed` rispetto a `metadata_only`.
- [ ] Facoltativo: attivare **Extra**, copiare il link pubblico, aprire la pagina condivisa, esportare PDF/ICS e chiarire che i pulsanti social sono mock.

### Chiusura demo

- [ ] Mostrare `backend/openapi.yaml`, `ARCHITECTURE.md` e `OPERATIONS.md`.
- [ ] Spiegare separazione PostgreSQL/RAG e transazione/idempotenza del booking.
- [ ] Dichiarare con trasparenza i limiti della sezione 12 e distinguere test correnti da risultati storici.
