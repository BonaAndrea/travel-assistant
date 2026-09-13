import { api, requireLogin, logout } from './api.js';

requireLogin();
document.getElementById('logout-link').addEventListener('click', logout);

const PHASE_LABELS = {
  collecting: 'Raccolta requisiti',
  confirming: 'In attesa di conferma',
  itinerary_proposed: 'Itinerario proposto',
  booking_confirmed: 'Prenotazione confermata',
  unknown: 'Stato non disponibile',
};
const ACTIVE_CONVERSATION_KEY = 'activeItineraryConversationId';

let currentPage = 1;
let detailTrigger = null;
let detailVisible = false;
let selectedConversationId = null;
const detailContainer = document.getElementById('conversation-detail');

function element(tag, { className, text } = {}) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function formatDate(value) {
  if (!value) return 'Data non disponibile';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Data non disponibile' : date.toLocaleString('it-IT');
}

function formatMoney(value) {
  return typeof value === 'number'
    ? new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR' }).format(value)
    : 'Costo non disponibile';
}

function requirementSummary(requirements = {}) {
  const parts = [];
  if (requirements.country) parts.push(requirements.country);
  if (requirements.travelMonth) parts.push(requirements.travelMonth);
  if (requirements.durationDays) parts.push(`${requirements.durationDays} giorni`);
  return parts.join(' · ') || 'Requisiti ancora incompleti';
}

function addDefinition(list, label, value) {
  const row = element('div', { className: 'definition-row' });
  row.append(element('dt', { text: label }), element('dd', { text: value }));
  list.append(row);
}

function renderRequirements(container, requirements = {}) {
  const list = element('dl', { className: 'definition-list' });
  const preferences = Array.isArray(requirements.activityPreferences)
    ? requirements.activityPreferences.join(', ')
    : null;
  addDefinition(list, 'Destinazione', requirements.country || 'Non indicata');
  addDefinition(list, 'Partenza', requirements.departureAirport || 'Non indicata');
  addDefinition(list, 'Periodo', requirements.travelMonth || 'Non indicato');
  addDefinition(list, 'Durata', requirements.durationDays ? `${requirements.durationDays} giorni` : 'Non indicata');
  addDefinition(list, 'Partecipanti', requirements.participants ? String(requirements.participants) : 'Non indicati');
  addDefinition(list, 'Budget', typeof requirements.budget === 'number' ? formatMoney(requirements.budget) : 'Non indicato');
  addDefinition(list, 'Preferenze', preferences || 'Non indicate');
  container.append(list);
}

function renderItinerary(itinerary) {
  const card = element('article', { className: 'history-itinerary' });
  const title = element('h3', { text: `Itinerario · ${itinerary.status || 'stato non disponibile'}` });
  card.append(title, element('p', { text: `Totale: ${formatMoney(itinerary.totalCost)}` }));

  const details = itinerary.details && typeof itinerary.details === 'object' ? itinerary.details : {};
  if (details.hotel?.name) card.append(element('p', { text: `Hotel: ${details.hotel.name}` }));
  const outbound = details.flights?.outbound;
  const inbound = details.flights?.inbound;
  if (outbound || inbound) {
    const flightText = [outbound, inbound].filter(Boolean).map((flight) => {
      const from = flight.originAirport?.iataCode || '?';
      const to = flight.destinationAirport?.iataCode || '?';
      return `${from} → ${to} (${formatDate(flight.date)})`;
    }).join(' · ');
    card.append(element('p', { text: `Voli: ${flightText}` }));
  }
  const activities = Array.isArray(details.activities) ? details.activities : [];
  card.append(element('p', { text: activities.length ? `Attività: ${activities.map((item) => item.name || 'Attività').join(', ')}` : 'Nessuna attività salvata' }));
  return card;
}

function isMobileHistory() {
  return typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 800px)').matches;
}

