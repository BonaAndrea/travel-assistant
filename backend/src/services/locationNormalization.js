/**
 * Chiave stabile per confrontare input geografici senza distinguere maiuscole,
 * accenti, punteggiatura o spazi.
 */
export function normalizeLocation(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('it-IT')
    .replace(/[^a-z0-9]+/g, '');
}

/** Normalizza un codice ISO 3166-1 alpha-2, se formalmente riconoscibile. */
export function normalizeCountryCode(value) {
  const code = String(value || '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : null;
}

const COUNTRY_ALIASES = new Map([
  ['italy', 'IT'], ['italia', 'IT'], ['spain', 'ES'], ['spagna', 'ES'],
  ['portugal', 'PT'], ['portogallo', 'PT'], ['france', 'FR'], ['francia', 'FR'],
  ['greece', 'GR'], ['grecia', 'GR'], ['czechrepublic', 'CZ'], ['repubblicaceca', 'CZ'],
  ['netherlands', 'NL'], ['paesibassi', 'NL'], ['holland', 'NL'], ['olanda', 'NL'],
  ['germany', 'DE'], ['germania', 'DE'], ['austria', 'AT'], ['hungary', 'HU'], ['ungheria', 'HU'],
  ['ireland', 'IE'], ['irlanda', 'IE'], ['denmark', 'DK'], ['danimarca', 'DK'],
  ['sweden', 'SE'], ['svezia', 'SE'], ['turkey', 'TR'], ['turkiye', 'TR'], ['turchia', 'TR'],
  ['croatia', 'HR'], ['croazia', 'HR'], ['poland', 'PL'], ['polonia', 'PL'],
  ['belgium', 'BE'], ['belgio', 'BE'],
]);

function countryCodeForInput(value) {
  return normalizeCountryCode(value) || COUNTRY_ALIASES.get(normalizeLocation(value));
}

function matches(value, input) {
  return normalizeLocation(value) === normalizeLocation(input);
}

function airportExactMatches(airport, input) {
  return [airport.iataCode, airport.city, airport.name].some((value) => matches(value, input));
}

function airportPartialMatches(airport, input) {
  const normalizedInput = normalizeLocation(input);
  // Il parziale serve per nomi umani come "Milano Malpensa", ma non deve
  // trasformare input troppo corti in un match casuale.
  return normalizedInput.length >= 5
    && [airport.name, airport.city].some((value) => {
      const normalizedValue = normalizeLocation(value);
      return normalizedValue.includes(normalizedInput);
    });
}

function findAirport(airports, input) {
  const exact = airports.filter((airport) => airportExactMatches(airport, input));
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;
  const partial = airports.filter((airport) => airportPartialMatches(airport, input));
  return partial.length === 1 ? partial[0] : null;
}

/** Risolve IATA, città o nome aeroporto usando il catalogo relazionale. */
export async function resolveAirportReference(db, input) {
  if (!input || !db?.airport?.findMany) return null;
  const airports = await db.airport.findMany({ include: { destination: true } });
  return findAirport(airports, input);
}

/** Risolve paese, città, IATA o nome aeroporto alla destinazione catalogata. */
export async function resolveDestinationReference(db, input) {
  if (!input || !db?.destination?.findMany) return null;
  const destinations = await db.destination.findMany({ include: { airports: true } });
  const countryCode = countryCodeForInput(input);
  return destinations.find((destination) => (
    matches(destination.country, input)
    || (countryCode && normalizeCountryCode(destination.countryCode) === countryCode)
    || matches(destination.city, input)
    || destination.airports.some((airport) => airportExactMatches(airport, input)
      || airportPartialMatches(airport, input))
  )) || null;
}
