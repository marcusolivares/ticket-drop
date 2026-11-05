// Read a PDF into the list of styled words that the booklet parser expects.

const PDFJS_URL = new URL("./vendor/pdfjs/pdf.min.mjs", import.meta.url).href;
const WORKER_URL = new URL("./vendor/pdfjs/pdf.worker.min.mjs", import.meta.url).href;

// Age ratings are small badges in the middle of schedule text. pdf.js merges text
// in the same font on a line and reports only the first size, so "A14 GRÁTIS." looks
// entirely small, and "25/10. A14" entirely normal. They're told apart again here.
const AGE_BADGE = /^(AL|A\d{1,2})$/;
const BADGE_SIZE = 6;
const SCHEDULE_SIZE = 8.5;
const SCHEDULE_FONT = /SemiBold$/;

function wordsOf(item, fontname, page) {
  const size = Math.hypot(item.transform[2], item.transform[3]);
  const isSchedule = SCHEDULE_FONT.test(fontname) && (size === BADGE_SIZE || size === SCHEDULE_SIZE);
  return item.str
    .split(/\s+/)
    .filter(Boolean)
    .map((text) => {
      if (!isSchedule) return { text, fontname, size, page };
      return { text, fontname, size: AGE_BADGE.test(text) ? BADGE_SIZE : SCHEDULE_SIZE, page };
    });
}

/**
 * Find the real name of each font in use.
 *
 * pdf.js only exposes them after a page's full contents are processed, including
 * its images, so that's done for as few pages as possible. Pages near the middle
 * of the booklet are mostly listings, with fewer large photos than the first pages.
 */
async function fontNames(document, pagesByFont) {
  const middle = document.numPages / 2;
  const names = new Map();
  for (const [font, pages] of pagesByFont) {
    if (names.has(font)) continue;
    const number = [...pages].sort((a, b) => Math.abs(a - middle) - Math.abs(b - middle))[0];
    const page = await document.getPage(number);
    await page.getOperatorList();
    for (const candidate of pagesByFont.keys()) {
      if (!names.has(candidate) && page.commonObjs.has(candidate)) names.set(candidate, page.commonObjs.get(candidate).name);
    }
    page.cleanup();
  }
  return names;
}

/** Return every word of an open pdf.js document, in the order the file stores them. */
export async function wordsFromDocument(document) {
  const pages = [];
  const pagesByFont = new Map();
  for (let number = 1; number <= document.numPages; number += 1) {
    const page = await document.getPage(number);
    const { items } = await page.getTextContent();
    const textItems = items.filter((item) => item.str?.trim());
    pages.push({ number, items: textItems });
    for (const item of textItems) {
      if (!pagesByFont.has(item.fontName)) pagesByFont.set(item.fontName, new Set());
      pagesByFont.get(item.fontName).add(number);
    }
    page.cleanup();
  }

  const names = await fontNames(document, pagesByFont);
  const words = [];
  for (const { number, items } of pages) {
    for (const item of items) words.push(...wordsOf(item, names.get(item.fontName) ?? "", number));
  }
  return words;
}

/** Read a PDF's bytes in the browser. pdf.js is only downloaded if this is called. */
export async function readPdfWords(data) {
  const pdfjs = await import(PDFJS_URL);
  pdfjs.GlobalWorkerOptions.workerSrc = WORKER_URL;
  const task = pdfjs.getDocument({ data, fontExtraProperties: true, isEvalSupported: false, verbosity: 0 });
  try {
    return await wordsFromDocument(await task.promise);
  } finally {
    await task.destroy();
  }
}
