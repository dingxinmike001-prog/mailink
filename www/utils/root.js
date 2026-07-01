export function getUtilsRoot() {
  const local = typeof window !== 'undefined' ? window.utils : undefined;
  if (local && typeof local === 'object') return local;

  const parent = typeof window !== 'undefined' ? window.parent?.utils : undefined;
  if (parent && typeof parent === 'object') return parent;

  return undefined;
}

