# ChatGPT Cleaner & Context Meter

A small Chrome Manifest V3 extension for `https://chatgpt.com/*`.

It has three focused features:

- Batch delete selected visible ChatGPT conversations from the left sidebar.
- Estimate the token/context usage of the visible messages on the current conversation page.
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
2. A selection dialog opens on the ChatGPT page.
3. No conversation is selected automatically.
4. Choose the conversations you want, or explicitly click **Select all visible** in the dialog.
5. Click **Apply selection**.

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
2. Click **Estimate Context** in the extension popup.
3. Review visible estimated tokens, characters, messages, and approximate percentage usage.

The estimator is local and dependency-free. It uses a hybrid heuristic for CJK text, English words, numbers, URLs/code-like text, punctuation, and line breaks. This is usually better than a pure character-count estimate, but it is still not a real tokenizer.

### Usage Counter

The popup includes a **Usage Counter** section.

- The extension automatically tries to count a usage when you send a ChatGPT message.
- It reads the currently visible model/mode label, for example `ChatGPT Pro`, `GPT-4o`, or `Deep Research`.
- Click **Record current model** if the automatic listener misses a send or if you want to manually count one use.
- Click **Refresh usage** to reload the local counts.
- Click **Reset usage** to clear all local usage counts.

Usage counts start after the extension is installed and loaded. The extension cannot reconstruct past usage from before it was installed.

## Limitations

- Batch deletion depends on ChatGPT's webpage UI and may break if the website changes.
- The token/context count is only an estimate.
- The estimate only reads visible page content.
- It cannot see hidden system prompts, memory, tools, uploaded file content, file parsing results, backend-compressed context, or any other model-side context that is not visible in the page.
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
- `content.js` handles sidebar checkboxes, selection dialogs, deletion flow, MutationObserver refresh, local context estimation, and local usage counting.
- `styles.css` styles only the temporary page-side checkbox, dialogs, and progress toast.
- `tests/smoke.html` is a local manual smoke-test page that mimics enough of ChatGPT's DOM to test the extension script safely.

## Optional local smoke test

This does not delete real ChatGPT conversations. It only tests the UI flow against mock rows.

1. Open a terminal in this folder.
2. Run `python -m http.server 8765 --bind 127.0.0.1`.
3. Open `http://127.0.0.1:8765/tests/smoke.html`.
4. Test **Select conversations**, **Deselect all**, **Estimate Context**, **Record Usage**, and **Delete selected**.
