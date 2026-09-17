import { prisma } from '../db/prisma.js';
import { semanticSearch } from './vectorStore.js';
import { getActivityMedia, getDestinationMedia } from './mediaCatalog.js';
import { canonicalCacheKey, searchCache } from './searchCache.js';
import {
  normalizeCountryCode,
  normalizeLocation,
  resolveAirportReference,
  resolveDestinationReference,
} from './locationNormalization.js';
import { normalizeTravelMonth } from './requirementsService.js';

const MONTHS_IT = [
  'gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno',
  'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre',
];

function monthName(date) {
  return MONTHS_IT[new Date(date).getUTCMonth()];
}

/** Converte "luglio" nel prossimo anno/mese futuro utile e restituisce [start, end] del mese. */
export function monthToDateRange(monthName, referenceDate = new Date()) {
  const idx = MONTHS_IT.indexOf(normalizeTravelMonth(monthName));
  if (idx === -1) return null;
  let year = referenceDate.getUTCFullYear();
  if (idx < referenceDate.getUTCMonth()) year += 1; // mese già passato quest'anno -> prossimo anno
  const start = new Date(Date.UTC(year, idx, 1));
  const end = new Date(Date.UTC(year, idx + 1, 1) - 1);
  return { start, end };
}

function addDays(date, days) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function startOfUtcDay(date) {
  const day = new Date(date);
  day.setUTCHours(0, 0, 0, 0);
  return day;
}

function canonicalNoReturnDiagnostics(attemptedOutbounds = [], alternatives = [], durationDays) {
  const requestedOutbound = attemptedOutbounds[0] || null;
  const requested = requestedOutbound
    ? {
      outbound: requestedOutbound,
      date: requestedOutbound.date,
      durationDays,
      expectedReturnDate: requestedOutbound.expectedReturnDate,
    }
    : { outbound: null, date: null, durationDays, expectedReturnDate: null };
  const expectedTime = Date.parse(requested.expectedReturnDate || '');
  const outboundTime = Date.parse(requested.date || requestedOutbound?.date || '');
  const unique = new Map();

  for (const alternative of alternatives) {
    const availableTime = Date.parse(alternative?.availableReturnDate || '');
    if (!Number.isFinite(availableTime)) continue;
    if (Number.isFinite(outboundTime) && availableTime <= outboundTime) continue;
    const availableReturnDate = new Date(availableTime).toISOString();
    if (unique.has(availableReturnDate)) continue;
    const daysShift = Number.isFinite(expectedTime)
      ? Math.round((availableTime - expectedTime) / 86400000)
      : null;
    unique.set(availableReturnDate, {
      ...alternative,
      availableReturnDate,
      ...(daysShift === null ? {} : {
        daysShift,
        resultingDurationDays: Number.isFinite(durationDays) ? durationDays + daysShift : null,
      }),
    });
  }

  const availableReturns = [...unique.values()]
    .sort((left, right) => left.availableReturnDate.localeCompare(right.availableReturnDate));
  return { requested, availableReturns };
}

/**
 * Cerca un volo andata e uno di ritorno, garantendo coerenza temporale con la durata del
 * soggiorno: il ritorno deve avvenire esattamente `durationDays` notti dopo l'andata (giorni UTC),
 * così che voli, pernottamenti e attività risultino sempre allineati.
 */
