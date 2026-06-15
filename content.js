(function () {
  "use strict";

  const APP_ID = "ccm-panel";
  const MODAL_ID = "ccm-confirm-modal";
  const CHECKBOX_CLASS = "ccm-conversation-checkbox";
  const ENHANCED_ATTR = "data-ccm-enhanced";
  const CONTEXT_WINDOWS = [
    { label: "8K", value: 8000 },
    { label: "16K", value: 16000 },
    { label: "32K", value: 32000 },
    { label: "64K", value: 64000 },
    { label: "128K", value: 128000 },
    { label: "200K", value: 200000 },
    { label: "1M", value: 1000000 }
  ];

  const state = {
    observer: null,
    refreshTimer: null,
    isDeleting: false,
    lastEstimate: null
  };

  function init() {
    if (!document.body) {
      return;
    }

    injectPanel();
    refreshConversationCheckboxes();
    installMutationObserver();
  }

  function injectPanel() {
    if (document.getElementById(APP_ID)) {
      return;
    }

    const panel = document.createElement("section");
    panel.id = APP_ID;
    panel.setAttribute("aria-label", "ChatGPT Cleaner and Context Meter");
    panel.innerHTML = `
      <div class="ccm-header">
        <div>
          <div class="ccm-title">ChatGPT Cleaner</div>
          <div class="ccm-subtitle">Batch delete + context estimate</div>
        </div>
        <button type="button" class="ccm-icon-button" id="ccm-minimize" title="Collapse panel" aria-label="Collapse panel">−</button>
      </div>

      <div class="ccm-body">
        <div class="ccm-button-grid" aria-label="Conversation selection controls">
          <button type="button" id="ccm-select-visible">Select visible</button>
          <button type="button" id="ccm-deselect-all">Deselect all</button>
          <button type="button" id="ccm-delete-selected" class="ccm-danger">Delete selected</button>
          <button type="button" id="ccm-refresh-list">Refresh list</button>
        </div>

        <div class="ccm-meter-row">
          <label for="ccm-context-window">Context window</label>
          <select id="ccm-context-window">
            ${CONTEXT_WINDOWS.map((item) => `<option value="${item.value}" ${item.value === 128000 ? "selected" : ""}>${item.label}</option>`).join("")}
          </select>
        </div>

        <button type="button" id="ccm-estimate-context" class="ccm-wide-button">Estimate Context</button>

        <div id="ccm-selection-status" class="ccm-status">Scanning visible conversations...</div>
        <div id="ccm-estimate-output" class="ccm-output" aria-live="polite"></div>
        <div id="ccm-progress" class="ccm-progress" aria-live="polite"></div>
        <details class="ccm-log-wrap">
          <summary>Log</summary>
          <ol id="ccm-log" class="ccm-log"></ol>
        </details>
      </div>
    `;

    document.body.appendChild(panel);

    byId("ccm-select-visible").addEventListener("click", selectVisibleConversations);
    byId("ccm-deselect-all").addEventListener("click", deselectAllConversations);
    byId("ccm-delete-selected").addEventListener("click", deleteSelectedConversations);
    byId("ccm-refresh-list").addEventListener("click", () => {
      refreshConversationCheckboxes();
      logMessage("Conversation list refreshed.");
    });
    byId("ccm-estimate-context").addEventListener("click", () => {
      const estimate = estimateVisibleContext();
      renderContextEstimate(estimate);
    });
    byId("ccm-context-window").addEventListener("change", () => {
      if (state.lastEstimate) {
        renderContextEstimate(state.lastEstimate);
      }
    });
    byId("ccm-minimize").addEventListener("click", togglePanel);
  }

  function byId(id) {
    return document.getElementById(id);
  }

  function togglePanel() {
    const panel = byId(APP_ID);
    const button = byId("ccm-minimize");
    const collapsed = panel.classList.toggle("ccm-collapsed");
    button.textContent = collapsed ? "+" : "−";
    button.title = collapsed ? "Expand panel" : "Collapse panel";
    button.setAttribute("aria-label", collapsed ? "Expand panel" : "Collapse panel");
  }

  function installMutationObserver() {
    if (state.observer) {
      state.observer.disconnect();
    }

    // ChatGPT is a single-page app. The sidebar is rebuilt often, so observe DOM
    // changes and re-add checkboxes after the page settles for a moment.
    state.observer = new MutationObserver(() => {
      window.clearTimeout(state.refreshTimer);
      state.refreshTimer = window.setTimeout(refreshConversationCheckboxes, 350);
    });

    state.observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  function refreshConversationCheckboxes() {
    const links = getConversationLinks();
    let added = 0;

    links.forEach((link) => {
      if (link.getAttribute(ENHANCED_ATTR) === "true") {
        const existing = link.querySelector(`.${CHECKBOX_CLASS}`);
        if (existing) {
          existing.setAttribute("aria-label", `Select conversation: ${getConversationTitle(link)}`);
        }
        return;
      }

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.className = CHECKBOX_CLASS;
      checkbox.dataset.ccmKey = getConversationKey(link);
      checkbox.setAttribute("aria-label", `Select conversation: ${getConversationTitle(link)}`);
      checkbox.title = "Select this conversation";

      // Prevent checkbox clicks from opening the conversation link underneath it.
      ["click", "mousedown", "mouseup", "keydown"].forEach((eventName) => {
        checkbox.addEventListener(eventName, (event) => event.stopPropagation());
      });

      link.insertBefore(checkbox, link.firstChild);
      link.classList.add("ccm-enhanced-link");
      link.setAttribute(ENHANCED_ATTR, "true");
      added += 1;
    });

    updateSelectionStatus();
    return added;
  }

  function getConversationLinks() {
    const root = findSidebarRoot() || document;
    const rawLinks = Array.from(root.querySelectorAll('a[href*="/c/"]'));
    const unique = new Map();

    rawLinks.forEach((link) => {
      if (!isConversationLink(link) || isInsideExtensionUi(link) || !isVisibleElement(link)) {
        return;
      }

      unique.set(getConversationKey(link), link);
    });

    return Array.from(unique.values());
  }

  function findSidebarRoot() {
    const candidates = Array.from(document.querySelectorAll([
      "aside",
      "nav",
      '[role="navigation"]',
      '[data-testid*="sidebar" i]',
      '[aria-label*="sidebar" i]',
      '[aria-label*="history" i]'
    ].join(",")));

    let best = null;
    let bestScore = 0;

    candidates.forEach((candidate) => {
      if (isInsideExtensionUi(candidate) || !isVisibleElement(candidate)) {
        return;
      }

      const links = Array.from(candidate.querySelectorAll('a[href*="/c/"]')).filter(isConversationLink);
      if (!links.length) {
        return;
      }

      const rect = candidate.getBoundingClientRect();
      const leftSideBonus = rect.left < Math.min(420, window.innerWidth * 0.45) ? 2 : 0;
      const compactBonus = rect.width && rect.width < 520 ? 1 : 0;
      const score = links.length * 10 + leftSideBonus + compactBonus;

      if (score > bestScore) {
        best = candidate;
        bestScore = score;
      }
    });

    return best;
  }

  function isConversationLink(link) {
    try {
      const url = new URL(link.href, location.href);
      const isConversationPath = /^\/c\/[^/?#]+/.test(url.pathname);
      const isCurrentHost = !url.hostname || url.hostname === location.hostname;
      const isChatGptHost = url.hostname === "chatgpt.com" || url.hostname.endsWith(".chatgpt.com");
      return isConversationPath && (isCurrentHost || isChatGptHost);
    } catch (error) {
      return false;
    }
  }

  function getConversationKey(link) {
    try {
      const url = new URL(link.href, location.href);
      return url.pathname.replace(/\/$/, "");
    } catch (error) {
      return link.getAttribute("href") || "";
    }
  }

  function getConversationTitle(link) {
    const title =
      link.getAttribute("aria-label") ||
      link.getAttribute("title") ||
      link.textContent ||
      "Untitled conversation";

    return cleanText(title.replace(/^Select conversation:\s*/i, "")) || "Untitled conversation";
  }

  function cleanText(text) {
    return String(text || "").replace(/\s+/g, " ").trim();
  }

  function isVisibleElement(element) {
    if (!element || !(element instanceof Element)) {
      return false;
    }

    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
      return false;
    }

    const rect = element.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      return false;
    }

    return rect.bottom >= 0 &&
      rect.right >= 0 &&
      rect.top <= (window.innerHeight || document.documentElement.clientHeight) &&
      rect.left <= (window.innerWidth || document.documentElement.clientWidth);
  }

  function isInsideExtensionUi(element) {
    return Boolean(element.closest(`#${APP_ID}, #${MODAL_ID}`));
  }

  function selectVisibleConversations() {
    refreshConversationCheckboxes();
    getConversationLinks().forEach((link) => {
      const checkbox = link.querySelector(`.${CHECKBOX_CLASS}`);
      if (checkbox && isVisibleElement(link)) {
        checkbox.checked = true;
      }
    });
    updateSelectionStatus();
  }

  function deselectAllConversations() {
    document.querySelectorAll(`.${CHECKBOX_CLASS}`).forEach((checkbox) => {
      checkbox.checked = false;
    });
    updateSelectionStatus();
  }

  function getSelectedConversations() {
    refreshConversationCheckboxes();
    return getConversationLinks()
      .map((link) => ({
        key: getConversationKey(link),
        title: getConversationTitle(link),
        href: link.href,
        link
      }))
      .filter((conversation) => {
        const checkbox = conversation.link.querySelector(`.${CHECKBOX_CLASS}`);
        return checkbox && checkbox.checked;
      });
  }

  function updateSelectionStatus() {
    const status = byId("ccm-selection-status");
    if (!status) {
      return;
    }

    const links = getConversationLinks();
    const selected = links.filter((link) => {
      const checkbox = link.querySelector(`.${CHECKBOX_CLASS}`);
      return checkbox && checkbox.checked;
    });

    status.textContent = `${selected.length} selected / ${links.length} visible conversations`;
  }

  async function deleteSelectedConversations() {
    if (state.isDeleting) {
      logMessage("Deletion is already running.");
      return;
    }

    const conversations = getSelectedConversations();
    if (!conversations.length) {
      logMessage("No conversations selected.");
      return;
    }

    const confirmed = await showDeleteConfirmation(conversations);
    if (!confirmed) {
      logMessage("Deletion cancelled.");
      return;
    }

    state.isDeleting = true;
    setBusyState(true);
    const failures = [];
    let deleted = 0;

    try {
      for (let index = 0; index < conversations.length; index += 1) {
        const conversation = conversations[index];
        setProgress(`Deleting ${index + 1} / ${conversations.length}: ${conversation.title}`);

        try {
          await deleteConversation(conversation);
          deleted += 1;
          logMessage(`Deleted: ${conversation.title}`);
        } catch (error) {
          failures.push({ conversation, error });
          logMessage(`Failed: ${conversation.title} — ${error.message}`);
        }

        setProgress(`Deleted ${deleted} / ${conversations.length}. Failures: ${failures.length}.`);
        await sleep(1400);
      }
    } finally {
      state.isDeleting = false;
      setBusyState(false);
      refreshConversationCheckboxes();
      setProgress(`Finished. Deleted ${deleted} / ${conversations.length}. Failures: ${failures.length}.`);
    }
  }

  async function deleteConversation(conversation) {
    const link = findConversationLinkByKey(conversation.key);
    if (!link) {
      throw new Error("Conversation link is no longer visible.");
    }

    const row = findConversationRow(link);
    link.scrollIntoView({ block: "center", inline: "nearest" });
    dispatchHover(row || link);
    await sleep(350);

    const menuButton = findMenuButton(row || link, link);
    if (!menuButton) {
      throw new Error("Could not find the conversation menu button.");
    }

    clickElement(menuButton);
    const deleteItem = await waitFor(() => findDeleteMenuItem(), 5000, 100);
    clickElement(deleteItem);

    const confirmButton = await waitFor(() => findConfirmDeleteButton(), 7000, 100);
    clickElement(confirmButton);

    await waitFor(() => {
      const currentLink = findConversationLinkByKey(conversation.key);
      return !currentLink || !isVisibleElement(currentLink);
    }, 9000, 150);
  }

  function findConversationLinkByKey(key) {
    return getConversationLinks().find((link) => getConversationKey(link) === key) || null;
  }

  function findConversationRow(link) {
    const selectors = [
      "li",
      '[role="listitem"]',
      '[data-testid*="conversation" i]',
      '[data-testid*="history" i]',
      "div"
    ];

    let node = link;
    for (let depth = 0; node && depth < 7; depth += 1) {
      if (node !== link && selectors.some((selector) => node.matches && node.matches(selector))) {
        return node;
      }
      node = node.parentElement;
    }

    return link.parentElement || link;
  }

  function dispatchHover(element) {
    ["pointerover", "mouseover", "mouseenter"].forEach((eventName) => {
      element.dispatchEvent(new MouseEvent(eventName, {
        bubbles: true,
        cancelable: true,
        view: window
      }));
    });
  }

  function findMenuButton(row, link) {
    const rowButtons = Array.from(row.querySelectorAll ? row.querySelectorAll("button,[role='button']") : []);
    const visibleRowButtons = rowButtons.filter((button) => !isInsideExtensionUi(button) && isVisibleElement(button));

    const labelPattern = /(conversation|chat|options|menu|more|更多|菜单|選單|選項|选项)/i;
    const ariaButton = visibleRowButtons.find((button) => labelPattern.test(getAccessibleText(button)));
    if (ariaButton) {
      return ariaButton;
    }

    const iconLikeButton = visibleRowButtons.find((button) => {
      const text = cleanText(button.textContent);
      return text === "" || text === "..." || text === "⋯" || text === "…";
    });
    if (iconLikeButton) {
      return iconLikeButton;
    }

    return findNearbyMenuButton(link);
  }

  function findNearbyMenuButton(link) {
    const linkRect = link.getBoundingClientRect();
    const candidates = Array.from(document.querySelectorAll("button,[role='button']"))
      .filter((button) => !isInsideExtensionUi(button) && isVisibleElement(button));

    return candidates.find((button) => {
      const rect = button.getBoundingClientRect();
      const overlapsVertically = rect.bottom >= linkRect.top - 8 && rect.top <= linkRect.bottom + 8;
      const nearRightEdge = rect.left >= linkRect.left && rect.left <= linkRect.right + 96;
      return overlapsVertically && nearRightEdge;
    }) || null;
  }

  function findDeleteMenuItem() {
    const selectors = [
      '[role="menuitem"]',
      '[data-radix-collection-item]',
      "button",
      '[role="button"]'
    ].join(",");

    const deletePattern = /^(delete|delete chat|delete conversation|删除|刪除|移除)$/i;
    const containsDeletePattern = /(delete|删除|刪除)/i;

    return Array.from(document.querySelectorAll(selectors))
      .filter((element) => !isInsideExtensionUi(element) && isVisibleElement(element))
      .find((element) => {
        const text = getAccessibleText(element);
        return deletePattern.test(text) || containsDeletePattern.test(text);
      }) || null;
  }

  function findConfirmDeleteButton() {
    const dialog = Array.from(document.querySelectorAll('[role="dialog"],[aria-modal="true"]'))
      .filter((element) => !isInsideExtensionUi(element) && isVisibleElement(element))
      .pop();

    const root = dialog || document;
    const buttons = Array.from(root.querySelectorAll("button,[role='button']"))
      .filter((button) => !isInsideExtensionUi(button) && isVisibleElement(button));

    const confirmPattern = /^(delete|delete chat|delete conversation|confirm|yes, delete|删除|刪除|确认|確認)$/i;
    const cancelPattern = /(cancel|keep|取消|保留)/i;

    return buttons.find((button) => {
      const text = getAccessibleText(button);
      return confirmPattern.test(text) && !cancelPattern.test(text);
    }) || null;
  }

  function getAccessibleText(element) {
    return cleanText([
      element.getAttribute("aria-label"),
      element.getAttribute("title"),
      element.textContent
    ].filter(Boolean).join(" "));
  }

  function clickElement(element) {
    element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
    element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
    element.click();
  }

  function waitFor(getValue, timeoutMs, intervalMs) {
    const startedAt = Date.now();

    return new Promise((resolve, reject) => {
      const check = () => {
        const value = getValue();
        if (value) {
          resolve(value);
          return;
        }

        if (Date.now() - startedAt >= timeoutMs) {
          reject(new Error("Timed out while waiting for the ChatGPT UI."));
          return;
        }

        window.setTimeout(check, intervalMs);
      };

      check();
    });
  }

  function sleep(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function showDeleteConfirmation(conversations) {
    return new Promise((resolve) => {
      const oldModal = byId(MODAL_ID);
      if (oldModal) {
        oldModal.remove();
      }

      const modal = document.createElement("div");
      modal.id = MODAL_ID;
      modal.setAttribute("role", "dialog");
      modal.setAttribute("aria-modal", "true");
      modal.setAttribute("aria-label", "Confirm batch deletion");
      modal.innerHTML = `
        <div class="ccm-modal-card">
          <h2>Delete ${conversations.length} conversations?</h2>
          <p>This will use ChatGPT's normal delete menu one conversation at a time.</p>
          <div class="ccm-modal-list" tabindex="0">
            <ol>
              ${conversations.map((conversation) => `<li>${escapeHtml(conversation.title)}</li>`).join("")}
            </ol>
          </div>
          <label class="ccm-confirm-label" for="ccm-confirm-input">Type DELETE to continue</label>
          <input id="ccm-confirm-input" type="text" autocomplete="off" spellcheck="false" />
          <div class="ccm-modal-actions">
            <button type="button" id="ccm-cancel-delete">Cancel</button>
            <button type="button" id="ccm-confirm-delete" class="ccm-danger" disabled>Delete selected</button>
          </div>
        </div>
      `;

      document.body.appendChild(modal);

      const input = byId("ccm-confirm-input");
      const confirm = byId("ccm-confirm-delete");
      const cancel = byId("ccm-cancel-delete");

      input.addEventListener("input", () => {
        confirm.disabled = input.value !== "DELETE";
      });

      cancel.addEventListener("click", () => {
        modal.remove();
        resolve(false);
      });

      confirm.addEventListener("click", () => {
        modal.remove();
        resolve(true);
      });

      input.focus();
    });
  }

  function escapeHtml(text) {
    const span = document.createElement("span");
    span.textContent = text;
    return span.innerHTML;
  }

  function setBusyState(isBusy) {
    ["ccm-select-visible", "ccm-deselect-all", "ccm-delete-selected", "ccm-refresh-list"].forEach((id) => {
      const button = byId(id);
      if (button) {
        button.disabled = isBusy;
      }
    });
  }

  function setProgress(message) {
    const progress = byId("ccm-progress");
    if (progress) {
      progress.textContent = message;
    }
  }

  function logMessage(message) {
    const log = byId("ccm-log");
    if (!log) {
      return;
    }

    const item = document.createElement("li");
    item.textContent = `${new Date().toLocaleTimeString()} — ${message}`;
    log.prepend(item);

    while (log.children.length > 40) {
      log.lastElementChild.remove();
    }
  }

  function estimateVisibleContext() {
    const messages = getVisibleMessages();
    const text = messages.map((message) => message.text).join("\n\n");
    const estimate = estimateTokens(text);

    state.lastEstimate = {
      tokens: estimate.tokens,
      characters: text.length,
      messages: messages.length,
      cjkCharacters: estimate.cjkCharacters,
      nonCjkCharacters: estimate.nonCjkCharacters
    };

    return state.lastEstimate;
  }

  function getVisibleMessages() {
    const main = document.querySelector("main") || document.body;
    const selectors = [
      "[data-message-author-role]",
      '[data-testid^="conversation-turn"]',
      "article"
    ].join(",");

    let elements = Array.from(main.querySelectorAll(selectors))
      .filter((element) => !isInsideExtensionUi(element) && isVisibleElement(element));

    if (!elements.length) {
      elements = Array.from(main.querySelectorAll(".markdown, [class*='markdown']"))
        .filter((element) => !isInsideExtensionUi(element) && isVisibleElement(element));
    }

    const seen = new Set();
    return elements
      .map((element) => cleanText(element.textContent))
      .filter((text) => {
        if (!text || seen.has(text)) {
          return false;
        }
        seen.add(text);
        return true;
      })
      .map((text) => ({ text }));
  }

  function estimateTokens(text) {
    const source = String(text || "");
    const cjkMatches = source.match(/[\u3400-\u9FFF\uF900-\uFAFF]/g) || [];
    const cjkCharacters = cjkMatches.length;
    const nonCjkCharacters = Math.max(source.length - cjkCharacters, 0);
    const cjkTokens = cjkCharacters / 1.5;
    const nonCjkTokens = nonCjkCharacters / 4;

    return {
      tokens: Math.ceil(cjkTokens + nonCjkTokens),
      cjkCharacters,
      nonCjkCharacters
    };
  }

  function renderContextEstimate(estimate) {
    const output = byId("ccm-estimate-output");
    if (!output) {
      return;
    }

    const contextWindow = Number(byId("ccm-context-window").value || 128000);
    const percentage = contextWindow > 0 ? (estimate.tokens / contextWindow) * 100 : 0;

    output.innerHTML = `
      <div class="ccm-metric"><span>Visible tokens</span><strong>${formatNumber(estimate.tokens)}</strong></div>
      <div class="ccm-metric"><span>Characters</span><strong>${formatNumber(estimate.characters)}</strong></div>
      <div class="ccm-metric"><span>Messages</span><strong>${formatNumber(estimate.messages)}</strong></div>
      <div class="ccm-meter" aria-label="Approximate visible context usage">
        <div class="ccm-meter-fill" style="width: ${Math.min(percentage, 100).toFixed(2)}%"></div>
      </div>
      <div class="ccm-warning">${percentage.toFixed(2)}% of selected ${formatNumber(contextWindow)} token window. Visible page only; not backend context.</div>
    `;

    logMessage(`Estimated ${formatNumber(estimate.tokens)} visible tokens across ${estimate.messages} messages.`);
  }

  function formatNumber(value) {
    return new Intl.NumberFormat().format(value);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }

  // Exposed for local smoke tests and for users who want to inspect behavior in DevTools.
  window.ChatGPTCleanerContextMeter = {
    refreshConversationCheckboxes,
    estimateVisibleContext,
    estimateTokens,
    getConversationCount: () => getConversationLinks().length,
    getSelectedConversations
  };
})();
