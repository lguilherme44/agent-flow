type Plain = Record<string, unknown>;

const isPlainObject = (value: unknown): value is Plain =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Deep merge for configuration overlays.
 *
 * Objects merge recursively; arrays replace wholesale. That asymmetry is
 * deliberate. Merging objects is what lets a project raise the effort of one
 * role without restating the entire routing table. Concatenating arrays would
 * make it impossible to *narrow* a list — a project could never reduce the set
 * of fallback triggers, only extend it.
 *
 * `undefined` never overwrites: an absent key means "inherit", not "clear".
 */
export function deepMerge<T extends Plain>(base: T, overlay: Plain): T {
  const result: Plain = { ...base };

  for (const [key, value] of Object.entries(overlay)) {
    if (value === undefined) continue;

    const current = result[key];
    result[key] = isPlainObject(current) && isPlainObject(value)
      ? deepMerge(current, value)
      : value;
  }

  return result as T;
}