async function findFlightPairs(departureAirport, destCountry, destinationCity, dateRange, participants, durationDays) {
  const origin = String(departureAirport).trim();
  const dest = String(destCountry).trim();
  const requestedDestination = String(destinationCity || dest).trim();
  const hasLocationCatalog = Boolean(prisma.airport?.findMany && prisma.destination?.findMany);
  const originEntity = hasLocationCatalog ? await resolveAirportReference(prisma, origin) : null;
  const destinationEntity = hasLocationCatalog ? await resolveDestinationReference(prisma, requestedDestination) : null;
  if (hasLocationCatalog && !originEntity) return { error: 'unknown_origin_airport', pairs: [] };
  if (hasLocationCatalog && !destinationEntity) return { error: 'unknown_destination', pairs: [] };

  const originFilter = originEntity
    ? { originAirportId: originEntity.id }
    : { originAirport: { iataCode: { equals: origin, mode: 'insensitive' } } };
  const returnDestinationFilter = originEntity
    ? { destinationAirportId: originEntity.id }
    : { destinationAirport: { iataCode: { equals: origin, mode: 'insensitive' } } };
  const destinationIsCountry = !destinationCity && destinationEntity
    && (normalizeLocation(destinationEntity.country) === normalizeLocation(dest)
      || normalizeCountryCode(destinationEntity.countryCode) === normalizeCountryCode(dest));
  const destinationFilter = destinationEntity && !destinationIsCountry
    ? { destinationAirportId: { in: destinationEntity.airports.map((airport) => airport.id) } }
    : destinationEntity?.countryCode && destinationIsCountry
      ? { destinationAirport: { destination: { countryCode: destinationEntity.countryCode } } }
      : { destinationAirport: { destination: { country: { equals: dest, mode: 'insensitive' } } } };

  const outboundQuery = {
    where: {
      ...originFilter,
      ...destinationFilter,
      direction: 'outbound',
      date: { gte: dateRange.start, lte: dateRange.end },
      seatsAvailable: { gte: participants },
    },
    include: { originAirport: true, destinationAirport: true },
    orderBy: { cost: 'asc' },
  };
  const outboundOptions = await searchCache.getOrSet(
    canonicalCacheKey('flight-outbound', outboundQuery),
    () => prisma.flight.findMany(outboundQuery),
  );
  if (outboundOptions.length === 0) {
    if (!hasLocationCatalog) return { error: 'no_outbound', pairs: [], alternatives: [] };
    const alternatives = await searchCache.getOrSet(
      canonicalCacheKey('flight-outbound-alternatives', {
        originAirportId: originEntity.id, destinationFilter, participants,
      }),
      () => prisma.flight.findMany({
        where: {
          ...originFilter,
          ...destinationFilter,
          direction: 'outbound',
          date: { gte: startOfUtcDay(new Date()) },
          seatsAvailable: { gte: participants },
        },
        orderBy: { date: 'asc' },
        take: 12,
        select: { date: true, destinationAirport: { select: { city: true } } },
      }),
    );
    return {
      error: 'no_outbound',
      pairs: [],
      alternatives: alternatives.map((flight) => ({ date: flight.date.toISOString(), month: monthName(flight.date), city: flight.destinationAirport.city })),
    };
  }

  // Proviamo le opzioni di andata dalla più economica; per ciascuna cerchiamo un ritorno
  // coerente con la durata richiesta, invece di fermarci alla prima andata trovata.
  const pairs = [];
  const returnAlternatives = [];
  const attemptedOutbounds = [];
  for (const outbound of outboundOptions) {
    const returnDate = addDays(startOfUtcDay(outbound.date), Math.max(0, durationDays - 1));
    const outboundReference = {
      date: outbound.date.toISOString(),
      origin: outbound.originAirport
        ? { iataCode: outbound.originAirport.iataCode, city: outbound.originAirport.city }
        : null,
      destination: outbound.destinationAirport
        ? { iataCode: outbound.destinationAirport.iataCode, city: outbound.destinationAirport.city }
        : null,
      expectedReturnDate: returnDate.toISOString(),
    };
    attemptedOutbounds.push(outboundReference);
    const returnQuery = {
      where: {
        originAirportId: outbound.destinationAirportId,
        ...returnDestinationFilter,
        direction: 'return',
        date: { gte: returnDate, lt: addDays(returnDate, 1) },
        seatsAvailable: { gte: participants },
      },
      include: { originAirport: true, destinationAirport: true },
      orderBy: [{ date: 'asc' }, { cost: 'asc' }],
      take: 1,
    };
    const returnOptions = await searchCache.getOrSet(
      canonicalCacheKey('flight-return', returnQuery),
      () => prisma.flight.findMany(returnQuery),
    );
    if (returnOptions.length > 0) {
      const inbound = returnOptions[0];
      pairs.push({ outbound, inbound, cost: (outbound.cost + inbound.cost) * participants });
    } else {
      const laterReturns = await searchCache.getOrSet(
        canonicalCacheKey('flight-return-alternatives', {
          originAirportId: outbound.destinationAirportId,
          returnDestinationFilter,
          from: returnDate,
          participants,
        }),
        () => prisma.flight.findMany({
          where: {
            originAirportId: outbound.destinationAirportId,
            ...returnDestinationFilter,
            direction: 'return',
            date: { gte: returnDate },
            seatsAvailable: { gte: participants },
          },
          orderBy: [{ date: 'asc' }, { cost: 'asc' }],
          take: 3,
          select: { date: true },
        }),
      );
      for (const inbound of laterReturns) {
        returnAlternatives.push({
          outboundDate: outbound.date.toISOString(),
          expectedReturnDate: returnDate.toISOString(),
          availableReturnDate: inbound.date.toISOString(),
          origin: outboundReference.origin,
          destination: outboundReference.destination,
        });
      }
    }
  }

  return pairs.length > 0
    ? { pairs }
    : { error: 'no_return', pairs: [], alternatives: returnAlternatives, attemptedOutbounds };
}

