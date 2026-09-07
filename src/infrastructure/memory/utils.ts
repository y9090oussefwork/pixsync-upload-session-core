/**
 * Yields to the event loop before every repository operation, simulating the
 * async I/O boundary of a real database. The check-and-mutate critical
 * sections below run synchronously after this yield, which is what makes
 * them atomic with respect to interleaved async callers — the same guarantee
 * a single conditional PostgreSQL UPDATE provides.
 */
export function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export function clone<T>(value: T): T {
  return structuredClone(value);
}
