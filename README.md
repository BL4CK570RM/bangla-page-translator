# Bangla Page Translator

A Firefox WebExtension that translates any webpage from any language into
**Bangla / Bengali** with one click, using the free Google Translate web
endpoint (no API key, no paid Google Cloud API, no account).

## 1. What the extension does

- Adds a toolbar button (popup) to Firefox.
- **Translate to Bangla** walks the open page, finds every visible **text
  node**, sends the text to Google Translate, and puts the Bangla result back
  into the same nodes - so the original layout, images, links and styling stay
  exactly the same (only the text changes).
- **Restore Original** puts every original string back in place without
  reloading the page.
- Status line always shows one of: `Ready`, `Translating`, `Done`, `Error`
  (with progress like `12 / 40 texts` while working).
- Text that is never translated: `script`, `style`, `code`, `pre`,
  `textarea`, `input`, `select`, `button`/`option` (keeps UI controls
  working), `noscript`/`iframe`/SVG, editable regions, and text that is
  already Bangla.
- A `MutationObserver` keeps watching the page, so articles that load later
  (infinite scroll, "load more", AJAX comments) are translated automatically.
- Results are cached in `browser.storage.local`, so the same sentence is
  never translated twice - repeat visits finish in milliseconds with **zero**
  Google requests.
- Built for one-click speed: every text is packed into batched requests (up
  to 12 pieces per request, newline separated), up to 6 requests run in
  parallel with 100 ms spacing, and the click starts work immediately. A
  typical article page (~40 texts) translates in roughly a second or two
  instead of one slow request per text node.
- Reliability: long texts are split into safe 400-character chunks, requests
  time out after 30 seconds instead of hanging, timeout/connection errors
  automatically switch to a second Google server (`translate.google.com`),
  HTTP 429 / network errors are retried with backoff, and all requests go
  through one global queue shared by all tabs.

### How it works

| File           | Role |
| -------------- | ---- |
| `manifest.json`| Manifest V2, permissions, popup, content script registration |
| `background.js`| Talks to Google Translate: chunking, batching, parallel requests with rate limiting, retries, cache in `browser.storage.local` |
| `content.js`   | Finds/replaces text nodes, stores originals, `MutationObserver` for new content |
| `popup.html`   | Popup UI (Translate / Restore buttons + status) |
| `popup.js`     | Sends `bpbt-status` / `bpbt-start` / `bpbt-restore` to the active tab and polls while translating |
| `popup.css`    | Popup styling |
| `PRIVACY.md`   | Privacy policy (also shown on the AMO listing) |

Google endpoint used (free, `client=gtx`, no key):

```
https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=bn&dt=t&q=TEXT
```

`background.js` encodes `q` with `encodeURIComponent`, parses
`response[0][n][0]`, and concatenates all segments into one final Bangla
string. If the endpoint changes, blocks the request, or returns bad JSON, the
popup shows a clear error such as:

- `Google Translate returned invalid JSON. The free endpoint may have changed or blocked this request.`
- `Google rate-limited this extension (HTTP 429). Wait a minute and try again.`
- `Could not reach translate.googleapis.com (...). Tried translate.googleapis.com and translate.google.com. Check your internet connection, proxy or VPN.`
- `Google Translate timed out on translate.googleapis.com (30s limit). Tried translate.googleapis.com and translate.google.com. Check your internet connection, proxy or VPN.`

## 2. How to install it in Firefox

1. Open Firefox.
2. Go to `about:debugging`.
3. Click **This Firefox**.
4. Click **Load Temporary Add-on**.
5. Select the `manifest.json` file inside the `bangla-page-translator` folder.

The extension now appears in the toolbar (Firefox may hide it in the puzzle
-piece menu - pin it for one-click access).

> Temporary add-ons are removed when Firefox restarts, so just load
> `manifest.json` again after a restart.

## 3. How to use

1. Open any blog / news / article website (any normal `http://` or `https://`
   page).
2. Click the extension icon (the toolbar button) - the popup opens.
3. Click **Translate to Bangla**.
4. Watch the status change `Ready` -> `Translating (n/m)` -> `Done`.
5. Click **Restore Original** any time to get the original page text back
   without reloading.

Tips:

- If the tab was already open before you installed the extension, the popup
  injects the content script automatically; if that is blocked, simply reload
  the page once and try again.
- Newly loaded content (infinite scroll, "load more", comments) is translated
  automatically while the page stays in Bangla mode.
- Translations are cached, so revisiting the same page is fast and does not
  hit Google again.

## 4. Known limitations

- **Rate limiting:** the Google free endpoint is unofficial and may return
  HTTP 429 or start failing. The extension limits itself to 6 parallel
  requests with 100 ms spacing, retries with backoff on 429/network errors
  and caches everything, but very large pages can still take a few seconds
  or need a short break before retrying.
- **Dynamic websites:** some single-page apps replace the whole page content
  through mechanisms the observer may not fully catch - refresh the page and
  click the button again.
- **Layout can change:** Bangla text is often longer than English (or other
  languages), so fixed-height boxes, buttons and menus may wrap or look
  slightly different after translation. This is a property of the text itself,
  not of the extension.
- **Buttons and form controls are intentionally left untranslated** so the UI
  keeps working.
- **Browser-internal pages** (`about:`, `addons.mozilla.org`, the Firefox
  UI) and PDFs cannot be translated - only normal web pages.
- Long paragraphs are cut into ~400-character pieces, so an occasional
  unnatural break at a piece boundary is possible.


## Running it locally (development)

1. Open a terminal in the `bangla-page-translator` folder.
2. Optional syntax check: `node --check background.js && node --check content.js && node --check popup.js`
3. Start Firefox and open `about:debugging` -> **This Firefox** ->
   **Load Temporary Add-on** -> select `manifest.json`.
4. Debugging:
   - **Popup errors:** right-click the popup -> *Inspect*.
   - **Content script console:** open the web page -> Web Console, filter with
     `content.js` (or use the *Debugger* panel).
   - **Background console:** `about:debugging` -> *Inspect* next to
     "Bangla Page Translator".
5. After editing any file, click the *Reload* button next to the extension in
   `about:debugging` and reload the web page.

No build tools, no dependencies - plain JavaScript, HTML and CSS only.
