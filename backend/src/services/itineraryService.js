import { prisma } from '../db/prisma.js';
import { semanticSearch } from './vectorStore.js';

const MONTHS_IT = [
  'gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno',
  'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre',
];

/** Converte "luglio" nel prossimo anno/mese futuro utile e restituisce [start, end] del mese. */
export function monthToDateRange(monthName, referenceDate = new Date()) {
  const idx = MONTHS_IT.indexOf(String(monthName).trim().toLowerCase());
  if (idx === -1) return null;
  let year = referenceDate.getFullYear();
  if (idx < referenceDate.getMonth()) year += 1; // mese già passato quest'anno -> prossimo anno
  const start = new Date(Date.UTC(year, idx, 1));
  const end = new Date(Date.UTC(year, idx + 1, 0));
  return { start, end };
}

function addDays(date, days) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

/**
 * Cerca un volo andata e uno di ritorno, garantendo coerenza temporale con la durata del
 * soggiorno: il ritorno deve avvenire ad almeno `durationDays` notti di distanza dall'andata,
 * così che voli, pernottamenti e attività risultino sempre allineati.
 */
async function findFlightPair(departureAirport, destCountry, dateRange, participants, durationDays) {
  const origin = String(departureAirport).trim();
  const dest = String(destCountry).trim();

  const outboundOptions = await prisma.flight.findMany({
    where: {
      originAirport: { iataCode: { equals: origin, mode: 'insensitive' } },
      destinationAirport: { destination: { country: { equals: dest, mode: 'insensitive' } } },
      direction: 'outbound',
      date: { gte: dateRange.start, lte: dateRange.end },
      seatsAvailable: { gte: participants },
    },
    include: { originAirport: true, destinationAirport: true },
    orderBy: { cost: 'asc' },
  });
  if (outboundOptions.length === 0) {
    return { error: 'no_outbound' };
  }

  // Proviamo le opzioni di andata dalla più economica; per ciascuna cerchiamo un ritorno
  // coerente con la durata richiesta, invece di fermarci alla prima andata trovata.
  for (const outbound of outboundOptions) {
    const minReturnDate = addDays(outbound.date, durationDays);
    const returnOptions = await prisma.flight.findMany({
      where: {
        originAirport: { destination: { country: { equals: dest, mode: 'insensitive' } } },
        destinationAirport: { iataCode: { equals: origin, mode: 'insensitive' } },
        direction: 'return',
        date: { gte: minReturnDate },
        seatsAvailable: { gte: participants },
      },
      include: { originAirport: true, destinationAirport: true },
      orderBy: [{ date: 'asc' }, { cost: 'asc' }],
      take: 1,
    });
    if (returnOptions.length > 0) {
      const inbound = returnOptions[0];
      return { outbound, inbound, cost: (outbound.cost + inbound.cost) * participants };
    }
  }

  return { error: 'no_return' };
}

