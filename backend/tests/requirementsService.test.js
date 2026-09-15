import {
  getMissingFields, validateConsistency, isComplete, normalizeTravelMonth,
  extractExplicitReturnDate, extractExplicitDepartureDate, extractExplicitTravelDates,
  extractExplicitDuration, extractExplicitBudget, extractExplicitParticipants,
} from '../src/services/requirementsService.js';

test.each(['torniamo il 13 novembre', 'preferisco tornare il 13 novembre'])('estrae la data di ritorno da "%s"', (message) => {
  expect(extractExplicitReturnDate(message, new Date(Date.UTC(2026, 0, 1)))).toEqual(new Date(Date.UTC(2026, 10, 13)));
});

test.each([
  ['Torniamo il 6 dicembre', new Date(Date.UTC(2026, 11, 6))],
  ['preferisco rientrare il 6 december', new Date(Date.UTC(2026, 11, 6))],
  ['rientriamo il 06/12', new Date(Date.UTC(2026, 11, 6))],
])('gestisce mesi, inglese e formati naturali per il ritorno: %s', (message, expected) => {
  expect(extractExplicitReturnDate(message, new Date(Date.UTC(2026, 0, 1)))).toEqual(expected);
});

test('estrae la partenza dallo storico per ricalcolare la durata', () => {
  expect(extractExplicitDepartureDate([
    { role: 'user', content: 'Partiamo il 1 novembre' },
  ], new Date(Date.UTC(2026, 0, 1)))).toEqual(new Date(Date.UTC(2026, 10, 1)));
});

test('estrae una durata dichiarata in italiano', () => {
  expect(extractExplicitDuration('con una durata totale della vacanza di 5 giorni')).toBe(5);
});

test('estrae budget e partecipanti dal prompt demo senza affidarsi al provider', () => {
  const prompt = 'Barcellona, 1-6 ottobre 2026, FCO, 2 persone, budget 2000 euro, cultura';
  expect(extractExplicitBudget(prompt)).toBe(2000);
  expect(extractExplicitParticipants(prompt)).toBe(2);
});

test('mantiene il ritorno inclusivo nel prompt QA-02 completo', () => {
  const dates = extractExplicitTravelDates(
    'Vorrei andare a Barcellona dal 1 ottobre 2026 al 6 ottobre 2026, partendo da FCO. Siamo in 2, il budget totale è di 2000 euro e preferiamo attività culturali.',
    new Date('2026-09-15T00:00:00Z'),
  );
  expect(dates.departure.toISOString()).toBe('2026-10-01T00:00:00.000Z');
  expect(dates.returnDate.toISOString()).toBe('2026-10-06T00:00:00.000Z');
});

test.each([
  ['22 novembre - 6 dicembre 2026', 14],
  ['22/11/2026 - 13/12/2026', 21],
  ['dal 1 ottobre 2026 al 6 ottobre 2026', 6],
])('calcola una sola durata per intervallo esplicito: %s', (value, durationDays) => {
  const dates = extractExplicitTravelDates(value, new Date(Date.UTC(2026, 0, 1)));
  expect(dates).not.toBeNull();
  const expectedCalendarDays = value.includes('1 ottobre') ? durationDays - 1 : durationDays;
  expect(Math.round((dates.returnDate - dates.departure) / 86400000)).toBe(expectedCalendarDays);
});

test('normalizza tutti i mesi italiani e le frasi naturali senza cambiare il significato', () => {
  const months = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];
  expect(months.map((month) => normalizeTravelMonth(`Andiamo a ${month}`))).toEqual(months);
  expect(normalizeTravelMonth('November')).toBe('novembre');
  expect(normalizeTravelMonth('mese inventato')).toBeNull();
});

describe('getMissingFields', () => {
  test('rileva tutti i campi mancanti su oggetto vuoto', () => {
    expect(getMissingFields({})).toHaveLength(7);
  });

  test('nessun campo mancante quando tutti presenti', () => {
    const req = {
      budget: 1000, country: 'Spagna', departureAirport: 'FCO',
      activityPreferences: ['cultura'], travelMonth: 'luglio', durationDays: 5, participants: 2,
    };
    expect(getMissingFields(req)).toHaveLength(0);
  });

  test('array vuoto conta come campo mancante', () => {
    const req = {
      budget: 1000, country: 'Spagna', departureAirport: 'FCO',
      activityPreferences: [], travelMonth: 'luglio', durationDays: 5, participants: 2,
    };
    expect(getMissingFields(req)).toContain('activityPreferences');
  });
});

describe('validateConsistency', () => {
  test('budget negativo genera un issue', () => {
    const issues = validateConsistency({ budget: -10 });
    expect(issues.length).toBeGreaterThan(0);
  });

  test('durata fuori range plausibile genera un issue', () => {
    const issues = validateConsistency({ durationDays: 90 });
    expect(issues.some((i) => i.includes('durata'))).toBe(true);
  });

  test('budget palesemente insufficiente viene segnalato', () => {
    const issues = validateConsistency({ budget: 50, durationDays: 7, participants: 4 });
    expect(issues.some((i) => i.toLowerCase().includes('insufficiente'))).toBe(true);
  });

  test('requisiti coerenti non generano issue', () => {
    const issues = validateConsistency({ budget: 2000, durationDays: 5, participants: 2 });
    expect(issues).toHaveLength(0);
  });
});

describe('isComplete', () => {
  test('false se mancano campi', () => {
    expect(isComplete({})).toBe(false);
  });

  test('true se tutti i campi presenti e coerenti', () => {
    const req = {
      budget: 2000, country: 'Spagna', departureAirport: 'FCO',
      activityPreferences: ['relax'], travelMonth: 'luglio', durationDays: 5, participants: 2,
    };
    expect(isComplete(req)).toBe(true);
  });
});
