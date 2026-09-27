/**
 * localStorage that never throws: private windows, blocked site data and thumbnail renderers all make the accessor
 * itself throw, and the UI must render correctly without a stored value.
 */
export function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStorage(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // Storage unavailable: the setting simply won't persist.
  }
}
