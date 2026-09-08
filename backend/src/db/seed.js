/**
 * Popola il DB con dati di esempio sufficienti a testare un flusso completo end-to-end.
 * Scenario suggerito per il test manuale (vedi README): partenza da "FCO", nazione "Spagna",
 * mese di viaggio = il mese seedato qui sotto (di default: due mesi da oggi).
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { buildIndex } from '../services/vectorStore.js';

const prisma = new PrismaClient();

const MONTHS_IT = ['gennaio','febbraio','marzo','aprile','maggio','giugno','luglio','agosto','settembre','ottobre','novembre','dicembre'];

function targetMonthDates(daysCount = 20) {
  const now = new Date();
  const target = new Date(Date.UTC(now.getFullYear(), now.getMonth() + 2, 1)); // due mesi da oggi
  const dates = [];
  for (let i = 0; i < daysCount; i++) {
    dates.push(new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), 1 + i)));
  }
  return { monthName: MONTHS_IT[target.getUTCMonth()], dates };
}

async function main() {
  console.log('Seeding...');
  const { monthName, dates } = targetMonthDates();
  console.log(`Mese seedato per i test manuali: "${monthName}"`);

  await prisma.message.deleteMany();
  await prisma.conversation.deleteMany();
  await prisma.booking.deleteMany();
  await prisma.itinerary.deleteMany();
  await prisma.activityAvailability.deleteMany();
  await prisma.activity.deleteMany();
  await prisma.hotelAvailability.deleteMany();
  await prisma.hotel.deleteMany();
  await prisma.flight.deleteMany();
  await prisma.airport.deleteMany();
  await prisma.destination.deleteMany();

  const destination = await prisma.destination.create({
    data: { country: 'Spagna', city: 'Barcellona' },
  });
  const departureAirport = await prisma.airport.create({
    data: {
      iataCode: 'FCO',
      name: 'Aeroporto di Roma Fiumicino',
      city: 'Roma',
      countryCode: 'IT',
    },
  });
  const destinationAirport = await prisma.airport.create({
    data: {
      iataCode: 'BCN',
      name: 'Aeroporto Josep Tarradellas Barcellona-El Prat',
      city: 'Barcellona',
      countryCode: 'ES',
      destinationId: destination.id,
    },
  });

  // --- Voli: FCO <-> BCN ---
  for (const d of dates.slice(0, 15)) {
    await prisma.flight.create({
      data: {
        originAirportId: departureAirport.id,
        destinationAirportId: destinationAirport.id,
        direction: 'outbound',
        date: d,
        seatsAvailable: 6,
        cost: 90 + Math.round(Math.random() * 60),
      },
    });
    await prisma.flight.create({
      data: {
        originAirportId: destinationAirport.id,
        destinationAirportId: departureAirport.id,
        direction: 'return',
        date: new Date(d.getTime() + 5 * 86400000),
        seatsAvailable: 6,
        cost: 95 + Math.round(Math.random() * 60),
      },
    });
  }

  // --- Hotel ---
  const hotelEconomy = await prisma.hotel.create({
    data: { destinationId: destination.id, name: 'Hostal Barcelonés', country: 'Spagna', city: 'Barcellona', description: 'Semplice e centrale, ideale per giovani e budget contenuti.', target: 'giovani, budget contenuto' },
  });
  const hotelMid = await prisma.hotel.create({
    data: { destinationId: destination.id, name: 'Hotel Rambla Plaza', country: 'Spagna', city: 'Barcellona', description: 'Hotel 3 stelle comodo per famiglie, vicino alle attrazioni culturali.', target: 'famiglie, cultura' },
  });
  for (const d of dates) {
    await prisma.hotelAvailability.create({ data: { hotelId: hotelEconomy.id, date: d, pricePerNight: 35 + Math.round(Math.random() * 10), roomsAvailable: 4 } });
    await prisma.hotelAvailability.create({ data: { hotelId: hotelMid.id, date: d, pricePerNight: 70 + Math.round(Math.random() * 20), roomsAvailable: 3 } });
  }

  // --- Attività ---
  const activitiesDef = [
    { name: 'Tour guidato Sagrada Familia', category: 'cultura', description: 'Visita guidata al capolavoro di Gaudì, con approfondimento storico-artistico.', target: 'famiglie, appassionati d\'arte', cost: 25 },
    { name: 'Escursione in bici lungo la costa', category: 'sport', description: 'Giro in bicicletta panoramico lungo il lungomare, adatto a tutti i livelli.', target: 'sportivi, giovani', cost: 20 },
    { name: 'Giornata spa e relax', category: 'relax', description: 'Accesso a percorso benessere con sauna, bagno turco e piscina termale.', target: 'coppie, chi cerca relax', cost: 40 },
    { name: 'Tour dei locali notturni', category: 'nightlife', description: 'Serata guidata tra i migliori bar e club della città, con accesso prioritario.', target: 'giovani, nightlife', cost: 30 },
    { name: 'Museo Picasso', category: 'cultura', description: 'Visita alla collezione permanente dedicata al periodo giovanile dell\'artista.', target: 'appassionati d\'arte, famiglie', cost: 15 },
    { name: 'Snorkeling in Costa Brava', category: 'sport', description: 'Escursione in barca con soste per lo snorkeling in acque cristalline.', target: 'sportivi, avventurosi', cost: 45 },
  ];

  for (const def of activitiesDef) {
    const activity = await prisma.activity.create({
      data: { destinationId: destination.id, name: def.name, country: 'Spagna', city: 'Barcellona', category: def.category, description: def.description, target: def.target },
    });
    for (const d of dates) {
      await prisma.activityAvailability.create({
        data: { activityId: activity.id, date: d, cost: def.cost, capacity: 15, booked: 0 },
      });
    }
  }

  console.log('Seed dati relazionali completato. Costruzione indice vettoriale (RAG)...');
  const count = await buildIndex();
  console.log(`Indice vettoriale costruito: ${count} documenti.`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
