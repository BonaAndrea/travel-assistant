import { readFileSync } from 'node:fs';

const dashboard = readFileSync(new URL('../../frontend/dashboard.html', import.meta.url), 'utf8');
const style = readFileSync(new URL('../../frontend/style.css', import.meta.url), 'utf8');

test('dashboard renders compact selectable booking cards with a selected detail panel', () => {
  expect(dashboard).toContain('id="booking-list" class="booking-list" role="list"');
  expect(dashboard).toContain('class="booking-card${selected ? \' is-selected\' : \'\'}"');
  expect(dashboard).toContain('aria-pressed="${selected}"');
   expect(dashboard).toContain('id="booking-detail" class="card booking-detail detail-drawer" aria-label="Dettaglio prenotazione"');
  expect(dashboard).toContain('tabindex="-1"');
  expect(dashboard).toContain('function selectBooking(id, { focus = false } = {})');
});

test('dashboard starts with the list and opens a mobile detail drawer only after selection', () => {
  expect(dashboard).toContain('let selectedBookingId = null');
  expect(dashboard).toContain('let detailVisible = false');
  expect(dashboard).toContain('function closeBookingDetail()');
  expect(dashboard).toContain("event.key === 'Escape'");
  expect(dashboard).toContain("button.classList.toggle('is-selected', isSelected)");
  expect(dashboard).toContain("button.setAttribute('aria-pressed', String(isSelected))");
  expect(dashboard).toContain('renderBookingDetail(selectedBookingId ? bookings.find((booking) => booking.id === selectedBookingId) : null);');
  expect(dashboard).not.toContain('selectBooking(selectedBookingId);');
  expect(style).toContain('#booking-detail.booking-detail.is-open{transform:translateX(0);visibility:visible;opacity:1');
  expect(style).toContain('body.booking-detail-open{overflow:hidden}');
});

test('dashboard keeps cancel and modify actions in the selected detail', () => {
  expect(dashboard).toContain('data-action="cancel"');
  expect(dashboard).toContain('data-action="modify"');
  expect(dashboard).toContain('class="booking-detail-heading"');
  expect(dashboard).toContain('class="booking-detail-header"');
  expect(dashboard).toContain("detail.querySelector('.booking-detail-header')?.prepend(createBookingDetailCloseButton())");
  expect(dashboard).toContain('class="booking-detail-actions booking-actions detail-actions"');
  expect(dashboard).toContain("method: 'PATCH', body: { newItineraryId: itinerarySelect.value }");
  expect(dashboard).toContain('booking-actions');
});

test('dashboard and history share the same panel border and action treatment', () => {
  expect(style).toContain('.history-detail-heading,.booking-detail-heading{display:flex;align-items:center;justify-content:space-between');
  expect(style).toContain('.history-detail-actions .history-resume,.booking-detail-actions button{min-height:48px');
  expect(style).toContain('.history-detail,#bookings.booking-layout>.booking-detail{border-top:1px solid var(--line)}');
  expect(style).toContain('.history-item,.booking-card{border-top:1px solid var(--line)}');
});

test('booking detail separates media and activity content with a readable fallback', () => {
  expect(dashboard).toContain('class="booking-detail-media"');
  expect(dashboard).toContain('class="booking-detail-content"');
  expect(dashboard).toContain('class="activity-media-placeholder"');
  expect(dashboard).toContain('function activityMarkup(activity)');
  expect(style).toContain('.booking-detail-media .media img');
  expect(style).toContain('.booking-detail-content .activity-item');
  expect(style).toContain('.activity-media-placeholder');
});

test('booking detail hero stays in flow and has bounded desktop/mobile dimensions', () => {
  expect(style).toContain('.booking-detail>h2{position:relative;z-index:1}');
  expect(style).toContain('.booking-detail-media{position:relative;z-index:0;width:calc(100% + 60px);max-width:none;margin:0 -30px 24px');
  expect(style).toContain('height:clamp(180px,28vw,320px);max-height:320px;aspect-ratio:16/7');
  expect(style).toContain('@media (max-width:800px){.booking-detail-media{width:calc(100% + 44px);margin:0 -22px 18px}');
});

test('dashboard cards and detail layout are responsive and keyboard-visible', () => {
  expect(style).toContain('#bookings.booking-layout');
  expect(style).toContain('.booking-card:hover,.booking-card:focus-visible,.booking-card.is-selected');
  expect(style).toContain('.booking-card:focus-visible{outline:3px solid var(--coral);outline-offset:3px}');
  expect(style).toContain('@media (max-width:800px){#bookings.booking-layout{grid-template-columns:1fr}');
  expect(style).toContain('.booking-detail-heading .booking-detail-actions button{flex:1 1 180px}');
  expect(style).toContain('.booking-detail-heading{display:block;margin:0 0 18px}');
   expect(style).toContain('#booking-detail.booking-detail .booking-detail-header{position:sticky;top:0;z-index:5');
   expect(style).toContain('.detail-drawer{min-width:0}');
  expect(style).toContain('#booking-detail.booking-detail .booking-detail-close{position:absolute;top:max(12px,env(safe-area-inset-top));left:14px');
  expect(style).toContain('.booking-detail-heading .booking-detail-actions{display:flex;flex-wrap:wrap;width:100%;min-width:0}');
  expect(style).toContain('.booking-detail-media{width:calc(100% + 28px);max-width:none;margin:0 -14px 18px}');
});
