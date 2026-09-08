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
