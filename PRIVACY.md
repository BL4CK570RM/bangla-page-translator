# Privacy Policy - Bangla Page Translator

Last updated: 2026-10-01

## Summary

This extension does **not** collect, store, sell, or share any personal data.
The developer has no servers, no accounts, no analytics, and no tracking.

## What leaves your device, and when

The only data that is transmitted anywhere is the **text of the page you are
looking at**, and it is sent **only** when you click **Translate to Bangla**:

- Sent to: Google's free web translation endpoint
  (`translate.googleapis.com`, with automatic failover to
  `translate.google.com`).
- Purpose: to obtain the Bangla translation of that text.
- Trigger: your explicit click. Nothing is sent before you press the button,
  and nothing is sent in the background while you browse.
- The URL of the page you are viewing is **not** sent; only the extracted text
  nodes are.

Google processes that text under its own privacy policy
(https://policies.google.com/privacy). This extension is not affiliated with
Google.

## What stays on your device

- Original text of translated pages (in memory, for **Restore Original**).
- Source/translation pairs in `browser.storage.local`, used as a cache so the
  same sentence is not translated twice. This cache never leaves your device
  and is deleted when you remove the extension.

## Permissions

- `activeTab`, `storage`: talk to the current tab, keep the cache.
- Host permission for the Google translation endpoints listed above: send the
  text you asked to translate.
- Content script on all web pages: read and replace the visible text when you
  ask for a translation. It reads nothing until you click the button.

## Contact

Questions about this policy: MD Mahmidul Hasan / https://www.linkedin.com/in/mdmahmidulhasan/ 
