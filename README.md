# ChatGPT Cleaner & Context Meter

A small Chrome Manifest V3 extension for `https://chatgpt.com/*`.

It has three focused features:

- Batch delete selected visible ChatGPT conversations from the left sidebar.
- Estimate the token/context usage of the loaded messages on the current conversation page.
- Count local ChatGPT message sends by visible model label, such as `ChatGPT Pro`.

The extension is opened from the Chrome extension icon. It does not show a permanent floating toolbar on the ChatGPT page.

## Install

1. Open `chrome://extensions`.
2. Enable **Developer Mode**.
3. Click **Load unpacked**.
4. Select this extension folder: `C:\Users\dz164\Desktop\codex\browser plug in`.
5. Open or refresh `https://chatgpt.com/`.
6. Click the **ChatGPT Cleaner & Context Meter** extension icon.

## Use

### Select conversations

1. Click **Select conversations** in the extension popup.
2. Checkboxes appear next to the visible conversations in the ChatGPT sidebar.
3. No conversation is selected automatically.
4. Tick the conversations you want directly in the sidebar.

The extension injects checkboxes into visible sidebar conversations only after you activate selection from the popup.

### Delete selected conversations

1. Select conversations first.
2. Click **Delete selected** in the extension popup.
3. Review the number and titles of conversations.
4. Type `DELETE`.
5. The extension opens each conversation's normal menu, clicks **Delete**, confirms deletion, waits briefly, and continues one at a time.

If one deletion fails, the extension logs the failure in the browser console and continues with the next selected conversation.

### Estimate Context

1. Choose an approximate context window, such as `128K`.
2. Leave **Enable context estimate** on.
3. Click **Estimate Context** in the extension popup.
4. Review estimated tokens, characters, messages, and approximate percentage usage.

The estimator first tries the bundled local `gpt-tokenizer`. If that fails, it falls back to a local rule-based estimate:

- English/European text: characters / 4
- Chinese CJK text: characters / 1.5
- Japanese text: characters / 1.2
- Korean text: characters / 1.3
- Code: characters / 3
- URL/JSON-like text: characters / 2.5
- Emoji: about 3 tokens each

Usage percentage is calculated as `estimatedVisibleTokens / selectedContextWindow * 100`. The context window can be set to `16K`, `32K`, `64K`, or `128K`.

When context estimation is enabled, the extension also looks for loaded images and visible PDF attachments. Images are estimated locally from rendered dimensions. PDFs are analyzed locally with bundled `pdf.js` only when the browser can access the PDF data, such as same-origin or blob URLs. If ChatGPT does not expose the original PDF file to the page, the extension reports the PDF as detected but inaccessible instead of guessing hidden backend tokens.

### Usage Counter

The popup includes a **Usage Counter** section.

- The extension automatically tries to count a usage when you send a ChatGPT message.
- It reads the currently visible model/mode label, for example `GPT-5`, `GPT-5 Pro`, `ChatGPT Pro`, `GPT-4o`, or `Deep Research`.
- It groups automatic counts into `GPT` and `GPT Pro`, while still keeping per-model details.
- Click **Refresh usage** to reload the local counts.
- Click **Reset usage** to clear all local usage counts.

Usage counts start after the extension is installed and loaded. The extension cannot reconstruct past usage from before it was installed.

## Limitations

- Batch deletion depends on ChatGPT's webpage UI and may break if the website changes.
- The token/context count is only an estimate.
- The estimate only reads message content currently loaded in the ChatGPT page.
- It cannot see hidden system prompts, memory, tools, uploaded file content, file parsing results, backend-compressed context, or any other model-side context that is not visible in the page.
- PDF analysis only works when the browser extension can access the actual PDF bytes from the page.
- It cannot know the real backend model context window; the percentage uses the context window you choose in the popup.
- Usage counting depends on visible ChatGPT UI labels and send controls. If ChatGPT changes its model picker or composer, automatic counting may miss or mislabel some sends.
- Usage counting is not an official OpenAI quota meter. It cannot verify billing, subscription limits, backend model routing, retries, or messages sent from other browsers/devices.

## Privacy

- No data leaves the browser.
- No OpenAI API key is needed.
- The extension does not send network requests.
- Usage counts are stored in `chrome.storage.local` on your browser profile.
- It only runs on `https://chatgpt.com/*`.

## Files

- `manifest.json` declares the Manifest V3 extension, popup, and ChatGPT content script match.
- `popup.html`, `popup.css`, and `popup.js` provide the Chrome extension popup controls.
- `content.js` handles sidebar checkboxes, deletion flow, MutationObserver refresh, local context estimation, and local usage counting.
- `styles.css` styles only the temporary page-side checkbox, confirmation dialog, and progress toast.
- `vendor/chatgpt-cleaner-tokenizer.js` is a bundled local `gpt-tokenizer` build used before the fallback estimator.
- `vendor/chatgpt-cleaner-pdf-analyzer.js` and `vendor/chatgpt-cleaner-pdf-analyzer.worker.js` are bundled local `pdf.js` files used for accessible PDF text/image estimates.
- `tests/smoke.html` is a local manual smoke-test page that mimics enough of ChatGPT's DOM to test the extension script safely.

## Optional local smoke test

This does not delete real ChatGPT conversations. It only tests the UI flow against mock rows.

1. Open a terminal in this folder.
2. Run `python -m http.server 8765 --bind 127.0.0.1`.
3. Open `http://127.0.0.1:8765/tests/smoke.html`.
4. Test **Select conversations**, **Deselect all**, **Estimate Context**, **Record Usage**, and **Delete selected**.
