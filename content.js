/**
 * Bangla Page Translator - content script
 *
 * What this script does:
 *   1. Walks the page and collects every visible TEXT NODE (never element
 *      HTML, so the layout stays exactly the same).
 *   2. Sends the unique texts to background.js, which talks to Google
 *      Translate and answers with Bangla strings.
 *   3. Puts the Bangla text back into the same text nodes.
 *   4. Keeps every original string in memory, so "Restore Original" can put
 *      the page back without reloading.
 *   5. Watches the page with a MutationObserver, so content that loads later
 *      (AJAX articles, infinite scroll, "load more" buttons) is translated
 *      automatically while the page stays in Bangla mode.
 *
 * Messages handled (from the popup / background):
 *   { type: 'bpbt-status'    } -> { ok, status, error, progress }
 *   { type: 'bpbt-start'     } -> same snapshot, starts translating
 *   { type: 'bpbt-restore'   } -> same snapshot, restores the original text
 *   { type: 'bpbt-progress'  } -> progress update from background.js
 */
'use strict';

(() => {
  /* Guard against being injected twice into the same page. */
  if (window.__banglaPageTranslatorInstalled) {
    return;
  }
  window.__banglaPageTranslatorInstalled = true;

  /* ---------------------------------------------------------------- *
   * Configuration
   * ---------------------------------------------------------------- */

  // Elements that must never be touched.
  //  - script/style/code/pre/textarea/input/select: required by the spec and
  //    translating them breaks the page or makes code unreadable.
  //  - button: translating button labels often breaks fixed-size UI
  //    (icons, toolbars, menus) so buttons are left in the original language.
  //  - option: options inside a <select> would desync the control.
  //  - noscript/iframe/svg/math/canvas: not normal page text.
  //  - contenteditable / translate="no" / data-no-translate: opt-outs.
  const SKIP_SELECTOR = [
    'script',
    'style',
    'code',
    'pre',
    'textarea',
    'input',
    'select',
    'button',
    'option',
    'noscript',
    'iframe',
    'svg',
    'math',
    'canvas',
    '[contenteditable]',
    '[translate="no"]',
    '[data-no-translate]'
  ].join(',');

  const DEBOUNCE_MS = 250; // wait after the last DOM change before translating
  const MAX_WAIT_MS = 1500; // ... but never wait longer than this
  const MAX_BATCH_PASSES = 10; // safety valve when a page keeps changing
  const AUTO_COOLDOWN_MS = 1000; // pause between back-to-back auto passes

  /* ---------------------------------------------------------------- *
   * State
   * ---------------------------------------------------------------- */

  let status = 'ready'; // ready | translating | done | error
  let lastError = '';
  let progress = { done: 0, total: 0 };

  // Bumped by "restore" (and by a fresh "start"). In-flight runs compare
  // their generation and stop applying results if it changed.
  let generation = 0;

  const originals = new Map(); // Text node -> original string (for restore)
  const written = new Map(); // Text node -> text we wrote (skip own mutations)
  const pending = new Set(); // Text nodes waiting to be translated

  let observer = null;
  let observerActive = false;
  let running = false;
  let rerunRequested = false;
  let debounceTimer = null;
  let firstQueuedAt = 0;

  /* ---------------------------------------------------------------- *
   * Text node checks
   * ---------------------------------------------------------------- */

  const LETTERS_RE = /[\p{L}]/u;
  const NON_BANGLA_LETTER_RE = /[^ঀ-৿\s\d]/; // any letter outside the Bengali block

  /** True when the text contains at least one letter and all letters are
   *  already Bangla - such text never needs to be sent to Google. */
  function isPureBangla(text) {
    const words = text.match(/\p{L}+/gu);
    if (!words || !words.length) {
      return true; // no letters at all (handled earlier, be safe)
    }
    for (const word of words) {
      if (NON_BANGLA_LETTER_RE.test(word)) {
        return false;
      }
    }
    return true;
  }

  /**
   * Decide if a text node is safe and worth translating.
   * Returns true when the node must be SKIPPED.
   */
  function isSkippable(node) {
    if (!node || node.nodeType !== Node.TEXT_NODE) {
      return true;
    }

    const value = node.nodeValue;
    if (!value || !value.trim()) {
      return true; // whitespace only - nothing to translate
    }

    const parent = node.parentElement;
    if (!parent) {
      return true;
    }
    if (parent.closest(SKIP_SELECTOR)) {
      return true; // inside script/style/code/... / any opt-out ancestor
    }
    if (parent.isContentEditable) {
      return true; // do not fight the user while they edit
    }
    if (!LETTERS_RE.test(value)) {
      return true; // numbers, punctuation, plain URLs - nothing to translate
    }
    if (isPureBangla(value)) {
      return true; // already Bangla - never re-translate
    }
    return false;
  }

  /** Collect all translatable text nodes under `root` into `out`. */
  function collectTextNodes(root, out) {
    if (!root) {
      return;
    }
    if (root.nodeType === Node.TEXT_NODE) {
      if (!isSkippable(root)) {
        out.push(root);
      }
      return;
    }
    if (
      root.nodeType !== Node.ELEMENT_NODE &&
      root.nodeType !== Node.DOCUMENT_NODE &&
      root.nodeType !== Node.DOCUMENT_FRAGMENT_NODE
    ) {
      return;
    }

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        return isSkippable(node) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      }
    });

    let current;
    while ((current = walker.nextNode())) {
      out.push(current);
    }
  }

  /* ---------------------------------------------------------------- *
   * MutationObserver - translate content that loads later
   * ---------------------------------------------------------------- */

  function onMutations(records) {
    if (!observerActive) {
      return;
    }

    const found = [];
    for (const record of records) {
      if (record.type === 'characterData') {
        const node = record.target;
        // Ignore the writes we made ourselves.
        if (written.get(node) === node.nodeValue) {
          continue;
        }
        if (!isSkippable(node)) {
          found.push(node);
        }
      } else if (record.type === 'childList') {
        for (const added of record.addedNodes) {
          collectTextNodes(added, found);
        }
        // Removed nodes are ignored - they are gone anyway.
      }
    }

    if (!found.length) {
      return;
    }
    for (const node of found) {
      pending.add(node);
    }
    scheduleRun();
  }

  function activateObserver() {
    if (!observer) {
      observer = new MutationObserver(onMutations);
    }
    if (!observerActive && document.body) {
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true
      });
      observerActive = true;
    }
  }

  function deactivateObserver() {
    if (observer && observerActive) {
      observer.disconnect();
      observerActive = false;
    }
  }

  /* ---------------------------------------------------------------- *
   * Scheduling (debounce with a maximum wait)
   * ---------------------------------------------------------------- */

  /**
   * Schedule (or re-schedule) a translation pass.
   * `minDelay` is an optional extra cooldown used when a finished pass has to
   * start another one because the page keeps changing - it stops a busy page
   * from hammering Google in a tight loop.
   */
  function scheduleRun(minDelay) {
    const base = typeof minDelay === 'number' ? minDelay : 0;
    if (!firstQueuedAt) {
      firstQueuedAt = Date.now();
    }
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }

    const waited = Date.now() - firstQueuedAt;
    const debounce =
      waited >= MAX_WAIT_MS ? 0 : Math.min(DEBOUNCE_MS, MAX_WAIT_MS - waited);
    debounceTimer = setTimeout(
      function () {
        debounceTimer = null;
        runPass();
      },
      base + debounce
    );
  }

  /* ---------------------------------------------------------------- *
   * Translating
   * ---------------------------------------------------------------- */

  function snapshot() {
    return {
      ok: true,
      status: status,
      error: lastError,
      progress: { done: progress.done, total: progress.total }
    };
  }

  /** Turn the pending nodes into a de-duplicated batch of source strings. */
  function buildBatch() {
    const nodesBySource = new Map();
    const texts = [];

    for (const node of Array.from(pending)) {
      pending.delete(node);
      if (!node.isConnected) {
        continue;
      }
      if (written.get(node) === node.nodeValue) {
        continue; // still our own translation - nothing new
      }
      if (isSkippable(node)) {
        continue;
      }

      const source = node.nodeValue.trim();
      if (!source) {
        continue;
      }
      if (!nodesBySource.has(source)) {
        nodesBySource.set(source, []);
        texts.push(source);
      }
      nodesBySource.get(source).push(node);
    }

    if (!texts.length) {
      return null;
    }
    return { texts: texts, nodesBySource: nodesBySource };
  }

  /** Put the Bangla strings back into their text nodes. */
  function applyResults(results, batch) {
    for (const source of batch.texts) {
      const translated = results[source];
      if (typeof translated !== 'string' || !translated.trim()) {
        continue;
      }

      for (const node of batch.nodesBySource.get(source)) {
        if (!node.isConnected) {
          continue;
        }

        const value = node.nodeValue;
        if (value.trim() !== source) {
          continue; // page changed it while we waited - the observer re-queued it
        }

        // Keep the original leading/trailing whitespace so the layout
        // (inline elements, indentation) stays untouched.
        const lead = value.match(/^\s*/)[0];
        const trail = value.match(/\s*$/)[0];
        const newValue = lead + translated + trail;
        if (newValue === value) {
          continue;
        }

        // Remember the original text of THIS version of the node, so
        // "Restore Original" gives back exactly what the page had.
        originals.set(node, value);
        written.set(node, newValue);
        node.nodeValue = newValue;
      }
    }
  }

  /** Main loop: translate everything currently pending, then repeat if the
   *  observer queued more content while we were waiting for Google. */
  async function runPass() {
    if (running) {
      rerunRequested = true;
      return;
    }

    const gen = generation;
    running = true;
    firstQueuedAt = 0;

    try {
      let passes = 0;
      while (pending.size > 0 && passes < MAX_BATCH_PASSES) {
        if (gen !== generation) {
          return; // the page was restored (or restarted) meanwhile
        }
        passes++;

        const batch = buildBatch();
        if (!batch) {
          continue;
        }

        status = 'translating';
        lastError = '';
        progress = { done: 0, total: batch.texts.length };

        let response;
        try {
          response = await browser.runtime.sendMessage({
            type: 'bpbt-translate',
            texts: batch.texts
          });
        } catch (err) {
          throw new Error(
            'Background script failed: ' + (err && err.message ? err.message : String(err))
          );
        }

        if (gen !== generation) {
          return; // restored while we were waiting - throw the results away
        }
        if (!response) {
          throw new Error('No answer from the background script.');
        }

        // Apply whatever came back (also on partial failure).
        applyResults(response.results || {}, batch);

        if (!response.ok) {
          status = 'error';
          lastError = response.error || 'Translation failed.';
          return;
        }

        progress = {
          done: typeof response.done === 'number' ? response.done : batch.texts.length,
          total: typeof response.total === 'number' ? response.total : batch.texts.length
        };
        // Loop again: the observer may have collected more content meanwhile.
      }

      if (gen === generation) {
        status = 'done';
      }
    } catch (err) {
      if (gen === generation) {
        status = 'error';
        lastError = err && err.message ? err.message : String(err);
      }
    } finally {
      running = false;
      // If new nodes showed up (or a start/restore happened while we were
      // busy), schedule another pass. `pending` is empty right after a
      // restore, so this never restarts a cancelled run by itself.
      // Automatic continuations get a cooldown so a page that keeps mutating
      // cannot hammer Google in a tight loop; an explicit start runs at once.
      const explicitRequest = rerunRequested;
      if (explicitRequest || pending.size > 0) {
        rerunRequested = false;
        scheduleRun(explicitRequest ? 0 : AUTO_COOLDOWN_MS);
      }
    }
  }

  /* ---------------------------------------------------------------- *
   * Commands from the popup
   * ---------------------------------------------------------------- */

  function startTranslation() {
    if (status === 'translating') {
      return snapshot();
    }
    if (!document.body) {
      status = 'error';
      lastError = 'This page has no document body to translate.';
      return snapshot();
    }

    lastError = '';
    progress = { done: 0, total: 0 };
    status = 'translating';
    generation++;

    activateObserver();
    // Re-scan the whole page: already translated (Bangla) text is skipped
    // by isSkippable(), so this only picks up text that is still missing.
    const found = [];
    collectTextNodes(document.body, found);
    for (const node of found) {
      pending.add(node);
    }
    // An explicit click runs right away - the debounce only exists so a
    // burst of DOM changes from the page gets translated in one go.
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    firstQueuedAt = 0;
    runPass();
    return snapshot();
  }

  function restoreOriginal() {
    generation++; // cancels any in-flight run (it checks the generation)
    rerunRequested = false;
    pending.clear();
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    firstQueuedAt = 0;
    deactivateObserver();

    for (const [node, original] of originals) {
      if (node.isConnected) {
        node.nodeValue = original;
      }
    }
    originals.clear();
    written.clear();

    status = 'ready';
    lastError = '';
    progress = { done: 0, total: 0 };
    return snapshot();
  }

  /* ---------------------------------------------------------------- *
   * Message listener
   * ---------------------------------------------------------------- */

  browser.runtime.onMessage.addListener(function (message) {
    if (!message || typeof message.type !== 'string') {
      return Promise.resolve({ ok: false, error: 'Unknown message.' });
    }

    switch (message.type) {
      case 'bpbt-status':
        return Promise.resolve(snapshot());

      case 'bpbt-start':
        return Promise.resolve(startTranslation());

      case 'bpbt-restore':
        return Promise.resolve(restoreOriginal());

      case 'bpbt-progress':
        // Progress report from background.js while a batch is running.
        progress = {
          done: typeof message.done === 'number' ? message.done : progress.done,
          total: typeof message.total === 'number' ? message.total : progress.total
        };
        return Promise.resolve({ ok: true });

      default:
        return Promise.resolve({ ok: false, error: 'Unknown message type: ' + message.type });
    }
  });

  // The page is ready but nothing happens until the user clicks the button.
})();
