const API_BASE = 'http://localhost:4000/api';

function getToken() {
  return localStorage.getItem('token');
}

export class ApiError extends Error {
  constructor(message, { status = 0, payload = {}, sessionExpired = false, retryAfter = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.payload = payload;
    this.sessionExpired = sessionExpired;
    this.retryAfter = retryAfter;
  }
}

function expireSession() {
  localStorage.removeItem('token');
  if (typeof window !== 'undefined' && !window.location.pathname.endsWith('/index.html')) {
    window.location.replace('index.html?session=expired');
  }
  return new ApiError('Sessione scaduta. Accedi di nuovo.', { status: 401, sessionExpired: true });
}

async function refreshAccessToken() {
  const res = await fetch(`${API_BASE}/auth/refresh`, {
    method: 'POST',
    credentials: 'include',
  });
  if (!res.ok) {
    localStorage.removeItem('token');
    return false;
  }
  const data = await res.json();
  localStorage.setItem('token', data.token);
  return true;
}

export async function api(path, { method = 'GET', body, retry = true } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    credentials: 'include',
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401 && retry && path !== '/auth/refresh' && await refreshAccessToken()) {
    return api(path, { method, body, retry: false });
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/auth/')) throw expireSession();
    throw new ApiError(data.error || `Errore ${res.status}`, {
      status: res.status, payload: data, retryAfter: res.headers.get('Retry-After'),
    });
  }
  return data;
}

export async function apiFormData(path, { file, field = 'image', retry = true } = {}) {
  const headers = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const formData = new FormData();
  formData.append(field, file);
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST', headers, credentials: 'include', body: formData,
  });
  if (res.status === 401 && retry && await refreshAccessToken()) {
    return apiFormData(path, { file, field, retry: false });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) throw expireSession();
    throw new ApiError(data.error || `Errore ${res.status}`, {
      status: res.status, payload: data, retryAfter: res.headers.get('Retry-After'),
    });
  }
  return data;
}

export function requireLogin() {
  if (!getToken()) window.location.href = 'index.html';
}

export function logout() {
  fetch(`${API_BASE}/auth/logout`, { method: 'POST', credentials: 'include' }).catch(() => {});
  localStorage.removeItem('token');
  window.location.href = 'index.html';
}
