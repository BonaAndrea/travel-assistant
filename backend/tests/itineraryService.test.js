import { monthToDateRange, optimizeActivitySelection } from '../src/services/itineraryService.js';
import { normalizeLocation } from '../src/services/locationNormalization.js';

describe('normalizzazione riferimenti geografici', () => {
  test('ignora accenti, maiuscole, spazi e punteggiatura', () => {
    expect(normalizeLocation('  Città  del-Messico ')).toBe('cittadelmessico');
    expect(normalizeLocation('CITTA del messico')).toBe('cittadelmessico');
  });
});

describe('monthToDateRange', () => {
  test('mese non riconosciuto ritorna null', () => {
    expect(monthToDateRange('mesefinto')).toBeNull();
  });

  test('normalizza novembre italiano e alias inglese', () => {
    const reference = new Date(Date.UTC(2026, 0, 15));
    expect(monthToDateRange('novembre', reference).start.getUTCMonth()).toBe(10);
    expect(monthToDateRange('November', reference).start.getUTCMonth()).toBe(10);
  });

  const candidate = (id, score, category, cost, preferenceIndexes = [0], booked = 0, capacity = 2) => ({
    id,
    score,
    preferenceIndexes,
    metadata: { name: id, category },
    availability: { cost, booked, capacity },
  });

  describe('optimizeActivitySelection', () => {
    test('sceglie una combinazione globale invece della scelta greedy del primo giorno', () => {
      const result = optimizeActivitySelection({
        days: 2,
        participants: 1,
        budgetRemaining: 10,
        candidatesByDate: [
          {
            date: '2026-10-01',
            candidates: [candidate('premium', 1, 'cultura', 8), candidate('cheap', 0.7, 'sport', 4)],
          },
          {
            date: '2026-10-02',
            candidates: [candidate('premium', 1, 'cultura', 8), candidate('cheap', 0.7, 'sport', 4)],
          },
        ],
      });

      expect(result.cost).toBe(8);
      expect(result.chosen).toHaveLength(2);
      expect(result.chosen.map((item) => item.activityId)).toEqual(['cheap', 'cheap']);
    });

    test('rispetta capacità e budget lasciando esplicitamente scoperto il giorno incompatibile', () => {
      const result = optimizeActivitySelection({
        days: 2,
        participants: 2,
        budgetRemaining: 20,
        candidatesByDate: [
          {
            date: '2026-10-01',
            candidates: [candidate('full', 1, 'cultura', 5, [0], 1, 2)],
          },
          {
            date: '2026-10-02',
            candidates: [candidate('expensive', 1, 'relax', 15, [1], 0, 4)],
          },
        ],
      });

      expect(result.cost).toBe(0);
      expect(result.chosen).toHaveLength(0);
      expect(result.daysWithoutActivity).toBe(2);
    });

    test('copre preferenze concorrenti privilegiando categorie diverse', () => {
      const result = optimizeActivitySelection({
        days: 2,
        participants: 1,
        budgetRemaining: 20,
        candidatesByDate: [
          {
            date: '2026-10-01',
            candidates: [candidate('culture', 0.9, 'cultura', 5, [0]), candidate('relax', 0.85, 'relax', 5, [1])],
          },
          {
            date: '2026-10-02',
            candidates: [candidate('culture', 0.95, 'cultura', 5, [0]), candidate('relax', 0.8, 'relax', 5, [1])],
          },
        ],
      });

      expect(result.chosen.map((item) => item.category).sort()).toEqual(['cultura', 'relax']);
    });

    test('seleziona piÃ¹ fasce nello stesso giorno senza sovrapposizioni e senza superare il budget', () => {
      const result = optimizeActivitySelection({
        days: 1,
        participants: 1,
        budgetRemaining: 15,
        candidatesByDate: [{
          date: '2026-10-01',
          candidates: [
            { ...candidate('morning', 1, 'cultura', 8), availability: { cost: 8, booked: 0, capacity: 2, startMinute: 9 * 60, endMinute: 11 * 60 } },
            { ...candidate('overlap', 1.2, 'relax', 1), availability: { cost: 1, booked: 0, capacity: 2, startMinute: 10 * 60, endMinute: 12 * 60 } },
            { ...candidate('afternoon', 0.9, 'sport', 7), availability: { cost: 7, booked: 0, capacity: 2, startMinute: 11 * 60, endMinute: 13 * 60 } },
          ],
        }],
      });

      expect(result.chosen.map((item) => item.activityId)).toEqual(['morning', 'afternoon']);
      expect(result.cost).toBe(15);
      expect(result.chosen[0].endMinute).toBeLessThanOrEqual(result.chosen[1].startMinute);
      expect(result.timedOut).toBe(false);
    });

    test('espone il superamento del limite temporale del solver', () => {
      const result = optimizeActivitySelection({
        days: 2,
        participants: 1,
        budgetRemaining: 100,
        timeLimitMs: 0,
        candidatesByDate: [{ date: '2026-10-01', candidates: [] }, { date: '2026-10-02', candidates: [] }],
      });

      expect(result.timedOut).toBe(true);
      expect(result.chosen).toHaveLength(0);
    });
  });

  test('mese futuro nello stesso anno viene risolto correttamente', () => {
    const reference = new Date(Date.UTC(2026, 0, 15)); // 15 gennaio 2026
    const range = monthToDateRange('luglio', reference);
    expect(range.start.getUTCFullYear()).toBe(2026);
    expect(range.start.getUTCMonth()).toBe(6); // luglio = indice 6
  });

  test('mese già passato viene proiettato al prossimo anno', () => {
    const reference = new Date(Date.UTC(2026, 8, 15)); // settembre 2026
    const range = monthToDateRange('marzo', reference);
    expect(range.start.getUTCFullYear()).toBe(2027);
  });
});
