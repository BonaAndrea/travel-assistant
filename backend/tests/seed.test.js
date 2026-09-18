import { buildSeedPlan } from '../src/db/seed.js';

describe('piano seed catalogo voli', () => {
  test('copre 12 mesi, sette aeroporti italiani e venti destinazioni europee', () => {
    const plan = buildSeedPlan(new Date('2026-09-09T00:00:00.000Z'));

    expect(plan.months).toHaveLength(12);
    expect(new Set(plan.months.map(({ year, month }) => `${year}-${month}`)).size).toBe(12);
    expect(plan.months.every(({ departureDates, coverageDates }) => (
      departureDates).length === 8 && coverageDates.length >= 28)).toBe(true);
    expect(plan.origins.map(({ iata }) => iata)).toEqual(['FCO', 'MXP', 'BLQ', 'NAP', 'VCE', 'TRN', 'BRI']);
    expect(plan.destinations).toHaveLength(20);
    expect(plan.destinations.map(({ iata }) => iata)).toEqual([
      'BCN', 'MAD', 'VLC', 'LIS', 'OPO', 'CDG', 'NCE', 'ATH', 'PRG', 'AMS',
      'BER', 'VIE', 'BUD', 'DUB', 'CPH', 'STO', 'IST', 'DBV', 'KRK', 'BRU',
    ]);
  });

  test('parte dal mese successivo e mantiene partenze nel mese dichiarato', () => {
    const plan = buildSeedPlan(new Date('2026-09-09T00:00:00.000Z'), 2);

    expect(plan.months.map(({ monthName }) => monthName)).toEqual(['ottobre', 'novembre']);
    for (const month of plan.months) {
      expect(month.departureDates.every((date) => date.getUTCMonth() === month.month)).toBe(true);
      expect(month.departureDates.every((date) => date.getUTCDate() <= 25)).toBe(true);
    }
  });

  test('copre le notti oltre il confine dell’ultima finestra, anche a febbraio', () => {
    const plan = buildSeedPlan(new Date('2026-01-10T00:00:00.000Z'), 1);
    const [february] = plan.months;

    expect(february.monthName).toBe('febbraio');
    expect(february.coverageDates.at(-1).toISOString().slice(0, 10)).toBe('2026-03-04');
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
