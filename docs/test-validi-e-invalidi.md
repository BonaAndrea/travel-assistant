# Matrice manuale browser-only: casi validi e non validi

## Scopo e precondizioni

Questa checklist verifica dal solo browser il comportamento visibile della demo, senza chiamare direttamente API o database.

Precondizioni:

- applicazione avviata e raggiungibile su `http://localhost:8080`;
- migrazioni applicate e seed eseguito nel settembre 2026;
- catalogo dichiarato dal seed: **ottobre 2026–settembre 2027**;
- partenze disponibili nei giorni **1, 8, 15 e 22** di ogni mese;
- ogni ritorno seedato è esattamente **5 notti dopo** la partenza;
- origini: FCO, MXP, BLQ, NAP;
- destinazioni: Barcellona/BCN, Madrid/MAD, Lisbona/LIS, Parigi/CDG, Atene/ATH, Praga/PRG;
- utente di prova registrato e autenticato;
- per ogni scenario, iniziare una nuova conversazione, salvo dove indicato diversamente.

Se il seed viene rieseguito in un mese diverso, prima dei test sostituire le date con quelle indicate dalla riga `Mesi seedati` del comando: il catalogo viene sempre generato per i 12 mesi successivi all'esecuzione.

## Regole comuni di osservazione

In tutti i casi validi la chat deve:

1. estrarre i requisiti senza cambiare città, aeroporto, date, partecipanti o budget;
2. mostrare un riepilogo prima di generare;
3. attendere una conferma esplicita;
4. mostrare lo stato del job durante la generazione;
5. presentare voli A/R, hotel per 5 notti, attività, totale e ripartizione dei costi;
6. non mostrare risultati appartenenti a conversazioni o richieste precedenti.

Un messaggio può essere formulato in modo leggermente diverso dal testo atteso; conta il significato e la correttezza dei dati mostrati.

## Scenari che DEVONO funzionare

### V1 — Barcellona da FCO, richiesta completa

**Input in chat**

> Voglio andare a Barcellona dal 1 al 6 ottobre 2026, partenza da FCO, budget totale 1500 euro per 2 persone. Ci interessano cultura e relax.

**Passi**

1. Aprire Chat e inviare il testo.
2. Controllare il riepilogo.
3. Rispondere `Confermo`.
4. Attendere il completamento del job.

**Risultato atteso**

- riepilogo: Barcellona/Spagna, FCO, 1–6 ottobre, 5 giorni/notti, 2 persone, 1500 €, cultura e relax;
- proposta con volo FCO→BCN il 1 ottobre e BCN→FCO il 6 ottobre;
- hotel a Barcellona per tutte le 5 notti;
- totale non superiore a 1500 € oppure compromesso chiaramente dichiarato;
- pulsante di prenotazione disponibile per una proposta valida.

**È un bug se** viene scelta Madrid, il ritorno non è il 6 ottobre, manca una notte di hotel, il totale supera il budget senza badge/compromesso, oppure la generazione parte senza conferma.

### V2 — Madrid da Milano Malpensa, normalizzazione del nome aeroporto

**Input in chat**

> Dal 8 al 13 novembre 2026 vorrei Madrid. Partiamo da Milano Malpensa, siamo 2, budget 1800 euro, preferenze nightlife e cultura.

**Passi**

1. Inviare il testo in una nuova conversazione.
2. Verificare che “Milano Malpensa” sia risolto come MXP.
3. Confermare il riepilogo.
4. Attendere proposta e alternativa.

**Risultato atteso**

- destinazione specifica Madrid, non genericamente Spagna;
- origine MXP;
- volo MXP→MAD l'8 novembre e MAD→MXP il 13 novembre;
- hotel e attività appartenenti a Madrid;
- eventuale alternativa distinta dalla proposta principale e accompagnata dal motivo del compromesso.

**È un bug se** il nome umano dell'aeroporto viene rifiutato, viene proposta Barcellona, o hotel/attività appartengono a un'altra città.

### V3 — Lisbona da FCO, requisiti raccolti in più turni

**Passi e input**