/** Trova un hotel con disponibilità continuativa per tutte le notti richieste. */
async function findHotelsForDestination(destinationId) {
  if (!destinationId) return null;

  const hotelQuery = {
    where: { destinationId },
    include: { rooms: true },
  };
  return searchCache.getOrSet(
    canonicalCacheKey('hotel-stay', hotelQuery),
    () => prisma.hotel.findMany(hotelQuery),
  );
}

/** Seleziona in memoria un hotel disponibile per tutte le notti richieste. */
function findHotelForStay(hotels, checkIn, nights, maxPricePerNight = Infinity) {
  if (!hotels) return null;

  const candidates = [];
  for (const hotel of hotels) {
    const nightsNeeded = [];
    for (let i = 0; i < nights; i++) nightsNeeded.push(addDays(checkIn, i).toISOString().slice(0, 10));

    const availabilityByDate = Object.fromEntries(
      hotel.rooms.map((r) => [r.date.toISOString().slice(0, 10), r])
    );

    const allAvailable = nightsNeeded.every((d) => {
      const room = availabilityByDate[d];
      return room && room.roomsAvailable > 0 && room.pricePerNight <= maxPricePerNight;
    });

    if (allAvailable) {
      const totalCost = nightsNeeded.reduce((sum, d) => sum + availabilityByDate[d].pricePerNight, 0);
      candidates.push({
        hotel,
        totalCost,
        nights: nightsNeeded,
        prices: Object.fromEntries(nightsNeeded.map((day) => [day, availabilityByDate[day].pricePerNight])),
      });
    }
  }

  candidates.sort((a, b) => a.totalCost - b.totalCost);
  return candidates[0] || null;
}

function activityKey(activity) {
  return activity.id || activity.activityId;
}

function selectionScore(candidate, usedIds, usedCategories, coveredPreferences) {
  const activityId = activityKey(candidate);
  const category = candidate.metadata?.category;
  const preferenceBonus = candidate.preferenceIndexes
    .filter((index) => !coveredPreferences.has(index))
    .length * 0.08;
  const varietyBonus = usedIds.has(activityId)
    ? -0.15
    : (category && usedCategories.has(category) ? 0.03 : 0.12);

  return candidate.score + preferenceBonus + varietyBonus;
}

/**
 * Ottimizza una selezione già normalizzata. La ricerca mantiene più piani candidati
 * contemporaneamente invece di fissare la scelta del giorno corrente: in questo modo
 * un'attività costosa o molto richiesta non può consumare il budget/capacità necessari
 * per una combinazione migliore nei giorni successivi.
 */
export const ACTIVITY_SOLVER_TIME_LIMIT_MS = 250;

function activityTimeWindow(availability) {
  const startMinute = availability.startMinute ?? 0;
  const endMinute = availability.endMinute ?? 24 * 60;
  if (!Number.isInteger(startMinute) || !Number.isInteger(endMinute)
    || startMinute < 0 || endMinute > 24 * 60 || startMinute >= endMinute) {
    return null;
  }
  return { startMinute, endMinute };
}

function overlaps(left, right) {
  return left.startMinute < right.endMinute && right.startMinute < left.endMinute;
}

