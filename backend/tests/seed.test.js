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
});
