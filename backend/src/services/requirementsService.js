/**
 * Logica pura (nessuna dipendenza da DB/LLM) per validare i requisiti di viaggio.
 * Separata volutamente dal resto per essere facilmente testabile in isolamento.
 */

const REQUIRED_FIELDS = [
  'budget',
  'country',
  'departureAirport',
  'activityPreferences',
  'travelMonth',
  'durationDays',
  'participants',
];

const MONTHS_IT = [
  'gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno',
  'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre',
];
const MONTH_ALIASES = new Map([
  ['january', 'gennaio'], ['february', 'febbraio'], ['march', 'marzo'], ['april', 'aprile'],
  ['may', 'maggio'], ['june', 'giugno'], ['july', 'luglio'], ['august', 'agosto'],
  ['september', 'settembre'], ['october', 'ottobre'], ['november', 'novembre'], ['december', 'dicembre'],
]);

export function normalizeTravelMonth(value) {
  const normalized = String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  if (!normalized) return null;
  const token = normalized.match(/[a-z]+/g)?.find((word) => MONTHS_IT.includes(word) || MONTH_ALIASES.has(word));
  return MONTHS_IT.includes(token) ? token : MONTH_ALIASES.get(token) || null;
}

function parseDayMonth(day, month, year = new Date().getUTCFullYear()) {
  const monthName = normalizeTravelMonth(month);
  const dayNumber = Number(day);
  const monthIndex = MONTHS_IT.indexOf(monthName);
  if (!monthName || !Number.isInteger(dayNumber) || dayNumber < 1 || dayNumber > 31) return null;
  const date = new Date(Date.UTC(year, monthIndex, dayNumber));
  return date.getUTCMonth() === monthIndex && date.getUTCDate() === dayNumber ? date : null;
}

/** Estrae un intervallo completo dichiarato dall'utente (partenza e ritorno). */
export function extractExplicitTravelDates(value, referenceDate = new Date()) {
  const text = String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const monthPattern = [...MONTHS_IT, ...MONTH_ALIASES.keys()].join('|');
  // Valuta prima l'intervallo con due mesi/date completi: altrimenti il
  // parser abbreviato può iniziare dal numero dell'anno (es. "2026").
  const namedFirst = text.match(new RegExp(`(\\d{1,2})\\s+(${monthPattern})(?:\\s+(20\\d{2}))?\\s*(?:-|a|al|fino\\s+a)\\s*(\\d{1,2})\\s+(${monthPattern})(?:\\s+(20\\d{2}))?`, 'i'));
  if (namedFirst) {
    const departure = parseDayMonth(namedFirst[1], namedFirst[2], namedFirst[3] || referenceDate.getUTCFullYear());
    const returnYear = namedFirst[6] || namedFirst[3] || referenceDate.getUTCFullYear();
    const returnDate = parseDayMonth(namedFirst[4], namedFirst[5], returnYear);
    if (departure && returnDate) return { departure, returnDate };
  }
  const abbreviated = text.match(new RegExp(`(?:dal[^0-9]{0,4})?(\\d{1,2})\\s*(?:-|–|—|al|a|fino\\s+a)\\s*(\\d{1,2})\\s+(${monthPattern})(?:\\s+(20\\d{2}))?`, 'i'));
  if (abbreviated) {
    const departure = parseDayMonth(abbreviated[1], abbreviated[3], abbreviated[4] || referenceDate.getUTCFullYear());
    const returnDate = parseDayMonth(abbreviated[2], abbreviated[3], abbreviated[4] || referenceDate.getUTCFullYear());
    if (departure && returnDate) return { departure, returnDate };
  }
  const named = text.match(new RegExp(`(\\d{1,2})\\s+(${monthPattern})(?:\\s+(20\\d{2}))?\\s*(?:-|–|—|a|al|fino\\s+a)\\s*(\\d{1,2})\\s+(${monthPattern})(?:\\s+(20\\d{2}))?`, 'i'));
  if (named) {
    const departure = parseDayMonth(named[1], named[2], named[3] || referenceDate.getUTCFullYear());
    const returnYear = named[6] || named[3] || referenceDate.getUTCFullYear();
    const returnDate = parseDayMonth(named[4], named[5], returnYear);
    if (departure && returnDate) return { departure, returnDate };
  }
  const numeric = text.match(/(\d{1,2})[\/-](\d{1,2})(?:[\/-](20\d{2}))?\s*(?:-|–|—|a|al|fino\s+a)\s*(\d{1,2})[\/-](\d{1,2})(?:[\/-](20\d{2}))?/i);
  if (!numeric) return null;
  const departure = parseDayMonth(numeric[1], MONTHS_IT[Number(numeric[2]) - 1], numeric[3] || referenceDate.getUTCFullYear());
  const returnDate = parseDayMonth(numeric[4], MONTHS_IT[Number(numeric[5]) - 1], numeric[6] || numeric[3] || referenceDate.getUTCFullYear());
  return departure && returnDate ? { departure, returnDate } : null;
}

/** Estrae una durata dichiarata esplicitamente, distinguendola dai valori LLM. */
export function extractExplicitDuration(value) {
  const text = String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const match = text.match(/(?:durata|vacanza|soggiorno|viaggio)[^0-9]{0,40}(\d{1,2})\s*giorni?/i)
    || text.match(/\b(\d{1,2})\s*giorni?\b/i);
  if (!match) return null;
  const durationDays = Number(match[1]);
  return Number.isInteger(durationDays) && durationDays > 0 && durationDays <= 60 ? durationDays : null;
}

