/**
 * Bangla Page Translator - background script
 *
 * The content script never talks to Google directly. It sends the texts it
 * found on the page to this script:
 *
 *   browser.runtime.sendMessage({ type: 'bpbt-translate', texts: [...] })
 *
 * This script then:
 *   1. Splits long texts into safe chunks (keeps every request small).
 *   2. Resolves everything it can from the browser.storage.local cache
 *      (repeated text = zero Google requests).
 *   3. Batches the remaining pieces into ONE request each, with up to
 *      SETTINGS.batchItems pieces separated by newlines (Google preserves
 *      the line structure and translates every line).
 *   4. Runs SETTINGS.concurrency requests in parallel, starting them at
 *      least SETTINGS.minStartGapMs apart - this is what makes a full page
 *      translate in roughly one second instead of one request per node.
 *   5. Backs off and retries automatically on HTTP 429 / network errors.
 *   6. Answers with { ok: true, results: { <source>: <bangla> } }
 *      or      with { ok: false, error: '<useful message>', results: <partial> }.
 *
 * It also answers { type: 'bpbt-inject' } which the popup uses to inject
 * content.js into tabs that were already open when the extension loaded.
 */
'use strict';

/* ------------------------------------------------------------------ *
 * Configuration (kept in one object so it can be tuned in one place)
 * ------------------------------------------------------------------ */

const SETTINGS = {
  // Free Google Translate hosts (client=gtx = the public web client).
  // The first reachable one is used; on timeout/connection errors we
  // automatically switch to the other server and keep going.
  hosts: ['translate.googleapis.com', 'translate.google.com'],
  translatePath: '/translate_a/single',
  targetLang: 'bn', // Bangla / Bengali

  maxChunk: 400, // long text is cut into pieces of at most this size
  batchItems: 12, // max pieces per request (newline separated)
  batchChars: 1400, // max total characters per request
  concurrency: 6, // requests in flight at the same time
  minStartGapMs: 100, // minimum spacing between two request starts
  requestTimeoutMs: 30000, // slow connections need room before we give up

  // Backoff before retrying (milliseconds), tried in order.
  retryRate: [1500, 3500], // after HTTP 429
  retryNet: [400, 1200], // timeouts / connection errors (also switches host)
  retrySoft: [400, 1200], // HTTP 5xx, bad JSON

  cacheMaxEntries: 1500 // browser.storage.local cache size limit
};

const CACHE_INDEX_KEY = 'bn-cache-index';

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

