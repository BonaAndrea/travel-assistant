import { monthToDateRange, optimizeActivitySelection } from '../src/services/itineraryService.js';

describe('monthToDateRange', () => {
  test('mese non riconosciuto ritorna null', () => {
    expect(monthToDateRange('mesefinto')).toBeNull();
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
