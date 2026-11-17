// Save the latest Em Cartaz booklet's theatre entries for the page, in web/booklet.json.
//
// Sesc no longer lets other sites read its programme or its booklets, so visitors'
// browsers can't (see docs/sesc-api.md). This runs on the maintainer's computer
// instead, which Sesc still answers. It makes two requests, without disguising
// them: the archive page, and the booklet itself if it's a new edition.
//
//     node tools/update-booklet.js [--force]
//
// Then commit web/booklet.json. Pushing it to master publishes it.

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import { BookletError, MIN_ENTRIES, findEdition, isKnownUnit, latestBookletUrl, parseEntries, textRuns } from "../web/booklet.js";
import { SITE_URL } from "../web/plays.js";
import { readPdfWords } from "./pdf-words.js";

export const USER_AGENT = "ticket-drop (unofficial schedule viewer)";
const ARCHIVE_URL = `${SITE_URL}/wp-json/wp/v2/posts?slug=emcartaz&_fields=content`;
const OUTPUT = new URL("../web/booklet.json", import.meta.url);
const FETCH_TIMEOUT_MS = 5 * 60 * 1000;

async function get(fetch, url) {
  const response = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response;
}

/**
 * Return the latest booklet's entries, or null if `saved` already has that edition.
 *
 * `readPdf` turns a PDF's bytes into styled words.
 */
export async function updateBooklet({ fetch = globalThis.fetch, readPdf = readPdfWords, saved = null, force = false } = {}) {
  const posts = await (await get(fetch, ARCHIVE_URL)).json();
  const html = posts?.[0]?.content?.rendered;
  if (typeof html !== "string") throw new BookletError("unexpected booklet archive response");
  const url = latestBookletUrl(html);
  if (!force && saved?.url === url) return null;

  const pdf = await (await get(fetch, url)).arrayBuffer();
  const runs = textRuns(await readPdf(new Uint8Array(pdf)));
  const entries = parseEntries(runs);
  if (entries.length < MIN_ENTRIES) {
    throw new BookletError(`only ${entries.length} theatre entries found, so the layout may have changed`);
  }
  return { url, edition: findEdition(runs), entries };
}

async function readSaved() {
  try {
    return JSON.parse(await readFile(OUTPUT, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function main(args) {
  const saved = await readSaved();
  const booklet = await updateBooklet({ saved, force: args.includes("--force") });
  if (!booklet) {
    console.log(`Already up to date: ${saved.url}`);
    return;
  }
  await writeFile(OUTPUT, `${JSON.stringify(booklet, null, 2)}\n`);
  const [month, year] = booklet.edition;
  console.log(`Saved ${booklet.entries.length} entries from the ${month}/${year} booklet to ${fileURLToPath(OUTPUT)}`);
  const unknown = [...new Set(booklet.entries.map((entry) => entry.unit).filter((unit) => !isKnownUnit(unit)))];
  if (unknown.length) {
    console.log(`These units aren't in web/regions.js, so their plays won't appear: ${unknown.join(", ")}`);
  }
  console.log("Commit web/booklet.json, then push to publish it.");
}

// Run only when started directly, not when imported. `node -e` has no script path.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`Couldn't update the booklet: ${error.message}`);
    process.exitCode = 1;
  });
}
