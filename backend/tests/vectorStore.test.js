import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, jest } from '@jest/globals';

const indexPath = path.resolve('src/db/vector-index.json');
const hadIndex = fs.existsSync(indexPath);
const previousIndex = hadIndex ? fs.readFileSync(indexPath) : null;

jest.unstable_mockModule('@xenova/transformers', () => ({
  pipeline: jest.fn(async () => async () => ({ data: [1, 0] })),
}));

const { semanticSearch } = await import('../src/services/vectorStore.js');
const { prisma } = await import('../src/db/prisma.js');

beforeAll(() => {
  const nationalActivities = Array.from({ length: 20 }, (_, index) => ({
    id: `other-${index}`,
    type: 'activity',
    metadata: { name: `Other ${index}`, category: 'cultura', country: 'Spagna', city: 'Madrid', destinationId: 'madrid' },
    vector: [0.9, 0],
  }));
  const localActivity = {
    id: 'barcelona-local',
    type: 'activity',
    metadata: { name: 'AttivitÃ  locale', category: 'cultura', country: 'Spagna', city: 'Barcellona', destinationId: 'barcelona' },
    vector: [0.8, 0],
  };
  fs.mkdirSync(path.dirname(indexPath), { recursive: true });
  fs.writeFileSync(indexPath, JSON.stringify([...nationalActivities, localActivity]));
});

afterAll(() => {
  if (hadIndex) fs.writeFileSync(indexPath, previousIndex);
  else if (fs.existsSync(indexPath)) fs.unlinkSync(indexPath);
});

test('filtra la destinazione prima di topK e conserva lattivitÃ  locale', async () => {
  const results = await semanticSearch('cultura', {
    type: 'activity',
    country: 'Spagna',
    destinationId: 'barcelona',
    destinationCity: 'Barcellona',
    topK: 20,
  });

  expect(results.map((result) => result.id)).toEqual(['barcelona-local']);
});

test('mantiene il fallback per indici legacy privi di destinationId', async () => {
  fs.writeFileSync(indexPath, JSON.stringify([
    {
      id: 'legacy-local', type: 'activity',
      metadata: { country: 'Spagna', city: 'Barcellona' }, vector: [1, 0],
    },
    {
      id: 'legacy-other', type: 'activity',
      metadata: { country: 'Spagna', city: 'Madrid' }, vector: [1, 0],
    },
  ]));

  const results = await semanticSearch('cultura', {
    type: 'activity', destinationId: 'barcelona', destinationCity: 'Barcellona', topK: 20,
  });
  expect(results.map((result) => result.id)).toEqual(['legacy-local']);
});

test('usa il catalogo relazionale se l’indice file non è presente', async () => {
  fs.unlinkSync(indexPath);
  const findMany = jest.spyOn(prisma.activity, 'findMany').mockResolvedValue([{
    id: 'budapest-cultural', name: 'Museo - Budapest', category: 'cultura',
    city: 'Budapest', country: 'Ungheria', destinationId: 'budapest',
  }]);

  const results = await semanticSearch('cultura', {
    type: 'activity', destinationId: 'budapest', destinationCity: 'Budapest', topK: 20,
  });

  expect(findMany).toHaveBeenCalledWith({ where: { destinationId: 'budapest' }, take: 20 });
  expect(results).toMatchObject([{ id: 'budapest-cultural', score: 0 }]);
  findMany.mockRestore();
});