function sleep(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

/** Build an Error that carries a machine readable "kind". */
function makeError(kind, message) {
  const err = new Error(message);
  err.kind = kind; // 'rate' | 'soft' | 'fatal'
  return err;
}

/**
 * All translation work is chained onto one queue, so requests coming from
 * several tabs still respect the same rate limits, in order.
 */
let workQueue = Promise.resolve();

function enqueue(task) {
  const run = workQueue.then(task, task);
  // Keep the chain alive even if this task fails.
  workQueue = run.then(
    function () {},
    function () {}
  );
  return run;
}

/* ------------------------------------------------------------------ *
 * Request pacing (shared by every worker and every tab)
 * ------------------------------------------------------------------ */

let nextSlotAt = 0;

/* Which Google host we are currently using (see SETTINGS.hosts).
 * Rotated on timeout/connection errors so one dead server can never
 * break the whole extension. */
let hostIndex = 0;

function currentHost() {
  return SETTINGS.hosts[hostIndex % SETTINGS.hosts.length];
}

function rotateHost() {
  hostIndex = (hostIndex + 1) % SETTINGS.hosts.length;
}

/** Reserve the next start slot so requests never fire closer together
 *  than SETTINGS.minStartGapMs, even when running in parallel. */
async function waitForSlot() {
  const now = Date.now();
  const at = Math.max(now, nextSlotAt);
  nextSlotAt = at + SETTINGS.minStartGapMs;
  if (at > now) {
    await sleep(at - now);
  }
}

/* ------------------------------------------------------------------ *
 * Translation cache (browser.storage.local)
 *
 * Key:    hash of the source text  ->  "bn:<hash>"
 * Value:  { s: <source text>, t: <translated text> }
 *
 * The source text is stored inside the value and re-checked on read, so a
 * hash collision can never show the wrong translation (it just re-translates).
 * ------------------------------------------------------------------ */

function fnv1a(str, seed) {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

function cacheKeyFor(text) {
  return 'bn:' + fnv1a(text, 0x811c9dc5) + fnv1a(text, 0x9e3779b1) + '-' + text.length.toString(36);
}

/** Look up many chunks in one storage call. Returns Map<chunk, translation>. */
async function cacheGetMany(chunks) {
  const found = new Map();
  if (!chunks.length) {
    return found;
  }
  try {
    const keyToChunk = new Map();
    const keys = [];
    for (const chunk of chunks) {
      const key = cacheKeyFor(chunk);
      if (!keyToChunk.has(key)) {
        keyToChunk.set(key, chunk);
        keys.push(key);
      }
    }
    const stored = await browser.storage.local.get(keys);
    keyToChunk.forEach(function (chunk, key) {
      const entry = stored[key];
      if (entry && entry.s === chunk && typeof entry.t === 'string') {
        found.set(chunk, entry.t);
      }
    });
  } catch (err) {
    // Storage problems must never break translation - treat as a miss.
  }
  return found;
}

/** Store many chunks in one storage call (with least-recentu-use trimming). */
async function cachePutMany(resolved) {
  if (!resolved || !resolved.size) {
    return;
  }
  try {
    const payload = {};
    const keys = [];
    resolved.forEach(function (translated, chunk) {
      const key = cacheKeyFor(chunk);
      keys.push(key);
      payload[key] = { s: chunk, t: translated };
    });

    const data = await browser.storage.local.get(CACHE_INDEX_KEY);
    const index = Array.isArray(data[CACHE_INDEX_KEY]) ? data[CACHE_INDEX_KEY].slice() : [];
    for (const key of keys) {
      const at = index.indexOf(key);
      if (at !== -1) {
        index.splice(at, 1);
      }
      index.push(key); // newest at the end
    }
    const evicted = [];
    while (index.length > SETTINGS.cacheMaxEntries) {
      evicted.push(index.shift());
    }
    payload[CACHE_INDEX_KEY] = index;

    await browser.storage.local.set(payload);
    if (evicted.length) {
      await browser.storage.local.remove(evicted);
    }
  } catch (err) {
    // Ignore cache write problems (for example: quota exceeded).
  }
}

/* ------------------------------------------------------------------ *
 * Chunking
 * ------------------------------------------------------------------ */

/**
 * Find a safe place to cut a long string:
 *   1. after a sentence end ( . ! ? \n and the Bangla/Devanagari danda )
 *      that is followed by whitespace or the end of the window,
 *   2. otherwise at the last space (word boundary),
 *   3. otherwise a hard cut (very long words / URLs).
 * Never cuts in the first 40% of the window.
 */
function findChunkBreak(win) {
  const min = Math.floor(win.length * 0.4);

  for (let i = win.length - 1; i >= min; i--) {
    const ch = win[i];
    if (ch === '\n') {
      return i + 1;
    }
    if (ch === '.' || ch === '!' || ch === '?' || ch === '।') {
      const next = win[i + 1];
      if (next === undefined || next === ' ' || next === '\n') {
        return i + 1;
      }
    }
  }

  const space = win.lastIndexOf(' ');
  if (space >= min) {
    return space + 1;
  }

  return win.length;
}

function splitIntoChunks(text) {
  if (text.length <= SETTINGS.maxChunk) {
    return [text];
  }

  const chunks = [];
  let rest = text;
  while (rest.length > SETTINGS.maxChunk) {
    const windowPart = rest.slice(0, SETTINGS.maxChunk);
    const cut = findChunkBreak(windowPart);
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.length) {
    chunks.push(rest);
  }
  return chunks;
}

/* ------------------------------------------------------------------ *
 * Talking to Google
 * ------------------------------------------------------------------ */

/** Parse the raw Google answer into one translated string. */
function parseGoogleResponse(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw makeError(
      'soft',
      'Google Translate returned invalid JSON. The free endpoint may have changed or blocked this request.'
    );
  }

  // Expected shape: [ [ [ "translated", "source", ... ], ... ], ... ]
  if (!Array.isArray(data) || !Array.isArray(data[0])) {
    throw makeError(
      'soft',
      'Unexpected Google Translate response format. The free endpoint may have changed.'
    );
  }

  let out = '';
  for (const part of data[0]) {
    if (Array.isArray(part) && typeof part[0] === 'string') {
      out += part[0];
    }
  }
  return out;
}

/** One Google request for one string (already shorter than maxChunk). */
async function fetchTranslated(text) {
  const host = currentHost();
  const url =
    'https://' +
    host +
    SETTINGS.translatePath +
    '?client=gtx&sl=auto&tl=' +
    SETTINGS.targetLang +
    '&dt=t&q=' +
    encodeURIComponent(text);

  // A stalled connection must never block the whole page forever.
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller
    ? setTimeout(function () {
        controller.abort();
      }, SETTINGS.requestTimeoutMs)
    : null;

  try {
    let response;
    try {
      response = await fetch(
        url,
        controller ? { method: 'GET', cache: 'no-store', signal: controller.signal } : { method: 'GET', cache: 'no-store' }
      );
    } catch (err) {
      if (err && err.name === 'AbortError') {
        throw makeError(
          'net',
          'Google Translate timed out on ' +
            host +
            ' (' +
            Math.max(1, Math.round(SETTINGS.requestTimeoutMs / 1000)) +
            's limit).'
        );
      }
      throw makeError(
        'net',
        'Could not reach ' + host + ' (' + (err && err.message ? err.message : err) + ').'
      );
    }

    if (response.status === 429) {
      throw makeError('rate', 'Google rate-limited this extension (HTTP 429). Wait a minute and try again.');
    }
    if (response.status >= 500) {
      throw makeError('soft', 'Google Translate endpoint returned HTTP ' + response.status + '.');
    }
    if (!response.ok) {
      throw makeError('fatal', 'Google Translate endpoint returned HTTP ' + response.status + '.');
    }

    let raw;
    try {
      raw = await response.text();
    } catch (err) {
      if (err && err.name === 'AbortError') {
        throw makeError('net', 'Reading the Google Translate response timed out on ' + host + '.');
      }
      throw makeError('net', 'Could not read the Google Translate response from ' + host + '.');
    }

    const out = parseGoogleResponse(raw);
    if (!out && text.trim()) {
      throw makeError('soft', 'Google Translate returned an empty translation for this text.');
    }
    return out;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

/** One request with pacing + automatic backoff/retry.
 *  Timeout/connection errors also switch to the other Google server. */
async function requestWithRetry(text) {
  let rateTries = 0;
  let netTries = 0;
  let softTries = 0;
  const triedHosts = [];

  for (;;) {
    await waitForSlot();
    triedHosts.push(currentHost());
    try {
      return await fetchTranslated(text);
    } catch (err) {
      if (err.kind === 'rate' && rateTries < SETTINGS.retryRate.length) {
        await sleep(SETTINGS.retryRate[rateTries++]);
        continue;
      }
      if (err.kind === 'net' && netTries < SETTINGS.retryNet.length) {
        netTries++;
        rotateHost(); // give the other Google server a chance
        await sleep(SETTINGS.retryNet[netTries - 1]);
        continue;
      }
      if (err.kind === 'soft' && softTries < SETTINGS.retrySoft.length) {
        await sleep(SETTINGS.retrySoft[softTries++]);
        continue;
      }
      if (err.kind === 'net') {
        // Every attempt failed - say exactly what was tried and what to do.
        const uniqueHosts = Array.from(new Set(triedHosts));
        throw makeError(
          'net',
          err.message +
            ' Tried ' +
            uniqueHosts.join(' and ') +
            '. Check your internet connection, proxy or VPN.'
        );
      }
      throw err;
    }
  }
}

/* ------------------------------------------------------------------ *
 * Batching - the key to speed
 * ------------------------------------------------------------------ */

/**
 * Group missing pieces into requests:
 *   - pieces that contain a newline always travel alone (their whole
 *     output is used as-is),
 *   - everything else is packed together, newline separated, up to
 *     SETTINGS.batchItems pieces / SETTINGS.batchChars characters.
 */
function buildBatches(chunks) {
  const batches = [];
  let current = null;
  let currentLen = 0;

  function flush() {
    if (current && current.chunks.length) {
      if (current.chunks.length === 1) {
        current.mode = 'solo';
      }
      batches.push(current);
    }
    current = null;
    currentLen = 0;
  }

  for (const chunk of chunks) {
    if (chunk.indexOf('\n') !== -1) {
      flush();
      batches.push({ mode: 'solo', chunks: [chunk] });
      continue;
    }
    const needed = chunk.length + 1;
    if (current && (current.chunks.length >= SETTINGS.batchItems || currentLen + needed > SETTINGS.batchChars)) {
      flush();
    }
    if (!current) {
      current = { mode: 'lines', chunks: [] };
      currentLen = 0;
    }
    current.chunks.push(chunk);
    currentLen += needed;
  }
  flush();

  return batches;
}

/** Split a batched answer back into per-piece strings.
 *  Returns null when the line count does not match (caller falls back). */
function splitAlignedLines(translated, expected) {
  const lines = translated.split('\n');
  while (lines.length && lines[lines.length - 1] === '') {
    lines.pop();
  }
  while (lines.length && lines[0] === '') {
    lines.shift();
  }
  if (lines.length !== expected) {
    return null;
  }
  return lines;
}

/** Translate one batch. Returns Map<chunk, translation>. */
async function translateBatch(batch) {
  const out = new Map();

  if (batch.mode === 'lines') {
    const translated = await requestWithRetry(batch.chunks.join('\n'));
    const lines = splitAlignedLines(translated, batch.chunks.length);
    if (lines) {
      batch.chunks.forEach(function (chunk, i) {
        out.set(chunk, lines[i]);
      });
      return out;
    }
    // Google merged/split our lines - fall through and translate solo,
    // so the result can never end up on the wrong text node.
  }

  for (const chunk of batch.chunks) {
    out.set(chunk, await requestWithRetry(chunk));
  }
  return out;
}

/** Run all batches with SETTINGS.concurrency workers. */
async function runBatches(batches, onBatchDone) {
  let cursor = 0;
  let fatal = null;

  async function worker() {
    for (;;) {
      if (fatal) {
        return;
      }
      const index = cursor++;
      if (index >= batches.length) {
        return;
      }
      try {
        const map = await translateBatch(batches[index]);
        onBatchDone(map);
      } catch (err) {
        if (!fatal) {
          fatal = err; // remember the first error, cancel the rest
        }
      }
    }
  }

  const workers = [];
  for (let i = 0; i < Math.max(1, SETTINGS.concurrency); i++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return fatal;
}

/* ------------------------------------------------------------------ *
 * Message handling
 * ------------------------------------------------------------------ */

/** How many texts have all of their chunks translated? */
function countCompleted(textChunks, resolved) {
  let done = 0;
  for (const entry of textChunks) {
    let complete = true;
    for (const chunk of entry.chunks) {
      if (!resolved.has(chunk)) {
        complete = false;
        break;
      }
    }
    if (complete) {
      done++;
    }
  }
  return done;
}

function sendProgress(tabId, done, total) {
  if (tabId !== null) {
    browser.tabs
      .sendMessage(tabId, { type: 'bpbt-progress', done: done, total: total })
      .catch(function () {
        // Tab may have been closed or navigated - ignore.
      });
  }
}

async function handleTranslate(message, sender) {
  const texts = Array.isArray(message.texts)
    ? message.texts.filter(function (t) {
        return typeof t === 'string' && t.trim().length > 0;
      })
    : [];

  const total = texts.length;
  if (!total) {
    return { ok: true, results: {}, done: 0, total: 0 };
  }

  const tabId = sender && sender.tab ? sender.tab.id : null;

  // 1) Cut every text into safe chunks.
  const textChunks = texts.map(function (text) {
    return { text: text, chunks: splitIntoChunks(text) };
  });

  // 2) Everything the cache already knows costs no request at all.
  const uniqueChunks = [];
  const seen = new Set();
  for (const entry of textChunks) {
    for (const chunk of entry.chunks) {
      if (!seen.has(chunk)) {
        seen.add(chunk);
        uniqueChunks.push(chunk);
      }
    }
  }

  const resolved = await cacheGetMany(uniqueChunks);
  sendProgress(tabId, countCompleted(textChunks, resolved), total);

  // 3) Pack the rest into as few requests as possible.
  const missing = uniqueChunks.filter(function (chunk) {
    return !resolved.has(chunk);
  });
  const batches = buildBatches(missing);

  // 4) Fire them with a small parallel worker pool.
  let done = countCompleted(textChunks, resolved);
  const fatal = await runBatches(batches, function (map) {
    map.forEach(function (translated, chunk) {
      resolved.set(chunk, translated);
    });
    done = countCompleted(textChunks, resolved);
    sendProgress(tabId, done, total);
  });

  // 5) Store everything we learned (one write, one index update).
  const fresh = new Map();
  for (const chunk of missing) {
    if (resolved.has(chunk)) {
      fresh.set(chunk, resolved.get(chunk));
    }
  }
  await cachePutMany(fresh);

  // 6) Reassemble one answer per original text.
  const results = {};
  for (const entry of textChunks) {
    let out = '';
    let complete = true;
    for (const chunk of entry.chunks) {
      const translated = resolved.get(chunk);
      if (translated === undefined) {
        complete = false;
        break;
      }
      out += translated;
    }
    if (complete) {
      results[entry.text] = out;
    }
  }

  const finished = Object.keys(results).length;
  if (fatal) {
    return {
      ok: false,
      error: fatal.message || String(fatal),
      results: results,
      done: finished,
      total: total
    };
  }
  return { ok: true, results: results, done: finished, total: total };
}

/**
 * Called by the popup when the content script is not present yet (for
 * example the tab was opened before the extension was loaded).
 */
async function handleInject(message) {
  const tabId = typeof message.tabId === 'number' ? message.tabId : null;
  if (tabId === null) {
    return { ok: false, error: 'No active tab.' };
  }
  try {
    await browser.tabs.executeScript(tabId, { file: 'content.js' });
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error:
        'This page cannot be translated (browser pages and some sites block scripts). ' +
        'Open a normal http/https website, reload it once, and try again.'
    };
  }
}

browser.runtime.onMessage.addListener(function (message, sender) {
  if (!message || typeof message.type !== 'string') {
    return undefined;
  }

  if (message.type === 'bpbt-translate') {
    return enqueue(function () {
      return handleTranslate(message, sender).catch(function (err) {
        return {
          ok: false,
          error: err && err.message ? err.message : 'Unexpected background error.'
        };
      });
    });
  }

  if (message.type === 'bpbt-inject') {
    return handleInject(message);
  }

  return undefined;
});
