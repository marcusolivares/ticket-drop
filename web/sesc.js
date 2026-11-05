// Client for the undocumented Sesc SP WordPress endpoints (see docs/sesc-api.md).
//
// It runs in each visitor's browser, so it's careful about how much it asks for,
// and it gives up quickly if Sesc starts refusing requests.

import { SITE_URL } from "./plays.js";

export const API_URL = `${SITE_URL}/wp-json/wp/v1`;
const POSTS_URL = `${SITE_URL}/wp-json/wp/v2/posts`;
const BOOKLET_ARCHIVE_SLUG = "emcartaz";
const PAGE_SIZE = 300;
const MAX_PAGES = 20;
const FILE_TIMEOUT_MS = 5 * 60 * 1000;

export class ApiError extends Error {}

/** The API answered 404. Normal for activities with no ticketed sessions. */
export class NotFoundError extends ApiError {}

/** Too many requests failed in a row, so no more are being sent. */
export class StoppedError extends ApiError {}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function requireSiteUrl(url) {
  if (!url.startsWith(`${SITE_URL}/`)) throw new ApiError(`refusing to download from outside the Sesc site: ${url}`);
  return url;
}

export class SescClient {
  #fetch;
  #sleep;
  #now;
  #concurrency;
  #spacing;
  #attempts;
  #maxFailuresInARow;
  #timeout;
  #active = 0;
  #waiting = [];
  #nextStart = 0;
  #failuresInARow = 0;

  constructor({
    fetch = (...args) => globalThis.fetch(...args),
    sleep = wait,
    now = Date.now,
    concurrency = 3,
    spacing = 150,
    attempts = 3,
    maxFailuresInARow = 3,
    timeout = 30000,
  } = {}) {
    this.#fetch = fetch;
    this.#sleep = sleep;
    this.#now = now;
    this.#concurrency = concurrency;
    this.#spacing = spacing;
    this.#attempts = attempts;
    this.#maxFailuresInARow = maxFailuresInARow;
    this.#timeout = timeout;
  }

  get stopped() {
    return this.#failuresInARow >= this.#maxFailuresInARow;
  }

  /** Return every theatre activity with a session between start and end. */
  async listPlays(start, end) {
    const items = [];
    let seen = 0;
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const query = new URLSearchParams({
        tipo: "atividade",
        linguagem: "teatro",
        data_inicial: start,
        data_final: end,
        ppp: PAGE_SIZE,
        page,
        dinamico: "true",
        sites: "true",
      });
      const payload = await this.#get(`${API_URL}/atividades/filter?${query}`);
      if (!Array.isArray(payload?.atividade)) {
        throw new ApiError(`unexpected listing response: ${String(JSON.stringify(payload)).slice(0, 200)}`);
      }
      const batch = payload.atividade;
      seen += batch.length;
      // Listings can contain null rows, which the total still counts.
      items.push(...batch.filter((item) => item && typeof item === "object"));
      if (batch.length < PAGE_SIZE || seen >= (payload.total?.value ?? 0)) return items;
    }
    throw new ApiError(`listing did not finish within ${MAX_PAGES} pages`);
  }

  /** Return an activity's sessions, or null if it has none to sell. */
  async getDetail(slug) {
    let payload;
    try {
      payload = await this.#get(`${API_URL}/atividades/detail?${new URLSearchParams({ slug })}`);
    } catch (error) {
      if (error instanceof NotFoundError) return null;
      throw error;
    }
    if (!payload || typeof payload !== "object" || !("sessoes" in payload)) {
      throw new ApiError(`unexpected detail response for ${slug}`);
    }
    return payload;
  }

  /** Return the page that links to every booklet, as HTML. */
  async getBookletArchive() {
    const query = new URLSearchParams({ slug: BOOKLET_ARCHIVE_SLUG, _fields: "content" });
    const posts = await this.#get(`${POSTS_URL}?${query}`);
    const html = posts?.[0]?.content?.rendered;
    if (typeof html !== "string") throw new ApiError("unexpected booklet archive response");
    return html;
  }

  /** Return a file's size in bytes, or null if the server doesn't say. */
  async getFileSize(url) {
    return this.#get(requireSiteUrl(url), {
      method: "HEAD",
      read: (response) => Number(response.headers.get("content-length")) || null,
    });
  }

  /** Download a file from the Sesc site. */
  async getFile(url) {
    return this.#get(requireSiteUrl(url), { read: (response) => response.arrayBuffer(), timeout: FILE_TIMEOUT_MS });
  }

  async #get(url, options = {}) {
    this.#throwIfStopped();
    await this.#takeSlot();
    try {
      this.#throwIfStopped();
      await this.#waitForTurn();
      return await this.#fetchWithRetries(url, options);
    } finally {
      this.#releaseSlot();
    }
  }

  async #fetchWithRetries(url, { method = "GET", read = (response) => response.json(), timeout = this.#timeout }) {
    let failure;
    for (let attempt = 1; attempt <= this.#attempts; attempt += 1) {
      this.#throwIfStopped();
      let response;
      try {
        response = await this.#fetch(url, { method, credentials: "omit", signal: AbortSignal.timeout(timeout) });
        if (response.status === 404) {
          this.#failuresInARow = 0;
          throw new NotFoundError(url);
        }
        if (response.ok) {
          const result = await read(response);
          this.#failuresInARow = 0;
          return result;
        }
        failure = new ApiError(`${url}: HTTP ${response.status}`);
        // A refusal won't change by asking again.
        if (response.status !== 429 && response.status < 500) break;
      } catch (error) {
        if (error instanceof NotFoundError) throw error;
        failure = error;
      }
      if (attempt < this.#attempts) await this.#sleep(1000 * 2 ** attempt);
    }
    // A blocked response can reach the browser as a plain network error, so
    // failures in a row are the only reliable sign that Sesc is refusing.
    this.#failuresInARow += 1;
    if (failure instanceof ApiError) throw failure;
    throw new ApiError(`${url}: ${failure}`);
  }

  #throwIfStopped() {
    if (this.stopped) throw new StoppedError("too many requests failed in a row");
  }

  #takeSlot() {
    if (this.#active < this.#concurrency) {
      this.#active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.#waiting.push(resolve));
  }

  #releaseSlot() {
    const next = this.#waiting.shift();
    if (next) next();
    else this.#active -= 1;
  }

  /** Keep at least `spacing` milliseconds between requests. */
  async #waitForTurn() {
    const now = this.#now();
    const start = Math.max(now, this.#nextStart);
    this.#nextStart = start + this.#spacing;
    if (start > now) await this.#sleep(start - now);
  }
}
