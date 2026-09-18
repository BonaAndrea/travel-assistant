import {
  normalizeCountryCode,
  resolveAirportReference,
  resolveDestinationReference,
} from '../src/services/locationNormalization.js';

describe('resolver geografico', () => {
  const destination = {
    id: 'destination-1',
    country: 'Messico',
    city: 'Città del Messico',
    airports: [{ id: 'airport-1', iataCode: 'MEX', name: 'Benito Juárez', city: 'Città del Messico' }],
  };
  const db = {
    airport: { findMany: async () => destination.airports.map((airport) => ({ ...airport, destination })) },
    destination: { findMany: async () => [destination] },
  };

  test.each(['MEX', 'mex', 'Benito Juarez', 'citta del messico'])('risolve aeroporto da %s', async (input) => {
    await expect(resolveAirportReference(db, input)).resolves.toMatchObject({ id: 'airport-1' });
  });

  test('risolve il nome umano parziale dell’aeroporto seed MXP', async () => {
    const milano = { id: 'airport-mxp', iataCode: 'MXP', name: 'Aeroporto di Milano Malpensa', city: 'Milano' };
    const milanoDb = { airport: { findMany: async () => [milano] } };
    await expect(resolveAirportReference(milanoDb, '  milano   malpensa ')).resolves.toMatchObject({ id: 'airport-mxp' });
    await expect(resolveAirportReference(milanoDb, 'mxp')).resolves.toMatchObject({ id: 'airport-mxp' });
    await expect(resolveAirportReference(milanoDb, 'MILANO')).resolves.toMatchObject({ id: 'airport-mxp' });
    await expect(resolveAirportReference(milanoDb, 'malpensa')).resolves.toMatchObject({ id: 'airport-mxp' });
  });

  test('non accetta parziali troppo corti o ambigui', async () => {
    const airports = [
      { id: 'airport-mxp', iataCode: 'MXP', name: 'Aeroporto di Milano Malpensa', city: 'Milano' },
      { id: 'airport-lin', iataCode: 'LIN', name: 'Aeroporto di Milano Linate', city: 'Milano' },
    ];
    const airportDb = { airport: { findMany: async () => airports } };
    await expect(resolveAirportReference(airportDb, 'mil')).resolves.toBeNull();
    await expect(resolveAirportReference(airportDb, 'milano')).resolves.toBeNull();
  });

  test.each(['Messico', 'citta del messico', 'MEX'])('risolve destinazione da %s', async (input) => {
    await expect(resolveDestinationReference(db, input)).resolves.toMatchObject({ id: 'destination-1' });
  });

  test.each(['Spagna', 'Spain', 'es'])('risolve alias paese %s tramite codice catalogo', async (input) => {
    const spainDb = { destination: { findMany: async () => [{
      id: 'destination-spain', country: 'Spagna', countryCode: 'ES', city: 'Barcellona', airports: [],
    }] } };
    await expect(resolveDestinationReference(spainDb, input)).resolves.toMatchObject({ id: 'destination-spain' });
  });

  test.each(['Turkey', 'T\u00fcrkiye', 'turkiye', 'TR'])('risolve gli alias della Turchia seedata: %s', async (input) => {
    const turkeyDb = { destination: { findMany: async () => [{
      id: 'destination-turkey', country: 'Turchia', countryCode: 'TR', city: 'Istanbul', airports: [],
    }] } };
    await expect(resolveDestinationReference(turkeyDb, input)).resolves.toMatchObject({ id: 'destination-turkey' });
  });

  test('normalizza il codice paese ISO alpha-2', () => {
    expect(normalizeCountryCode(' es ')).toBe('ES');
    expect(normalizeCountryCode('Spagna')).toBeNull();
  });

  test('risolve una destinazione anche dal codice ISO', async () => {
    const isoDb = {
      destination: {
        findMany: async () => [{ ...destination, countryCode: 'MX' }],
      },
    };
    await expect(resolveDestinationReference(isoDb, 'mx')).resolves.toMatchObject({ id: 'destination-1' });
  });
});
