/**
 * Seed deterministico per il catalogo multi-rotta e multi-mese.
 * Ogni destinazione ha voli da piu aeroporti italiani per 12 mesi consecutivi;
 * i ritorni sono cinque notti dopo ogni partenza e hotel/attivita coprono le
 * notti dei voli seedati.
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { pathToFileURL } from 'node:url';
import { buildIndex } from '../services/vectorStore.js';
import { invalidateSearchCache } from '../services/searchCache.js';

const prisma = new PrismaClient();
const MONTHS_IT = [
  'gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno',
  'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre',
];
const DEPARTURE_DAYS = [1, 8, 15, 22];
const COVERAGE_DAYS = Array.from({ length: 28 }, (_, index) => index + 1);

export function buildSeedPlan(referenceDate = new Date(), monthCount = 12) {
  const firstMonth = new Date(Date.UTC(
    referenceDate.getUTCFullYear(), referenceDate.getUTCMonth() + 1, 1,
  ));
  const months = Array.from({ length: monthCount }, (_, offset) => {
    const start = new Date(Date.UTC(firstMonth.getUTCFullYear(), firstMonth.getUTCMonth() + offset, 1));
    const year = start.getUTCFullYear();
    const month = start.getUTCMonth();
    return {
      year,
      month,
      monthName: MONTHS_IT[month],
      departureDates: DEPARTURE_DAYS.map((day) => new Date(Date.UTC(year, month, day, 8))),
      coverageDates: COVERAGE_DAYS.map((day) => new Date(Date.UTC(year, month, day))),
    };
  });

  const origins = [
    { iata: 'FCO', name: 'Aeroporto di Roma Fiumicino', city: 'Roma', countryCode: 'IT', costBias: 0 },
    { iata: 'MXP', name: 'Aeroporto di Milano Malpensa', city: 'Milano', countryCode: 'IT', costBias: 8 },
    { iata: 'BLQ', name: 'Aeroporto di Bologna', city: 'Bologna', countryCode: 'IT', costBias: 5 },
    { iata: 'NAP', name: 'Aeroporto di Napoli', city: 'Napoli', countryCode: 'IT', costBias: 6 },
  ];
  const destinations = [
    { country: 'Spagna', countryCode: 'ES', city: 'Barcellona', iata: 'BCN', flightBase: 90 },
    { country: 'Spagna', countryCode: 'ES', city: 'Madrid', iata: 'MAD', flightBase: 82 },
    { country: 'Portogallo', countryCode: 'PT', city: 'Lisbona', iata: 'LIS', flightBase: 78 },
    { country: 'Francia', countryCode: 'FR', city: 'Parigi', iata: 'CDG', flightBase: 95 },
    { country: 'Grecia', countryCode: 'GR', city: 'Atene', iata: 'ATH', flightBase: 110 },
    { country: 'Repubblica Ceca', countryCode: 'CZ', city: 'Praga', iata: 'PRG', flightBase: 88 },
  ];
  return { months, origins, destinations };
}

const activityTemplates = [
  {
    name: 'Tour culturale del centro storico', category: 'cultura',
    description: 'Visita guidata a monumenti e quartieri storici.',
    target: 'famiglie, appassionati d\'arte', cost: 25, startMinute: 9 * 60, endMinute: 11 * 60,
  },
  {
    name: 'Escursione in bici', category: 'sport',
    description: 'Giro panoramico in bicicletta, adatto a tutti i livelli.',
    target: 'sportivi, giovani', cost: 20, startMinute: 11 * 60 + 30, endMinute: 13 * 60 + 30,
  },
  {
    name: 'Giornata spa e relax', category: 'relax',
    description: 'Percorso benessere con sauna, bagno turco e piscina.',
    target: 'coppie, chi cerca relax', cost: 40, startMinute: 15 * 60, endMinute: 17 * 60,
  },
  {
    name: 'Tour della vita notturna', category: 'nightlife',
    description: 'Serata guidata tra locali e punti panoramici della citta.',
    target: 'giovani, nightlife', cost: 30, startMinute: 20 * 60, endMinute: 22 * 60,
  },
  {
    name: 'Museo di arte moderna', category: 'cultura',
    description: 'Visita a una collezione permanente di arte moderna.',
    target: 'appassionati d\'arte, famiglie', cost: 15, startMinute: 9 * 60 + 30, endMinute: 11 * 60 + 30,
  },
  {
    name: 'Escursione naturalistica', category: 'sport',
    description: 'Attivita outdoor in paesaggi naturali vicino alla citta.',
    target: 'sportivi, avventurosi', cost: 45, startMinute: 14 * 60, endMinute: 16 * 60,
  },
];

async function clearCatalog() {
  await prisma.message.deleteMany();
  await prisma.booking.deleteMany();
  await prisma.itinerary.deleteMany();
  await prisma.itineraryGenerationJob.deleteMany();
  await prisma.conversation.deleteMany();
  await prisma.activityAvailability.deleteMany();
  await prisma.activity.deleteMany();
  await prisma.hotelAvailability.deleteMany();
  await prisma.hotel.deleteMany();
  await prisma.flight.deleteMany();
  await prisma.airport.deleteMany();
  await prisma.destination.deleteMany();
}

export async function main() {
  const { months, origins, destinations } = buildSeedPlan();
  console.log('Seeding catalogo deterministico multi-rotta...');
  console.log(`Mesi seedati: ${months[0].monthName} ${months[0].year} - ${months.at(-1).monthName} ${months.at(-1).year}`);
  console.log(`Aeroporti di partenza: ${origins.map(({ iata }) => iata).join(', ')}`);

  invalidateSearchCache();
  await clearCatalog();

  const originAirports = {};
  for (const origin of origins) {
    originAirports[origin.iata] = await prisma.airport.create({ data: {
      iataCode: origin.iata,
      name: origin.name,
      city: origin.city,
      countryCode: origin.countryCode,
    } });
  }

  for (const [destinationIndex, definition] of destinations.entries()) {
    const destination = await prisma.destination.create({
      data: {
        country: definition.country,
        countryCode: definition.countryCode,
        city: definition.city,
      },
    });
    const destinationAirport = await prisma.airport.create({
      data: {
        iataCode: definition.iata,
        name: `Aeroporto di ${definition.city}`,
        city: definition.city,
        countryCode: definition.countryCode,
        destinationId: destination.id,
      },
    });

    for (const origin of origins) {
      for (const month of months) {
        for (const [dayIndex, date] of month.departureDates.entries()) {
          const baseCost = definition.flightBase + origin.costBias + (dayIndex % 3) * 4;
          await prisma.flight.create({
            data: {
              originAirportId: originAirports[origin.iata].id,
              destinationAirportId: destinationAirport.id,
              direction: 'outbound',
              date,
              seatsAvailable: 6,
              cost: baseCost,
            },
          });
          await prisma.flight.create({
            data: {
              originAirportId: destinationAirport.id,
              destinationAirportId: originAirports[origin.iata].id,
              direction: 'return',
              date: new Date(date.getTime() + 5 * 86400000),
              seatsAvailable: 6,
              cost: baseCost + 8 + (dayIndex % 2) * 3,
            },
          });
        }
      }
    }

    const hotels = await Promise.all([
      prisma.hotel.create({
        data: {
          destinationId: destination.id,
          name: `Hostal ${definition.city}`,
          country: definition.country,
          city: definition.city,
          description: 'Sistemazione centrale per budget contenuti.',
          target: 'giovani, budget contenuto',
        },
      }),
      prisma.hotel.create({
        data: {
          destinationId: destination.id,
          name: `Hotel Plaza ${definition.city}`,
          country: definition.country,
          city: definition.city,
          description: 'Hotel comodo per famiglie e visite culturali.',
          target: 'famiglie, cultura',
        },
      }),
    ]);
    for (const month of months) {
      for (const date of month.coverageDates) {
        for (const [hotelIndex, hotel] of hotels.entries()) {
          await prisma.hotelAvailability.create({
            data: {
              hotelId: hotel.id,
              date,
              pricePerNight: (hotelIndex === 0 ? 35 : 70) + (date.getUTCDate() % 4),
              roomsAvailable: hotelIndex === 0 ? 4 : 3,
            },
          });
        }
      }
    }

    for (const activityDefinition of activityTemplates) {
      const activity = await prisma.activity.create({
        data: {
          destinationId: destination.id,
          name: `${activityDefinition.name} - ${definition.city}`,
          country: definition.country,
          city: definition.city,
          category: activityDefinition.category,
          description: activityDefinition.description,
          target: activityDefinition.target,
        },
      });
      for (const month of months) {
        for (const date of month.coverageDates) {
          await prisma.activityAvailability.create({
            data: {
              activityId: activity.id,
              date,
              startMinute: activityDefinition.startMinute,
              endMinute: activityDefinition.endMinute,
              cost: activityDefinition.cost,
              capacity: 15,
              booked: 0,
            },
          });
        }
      }
    }

    console.log(`Catalogata destinazione ${destinationIndex + 1}/${destinations.length}: ${definition.city} (${definition.countryCode})`);
  }

  console.log('Seed relazionale completato. Costruzione indice vettoriale (RAG)...');
  const count = await buildIndex();
  invalidateSearchCache();
  console.log(`Indice vettoriale costruito: ${count} documenti.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .catch((error) => { console.error(error); process.exitCode = 1; })
    .finally(() => prisma.$disconnect());
}