function syncDetailMode() {
  const mobile = isMobileHistory();
  if (mobile && detailVisible) {
    detailContainer.classList.add('is-open');
    detailContainer.setAttribute('role', 'dialog');
    detailContainer.setAttribute('aria-modal', 'true');
    detailContainer.setAttribute('aria-hidden', 'false');
    document.body.classList.add('history-detail-open');
  } else if (!mobile && detailVisible) {
    detailContainer.classList.remove('is-open');
    detailContainer.removeAttribute('role');
    detailContainer.removeAttribute('aria-modal');
    detailContainer.setAttribute('aria-hidden', 'false');
    document.body.classList.remove('history-detail-open');
  } else {
    detailContainer.classList.remove('is-open');
    detailContainer.removeAttribute('role');
    detailContainer.removeAttribute('aria-modal');
    detailContainer.setAttribute('aria-hidden', mobile ? 'true' : 'false');
    document.body.classList.remove('history-detail-open');
  }
}

function closeDetail() {
  if (!detailVisible) return;
  detailVisible = false;
  syncDetailMode();
  if (detailTrigger && typeof detailTrigger.focus === 'function') detailTrigger.focus();
}

function createDetailCloseButton() {
  const button = element('button', { className: 'history-detail-close', text: '×' });
  button.type = 'button';
  button.setAttribute('aria-label', 'Chiudi dettaglio conversazione');
  button.addEventListener('click', closeDetail);
  return button;
}

function setSelectedConversation(id) {
  selectedConversationId = id;
  document.querySelectorAll('.history-item').forEach((item) => {
    const selected = item.dataset.conversationId === id;
    item.classList.toggle('is-selected', selected);
    item.setAttribute('aria-pressed', String(selected));
  });
}

async function showDetail(id, trigger = null) {
  setSelectedConversation(id);
  detailTrigger = trigger || document.activeElement;
  detailVisible = true;
  syncDetailMode();
  const closeButton = createDetailCloseButton();
  const loadingHeader = element('div', { className: 'history-detail-header booking-detail-header' });
  const loadingHeading = element('div', { className: 'history-detail-heading booking-detail-heading' });
  loadingHeading.append(element('h2', { text: 'Dettaglio conversazione' }));
  loadingHeader.append(closeButton, loadingHeading);
  detailContainer.replaceChildren(loadingHeader, element('p', { text: 'Caricamento dettaglio...' }));
  if (isMobileHistory()) requestAnimationFrame(() => closeButton.focus());
  try {
    const conversation = await api(`/chat/conversations/${encodeURIComponent(id)}`);
    const state = conversation.state || {};
    const detailHeader = element('div', { className: 'history-detail-header booking-detail-header' });
    detailHeader.append(closeButton);
    const resumeLink = element('a', { className: 'history-resume', text: 'Riprendi conversazione' });
    resumeLink.href = `chat.html?conversationId=${encodeURIComponent(conversation.id)}`;
    resumeLink.setAttribute('aria-label', `Riprendi conversazione: ${requirementSummary(state.requirements)}`);
    resumeLink.addEventListener('click', () => {
      localStorage.setItem(ACTIVE_CONVERSATION_KEY, conversation.id);
    });
    const deleteButton = element('button', { className: 'history-delete', text: 'Elimina conversazione' });
    deleteButton.type = 'button';
    deleteButton.setAttribute('aria-label', `Elimina conversazione: ${requirementSummary(state.requirements)}`);
    deleteButton.addEventListener('click', async () => {
      if (!window.confirm('Eliminare questa conversazione dallo storico?')) return;
      deleteButton.disabled = true;
      try {
        await api(`/chat/conversations/${encodeURIComponent(conversation.id)}`, { method: 'DELETE' });
        if (localStorage.getItem(ACTIVE_CONVERSATION_KEY) === conversation.id) {
          localStorage.removeItem(ACTIVE_CONVERSATION_KEY);
        }
        selectedConversationId = null;
        detailVisible = false;
        syncDetailMode();
        detailContainer.replaceChildren(element('p', { className: 'muted', text: 'Seleziona una conversazione per visualizzarne il dettaglio.' }));
        await loadPage(currentPage);
      } catch (error) {
        deleteButton.disabled = false;
        document.getElementById('history-status').textContent = `Errore: ${error.message}`;
      }
    });
    const detailActions = element('div', { className: 'detail-actions history-detail-actions booking-detail-actions' });
    detailActions.append(resumeLink, deleteButton);
    const detailHeading = element('div', { className: 'history-detail-heading booking-detail-heading' });
    const detailTitle = element('h2', { text: 'Dettaglio conversazione' });
    detailTitle.id = 'history-detail-title';
    detailHeading.append(detailTitle, detailActions);
    detailHeader.append(detailHeading);
    detailContainer.replaceChildren(
      detailHeader,
      element('span', { className: 'badge history-status', text: PHASE_LABELS[conversation.status] || conversation.status || PHASE_LABELS.unknown }),
      element('p', { className: 'muted', text: `Aggiornata: ${formatDate(conversation.updatedAt)}` }),
      element('h3', { text: 'Requisiti' }),
    );
    renderRequirements(detailContainer, state.requirements);

    detailContainer.append(element('h3', { text: 'Messaggi' }));
    const messages = Array.isArray(conversation.messages) ? conversation.messages : [];
    if (!messages.length) detailContainer.append(element('p', { className: 'muted', text: 'Nessun messaggio registrato.' }));
    for (const message of messages) {
      const item = element('div', { className: `history-message ${message.role === 'user' ? 'user' : 'assistant'}` });
      item.append(
        element('strong', { text: message.role === 'user' ? 'Tu' : 'Assistente' }),
        element('p', { text: message.content || '' }),
      );
      detailContainer.append(item);
    }

    detailContainer.append(element('h3', { text: 'Itinerari associati' }));
    const itineraries = Array.isArray(conversation.itineraries) ? conversation.itineraries : [];
    if (!itineraries.length) detailContainer.append(element('p', { className: 'muted', text: 'Nessun itinerario salvato per questa conversazione.' }));
    itineraries.forEach((itinerary) => detailContainer.append(renderItinerary(itinerary)));
  } catch (error) {
    const errorHeader = element('div', { className: 'history-detail-header booking-detail-header' });
    errorHeader.append(closeButton);
    detailContainer.replaceChildren(errorHeader, element('p', { className: 'error', text: `Errore: ${error.message}` }));
  }
}