function chosenActivity(candidate, date, day, cost) {
  const window = activityTimeWindow(candidate.availability);
  return {
    day,
    date,
    activityId: activityKey(candidate),
    availabilityId: candidate.availability.id,
    name: candidate.metadata?.name,
    category: candidate.metadata?.category,
    cost,
    matchScore: candidate.score,
    startMinute: window?.startMinute,
    endMinute: window?.endMinute,
  };
}

export function optimizeActivitySelection({
  days,
  participants,
  budgetRemaining,
  candidatesByDate,
  maxActivitiesPerDay = Infinity,
  timeLimitMs = ACTIVITY_SOLVER_TIME_LIMIT_MS,
}) {
  const beamWidth = 250;
  const dailyBeamWidth = 64;
  const startedAt = Date.now();
  const limit = Math.max(0, Number.isFinite(timeLimitMs) ? timeLimitMs : ACTIVITY_SOLVER_TIME_LIMIT_MS);
  let timedOut = false;
  const isOverTime = () => Date.now() - startedAt >= limit;
  let states = [{
    chosen: [],
    spent: 0,
    usedIds: new Set(),
    usedCategories: new Set(),
    coveredPreferences: new Set(),
    score: 0,
  }];

  for (let day = 0; day < days && !timedOut; day++) {
    if (isOverTime()) {
      timedOut = true;
      break;
    }
    const date = candidatesByDate[day]?.date;
    const candidates = candidatesByDate[day]?.candidates || [];
    const nextStates = [];

    for (const state of states) {
      if (isOverTime()) {
        timedOut = true;
        break;
      }
      // Lasciare un giorno libero è una scelta lecita quando tutti i candidati violano
      // un vincolo; la penalità evita però che diventi preferibile senza motivo.
      let dailyPlans = [{
        chosen: [],
        spent: 0,
        usedIds: new Set(),
        usedCategories: new Set(),
        coveredPreferences: new Set(),
        occupied: [],
        score: 0,
      }];

      for (const candidate of candidates) {
        if (isOverTime()) {
          timedOut = true;
          break;
        }
        const cost = candidate.availability.cost * participants;
        const freeCapacity = candidate.availability.capacity - candidate.availability.booked;
        const activityId = activityKey(candidate);
        const window = activityTimeWindow(candidate.availability);
        if (freeCapacity < participants || !window) continue;

        const plansBeforeCandidate = [...dailyPlans];
        for (const plan of plansBeforeCandidate) {
          if (plan.chosen.length >= maxActivitiesPerDay) continue;
          if (plan.usedIds.has(activityId)
            || state.spent + plan.spent + cost > budgetRemaining
            || plan.occupied.some((occupied) => overlaps(occupied, window))) continue;

          const coveredPreferences = new Set(plan.coveredPreferences);
          candidate.preferenceIndexes.forEach((index) => coveredPreferences.add(index));
          const usedIds = new Set(plan.usedIds);
          const usedCategories = new Set(plan.usedCategories);
          const incrementalScore = selectionScore(
            candidate,
            new Set([...state.usedIds, ...plan.usedIds]),
            new Set([...state.usedCategories, ...plan.usedCategories]),
            new Set([...state.coveredPreferences, ...plan.coveredPreferences]),
          );
          usedIds.add(activityId);
          if (candidate.metadata?.category) usedCategories.add(candidate.metadata.category);
          dailyPlans.push({
            chosen: [...plan.chosen, chosenActivity(candidate, date, day + 1, cost)],
            spent: plan.spent + cost,
            usedIds,
            usedCategories,
            coveredPreferences,
            occupied: [...plan.occupied, window],
            score: plan.score + incrementalScore,
          });
        }
        dailyPlans = dailyPlans
          .sort((a, b) => b.score - a.score)
          .slice(0, dailyBeamWidth);
      }

      if (timedOut) break;
      for (const plan of dailyPlans) {
        const usedIds = new Set([...state.usedIds, ...plan.usedIds]);
        const usedCategories = new Set([...state.usedCategories, ...plan.usedCategories]);
        const coveredPreferences = new Set([...state.coveredPreferences, ...plan.coveredPreferences]);
        nextStates.push({
          chosen: [...state.chosen, ...plan.chosen],
          spent: state.spent + plan.spent,
          usedIds,
          usedCategories,
          coveredPreferences,
          score: state.score + plan.score + (plan.chosen.length === 0 ? -0.35 : 0),
        });
      }
    }

    if (timedOut) break;

    // Deduplicare per budget/attività/categorie limita la crescita senza perdere
    // combinazioni con compromessi diversi.
    const bestBySignature = new Map();
    for (const state of nextStates) {
      const signature = [
        state.spent.toFixed(2),
        [...state.usedIds].sort().join(','),
        [...state.usedCategories].sort().join(','),
        state.chosen.map((item) => `${item?.date || '-'}:${item?.activityId || '-'}:${item?.startMinute ?? ''}`).join(','),
      ].join('|');
      const previous = bestBySignature.get(signature);
      if (!previous || state.score > previous.score) bestBySignature.set(signature, state);
    }
    states = [...bestBySignature.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, beamWidth);
  }

  const best = states.sort((a, b) => {
    const coverageDifference = b.coveredPreferences.size - a.coveredPreferences.size;
    return coverageDifference || b.score - a.score;
  })[0] || { chosen: [], spent: 0 };

  const chosen = best.chosen.filter(Boolean);
  const coveredDays = [...new Set(chosen.map((item) => item.day))].sort((a, b) => a - b);
  const uncoveredDays = Array.from({ length: days }, (_, index) => index + 1)
    .filter((day) => !coveredDays.includes(day));
  return {
    chosen,
    cost: best.spent,
    coveredDays,
    uncoveredDays,
    daysWithoutActivity: uncoveredDays.length,
    timedOut,
    elapsedMs: Date.now() - startedAt,
  };
}

