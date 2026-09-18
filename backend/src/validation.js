import { z } from 'zod';

const identifier = z.string().trim().min(1).max(128);
const idempotencyKey = z.string().trim().min(8).max(128);

export const chatMessageSchema = z.object({
  imageIds: z.array(z.string().uuid()).max(5).optional().default([]),
  message: z.string().max(10000).refine((value) => value.trim().length > 0, 'Il messaggio non può essere vuoto').optional(),
});

export const itineraryChoiceSchema = z.object({
  conversationId: identifier,
  choice: z.enum(['primary', 'alternative']),
});

export const bookingCreateSchema = z.object({
  itineraryId: identifier,
  idempotencyKey,
  confirm: z.literal(true),
});

export const bookingCancelSchema = z.object({
  reason: z.string().max(500).optional(),
});

export const bookingModifySchema = z.object({
  newItineraryId: identifier,
});

export function validationError(message, details) {
  return { error: message, details: details?.flatten?.() };
}
