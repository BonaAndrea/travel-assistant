import { bookingCreateSchema, bookingModifySchema, chatMessageSchema, itineraryChoiceSchema } from '../src/validation.js';

describe('validazione REST', () => {
  test('rifiuta payload booking incompleti o chiavi troppo lunghe', () => {
    expect(bookingCreateSchema.safeParse({ itineraryId: 'i', idempotencyKey: 'short', confirm: true }).success).toBe(false);
    expect(bookingCreateSchema.safeParse({ itineraryId: 'i', idempotencyKey: '12345678', confirm: false }).success).toBe(false);
    expect(bookingCreateSchema.safeParse({ itineraryId: 'i', idempotencyKey: 'x'.repeat(129), confirm: true }).success).toBe(false);
  });

  test('valida scelta itinerario e messaggi non vuoti con limite', () => {
    expect(itineraryChoiceSchema.safeParse({ conversationId: 'c', choice: 'primary' }).success).toBe(true);
    expect(itineraryChoiceSchema.safeParse({ conversationId: 'c', choice: 'unknown' }).success).toBe(false);
    expect(chatMessageSchema.safeParse({ message: '   ' }).success).toBe(false);
    expect(chatMessageSchema.safeParse({ message: 'x'.repeat(10001) }).success).toBe(false);
    expect(chatMessageSchema.safeParse({ imageIds: ['550e8400-e29b-41d4-a716-446655440000'] }).success).toBe(true);
  });

  test('limita la motivazione di cancellazione e richiede un nuovo draft', () => {
    expect(bookingModifySchema.safeParse({ newItineraryId: 'draft-1' }).success).toBe(true);
    expect(bookingModifySchema.safeParse({ newItineraryId: '' }).success).toBe(false);
  });
});