/**
 * Il beam solver privilegia qualità e varietà; se raggiunge il suo limite di
 * tempo, completiamo i giorni rimasti con una scelta lineare verificabile.
 * L'itinerario demo richiede una sola attività principale per giorno, quindi
 * questa fase non introduce conflitti di orario tra attività della stessa data.
 */
export function completeActivityCoverage(selection, {
  candidatesByDate, participants, budgetRemaining,
}) {
  const chosen = [...selection.chosen];
  const coveredDays = new Set(chosen.map((item) => item.day));
  let cost = selection.cost;

  for (let index = 0; index < candidatesByDate.length; index++) {
    const day = index + 1;
    if (coveredDays.has(day)) continue;
    const { date, candidates = [] } = candidatesByDate[index];
    const candidate = candidates.find(({ availability }) => {
      const activityCost = Number(availability.cost) * participants;
      const freeCapacity = Number(availability.capacity) - Number(availability.booked || 0);
      return freeCapacity >= participants
        && activityTimeWindow(availability)
        && Number.isFinite(activityCost)
        && cost + activityCost <= budgetRemaining;
    });
    if (!candidate) continue;
    const activityCost = Number(candidate.availability.cost) * participants;
    chosen.push(chosenActivity(candidate, date, day, activityCost));
    cost += activityCost;
    coveredDays.add(day);
  }

  const sortedChosen = chosen.sort((left, right) => left.day - right.day);
  const sortedCoveredDays = [...coveredDays].sort((left, right) => left - right);
  const uncoveredDays = Array.from({ length: candidatesByDate.length }, (_, index) => index + 1)
    .filter((day) => !coveredDays.has(day));
  return {
    ...selection,
    chosen: sortedChosen,
    cost,
    coveredDays: sortedCoveredDays,
    uncoveredDays,
    daysWithoutActivity: uncoveredDays.length,
    // La fase lineare ha verificato tutti i giorni rimasti: non presentiamo un
    // timeout del solver come indisponibilità del catalogo.
    timedOut: false,
  };
}

/**
 * Recupera le disponibilità e prepara i candidati per l'ottimizzatore globale.
 */
