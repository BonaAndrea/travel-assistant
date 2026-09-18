import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const mockPrisma = {
  conversation: {
    count: jest.fn(),
    findMany: jest.fn(),
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  },
  message: { create: jest.fn(), deleteMany: jest.fn() },
  itineraryGenerationJob: { deleteMany: jest.fn() },
  preferenceImage: { findMany: jest.fn(), deleteMany: jest.fn() },
  $transaction: jest.fn(),
};

jest.unstable_mockModule('../src/db/prisma.js', () => ({ prisma: mockPrisma }));
jest.unstable_mockModule('../src/middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => {
    req.userId = req.headers['x-test-user'] || 'user-1';
    next();
  },
}));
jest.unstable_mockModule('../src/services/llmService.js', () => ({ chatTurn: jest.fn() }));
jest.unstable_mockModule('../src/services/itineraryService.js', () => ({ generateItinerary: jest.fn() }));

const { default: chatRoutes } = await import('../src/routes/chat.js');
const { chatTurn } = await import('../src/services/llmService.js');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/chat', chatRoutes);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  return app;
}

describe('API storico conversazioni', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.preferenceImage.findMany.mockResolvedValue([]);
    mockPrisma.$transaction.mockImplementation((operations) => (
      typeof operations === 'function' ? operations(mockPrisma) : Promise.all(operations)
    ));
  });

  test('prepara un ID transitorio senza creare una Conversation vuota', async () => {
    const response = await request(createApp())
      .post('/api/chat/conversations')
      .set('x-test-user', 'user-1');

    expect(response.status).toBe(201);
    expect(response.body.conversationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(mockPrisma.conversation.create).not.toHaveBeenCalled();
  });

  test('restituisce solo query filtrate per utente con paginazione e riepilogo', async () => {
    mockPrisma.conversation.count.mockResolvedValue(21);
    mockPrisma.conversation.findMany.mockResolvedValue([{
      id: 'conversation-1',
      state: { phase: 'collecting', requirements: { country: 'Spagna' } },
      createdAt: new Date('2026-09-01T10:00:00Z'),
      updatedAt: new Date('2026-09-02T10:00:00Z'),
      _count: { messages: 2, itineraries: 0 },
      messages: [{ role: 'assistant', content: 'Quando vuoi partire?', createdAt: new Date('2026-09-02T10:00:00Z') }],
      itineraries: [],
    }]);

    const response = await request(createApp())
      .get('/api/chat/conversations?page=2&pageSize=10')
      .set('x-test-user', 'user-1');

    expect(response.status).toBe(200);
    expect(response.body.pagination).toEqual({
      page: 2,
      pageSize: 10,
      totalItems: 21,
      totalPages: 3,
      hasPreviousPage: true,
      hasNextPage: true,
    });
    expect(response.body.items[0]).toMatchObject({
      id: 'conversation-1',
      status: 'collecting',
      requirements: { country: 'Spagna' },
      messageCount: 2,
      itineraryCount: 0,
      latestItinerary: null,
    });
    expect(mockPrisma.conversation.count).toHaveBeenCalledWith({
      where: { userId: 'user-1', messages: { some: {} } },
    });
    expect(mockPrisma.conversation.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: 'user-1', messages: { some: {} } },
      skip: 10,
      take: 10,
    }));
  });

  test('presenta una sessione transitoria senza materializzarla', async () => {
    const response = await request(createApp())
      .get('/api/chat/conversations/550e8400-e29b-41d4-a716-446655440000')
      .set('x-test-user', 'user-1');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      id: '550e8400-e29b-41d4-a716-446655440000',
      status: 'collecting',
      messages: [],
      itineraries: [],
    });
    expect(mockPrisma.conversation.findFirst).toHaveBeenCalled();
    expect(mockPrisma.conversation.create).not.toHaveBeenCalled();
  });

  test('limita pageSize a 50 e rifiuta parametri non validi', async () => {
    mockPrisma.conversation.count.mockResolvedValue(0);
    mockPrisma.conversation.findMany.mockResolvedValue([]);

    const capped = await request(createApp()).get('/api/chat/conversations?pageSize=500');
    expect(capped.status).toBe(200);
    expect(capped.body.pagination.pageSize).toBe(50);
    expect(mockPrisma.conversation.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 50 }));

    const invalid = await request(createApp()).get('/api/chat/conversations?page=zero');
    expect(invalid.status).toBe(400);
    expect(invalid.body.error).toMatch(/interi positivi/);
  });

  test('il dettaglio applica il filtro proprietario nella query e include itinerari', async () => {
    mockPrisma.conversation.findFirst.mockResolvedValue({
      id: 'conversation-1',
      userId: 'user-1',
      state: { phase: 'itinerary_proposed', requirements: { country: 'Spagna' } },
      messages: [{ id: 'message-1', role: 'user', content: 'Spagna' }],
      itineraries: [{ id: 'itinerary-1', status: 'draft', details: {}, totalCost: 900 }],
    });

    const response = await request(createApp())
      .get('/api/chat/conversations/conversation-1')
      .set('x-test-user', 'user-1');

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('itinerary_proposed');
    expect(response.body.itineraries).toHaveLength(1);
    expect(response.body.userId).toBeUndefined();
    expect(mockPrisma.conversation.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'conversation-1', userId: 'user-1' },
    }));
  });

  test('elimina solo una conversazione appartenente all’utente autenticato', async () => {
    mockPrisma.conversation.findFirst.mockResolvedValue({ id: 'conversation-1' });

    const response = await request(createApp())
      .delete('/api/chat/conversations/conversation-1')
      .set('x-test-user', 'user-1');

    expect(response.status).toBe(204);
    expect(mockPrisma.message.deleteMany).toHaveBeenCalledWith({ where: { conversationId: 'conversation-1' } });
    expect(mockPrisma.itineraryGenerationJob.deleteMany).toHaveBeenCalledWith({
      where: { conversationId: 'conversation-1', userId: 'user-1' },
    });
    expect(mockPrisma.conversation.delete).toHaveBeenCalledWith({ where: { id: 'conversation-1' } });
  });

  test('non elimina una conversazione di un altro utente', async () => {
    mockPrisma.conversation.findFirst.mockResolvedValue(null);

    const response = await request(createApp())
      .delete('/api/chat/conversations/other-conversation')
      .set('x-test-user', 'user-1');

    expect(response.status).toBe(404);
    expect(mockPrisma.conversation.delete).not.toHaveBeenCalled();
  });

  test('normalizza lo stato nullo anche quando arriva un nuovo messaggio', async () => {
    chatTurn.mockResolvedValue({ assistantMessage: 'Dimmi la destinazione.', updatedFields: {} });
    mockPrisma.conversation.findUnique.mockResolvedValue({
      id: 'conversation-incomplete',
      userId: 'user-1',
      state: null,
      messages: [],
    });

    const response = await request(createApp())
      .post('/api/chat/conversations/conversation-incomplete/messages')
      .set('x-test-user', 'user-1')
      .send({ message: 'Ciao' });

    expect(response.status).toBe(200);
    expect(response.body.phase).toBe('collecting');
    expect(response.body.requirements).toEqual({});
    expect(mockPrisma.conversation.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'conversation-incomplete' },
      data: { state: expect.objectContaining({ phase: 'collecting', requirements: {} }) },
    }));
  });

  test('passa al contesto chat solo i metadati delle immagini associate', async () => {
    chatTurn.mockResolvedValue({ assistantMessage: 'Descrivimi cosa preferisci.', updatedFields: {} });
    const preferenceImages = [{ id: 'image-1', mimeType: 'image/png', sizeBytes: 128, createdAt: new Date() }];
    mockPrisma.conversation.findUnique.mockResolvedValue({
      id: 'conversation-images', userId: 'user-1',
      state: { phase: 'collecting', requirements: {} }, messages: [], preferenceImages,
    });

    const response = await request(createApp())
      .post('/api/chat/conversations/conversation-images/messages')
      .set('x-test-user', 'user-1')
      .send({ message: 'Ho caricato una foto' });

    expect(response.status).toBe(200);
    expect(chatTurn).toHaveBeenCalledWith(expect.any(Array), {}, 'collecting', preferenceImages);
  });

  test('crea Conversation e primo messaggio atomicamente al primo invio', async () => {
    chatTurn.mockResolvedValue({ assistantMessage: 'Dimmi la destinazione.', updatedFields: {} });
    mockPrisma.conversation.findUnique.mockResolvedValue(null);
    mockPrisma.conversation.create.mockResolvedValue({
      id: '550e8400-e29b-41d4-a716-446655440000',
      userId: 'user-1',
      state: { phase: 'collecting', requirements: {} },
    });

    const response = await request(createApp())
      .post('/api/chat/conversations/550e8400-e29b-41d4-a716-446655440000/messages')
      .set('x-test-user', 'user-1')
      .send({ message: 'Ciao' });

    expect(response.status).toBe(200);
    expect(mockPrisma.conversation.create).toHaveBeenCalledWith({
      data: {
        id: '550e8400-e29b-41d4-a716-446655440000',
        userId: 'user-1',
        state: { phase: 'collecting', requirements: {} },
      },
    });
    expect(mockPrisma.message.create).toHaveBeenCalledWith({
      data: { conversationId: '550e8400-e29b-41d4-a716-446655440000', role: 'user', content: 'Ciao' },
    });
  });

  test('non espone conversazioni altrui e normalizza stati incompleti', async () => {
    mockPrisma.conversation.findFirst.mockResolvedValueOnce(null);
    const missing = await request(createApp())
      .get('/api/chat/conversations/other-conversation')
      .set('x-test-user', 'user-1');
    expect(missing.status).toBe(404);

    mockPrisma.conversation.findFirst.mockResolvedValueOnce({
      id: 'conversation-incomplete',
      userId: 'user-1',
      state: null,
      messages: [],
      itineraries: [],
    });
    const incomplete = await request(createApp()).get('/api/chat/conversations/conversation-incomplete');
    expect(incomplete.status).toBe(200);
    expect(incomplete.body.status).toBe('unknown');
    expect(incomplete.body.state).toEqual({ phase: 'unknown', requirements: {} });
    expect(incomplete.body.itineraries).toEqual([]);
  });
});
