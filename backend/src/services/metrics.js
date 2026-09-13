const DEFAULT_BUCKETS = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];
const ALLOWED_LABELS = new Set(['method', 'route', 'status', 'outcome', 'reason', 'operation', 'error', 'cache']);

function normalizeLabels(labels = {}) {
  return Object.fromEntries(Object.entries(labels)
    .filter(([key, value]) => ALLOWED_LABELS.has(key) && value !== undefined)
    .map(([key, value]) => [key, String(value)]));
}

function keyFor(name, labels) {
  return `${name}|${JSON.stringify(Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)))}`;
}

export function createMetricsRegistry({ now = () => new Date().toISOString(), buckets = DEFAULT_BUCKETS } = {}) {
  const counters = new Map();
  const histograms = new Map();

  function increment(name, labels = {}, value = 1) {
    const safeLabels = normalizeLabels(labels);
    const key = keyFor(name, safeLabels);
    const current = counters.get(key);
    counters.set(key, { name, labels: safeLabels, value: (current?.value || 0) + value });
  }

  function observe(name, value, labels = {}) {
    const safeLabels = normalizeLabels(labels);
    const key = keyFor(name, safeLabels);
    const current = histograms.get(key) || {
      name, labels: safeLabels, count: 0, sum: 0,
      buckets: Object.fromEntries(buckets.map((bucket) => [String(bucket), 0])),
    };
    current.count += 1;
    current.sum += value;
    for (const bucket of buckets) if (value <= bucket) current.buckets[String(bucket)] += 1;
    histograms.set(key, current);
  }

  function snapshot() {
    return {
      generatedAt: now(),
      counters: [...counters.values()].map((metric) => ({ ...metric, labels: { ...metric.labels } })),
      histograms: [...histograms.values()].map((metric) => ({
        ...metric, labels: { ...metric.labels }, buckets: { ...metric.buckets },
      })),
    };
  }

  function reset() {
    counters.clear();
    histograms.clear();
  }

  return { increment, observe, snapshot, reset };
}

export const metrics = createMetricsRegistry();

function routeLabel(req) {
  const route = req.route?.path;
  if (route) return `${req.baseUrl || ''}${route}`;
  if (req.path === '/health') return '/health';
  return 'unmatched';
}

export function createMetricsMiddleware(registry = metrics) {
  return (req, res, next) => {
    const startedAt = process.hrtime.bigint();
    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      const labels = { method: req.method, route: routeLabel(req), status: res.statusCode };
      registry.increment('http_requests_total', labels);
      registry.observe('http_request_duration_ms', durationMs, labels);
    });
    next();
  };
}

export function createMetricsEndpoint({ registry = metrics, token = process.env.METRICS_TOKEN } = {}) {
  return (req, res) => {
    if (!token) return res.status(404).json({ error: 'Metriche non abilitate' });
    if (req.get('authorization') !== `Bearer ${token}`) {
      return res.status(401).json({ error: 'Autorizzazione richiesta' });
    }
    return res.json(registry.snapshot());
  };
}

export function metricErrorCategory(error) {
  if (error?.code && /^[A-Z0-9_]+$/.test(error.code)) return error.code;
  if (error?.name && /^[A-Za-z0-9]+Error$/.test(error.name)) return error.name;
  return 'unknown';
}