async function selectActivities(
  country,
  destinationId,
  destinationCity,
  preferences,
  checkIn,
  days,
  participants,
  budgetRemaining,
) {
  const prefList = preferences.length > 0 ? preferences : ['generico'];
  const scoreByActivity = new Map();

  for (let preferenceIndex = 0; preferenceIndex < prefList.length; preferenceIndex++) {
    const results = await semanticSearch(
      `Attività di tipo: ${prefList[preferenceIndex]}`,
      {
        type: 'activity',
        country,
        destinationId,
        destinationCity,
        topK: 20,
      },
    );
    for (const result of results) {
      const previous = scoreByActivity.get(result.id);
      if (!previous) {
        scoreByActivity.set(result.id, {
          ...result,
          preferenceIndexes: [preferenceIndex],
        });
      } else {
        previous.preferenceIndexes.push(preferenceIndex);
        previous.score = Math.max(previous.score, result.score);
      }
    }
  }

  const ranked = [...scoreByActivity.values()].sort((a, b) => b.score - a.score);
  const dates = Array.from({ length: days }, (_, day) => addDays(checkIn, day));
  const availability = await prisma.activityAvailability.findMany({
    where: {
      activityId: { in: ranked.map((candidate) => candidate.id) },
      activity: { destinationId },
      date: { gte: dates[0], lt: addDays(dates[dates.length - 1], 1) },
    },
  });
  const availabilityByDate = new Map();
  for (const item of availability) {
    const key = `${item.activityId}|${item.date.toISOString().slice(0, 10)}`;
    const slots = availabilityByDate.get(key) || [];
    slots.push(item);
    availabilityByDate.set(key, slots);
  }

  const candidatesByDate = dates.map((date) => {
    const dateKey = date.toISOString().slice(0, 10);
    return {
      date: dateKey,
      candidates: ranked.flatMap((candidate) => (
        availabilityByDate.get(`${candidate.id}|${dateKey}`) || []
      ).map((slot) => ({
        ...candidate,
        availability: slot,
      }))),
    };
  });

  // Nell'itinerario demo proponiamo una sola attività principale al giorno.
  // Evita che il solver esplori combinazioni superflue (e che sulle istanze
  // con CPU ridotta esaurisca il tempo pur avendo attività disponibili).
  const selection = optimizeActivitySelection({
    days,
    participants,
    budgetRemaining,
    candidatesByDate,
    maxActivitiesPerDay: 1,
  });
  return selection.uncoveredDays.length > 0
    ? completeActivityCoverage(selection, { candidatesByDate, participants, budgetRemaining })
    : selection;
}

/**
 * Genera un itinerario a partire dai requisiti. Se i vincoli stretti non sono soddisfacibili,
 * tenta una versione "rilassata" (hotel più economico) e la restituisce come alternativa,
 * indicando esplicitamente i compromessi applicati.
 */
