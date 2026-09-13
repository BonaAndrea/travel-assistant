// Stable comparison for JSON requirements, independent of object key order.
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
}

export function sameRequirements(left, right) {
  return !!left && !!right && JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}
