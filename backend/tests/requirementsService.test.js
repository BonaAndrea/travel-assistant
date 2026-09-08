import { getMissingFields, validateConsistency, isComplete } from '../src/services/requirementsService.js';

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