export async function generateItinerary(requirements, onProgress = async () => {}) {
  const {
    budget, country, destinationCity, departureAirport, activityPreferences, travelMonth, durationDays, participants,
    outboundDate,
  } = requirements;
  const stayNights = Math.max(1, Number(durationDays) - 1);

  const explicitOutbound = outboundDate ? startOfUtcDay(new Date(outboundDate)) : null;
  const dateRange = explicitOutbound && !Number.isNaN(explicitOutbound.getTime())
    ? { start: explicitOutbound, end: new Date(addDays(explicitOutbound, 1).getTime() - 1) }
    : monthToDateRange(travelMonth);
  if (!dateRange) {
    return { errorCode: 'invalid_month', error: `Mese "${travelMonth}" non riconosciuto.` };
  }

  await onProgress(20, 'Ricerca voli');
  const flights = await findFlightPairs(departureAirport, country, destinationCity, dateRange, participants, durationDays);
  if (flights.error === 'unknown_origin_airport') {
    return {
      errorCode: flights.error,
      error: `L'aeroporto di partenza "${departureAirport}" non è riconosciuto dal catalogo. Usa un codice IATA o una città con voli disponibili.`,
    };
  }
  if (flights.error === 'unknown_destination') {
    return {
      errorCode: flights.error,
      error: `La destinazione "${country}" non è presente nel catalogo. Prova una nazione o città supportata.`,
    };
  }
  if (flights.error === 'no_outbound') {
    const months = [...new Set(flights.alternatives.map(({ month }) => month))];
    const suggestion = months.length > 0
      ? ` Mesi disponibili nel catalogo: ${months.join(', ')}.`
      : ' Non risultano mesi futuri disponibili per questa rotta.';
    return {
      errorCode: flights.error,
      error: `Nessun volo da ${departureAirport} verso ${country} nel mese richiesto.${suggestion}`,
      alternatives: flights.alternatives,
    };
  }
  if (flights.error === 'no_return') {
    const selectedOutbound = flights.attemptedOutbounds?.[0];
    const diagnostics = canonicalNoReturnDiagnostics(flights.attemptedOutbounds, flights.alternatives, durationDays);
    const returnDates = diagnostics.availableReturns.map(({ availableReturnDate }) => availableReturnDate.slice(0, 10));
    const suggestion = returnDates.length > 0
      ? ` Ritorni disponibili dal catalogo: ${returnDates.join(', ')}.`
      : ' Non risultano ritorni successivi compatibili per questa rotta.';
    return {
      errorCode: flights.error,
      error: selectedOutbound
        ? `Trovato un volo di andata ${selectedOutbound.origin?.iataCode || departureAirport}${selectedOutbound.origin?.city ? ` (${selectedOutbound.origin.city})` : ''} → ${selectedOutbound.destination?.iataCode || country}${selectedOutbound.destination?.city ? ` (${selectedOutbound.destination.city})` : ''} il ${selectedOutbound.date.slice(0, 10)}, ma nessun ritorno compatibile con ${durationDays} giorni di soggiorno (ritorno atteso il ${selectedOutbound.expectedReturnDate.slice(0, 10)}).${suggestion}`
        : `Trovato un volo di andata, ma nessun ritorno compatibile con ${durationDays} giorni di soggiorno.${suggestion}`,
      alternatives: diagnostics.availableReturns,
      outbound: selectedOutbound || null,
      requested: diagnostics.requested,
      availableReturns: diagnostics.availableReturns,
    };
  }

  const firstPair = flights.pairs[0];
  // Il costo della coppia viene verificato per ogni candidato in `attempt`,
  // così una prima coppia fuori budget non impedisce di valutarne altre.

  const hotelInventories = new Map();
  const getHotels = async (destinationId) => {
    if (!hotelInventories.has(destinationId)) {
      hotelInventories.set(destinationId, await findHotelsForDestination(destinationId));
    }
    return hotelInventories.get(destinationId);
  };

  const attempt = async (flightPair, maxHotelPrice, compromises) => {
    const checkIn = startOfUtcDay(flightPair.outbound.date);
    const destinationId = flightPair.outbound.destinationAirport.destinationId;
    if (flightPair.cost > budget) return { status: 'flight_over_budget' };
    await onProgress(45, 'Ricerca hotel');
    const hotelPick = findHotelForStay(
      await getHotels(destinationId), checkIn, stayNights, maxHotelPrice,
    );
    if (!hotelPick) return { status: 'no_hotel' };

    const hotelCost = hotelPick.totalCost * participants;
    const budgetAfterHotel = budget - flightPair.cost - hotelCost;
    if (budgetAfterHotel < 0) return { status: 'hotel_over_budget' };

    await onProgress(70, 'Selezione attività');
    const activities = await selectActivities(
      country,
      destinationId,
      flightPair.outbound.destinationAirport.city,
      activityPreferences,
      checkIn,
      stayNights,
      participants,
      budgetAfterHotel,
    );

    const totalCost = flightPair.cost + hotelCost + activities.cost;
    const allCompromises = [...compromises];
    if (activities.daysWithoutActivity > 0) {
      allCompromises.push(
        `${activities.daysWithoutActivity} giorno/i senza attività proposta per budget/capacità residui insufficienti.`
      );
    }
    if (activities.timedOut) {
      allCompromises.push('Selezione attivitÃ  arrestata al limite temporale del solver; mantenuti solo i candidati giÃ  verificati.');
    }

    return {
      status: activities.uncoveredDays.length === 0 ? 'ok' : 'activity_coverage_incomplete',
      activityCoverage: {
        coveredDays: activities.coveredDays,
        uncoveredDays: activities.uncoveredDays,
        complete: activities.uncoveredDays.length === 0,
      },
      flights: flightPair,
      hotel: hotelPick,
      destinationMedia: getDestinationMedia(country, flightPair.outbound.destinationAirport.city),
      activities: activities.chosen.map((activity) => ({
        ...activity,
        media: getActivityMedia(activity.name),
      })),
      totalCost,
      breakdown: { flightCost: flightPair.cost, hotelCost, activityCost: activities.cost },
      compromises: allCompromises,
      budget,
      budgetDelta: budget - totalCost,
      withinBudget: totalCost <= budget,
    };
  };

  // Tentativo 1: nessun vincolo extra sul prezzo hotel
  let result = await attempt(firstPair, Infinity, []);

  // Tentativo 2 (alternativa): se non trovato o fuori budget, ricalcola con hotel più economico
  let alternative = null;
  if (result.status === 'hotel_over_budget'
      || (result.status === 'ok' && !result.withinBudget)) {
    const avgNightlyBudget = (budget - firstPair.cost) / Math.max(1, durationDays - 1) / participants;
    alternative = await attempt(firstPair, Math.max(avgNightlyBudget * 0.7, 20), [
      'Selezionato hotel con fascia di prezzo inferiore per rientrare nel budget.',
    ]);
  }

  const isDistinctOption = (candidate, reference) => candidate?.status === 'ok'
    && (!reference || reference.status !== 'ok'
      || candidate.flights.outbound.id !== reference.flights.outbound.id
      || candidate.flights.inbound.id !== reference.flights.inbound.id
      || candidate.hotel.hotel.id !== reference.hotel.hotel.id
      || candidate.hotel.nights.join(',') !== reference.hotel.nights.join(','));

  if (!isDistinctOption(alternative, result)) alternative = null;

  // Se la prima coppia non ha un soggiorno compatibile, proviamo le altre coppie
  // volo già trovate. Ogni coppia ricalcola date, destinazione, disponibilità e budget.
  if ((!alternative || alternative.status !== 'ok')
      && (result.status !== 'ok' || !result.withinBudget)) {
    for (const flightPair of flights.pairs.slice(1)) {
      let candidate = await attempt(flightPair, Infinity, [
        'Selezionata una coppia di voli alternativa con hotel compatibile.',
      ]);
      if (candidate.status === 'hotel_over_budget') {
        const avgNightlyBudget = (budget - flightPair.cost) / Math.max(1, durationDays - 1) / participants;
        candidate = await attempt(flightPair, Math.max(avgNightlyBudget * 0.7, 20), [
          'Selezionata una coppia di voli alternativa con hotel compatibile.',
          'Selezionato hotel con fascia di prezzo inferiore per rientrare nel budget.',
        ]);
      }
      if (isDistinctOption(candidate, result)) {
        alternative = candidate;
        break;
      }
    }
  }

  if (result.status === 'flight_over_budget' && (!alternative || alternative.status !== 'ok')) {
    return {
      errorCode: 'flight_over_budget',
      error: 'Il costo della coppia di voli supera il budget indicato.',
      alternatives: flights.pairs.slice(1, 5).map((pair) => ({
        outboundDate: pair.outbound.date.toISOString(),
        returnDate: pair.inbound.date.toISOString(),
        totalFlightCost: pair.cost,
      })),
    };
  }

  if (result.status !== 'ok' && (!alternative || alternative.status !== 'ok')) {
    if (result.status === 'activity_coverage_incomplete') {
      return {
        errorCode: 'activity_coverage_incomplete',
        error: `Nessuna proposta copre tutte le ${stayNights} giornate utili con attività disponibili entro i vincoli.`,
        uncoveredDays: result.activityCoverage?.uncoveredDays || [],
        alternatives: [],
      };
    }
    const issue = result.status === 'no_hotel'
      ? { errorCode: 'no_hotel', error: 'Nessun hotel con disponibilità continuativa per tutte le notti richieste.' }
      : { errorCode: 'hotel_over_budget', error: 'Il costo dell\'hotel, anche nella fascia più economica, supera il budget residuo dopo i voli.' };
    return { ...issue, alternatives: flights.pairs.slice(1, 5).map((pair) => ({
      outboundDate: pair.outbound.date.toISOString(),
      returnDate: pair.inbound.date.toISOString(),
      totalFlightCost: pair.cost,
    })) };
  }

  // Una proposta con copertura incompleta resta visibile solo come parziale:
  // contiene i giorni scoperti e non puÃ² essere salvata/prenotata come completa.
  return { primary: ['ok', 'activity_coverage_incomplete'].includes(result.status) ? result : null, alternative };
}
