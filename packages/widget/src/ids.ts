// Id generation for items, clientMessageIds, and nothing else. These ids
// need uniqueness, not unpredictability — crypto.randomUUID requires a
// secure context, and a storefront staging site on plain http should degrade
// to weaker ids rather than crash the widget.

export function generateId(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi !== undefined && typeof cryptoApi.randomUUID === 'function') {
    return cryptoApi.randomUUID();
  }
  if (cryptoApi !== undefined && typeof cryptoApi.getRandomValues === 'function') {
    const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
}
