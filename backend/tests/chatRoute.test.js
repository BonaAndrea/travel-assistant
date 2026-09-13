import { isConfirmationMessage } from '../src/routes/chat.js';

describe('isConfirmationMessage', () => {
  test('riconosce sì anche con accentate', () => {
    expect(isConfirmationMessage('sì')).toBe(true);
    expect(isConfirmationMessage('si')).toBe(true);
    expect(isConfirmationMessage('conferma')).toBe(true);
    expect(isConfirmationMessage('ok')).toBe(true);
  });

  test('non tratta messaggi non confermativi come conferma', () => {
    expect(isConfirmationMessage('voglio cambiare il budget')).toBe(false);
    expect(isConfirmationMessage('non va bene')).toBe(false);
    expect(isConfirmationMessage('non confermo')).toBe(false);
    expect(isConfirmationMessage('ok ma siamo 3')).toBe(false);
    expect(isConfirmationMessage('si, cambio budget')).toBe(false);
    expect(isConfirmationMessage('confermo?')).toBe(false);
    expect(isConfirmationMessage('  CONFERMO! ')).toBe(true);
  });
});
