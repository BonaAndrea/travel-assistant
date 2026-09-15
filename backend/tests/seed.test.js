import { buildSeedPlan } from '../src/db/seed.js';

describe('piano seed catalogo voli', () => {
  test('copre 12 mesi, quattro aeroporti italiani e sei destinazioni', () => {
    const plan = buildSeedPlan(new Date('2026-09-09T00:00:00.000Z'));

    expect(plan.months).toHaveLength(12);
    expect(new Set(plan.months.map(({ year, month }) => `${year}-${month}`)).size).toBe(12);
    expect(plan.months.every(({ departureDates, coverageDates }) => (
      departureDates).length === 4 && coverageDates.length === 28)).toBe(true);
    expect(plan.origins.map(({ iata }) => iata)).toEqual(['FCO', 'MXP', 'BLQ', 'NAP']);
    expect(plan.destinations.map(({ iata }) => iata)).toEqual(['BCN', 'MAD', 'LIS', 'CDG', 'ATH', 'PRG']);
  });

  test('parte dal mese successivo e mantiene partenze nel mese dichiarato', () => {
    const plan = buildSeedPlan(new Date('2026-09-09T00:00:00.000Z'), 2);

    expect(plan.months.map(({ monthName }) => monthName)).toEqual(['ottobre', 'novembre']);
    for (const month of plan.months) {
      expect(month.departureDates.every((date) => date.getUTCMonth() === month.month)).toBe(true);
      expect(month.departureDates.every((date) => date.getUTCDate() <= 22)).toBe(true);
    }
  });

  test('copre il caso QA-02 del 1 ottobre per tutte le cinque notti', () => {
    const plan = buildSeedPlan(new Date('2026-09-15T00:00:00.000Z'));
    const october = plan.months[0];

    expect(`${october.year}-${String(october.month + 1).padStart(2, '0')}`).toBe('2026-10');
    expect(october.departureDates.map((date) => date.toISOString().slice(0, 10))).toContain('2026-10-01');
    expect(october.coverageDates.slice(0, 5).map((date) => date.toISOString().slice(0, 10)))
      .toEqual(['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05']);
  });
});