1. Inviare: `Vorrei andare a Lisbona a dicembre 2026.`
2. Attendere la richiesta dei dati mancanti.
3. Inviare: `Parto da Roma Fiumicino il 15 dicembre e torno il 20. Viaggio da solo, budget 900 euro, mi piacciono sport e relax.`
4. Verificare il riepilogo e rispondere `Sì, confermo`.
5. Attendere il job.

**Risultato atteso**

- dopo il primo turno l'assistente chiede chiarimenti e non genera;
- i dati del primo turno restano memorizzati nel secondo;
- “Roma Fiumicino” viene risolto come FCO;
- voli FCO→LIS il 15 dicembre e LIS→FCO il 20 dicembre;
- proposta completa, coerente e prenotabile.

**È un bug se** l'assistente dimentica Lisbona, inventa i dati mancanti, genera prima della conferma o duplica i messaggi.

### V4 — Parigi da MXP e modifica prima della conferma

**Passi e input**

1. Inviare: `Parigi dal 22 al 27 gennaio 2027, partenza MXP, 2 persone, budget 2000 euro, cultura.`
2. Quando compare il riepilogo, inviare: `Modifica le preferenze: aggiungi relax e mantieni tutto il resto.`
3. Controllare il nuovo riepilogo.
4. Confermare e attendere il job.

**Risultato atteso**

- date, città, origine, partecipanti e budget restano invariati;
- le preferenze diventano cultura + relax;
- voli MXP→CDG il 22 gennaio e CDG→MXP il 27 gennaio;
- nessun risultato generato prima dell'ultima conferma.

**È un bug se** la modifica cancella altri requisiti, genera una proposta obsoleta o ripristina in seguito la preferenza precedente.

### V5 — Prenotazione, idempotenza visibile e dashboard

Usare la proposta ottenuta in V1 oppure creare una nuova richiesta equivalente.

**Passi**

1. Premere `Prenota questa proposta`.
2. Leggere la conferma finale e confermare una sola volta.
3. Attendere l'esito.
4. Aggiornare la pagina del browser.
5. Aprire `Le mie prenotazioni`.

**Risultato atteso**

- prima della conferma finale sono mostrati almeno destinazione, totale e avviso di verifica prezzo/disponibilità;
- dopo la conferma compare un solo booking `confirmed`;
- dopo refresh lo stato resta confermato;
- la dashboard contiene una sola riga/card per l'operazione e il dettaglio è coerente con la proposta.

**È un bug se** il click crea subito il booking senza conferma, compare un booking parziale come confermato, il refresh perde lo stato o una singola operazione genera duplicati.

## Scenari che DEVONO essere rifiutati, fermati o corretti

### N1 — Destinazione non presente nel catalogo

**Input in chat**

> Tokyo dal 1 al 6 ottobre 2026, partenza FCO, 1 persona, budget 2000 euro, cultura.

**Passi**

1. Inviare la richiesta.
2. Se compare un riepilogo, tentare di confermarlo.

**Risultato atteso**

- la destinazione viene dichiarata non presente/non riconosciuta;
- vengono suggerite città o nazioni supportate;
- non parte alcun job e non compare una proposta prenotabile.

**È un bug se** il sistema inventa voli o hotel per Tokyo, sostituisce silenziosamente la città o consente il booking.

### N2 — Ritorno incompatibile con il catalogo

**Input in chat**

> Barcellona dal 1 al 4 ottobre 2026, partenza FCO, 1 persona, budget 1000 euro, cultura.

**Passi**

1. Inviare la richiesta e controllare che la durata ricavata sia 3 notti.
2. Confermare il riepilogo.

**Risultato atteso**

- il sistema trova l'andata del 1 ottobre ma rifiuta la combinazione perché non esiste il ritorno esatto del 4 ottobre;
- il messaggio indica il ritorno atteso e suggerisce il ritorno disponibile del 6 ottobre o una durata compatibile;
- i requisiti raccolti restano modificabili; nessun itinerario incompleto è prenotabile.

**È un bug se** usa il ritorno del 6 senza consenso, accorcia/allunga il viaggio silenziosamente o presenta un itinerario privo di ritorno.

### N3 — Budget manifestamente insufficiente

**Input in chat**

