/**
 * Bangla Page Translator - popup script
 *
 * Talks to the content script of the active tab:
 *   bpbt-status   - what is the page doing right now?
 *   bpbt-start    - translate the page to Bangla
 *   bpbt-restore  - put the original text back
 *
 * If the content script is missing (tab opened before the extension was
 * loaded), it asks background.js to inject it (bpbt-inject) and retries.
 *
 * While the page reports status "translating", the popup polls every 500ms
 * so the status line shows Ready / Translating / Done / Error live.
 */
'use strict';

const POLL_INTERVAL_MS = 500;

const NO_PAGE_MSG =
  'This page cannot be translated. Open a normal http/https website and try again.';

const STATUS_LABELS = {
  ready: 'Ready',
  translating: 'Translating',
  done: 'Done',
  error: 'Error'
};

const els = {
  statusDot: document.getElementById('statusDot'),
  statusText: document.getElementById('statusText'),
  progressText: document.getElementById('progressText'),
  errorText: document.getElementById('errorText'),
  translateBtn: document.getElementById('translateBtn'),
  restoreBtn: document.getElementById('restoreBtn')
};

let tabId = null;
let pollTimer = null;

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

function render(state) {
  const status = state && state.status ? state.status : 'ready';
  const progress = (state && state.progress) || { done: 0, total: 0 };
  const error = (state && state.error) || '';

  els.statusText.textContent = STATUS_LABELS[status] || status;
  els.statusDot.className = 'dot ' + status;

  if (status === 'translating' && progress.total > 0) {
    els.progressText.textContent = progress.done + ' / ' + progress.total + ' texts';
  } else {
    els.progressText.textContent = '';
  }

  if (status === 'error' && error) {
    els.errorText.textContent = error;
    els.errorText.hidden = false;
  } else {
    els.errorText.textContent = '';
    els.errorText.hidden = true;
  }

  els.translateBtn.disabled = status === 'translating';
}

/* ------------------------------------------------------------------ *
 * Communication with the active tab
 * ------------------------------------------------------------------ */

async function sendToTab(message) {
  if (tabId === null) {
    return null;
  }
  try {
    return await browser.tabs.sendMessage(tabId, message);
  } catch (err) {
    return null; // no content script in this tab (yet)
  }
}

/** Get the page status, injecting content.js first if necessary. */
async function fetchStatus() {
  let state = await sendToTab({ type: 'bpbt-status' });
  if (state) {
    return state;
  }

  // The content script is not there - ask the background script to add it.
  try {
    await browser.runtime.sendMessage({ type: 'bpbt-inject', tabId: tabId });
  } catch (err) {
    // fall through - handled below
  }

  state = await sendToTab({ type: 'bpbt-status' });
  if (state) {
    return state;
  }
  return { status: 'error', error: NO_PAGE_MSG };
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(async function () {
    const state = await sendToTab({ type: 'bpbt-status' });
    if (!state) {
      stopPolling();
      render({ status: 'error', error: NO_PAGE_MSG });
      return;
    }
    render(state);
    if (state.status !== 'translating') {
      stopPolling();
    }
  }, POLL_INTERVAL_MS);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

/* ------------------------------------------------------------------ *
 * Buttons
 * ------------------------------------------------------------------ */

els.translateBtn.addEventListener('click', async function () {
  stopPolling();
  render({ status: 'translating' }); // optimistic feedback
  const state = await sendToTab({ type: 'bpbt-start' });
  if (!state) {
    render({ status: 'error', error: NO_PAGE_MSG });
    return;
  }
  render(state);
  if (state.status === 'translating') {
    startPolling();
  }
});

els.restoreBtn.addEventListener('click', async function () {
  stopPolling();
  const state = await sendToTab({ type: 'bpbt-restore' });
  if (!state) {
    render({ status: 'error', error: NO_PAGE_MSG });
    return;
  }
  render(state);
});

/* ------------------------------------------------------------------ *
 * Init
 * ------------------------------------------------------------------ */

(async function init() {
  try {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    tabId = tabs.length && tabs[0].id !== undefined ? tabs[0].id : null;
  } catch (err) {
    tabId = null;
  }

  const state = await fetchStatus();
  render(state);
  if (state.status === 'translating') {
    startPolling();
  }
})();
