// A small wrapper around localStorage. Browsers can refuse or empty it at any
// time, so every failure just means there's nothing saved.

const PREFIX = "quando-abre:v1:";

export function createStore(getStorage = () => globalThis.localStorage) {
  return {
    read(key) {
      try {
        return JSON.parse(getStorage().getItem(PREFIX + key)) ?? undefined;
      } catch {
        return undefined;
      }
    },
    write(key, value) {
      try {
        getStorage().setItem(PREFIX + key, JSON.stringify(value));
        return true;
      } catch {
        return false;
      }
    },
  };
}

// A clock that has moved backwards also counts as not fresh.
export function isFresh(savedAt, maxAgeMs, now) {
  const age = now - savedAt;
  return age >= 0 && age < maxAgeMs;
}
