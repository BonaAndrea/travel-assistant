# Architettura e threat model

## Confini

Il backend Express espone API REST sotto `/api`; PostgreSQL è la fonte autorevole per stato,
disponibilità e booking. Il retrieval RAG è un indice JSON locale alimentato da embeddings
locali: non sostituisce il database relazionale e non decide la disponibilità finale.
Groq gestisce solo la conversazione/estrazione requisiti; il server valida e persiste ogni stato.

## Consistenza

La conferma booking usa una transazione Prisma e decrementi condizionati su voli, camere e slot.
La chiave idempotente è unica. I turni chat acquisiscono un advisory lock PostgreSQL su una
connessione dedicata per tutta la richiesta, inclusa la chiamata LLM; timeout e rilascio sono
gestiti dal middleware. Rate limit, cache e metriche restano process-local e richiedono adapter
condivisi in un deployment multi-replica.

## Threat model sintetico

- Auth: password bcrypt, access JWT breve, refresh token opaco hashato/ruotato; ownership per
  risorsa, rate limit auth, claim JWT `typ/sub` e cookie HttpOnly.
- Input: Zod e limiti body/file; upload con MIME e magic bytes, storage fuori dalla directory
  statica. In produzione servono anche WAF e limiti al reverse proxy.
- Secret/log: chiavi via env/secret manager, mai nel repository; logger whitelistato e redazione
  dei prompt provider. I valori demo non sono adatti alla produzione.
- Booking: transazioni, lock condizionali e idempotenza mitigano doppie conferme/overselling.
- Health: readiness verifica PostgreSQL; liveness non dipende dal DB; shutdown chiude HTTP,
  Prisma e pool advisory.

## Fuori scope

Non sono inclusi provider di booking reale, coda esterna, secret manager, tracing distribuito,
WAF o replica PostgreSQL: aggiungerli prima di un esercizio production reale.