/** Estrae i valori numerici dichiarati dall'utente, senza delegarli al provider. */
export function extractExplicitBudget(value) {
  const text = String(value || '').replace(/\./g, '').replace(/,/g, '.');
  const match = text.match(/(?:budget|spesa|spendere|costo)[^0-9]{0,20}(\d+(?:\.\d{1,2})?)/i)
    || text.match(/\b(\d+(?:\.\d{1,2})?)\s*(?:€|euro)\b/i);
  if (!match) return null;
  const budget = Number(match[1]);
  return Number.isFinite(budget) && budget > 0 ? budget : null;
}

export function extractExplicitParticipants(value) {
  const text = String(value || '');
  const match = text.match(/\b(\d{1,2})\s*(?:persone|partecipanti|adulti)\b/i);
  if (!match) return null;
  const participants = Number(match[1]);
  return Number.isInteger(participants) && participants > 0 ? participants : null;
}

/** Intervallo numerico privo di mese/anno (es. "1-6"): non è una durata. */
export function hasAmbiguousNumericDateInterval(value) {
  const text = String(value || '').trim();
  if (/\b(?:gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre|january|february|march|april|may|june|july|august|september|october|november|december)\b/i.test(text)) return false;
  return /(?:^|\s)(?:dal(?:l['’])?\s+)?\d{1,2}\s*[-–—]\s*\d{1,2}(?=\s|$|[,.!?])/i.test(text)
    || /(?:^|\s)(?:dal(?:l['’])?\s+)?\d{1,2}\s+al\s+\d{1,2}(?=\s|$|[,.!?])/i.test(text);
}

/** Estrae solo date esplicitamente associate a ritorno/rientro, senza usare segnali vision. */
export function extractExplicitReturnDate(value, referenceDate = new Date()) {
  const text = String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const monthPattern = [...MONTHS_IT, ...MONTH_ALIASES.keys()].join('|');
  const intent = '(?:torniamo|torno|tornare|ritorno|rientro|rientrare|rientriamo|rientri|cambio\\s+(?:il\\s+)?ritorno|data\\s+di\\s+ritorno|preferisco\\s+(?:tornare|rientrare))';
  const named = text.match(new RegExp(`${intent}[^.!?\\n]{0,60}?(\\d{1,2})\\s+(${monthPattern})(?:\\s+(20\\d{2}))?`, 'i'));
  if (named) return parseDayMonth(named[1], named[2], named[3] || referenceDate.getUTCFullYear());
  const numeric = text.match(new RegExp(`${intent}[^.!?\\n]{0,60}?(\\d{1,2})[\\/-](\\d{1,2})(?:[\\/-](20\\d{2}))?`, 'i'));
  if (!numeric) return null;
  return parseDayMonth(numeric[1], MONTHS_IT[Number(numeric[2]) - 1], numeric[3] || referenceDate.getUTCFullYear());
}

/** Cerca la data di partenza già dichiarata nello storico per ricalcolare la durata. */
export function extractExplicitDepartureDate(history = [], referenceDate = new Date()) {
  const text = history.filter((entry) => entry?.role === 'user').map((entry) => entry.content).join(' ')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const monthPattern = MONTHS_IT.join('|');
  const named = text.match(new RegExp(`(?:partenza|partiamo|andiamo|dal|il)\\s+(\\d{1,2})\\s+(${monthPattern})`, 'i'));
  const numeric = text.match(/(?:partenza|partiamo|dal|il)\s+(\d{1,2})[\/-](\d{1,2})/i);
  if (named) return parseDayMonth(named[1], named[2], referenceDate.getUTCFullYear());
  if (!numeric) return null;
  const month = MONTHS_IT[Number(numeric[2]) - 1];
  return parseDayMonth(numeric[1], month, referenceDate.getUTCFullYear());
}

export function getMissingFields(requirements) {
  return REQUIRED_FIELDS.filter((f) => {
    const v = requirements[f];
    if (Array.isArray(v)) return v.length === 0;
    return v === undefined || v === null || v === '';
  });
}

/**
 * Controlli di coerenza "di buon senso" oltre alla semplice presenza dei campi.
 * Ritorna un array di problemi testuali (vuoto se tutto ok).
 */
export function validateConsistency(requirements) {
  const issues = [];
  const { budget, durationDays, participants } = requirements;

  if (budget !== undefined && budget <= 0) {
    issues.push('Il budget deve essere maggiore di zero.');
  }
  if (durationDays !== undefined && (durationDays <= 0 || durationDays > 60)) {
    issues.push('La durata del viaggio non è plausibile (deve essere tra 1 e 60 giorni).');
  }
  if (participants !== undefined && participants <= 0) {
    issues.push('Il numero di partecipanti deve essere almeno 1.');
  }
  // Budget palesemente insufficiente: euristica minima (voli+hotel economici) per dare
  // subito un chiarimento invece di generare un itinerario impossibile.
  if (budget !== undefined && durationDays !== undefined && participants !== undefined) {
    const minPlausibleCost = participants * (150 /* volo A/R stimato minimo */ + durationDays * 40 /* hotel low-cost */);
    if (budget < minPlausibleCost) {
      issues.push(
        `Il budget indicato (${budget}€) sembra insufficiente per ${participants} partecipant${participants === 1 ? 'e' : 'i'} e ${durationDays} notti (minimo stimato ~${minPlausibleCost}€).`
      );
    }
  }
  return issues;
}

export function isComplete(requirements) {
  return getMissingFields(requirements).length === 0 && validateConsistency(requirements).length === 0;
}
