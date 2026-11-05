import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { createStore, isFresh } from "../web/store.js";

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    values,
  };
}

describe("createStore", () => {
  test("reads back what it wrote", () => {
    const storage = memoryStorage();
    const store = createStore(() => storage);
    assert.equal(store.write("plays", { a: 1 }), true);
    assert.deepEqual(store.read("plays"), { a: 1 });
  });

  test("gives nothing for an unknown key", () => {
    assert.equal(createStore(memoryStorage).read("missing"), undefined);
  });

  test("gives nothing for corrupt data", () => {
    const storage = memoryStorage();
    storage.values.set("quando-abre:v1:plays", "{not json");
    assert.equal(createStore(() => storage).read("plays"), undefined);
  });

  test("survives storage being unavailable", () => {
    const store = createStore(() => {
      throw new Error("blocked");
    });
    assert.equal(store.read("plays"), undefined);
    assert.equal(store.write("plays", 1), false);
  });

  test("survives storage being full", () => {
    const store = createStore(() => ({
      setItem() {
        throw new Error("QuotaExceededError");
      },
    }));
    assert.equal(store.write("plays", 1), false);
  });
});

describe("isFresh", () => {
  test("is true only within the age limit", () => {
    assert.equal(isFresh(1000, 500, 1499), true);
    assert.equal(isFresh(1000, 500, 1500), false);
  });

  test("is false when the clock has moved backwards", () => {
    assert.equal(isFresh(2000, 500, 1000), false);
  });
});