async function loadPage(page) {
  const status = document.getElementById('history-status');
  const list = document.getElementById('conversation-list');
  status.textContent = 'Caricamento...';
  try {
    const data = await api(`/chat/conversations?page=${page}&pageSize=10`);
    currentPage = data.pagination.page;
    list.replaceChildren();
    if (!data.items.length) {
      list.append(element('div', { className: 'card muted', text: 'Nessuna conversazione disponibile. Inizia dalla chat.' }));
    }
    for (const conversation of data.items) {
      const item = element('article', { className: 'history-entry' });
      item.setAttribute('role', 'listitem');
      const button = element('button', { className: 'card history-item' });
      button.type = 'button';
      button.dataset.conversationId = conversation.id;
      button.setAttribute('aria-pressed', String(conversation.id === selectedConversationId));
      button.append(
        element('strong', { text: requirementSummary(conversation.requirements) }),
        element('span', { className: 'badge history-status', text: PHASE_LABELS[conversation.status] || conversation.status || PHASE_LABELS.unknown }),
        element('small', { className: 'muted', text: `${conversation.messageCount} messaggi · ${conversation.itineraryCount} itinerari · ${formatDate(conversation.updatedAt)}` }),
      );
      button.addEventListener('click', () => showDetail(conversation.id, button));
      item.append(button);
      list.append(item);
    }
    const { totalItems, totalPages, hasPreviousPage, hasNextPage } = data.pagination;
    status.textContent = `${totalItems} conversazioni`;
    document.getElementById('page-label').textContent = totalPages ? `Pagina ${currentPage} di ${totalPages}` : 'Nessuna pagina';
    document.getElementById('previous-page').disabled = !hasPreviousPage;
    document.getElementById('next-page').disabled = !hasNextPage;
  } catch (error) {
    status.textContent = `Errore: ${error.message}`;
    list.replaceChildren();
  }
}

document.getElementById('previous-page').addEventListener('click', () => loadPage(currentPage - 1));
document.getElementById('next-page').addEventListener('click', () => loadPage(currentPage + 1));
document.addEventListener('keydown', (event) => {
  if (!detailContainer.classList.contains('is-open')) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    closeDetail();
    return;
  }
  if (event.key !== 'Tab') return;
  const focusable = [...detailContainer.querySelectorAll('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])')];
  if (!focusable.length) {
    event.preventDefault();
    detailContainer.focus();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
});
window.addEventListener('resize', syncDetailMode);
syncDetailMode();
loadPage(1);
