// jsdom under Vitest does not provide a working localStorage, so install a
// small Map-backed polyfill that matches the Web Storage API surface our code
// uses (getItem / setItem / removeItem / clear).
class MemoryStorage {
  #m = new Map();
  getItem(k) { return this.#m.has(k) ? this.#m.get(k) : null; }
  setItem(k, v) { this.#m.set(String(k), String(v)); }
  removeItem(k) { this.#m.delete(k); }
  clear() { this.#m.clear(); }
  key(i) { return [...this.#m.keys()][i] ?? null; }
  get length() { return this.#m.size; }
}

Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: new MemoryStorage(),
});