/** Trova un hotel con disponibilità continuativa per tutte le notti richieste. */
async function findHotelForStay(country, checkIn, nights, maxPricePerNight = Infinity) {
  const destination = await prisma.destination.findFirst({
    where: { country: { equals: String(country).trim(), mode: 'insensitive' } },
  });
  if (!destination) return null;

  const hotels = await prisma.hotel.findMany({
    where: { destinationId: destination.id },
    include: { rooms: true },
  });

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
      candidates.push({ hotel, totalCost, nights: nightsNeeded });
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
export function optimizeActivitySelection({ days, participants, budgetRemaining, candidatesByDate }) {
  const beamWidth = 250;
  let states = [{
    chosen: [],
    spent: 0,
    usedIds: new Set(),
    usedCategories: new Set(),
    coveredPreferences: new Set(),
    score: 0,
  }];

  for (let day = 0; day < days; day++) {
    const date = candidatesByDate[day]?.date;
    const candidates = candidatesByDate[day]?.candidates || [];
    const nextStates = [];

    for (const state of states) {
      // Lasciare un giorno libero è una scelta lecita quando tutti i candidati violano
      // un vincolo; la penalità evita però che diventi preferibile senza motivo.
      nextStates.push({
        ...state,
        chosen: [...state.chosen, null],
        score: state.score - 0.35,
      });

      for (const candidate of candidates) {
        const cost = candidate.availability.cost * participants;
        const freeCapacity = candidate.availability.capacity - candidate.availability.booked;
        if (freeCapacity < participants || state.spent + cost > budgetRemaining) continue;

        const activityId = activityKey(candidate);
        const category = candidate.metadata?.category;
        const coveredPreferences = new Set(state.coveredPreferences);
        candidate.preferenceIndexes.forEach((index) => coveredPreferences.add(index));
        const usedIds = new Set(state.usedIds);
        const usedCategories = new Set(state.usedCategories);
        const incrementalScore = selectionScore(
          candidate,
          state.usedIds,
          state.usedCategories,
          state.coveredPreferences,
        );
        usedIds.add(activityId);
        if (category) usedCategories.add(category);

        nextStates.push({
          chosen: [...state.chosen, {
            day: day + 1,
            date,
            activityId,
            name: candidate.metadata?.name,
            category,
            cost,
            matchScore: candidate.score,
          }],
          spent: state.spent + cost,
          usedIds,
          usedCategories,
          coveredPreferences,
          score: state.score + incrementalScore,
        });
      }
    }

    // Deduplicare per budget/attività/categorie limita la crescita senza perdere
    // combinazioni con compromessi diversi.
    const bestBySignature = new Map();
    for (const state of nextStates) {
      const signature = [
        state.spent.toFixed(2),
        [...state.usedIds].sort().join(','),
        [...state.usedCategories].sort().join(','),
        state.chosen.map((item) => item?.activityId || '-').join(','),
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

  return {
    chosen: best.chosen.filter(Boolean),
    cost: best.spent,
    daysWithoutActivity: days - best.chosen.filter(Boolean).length,
  };
}

/**
 * Recupera le disponibilità e prepara i candidati per l'ottimizzatore globale.
 */
async function selectActivities(country, preferences, checkIn, days, participants, budgetRemaining) {
  const prefList = preferences.length > 0 ? preferences : ['generico'];
  const scoreByActivity = new Map();

  for (let preferenceIndex = 0; preferenceIndex < prefList.length; preferenceIndex++) {
    const results = await semanticSearch(
      `Attività di tipo: ${prefList[preferenceIndex]}`,
      { type: 'activity', country, topK: 20 },
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
      date: { gte: dates[0], lte: dates[dates.length - 1] },
    },
  });
  const availabilityByDate = new Map(
    availability.map((item) => [`${item.activityId}|${item.date.toISOString().slice(0, 10)}`, item]),
  );

  const candidatesByDate = dates.map((date) => {
    const dateKey = date.toISOString().slice(0, 10);
    return {
      date: dateKey,
      candidates: ranked
        .map((candidate) => ({
          ...candidate,
          availability: availabilityByDate.get(`${candidate.id}|${dateKey}`),
        }))
        .filter((candidate) => candidate.availability),
    };
  });

  return optimizeActivitySelection({ days, participants, budgetRemaining, candidatesByDate });
}

/**
 * Genera un itinerario a partire dai requisiti. Se i vincoli stretti non sono soddisfacibili,
 * tenta una versione "rilassata" (hotel più economico) e la restituisce come alternativa,
 * indicando esplicitamente i compromessi applicati.
 */
export async function generateItinerary(requirements) {
  const { budget, country, departureAirport, activityPreferences, travelMonth, durationDays, participants } = requirements;

  const dateRange = monthToDateRange(travelMonth);
  if (!dateRange) {
    return { error: `Mese "${travelMonth}" non riconosciuto.` };
  }

  const flights = await findFlightPair(departureAirport, country, dateRange, participants, durationDays);
  if (flights.error === 'no_outbound') {
    return { error: `Nessun volo da ${departureAirport} verso ${country} nel periodo richiesto. Prova a variare il mese o l'aeroporto di partenza.` };
  }
  if (flights.error === 'no_return') {
    return { error: `Trovato un volo di andata, ma nessun volo di ritorno compatibile con ${durationDays} giorni di soggiorno. Prova a ridurre la durata del viaggio.` };
  }

  const budgetAfterFlights = budget - flights.cost;
  if (budgetAfterFlights <= 0) {
    return { error: `Il costo dei voli (${flights.cost.toFixed(2)}€) supera già il budget indicato (${budget}€).` };
  }

  const attempt = async (maxHotelPrice, compromises) => {
    const hotelPick = await findHotelForStay(country, flights.outbound.date, durationDays, maxHotelPrice);
    if (!hotelPick) return { status: 'no_hotel' };

    const hotelCost = hotelPick.totalCost * participants;
    const budgetAfterHotel = budgetAfterFlights - hotelCost;
    if (budgetAfterHotel <= 0) return { status: 'hotel_over_budget' };

    const activities = await selectActivities(
      country, activityPreferences, flights.outbound.date, durationDays, participants, budgetAfterHotel
    );

    const totalCost = flights.cost + hotelCost + activities.cost;
    const allCompromises = [...compromises];
    if (activities.daysWithoutActivity > 0) {
      allCompromises.push(
        `${activities.daysWithoutActivity} giorno/i senza attività proposta per budget/capacità residui insufficienti.`
      );
    }

    return {
      status: 'ok',
      flights,
      hotel: hotelPick,
      activities: activities.chosen,
      totalCost,
      breakdown: { flightCost: flights.cost, hotelCost, activityCost: activities.cost },
      compromises: allCompromises,
      withinBudget: totalCost <= budget,
    };
  };

  // Tentativo 1: nessun vincolo extra sul prezzo hotel
  let result = await attempt(Infinity, []);

  // Tentativo 2 (alternativa): se non trovato o fuori budget, ricalcola con hotel più economico
  let alternative = null;
  if (result.status !== 'ok' || !result.withinBudget) {
    const avgNightlyBudget = budgetAfterFlights / durationDays / participants;
    alternative = await attempt(Math.max(avgNightlyBudget * 0.7, 20), [
      'Selezionato hotel con fascia di prezzo inferiore per rientrare nel budget.',
    ]);
  }

  if (result.status !== 'ok' && (!alternative || alternative.status !== 'ok')) {
    const reason = result.status === 'no_hotel'
      ? 'Nessun hotel con disponibilità continuativa per tutte le notti richieste.'
      : 'Il costo dell\'hotel, anche nella fascia più economica, supera il budget residuo dopo i voli.';
    return { error: reason };
  }

  return { primary: result.status === 'ok' ? result : null, alternative };
}
