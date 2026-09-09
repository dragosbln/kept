// Node's experimental Web Storage globals shadow happy-dom's storages under
// the vitest environment — and Node's localStorage is undefined unless the
// process runs with --localstorage-file. The suite needs deterministic
// Storage semantics, so both globals are replaced with a minimal in-memory
// implementation. Browsers are unaffected; this file exists for tests only.

class MemoryStorage {
  private store = new Map<string, string>();

  get length(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
  }

  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.store.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
}

for (const name of ['localStorage', 'sessionStorage'] as const) {
  Object.defineProperty(globalThis, name, {
    value: new MemoryStorage(),
    configurable: true,
    writable: true,
  });
}