> Madrid dal 8 al 13 novembre 2026, partenza FCO, 2 persone, budget totale 100 euro, cultura e relax.

**Passi**

1. Inviare la richiesta.
2. Osservare la validazione; se viene chiesta conferma, confermare per verificare il blocco di generazione.

**Risultato atteso**

- la chat segnala che 100 € sono incompatibili con due voli A/R e cinque notti;
- chiede di aumentare il budget o modificare partecipanti/durata;
- se la generazione viene comunque tentata, termina con errore esplicito “voli oltre budget” o “hotel oltre budget”, senza opzione prenotabile;
- una proposta fuori budget è accettabile solo se chiaramente marcata come alternativa/compromesso e non spacciata per conforme.

**È un bug se** compare il badge “Entro il budget” su un totale superiore a 100 €, il costo viene calcolato per una sola persona o il sistema conferma una prenotazione fuori vincolo senza avviso.

### N4 — Mese precedente/fuori dalla finestra seed

**Input in chat**

> Lisbona dal 15 al 20 settembre 2026, partenza MXP, 1 persona, budget 1200 euro, relax.

**Passi**

1. Inviare e confermare la richiesta.

**Risultato atteso**

- nessun volo viene trovato nel mese richiesto;
- il messaggio suggerisce mesi/date realmente disponibili, a partire da ottobre 2026;
- il sistema non sposta automaticamente il viaggio a ottobre e non mostra una proposta prenotabile finché l'utente non accetta/modifica le date.

**È un bug se** il sistema dichiara genericamente “errore”, suggerisce un mese non seedato, cambia mese senza consenso o restituisce dati di un job precedente.

### N5 — Sovrapposizione con una prenotazione esistente

**Precondizione specifica**

Completare V5 e avere una prenotazione confermata per Barcellona dal 1 al 6 ottobre 2026.

**Passi**

1. Creare una nuova conversazione.
2. Inviare: `Madrid dal 1 al 6 ottobre 2026, partenza MXP, 1 persona, budget 1200 euro, nightlife.`
3. Confermare i requisiti.

**Risultato atteso**

- prima di procedere compare un avviso che le date coincidono con una prenotazione confermata;
- sono disponibili le azioni `Modifica date` e `Continua comunque`;
- `Modifica date` ferma il percorso e permette di correggere i requisiti;
- `Continua comunque` prosegue solo dopo una scelta esplicita dell'utente.

La sovrapposizione è un **warning intenzionale**, non un rifiuto assoluto: il sistema non deve decidere al posto dell'utente.

**È un bug se** non compare alcun avviso, il warning riguarda date non sovrapposte, il click “Modifica date” avvia comunque la generazione o il sistema blocca senza offrire le due azioni previste.

### N6 — Aeroporto di partenza sconosciuto

**Input in chat**

> Praga dal 22 al 27 febbraio 2027, partenza da XXX, 1 persona, budget 1200 euro, cultura.

**Risultato atteso**

- origine dichiarata non riconosciuta;
- richiesta di un codice IATA/città supportata, idealmente con suggerimenti FCO, MXP, BLQ o NAP;
- nessun job o itinerario prenotabile.

**È un bug se** `XXX` viene associato arbitrariamente a un aeroporto o ignorato usando un'origine diversa.

## Controlli trasversali dopo ogni scenario

- [ ] Il riepilogo corrisponde esattamente ai dati confermati.
- [ ] Errori e compromessi sono in italiano e indicano cosa modificare.
- [ ] Nessun errore tecnico grezzo, stack trace o token compare nell'interfaccia.
- [ ] Il pulsante di prenotazione appare soltanto su una proposta completa.
- [ ] Cambiare conversazione o aggiornare la pagina non mescola transcript e risultati.
- [ ] Storico e dashboard mostrano solo risorse dell'utente autenticato.
- [ ] Le azioni disabilitate non restano bloccate dopo un errore recuperabile.

## Criterio finale

La matrice è superata solo se tutti i casi V1–V5 producono dati coerenti e tutti i casi N1–N6 impediscono risultati ingannevoli. Un'alternativa è valida soltanto quando il compromesso è visibile e richiede una scelta dell'utente; non è valida una correzione silenziosa dei requisiti.
