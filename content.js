(function () {
  "use strict";

  const CONFIRM_MODAL_ID = "ccm-confirm-modal";
  const SELECT_MODAL_ID = "ccm-select-modal";
  const TOAST_ID = "ccm-toast";
  const CHECKBOX_CLASS = "ccm-conversation-checkbox";
  const ENHANCED_ATTR = "data-ccm-enhanced";
  const DELETE_DELAY_MS = 1400;

  const state = {
    observer: null,
    refreshTimer: null,
    isActivated: false,
    isDeleting: false,
    lastEstimate: null,
    logs: [],
    selectedConversationKeys: new Set()
  };

  function init() {
    installMessageBridge();
    exposeTestApi();
  }

  function installMessageBridge() {
    if (!globalThis.chrome || !chrome.runtime || !chrome.runtime.onMessage) {
      return;
    }

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (!message || message.source !== "ccm-popup") {
        return false;
      }

      Promise.resolve(handlePopupMessage(message))
        .then((response) => sendResponse(response))
        .catch((error) => sendResponse({
          ok: false,
          error: error && error.message ? error.message : String(error)
        }));

      return true;
    });
  }

  async function handlePopupMessage(message) {
    switch (message.type) {
      case "CCM_GET_STATUS":
        if (state.isActivated) {
          refreshConversationCheckboxes();
        }
        return ok({ status: getStatus() });

      case "CCM_SELECT_CONVERSATIONS":
        activateConversationTools();
        showConversationSelectionDialog();
        return ok({
          message: "Selection dialog opened on the ChatGPT page.",
          status: getStatus()
        });

      case "CCM_DESELECT_ALL":
        activateConversationTools();
        deselectAllConversations();
        showToast("All selected conversations were cleared.");
        return ok({
          message: "Selection cleared.",
          status: getStatus()
        });

      case "CCM_DELETE_SELECTED":
        activateConversationTools();
        // Let the page-side confirmation and progress continue even if the
        // extension popup closes while the user types DELETE.
        deleteSelectedConversations();
        return ok({
          message: "Confirm deletion on the ChatGPT page.",
          status: getStatus()
        });

      case "CCM_REFRESH_LIST":
        activateConversationTools();
        refreshConversationCheckboxes();
        showToast("Conversation list refreshed.");
        return ok({
          message: "Conversation list refreshed.",
          status: getStatus()
        });

      case "CCM_ESTIMATE_CONTEXT":
        return ok({
          estimate: estimateVisibleContext(Number(message.contextWindow)),
          status: getStatus()
        });

      default:
        throw new Error("Unknown extension action.");
    }
  }

  function ok(payload) {
    return Object.assign({ ok: true }, payload);
  }

  function activateConversationTools() {
    state.isActivated = true;
    refreshConversationCheckboxes();
    installMutationObserver();
  }

  function installMutationObserver() {
    if (state.observer || !document.body) {
      return;
    }

    // ChatGPT is a single-page app. The sidebar is rebuilt often, so observe
    // DOM changes only after the user activates the extension.
    state.observer = new MutationObserver(() => {
      if (!state.isActivated) {
        return;
      }

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
      const key = getConversationKey(link);
      const existing = link.querySelector(`.${CHECKBOX_CLASS}`);

      if (existing) {
        existing.dataset.ccmKey = key;
        existing.checked = state.selectedConversationKeys.has(key);
        existing.setAttribute("aria-label", `Select conversation: ${getConversationTitle(link)}`);
        return;
      }

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.className = CHECKBOX_CLASS;
      checkbox.dataset.ccmKey = key;
      checkbox.checked = state.selectedConversationKeys.has(key);
      checkbox.setAttribute("aria-label", `Select conversation: ${getConversationTitle(link)}`);
      checkbox.title = "Select this conversation";

      // Prevent checkbox clicks from opening the conversation link underneath it.
      ["click", "mousedown", "mouseup", "keydown"].forEach((eventName) => {
        checkbox.addEventListener(eventName, (event) => event.stopPropagation());
      });
      checkbox.addEventListener("change", () => {
        setConversationSelected(key, checkbox.checked);
      });

      link.insertBefore(checkbox, link.firstChild);
      link.classList.add("ccm-enhanced-link");
      link.setAttribute(ENHANCED_ATTR, "true");
      added += 1;
    });

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
    const selectors = [
      "aside",
      "nav",
      '[role="navigation"]',
      '[data-testid*="sidebar" i]',
      '[aria-label*="sidebar" i]',
      '[aria-label*="history" i]'
    ].join(",");

    const candidates = Array.from(document.querySelectorAll(selectors));
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
    return Boolean(element.closest(`#${CONFIRM_MODAL_ID}, #${SELECT_MODAL_ID}, #${TOAST_ID}`));
  }

  function setConversationSelected(key, isSelected) {
    if (isSelected) {
      state.selectedConversationKeys.add(key);
    } else {
      state.selectedConversationKeys.delete(key);
    }
  }

  function syncSidebarSelection() {
    getConversationLinks().forEach((link) => {
      const checkbox = link.querySelector(`.${CHECKBOX_CLASS}`);
      if (checkbox) {
        checkbox.checked = state.selectedConversationKeys.has(getConversationKey(link));
      }
    });
  }

  function deselectAllConversations() {
    state.selectedConversationKeys.clear();
    document.querySelectorAll(`.${CHECKBOX_CLASS}`).forEach((checkbox) => {
      checkbox.checked = false;
    });
  }

  function showConversationSelectionDialog() {
    const conversations = getConversationLinks().map((link) => ({
      key: getConversationKey(link),
      title: getConversationTitle(link),
      selected: state.selectedConversationKeys.has(getConversationKey(link))
    }));

    if (!conversations.length) {
      logMessage("No visible conversations found.");
      showToast("No visible conversations found.");
      return;
    }

    const oldModal = byId(SELECT_MODAL_ID);
    if (oldModal) {
      oldModal.remove();
    }

    const modal = document.createElement("div");
    modal.id = SELECT_MODAL_ID;
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.setAttribute("aria-label", "Select conversations");
    modal.innerHTML = `
      <div class="ccm-modal-card">
        <h2>Select conversations</h2>
        <p>Choose the visible conversations to mark for deletion. Nothing is selected automatically.</p>
        <div class="ccm-selection-count" id="ccm-selection-count"></div>
        <div class="ccm-selection-list" id="ccm-selection-list" tabindex="0"></div>
        <div class="ccm-modal-actions ccm-modal-actions-spread">
          <button type="button" id="ccm-selection-clear">Clear</button>
          <button type="button" id="ccm-selection-all">Select all visible</button>
          <span class="ccm-modal-spacer"></span>
          <button type="button" id="ccm-selection-cancel">Cancel</button>
          <button type="button" id="ccm-selection-apply">Apply selection</button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    const list = byId("ccm-selection-list");
    conversations.forEach((conversation, index) => {
      const label = document.createElement("label");
      label.className = "ccm-selection-item";

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.dataset.index = String(index);
      checkbox.checked = conversation.selected;

      const title = document.createElement("span");
      title.textContent = conversation.title;

      label.append(checkbox, title);
      list.appendChild(label);
    });

    const updateDialogCount = () => {
      const selectedCount = list.querySelectorAll("input[type='checkbox']:checked").length;
      byId("ccm-selection-count").textContent =
        `${selectedCount} selected / ${conversations.length} visible conversations`;
    };

    list.addEventListener("change", updateDialogCount);
    updateDialogCount();

    byId("ccm-selection-clear").addEventListener("click", () => {
      list.querySelectorAll("input[type='checkbox']").forEach((checkbox) => {
        checkbox.checked = false;
      });
      updateDialogCount();
    });

    byId("ccm-selection-all").addEventListener("click", () => {
      list.querySelectorAll("input[type='checkbox']").forEach((checkbox) => {
        checkbox.checked = true;
      });
      updateDialogCount();
    });

    byId("ccm-selection-cancel").addEventListener("click", () => {
      modal.remove();
    });

    byId("ccm-selection-apply").addEventListener("click", () => {
      state.selectedConversationKeys.clear();
      list.querySelectorAll("input[type='checkbox']").forEach((checkbox) => {
        if (!checkbox.checked) {
          return;
        }

        const conversation = conversations[Number(checkbox.dataset.index)];
        if (conversation) {
          state.selectedConversationKeys.add(conversation.key);
        }
      });

      modal.remove();
      syncSidebarSelection();
      logMessage(`Applied selection: ${state.selectedConversationKeys.size} conversations.`);
      showToast(`${state.selectedConversationKeys.size} conversations selected.`);
    });
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
        return state.selectedConversationKeys.has(conversation.key) || Boolean(checkbox && checkbox.checked);
      });
  }

  async function deleteSelectedConversations() {
    if (state.isDeleting) {
      logMessage("Deletion is already running.");
      showToast("Deletion is already running.");
      return;
    }

    const conversations = getSelectedConversations();
    if (!conversations.length) {
      logMessage("No conversations selected.");
      showToast("No conversations selected.");
      return;
    }

    const confirmed = await showDeleteConfirmation(conversations);
    if (!confirmed) {
      logMessage("Deletion cancelled.");
      showToast("Deletion cancelled.");
      return;
    }

    state.isDeleting = true;
    const failures = [];
    let deleted = 0;

    try {
      for (let index = 0; index < conversations.length; index += 1) {
        const conversation = conversations[index];
        setProgress(`Deleting ${index + 1} / ${conversations.length}: ${conversation.title}`);

        try {
          await deleteConversation(conversation);
          deleted += 1;
          state.selectedConversationKeys.delete(conversation.key);
          logMessage(`Deleted: ${conversation.title}`);
        } catch (error) {
          failures.push({ conversation, error });
          logMessage(`Failed: ${conversation.title} - ${error.message}`);
        }

        setProgress(`Deleted ${deleted} / ${conversations.length}. Failures: ${failures.length}.`);
        await sleep(DELETE_DELAY_MS);
      }
    } finally {
      state.isDeleting = false;
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

    logMessage(`Opening menu: ${conversation.title}`);
    clickElement(menuButton);
    const deleteItem = await waitFor(() => findDeleteMenuItem(), 5000, 100);
    logMessage(`Clicking delete menu item: ${conversation.title}`);
    clickElement(deleteItem);

    const confirmButton = await waitFor(() => findConfirmDeleteButton(), 7000, 100);
    logMessage(`Confirming deletion: ${conversation.title}`);
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

    const labelPattern = /(conversation|chat|options|menu|more|\u66f4\u591a|\u83dc\u5355|\u9009\u9879)/i;
    const ariaButton = visibleRowButtons.find((button) => labelPattern.test(getAccessibleText(button)));
    if (ariaButton) {
      return ariaButton;
    }

    const iconLikeButton = visibleRowButtons.find((button) => {
      const text = cleanText(button.textContent);
      return text === "" || text === "..." || text === "\u22ef" || text === "\u2026";
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
    const menuRootSelectors = [
      '[role="menu"]',
      '[data-radix-menu-content]',
      '[data-radix-popper-content-wrapper]',
      '[data-side][data-align]'
    ].join(",");
    const selectors = [
      '[role="menuitem"]',
      '[data-radix-collection-item]',
      "button",
      '[role="button"]'
    ].join(",");

    const deletePattern = /^(delete|delete chat|delete conversation|remove|\u5220\u9664|\u79fb\u9664)$/i;
    const containsDeletePattern = /(delete|\u5220\u9664|\u79fb\u9664)/i;
    const roots = Array.from(document.querySelectorAll(menuRootSelectors))
      .filter((element) => !isInsideExtensionUi(element) && isVisibleElement(element));
    const searchRoots = roots.length ? roots.reverse() : [document];

    for (const root of searchRoots) {
      const match = Array.from(root.querySelectorAll(selectors))
        .filter((element) => !isInsideExtensionUi(element) && isVisibleElement(element))
        .find((element) => {
          const text = getAccessibleText(element);
          return deletePattern.test(text) || containsDeletePattern.test(text);
        });

      if (match) {
        return match;
      }
    }

    return null;
  }

  function findConfirmDeleteButton() {
    const dialog = Array.from(document.querySelectorAll('[role="dialog"],[aria-modal="true"]'))
      .filter((element) => !isInsideExtensionUi(element) && isVisibleElement(element))
      .pop();

    const root = dialog || document;
    const buttons = Array.from(root.querySelectorAll("button,[role='button']"))
      .filter((button) => !isInsideExtensionUi(button) && isVisibleElement(button));

    const directConfirm = buttons.find((button) => button.matches([
      "[data-confirm-delete]",
      '[data-testid*="delete" i]',
      '[aria-label*="delete" i]',
      '[aria-label*="confirm" i]'
    ].join(",")));
    if (directConfirm) {
      return directConfirm;
    }

    const confirmPattern = /^(delete|delete chat|delete conversation|confirm|yes, delete|\u5220\u9664|\u786e\u8ba4|\u662f)$/i;
    const cancelPattern = /(cancel|keep|\u53d6\u6d88|\u4fdd\u7559)/i;

    const textMatch = buttons.find((button) => {
      const text = getAccessibleText(button);
      return confirmPattern.test(text) && !cancelPattern.test(text);
    });
    if (textMatch) {
      return textMatch;
    }

    const nonCancelButtons = buttons.filter((button) => !cancelPattern.test(getAccessibleText(button)));
    if (dialog && nonCancelButtons.length === 1) {
      return nonCancelButtons[0];
    }

    return null;
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
      const oldModal = byId(CONFIRM_MODAL_ID);
      if (oldModal) {
        oldModal.remove();
      }

      const modal = document.createElement("div");
      modal.id = CONFIRM_MODAL_ID;
      modal.setAttribute("role", "dialog");
      modal.setAttribute("aria-modal", "true");
      modal.setAttribute("aria-label", "Confirm batch deletion");
      modal.innerHTML = `
        <div class="ccm-modal-card">
          <h2>Delete ${conversations.length} conversations?</h2>
          <p>This uses ChatGPT's normal delete menu one conversation at a time.</p>
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

  function setProgress(message) {
    showToast(message, { sticky: true });
  }

  function showToast(message, options = {}) {
    let toast = byId(TOAST_ID);
    if (!toast) {
      toast = document.createElement("div");
      toast.id = TOAST_ID;
      toast.setAttribute("role", "status");
      toast.setAttribute("aria-live", "polite");
      document.body.appendChild(toast);
    }

    toast.textContent = message;

    if (!options.sticky) {
      window.clearTimeout(showToast.timer);
      showToast.timer = window.setTimeout(() => {
        const current = byId(TOAST_ID);
        if (current) {
          current.remove();
        }
      }, 4200);
    }
  }

  function logMessage(message) {
    const entry = `${new Date().toLocaleTimeString()} - ${message}`;
    state.logs.unshift(entry);
    state.logs = state.logs.slice(0, 60);
    console.info("[ChatGPT Cleaner]", message);
  }

  function estimateVisibleContext(contextWindowValue) {
    const messages = getVisibleMessages();
    const text = messages.map((message) => message.text).join("\n\n");
    const estimate = estimateTokens(text);
    const contextWindow = Number(contextWindowValue || 128000);
    const percentage = contextWindow > 0 ? (estimate.tokens / contextWindow) * 100 : 0;

    state.lastEstimate = {
      tokens: estimate.tokens,
      characters: text.length,
      messages: messages.length,
      contextWindow,
      percentage,
      method: estimate.method,
      cjkCharacters: estimate.cjkCharacters,
      nonCjkCharacters: estimate.nonCjkCharacters,
      englishWordCount: estimate.englishWordCount,
      numberCount: estimate.numberCount,
      urlCount: estimate.urlCount,
      punctuationCount: estimate.punctuationCount,
      warning: "Visible page only. This is not the real model backend context."
    };

    logMessage(`Estimated ${formatNumber(estimate.tokens)} visible tokens across ${messages.length} messages.`);
    return state.lastEstimate;
  }

  function getVisibleMessages() {
    const main = document.querySelector("main") || document.body;
    const selectorGroups = [
      "[data-message-author-role]",
      '[data-testid^="conversation-turn"]',
      "article",
      ".markdown, [class*='markdown']"
    ];

    let elements = [];
    for (const selectors of selectorGroups) {
      elements = Array.from(main.querySelectorAll(selectors))
        .filter((element) => !isInsideExtensionUi(element) && isVisibleElement(element));

      if (elements.length) {
        break;
      }
    }

    const seen = new Set();
    return elements
      .map((element) => extractReadableText(element))
      .filter((text) => {
        if (!text || seen.has(text)) {
          return false;
        }
        seen.add(text);
        return true;
      })
      .map((text) => ({ text }));
  }

  function extractReadableText(element) {
    const clone = element.cloneNode(true);
    clone.querySelectorAll([
      "button",
      "[role='button']",
      "nav",
      "menu",
      "input",
      "textarea",
      "select",
      "script",
      "style",
      ".sr-only"
    ].join(",")).forEach((node) => node.remove());

    return cleanText(clone.textContent);
  }

  function estimateTokens(text) {
    const source = String(text || "");
    if (!source) {
      return {
        tokens: 0,
        cjkCharacters: 0,
        nonCjkCharacters: 0,
        englishWordCount: 0,
        numberCount: 0,
        urlCount: 0,
        punctuationCount: 0,
        method: "hybrid-local-v2"
      };
    }

    const cjkRegex = /[\u3400-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/g;
    const urlRegex = /(?:https?:\/\/|www\.)[^\s<>"']+/gi;
    const cjkMatches = source.match(cjkRegex) || [];
    const urlMatches = source.match(urlRegex) || [];
    const cjkCharacters = cjkMatches.length;
    const nonCjkCharacters = Math.max(source.length - cjkCharacters, 0);

    // Remove high-density pieces before counting normal words so URLs do not
    // get counted twice. This stays local and dependency-free.
    const withoutCjk = source.replace(cjkRegex, " ");
    const withoutUrls = withoutCjk.replace(urlRegex, " ");
    const englishWords = withoutUrls.match(/[A-Za-z]+(?:['-][A-Za-z]+)?/g) || [];
    const numbers = withoutUrls.match(/\b\d+(?:[.,:/-]\d+)*\b/g) || [];
    const punctuation = source.match(/[^\sA-Za-z0-9\u3400-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/g) || [];
    const lineBreaks = source.match(/\n+/g) || [];

    const cjkTokens = cjkCharacters / 1.5;
    const urlTokens = sum(urlMatches.map((url) => Math.max(1, url.length / 3.2)));
    const wordTokens = englishWords.length * 1.28;
    const numberTokens = numbers.length * 1.15;
    const punctuationTokens = punctuation.length * 0.35;
    const lineBreakTokens = lineBreaks.length * 0.25;
    const structuralNonCjkTokens = urlTokens + wordTokens + numberTokens + punctuationTokens + lineBreakTokens;
    const characterNonCjkTokens = nonCjkCharacters / 4;
    const nonCjkTokens = structuralNonCjkTokens > 0
      ? (structuralNonCjkTokens * 0.65) + (characterNonCjkTokens * 0.35)
      : characterNonCjkTokens;

    return {
      tokens: Math.ceil(cjkTokens + nonCjkTokens),
      cjkCharacters,
      nonCjkCharacters,
      englishWordCount: englishWords.length,
      numberCount: numbers.length,
      urlCount: urlMatches.length,
      punctuationCount: punctuation.length,
      method: "hybrid-local-v2"
    };
  }

  function sum(values) {
    return values.reduce((total, value) => total + value, 0);
  }

  function getStatus() {
    const visible = state.isActivated ? getConversationLinks().length : 0;
    return {
      activated: state.isActivated,
      isDeleting: state.isDeleting,
      selected: state.selectedConversationKeys.size,
      visible,
      lastEstimate: state.lastEstimate,
      logs: state.logs.slice(0, 10)
    };
  }

  function byId(id) {
    return document.getElementById(id);
  }

  function formatNumber(value) {
    return new Intl.NumberFormat().format(value);
  }

  function exposeTestApi() {
    globalThis.ChatGPTCleanerContextMeter = {
      activateConversationTools,
      refreshConversationCheckboxes,
      showConversationSelectionDialog,
      deselectAllConversations,
      deleteSelectedConversations,
      estimateVisibleContext,
      estimateTokens,
      getConversationCount: () => getConversationLinks().length,
      getSelectedConversations,
      getStatus
    };
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
