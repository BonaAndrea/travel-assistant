/**
 * Vector store "leggero" per il supporto RAG.
 *
 * Scelta architetturale: invece di introdurre un servizio esterno (Chroma/Pinecone/pgvector),
 * usiamo un indice vettoriale file-based (JSON) con similarità coseno calcolata in-process.
 * Il ruolo è chiaramente separato dal DB relazionale (Postgres/Prisma):
 * - Postgres: stato transazionale (disponibilità, prezzi, prenotazioni)
 * - Vector store: descrizioni testuali + target ideale di attività/strutture, usate per il
 *   retrieval semantico che alimenta la selezione/motivazione delle attività proposte dall'LLM.
 *
 * Embeddings calcolati localmente con @xenova/transformers (modello all-MiniLM-L6-v2),
 * quindi nessun costo/API key aggiuntiva richiesta per questa parte.
 */
import fs from 'fs';
import path from 'path';
import { pipeline } from '@xenova/transformers';
import { prisma } from '../db/prisma.js';

function normalizeLocation(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('it-IT')
    .replace(/[^a-z0-9]+/g, '');
}

const INDEX_PATH = path.resolve('src/db/vector-index.json');

let embedder = null;
async function getEmbedder() {
  if (!embedder) {
    embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
  }
  return embedder;
}

async function embed(text) {
  const model = await getEmbedder();
  const output = await model(text, { pooling: 'mean', normalize: true });
  return Array.from(output.data);
}

function cosineSim(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot; // i vettori sono già normalizzati -> dot product = coseno
}

/**
 * Costruisce l'indice a partire da attività e hotel presenti nel DB relazionale.
 * Va rieseguito quando cambia il catalogo (in questa challenge: on-demand via script/seed).
 */
export async function buildIndex() {
  const activities = await prisma.activity.findMany();
  const hotels = await prisma.hotel.findMany();

  const documents = [
    ...activities.map((a) => ({
      id: a.id,
      type: 'activity',
      text: `${a.name} (${a.category}) a ${a.city}, ${a.country}. ${a.description} Target ideale: ${a.target}.`,
      metadata: {
        name: a.name,
        category: a.category,
        city: a.city,
        country: a.country,
        destinationId: a.destinationId,
      },
    })),
    ...hotels.map((h) => ({
      id: h.id,
      type: 'hotel',
      text: `${h.name} a ${h.city}, ${h.country}. ${h.description} Target ideale: ${h.target}.`,
      metadata: { name: h.name, city: h.city, country: h.country },
    })),
  ];

  const indexed = [];
  for (const doc of documents) {
    const vector = await embed(doc.text);
    indexed.push({ ...doc, vector });
  }

  fs.mkdirSync(path.dirname(INDEX_PATH), { recursive: true });
  fs.writeFileSync(INDEX_PATH, JSON.stringify(indexed));
  return indexed.length;
}

function loadIndex() {
  if (!fs.existsSync(INDEX_PATH)) return [];
  return JSON.parse(fs.readFileSync(INDEX_PATH, 'utf-8'));
}

/**
 * Filtra il catalogo prima del ranking semantico e del limite topK.
 * Il fallback sulla cittÃ  mantiene compatibili gli indici creati prima dei metadata
 * destinationId, senza consentire risultati di altre cittÃ .
 */
export function filterRetrievalCandidates(documents, {
  type, country, destinationId, destinationCity,
} = {}) {
  const countryKey = normalizeLocation(country);
  const cityKey = normalizeLocation(destinationCity);
  return documents.filter((document) => {
    if (type && document.type !== type) return false;
    // Quando destinationId è presente, è il riferimento relazionale autorevole:
    // il paese può arrivare tradotto dal provider (es. "Spain" vs "Spagna").
    if (country && !destinationId && normalizeLocation(document.metadata?.country) !== countryKey) return false;
    if (!destinationId && !destinationCity) return true;
    if (destinationId && document.metadata?.destinationId) {
      return document.metadata.destinationId === destinationId;
    }
    return Boolean(cityKey && normalizeLocation(document.metadata?.city) === cityKey);
  });
}

/**
 * Il filesystem delle istanze gratuite è effimero. Quando l'indice RAG non è
 * presente, il fallback relazionale mantiene la generazione disponibile senza
 * caricare il modello di embedding durante una richiesta utente.
 */
async function relationalFallbackSearch({
  type, country, destinationId, destinationCity, topK,
}) {
  if (type !== 'activity') return [];
  const where = destinationId
    ? { destinationId }
    : destinationCity
      ? { city: { equals: destinationCity, mode: 'insensitive' } }
      : country
        ? { country: { equals: country, mode: 'insensitive' } }
        : {};
  const activities = await prisma.activity.findMany({ where, take: topK });
  return activities.map((activity) => ({
    id: activity.id,
    type: 'activity',
    text: `${activity.name} (${activity.category}) a ${activity.city}, ${activity.country}.`,
    metadata: {
      name: activity.name,
      category: activity.category,
      city: activity.city,
      country: activity.country,
      destinationId: activity.destinationId,
    },
    score: 0,
  }));
}

/**
 * Retrieval semantico: dato un testo libero (es. preferenze utente "relax e cultura in famiglia"),
 * ritorna i documenti più affini, opzionalmente filtrati per tipo/paese.
 */
export async function semanticSearch(query, {
  type, country, destinationId, destinationCity, topK = 5,
} = {}) {
  const index = loadIndex();
  if (index.length === 0) {
    return relationalFallbackSearch({ type, country, destinationId, destinationCity, topK });
  }

  const qVector = await embed(query);
  // Apply all relational filters before ranking/topK so national results cannot crowd out
  // local ones. destinationCity keeps old indexes usable until the next rebuild.
  const candidates = filterRetrievalCandidates(index, {
    type, country, destinationId, destinationCity,
  });

  return candidates
    .map((d) => ({ ...d, score: cosineSim(qVector, d.vector) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map(({ vector, ...rest }) => rest); // non serve esporre il vettore grezzo
}
