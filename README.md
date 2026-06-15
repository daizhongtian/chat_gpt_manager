# ChatGPT Cleaner & Context Meter

A small Chrome Manifest V3 extension for `https://chatgpt.com/*`.

It has two features:

- Batch delete visible ChatGPT conversations from the left sidebar.
- Estimate the token/context usage of the visible messages on the current conversation page.

## Install

1. Open `chrome://extensions`.
2. Enable **Developer Mode**.
3. Click **Load unpacked**.
4. Select this extension folder: `C:\Users\14660\OneDrive\Desktop\my project\chrome plug in`.
5. Open or refresh `https://chatgpt.com/`.

## Use

The extension injects a small floating panel on ChatGPT pages.

For deletion:

1. Use **Select visible** or tick individual checkboxes in the ChatGPT sidebar.
2. Click **Delete selected**.
3. Review the number and titles of conversations.
4. Type `DELETE`.
5. The extension opens each conversation's normal menu, clicks **Delete**, confirms deletion, waits briefly, and continues.

If one deletion fails, the extension logs the failure and continues with the next selected conversation.

For context estimation:

1. Choose an approximate context window, such as `128K`.
2. Click **Estimate Context**.
3. Review visible estimated tokens, characters, messages, and approximate percentage usage.

## Limitations

- Batch deletion depends on ChatGPT's webpage UI and may break if the website changes.
- The token/context count is only an estimate.
- The estimate only reads visible page content.
- It cannot see hidden system prompts, memory, tool calls, uploaded file content, file parsing results, backend-compressed context, or any other model-side context that is not visible in the page.
- The tokenizer is an approximation:
  - English and European-language text is estimated at about characters / 4.
  - Chinese/CJK text is estimated at about characters / 1.5.
  - Mixed text uses a weighted estimate.

## Privacy

- No data leaves the browser.
- No OpenAI API key is needed.
- The extension does not send network requests.
- It only runs on `https://chatgpt.com/*`.

## Files

- `manifest.json` declares the Manifest V3 extension and ChatGPT content script match.
- `content.js` injects the controls, sidebar checkboxes, deletion flow, MutationObserver refresh, and local token estimate.
- `styles.css` styles the injected UI.
- `tests/smoke.html` is a local manual smoke-test page that mimics enough of ChatGPT's DOM to test the extension script safely.

## Optional local smoke test

This does not delete real ChatGPT conversations. It only tests the UI flow against mock rows.

1. Open a terminal in this folder.
2. Run `python -m http.server 8765 --bind 127.0.0.1`.
3. Open `http://127.0.0.1:8765/tests/smoke.html`.
4. Test **Select visible**, **Estimate Context**, and **Delete selected**.
