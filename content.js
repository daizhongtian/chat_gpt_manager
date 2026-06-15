(function () {
  "use strict";

  const CONFIRM_MODAL_ID = "ccm-confirm-modal";
  const TOAST_ID = "ccm-toast";
  const CHECKBOX_CLASS = "ccm-conversation-checkbox";
  const ENHANCED_ATTR = "data-ccm-enhanced";
  const DELETE_DELAY_MS = 1400;
  const USAGE_STORAGE_KEY = "ccmUsageStats";
  const DEFAULT_MODEL_LABEL = "Unknown model";

  const state = {
    observer: null,
    refreshTimer: null,
    isActivated: false,
    isDeleting: false,
    lastEstimate: null,
    logs: [],
    selectedConversationKeys: new Set(),
    usageTrackingInstalled: false,
    usageMessageObserver: null,
    seenUserMessageKeys: new Set(),
    pendingUsageTimer: null,
    lastUsageSignature: "",
    lastUsageStartedAt: 0,
    lastComposerActivityAt: 0,
    memoryUsageStats: createEmptyUsageStats()
  };

  function init() {
    installMessageBridge();
    installUsageTracking();
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
        showToast("Conversation checkboxes are ready in the sidebar.");
        return ok({
          message: "Conversation checkboxes are ready in the sidebar.",
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

      case "CCM_RECORD_USAGE_NOW": {
        const usageStats = await recordModelUsage("manual-popup");
        return ok({
          message: `Recorded one ${usageStats.lastModelLabel} use.`,
          status: getStatus(),
          usageStats
        });
      }

      case "CCM_GET_USAGE_STATS":
        return ok({
          status: getStatus(),
          usageStats: await readUsageStats()
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

  function installUsageTracking() {
    if (state.usageTrackingInstalled || !document.body) {
      return;
    }

    state.usageTrackingInstalled = true;

    document.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target : null;
      const button = target ? target.closest("button,[role='button']") : null;
      if (button && isLikelySendButton(button)) {
        scheduleUsageRecord("send-button", button);
      }
    }, true);

    document.addEventListener("submit", (event) => {
      if (event.target instanceof Element && isLikelyComposerForm(event.target)) {
        scheduleUsageRecord("composer-submit", event.target);
      }
    }, true);

    document.addEventListener("keydown", (event) => {
      if (isLikelyComposerEnter(event)) {
        scheduleUsageRecord("enter-key", event.target);
      }
    }, true);

    document.addEventListener("input", (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target && isLikelyComposerInput(target)) {
        state.lastComposerActivityAt = Date.now();
      }
    }, true);

    installUsageMessageObserver();
  }

  function isLikelySendButton(button) {
    if (!button || isInsideExtensionUi(button) || !isVisibleElement(button)) {
      return false;
    }

    if (button.disabled || button.getAttribute("aria-disabled") === "true") {
      return false;
    }

    const label = cleanText([
      button.getAttribute("data-testid"),
      button.getAttribute("aria-label"),
      button.getAttribute("title"),
      button.textContent
    ].filter(Boolean).join(" "));
    const hasSendLabel = /(send|submit|发送|提交|傳送|送出)/i.test(label);
    const hasSendTestId = /send/i.test(button.getAttribute("data-testid") || "");

    return (hasSendLabel || hasSendTestId) && (hasSendTestId || Boolean(findNearbyComposerInput(button)));
  }

  function isLikelyComposerForm(form) {
    if (!form || isInsideExtensionUi(form)) {
      return false;
    }

    return Boolean(form.querySelector("textarea,[contenteditable='true'],[role='textbox']"));
  }

  function isLikelyComposerEnter(event) {
    if (!event || event.key !== "Enter" || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) {
      return false;
    }

    const target = event.target instanceof Element ? event.target : null;
    if (!target || isInsideExtensionUi(target)) {
      return false;
    }

    if (!isLikelyComposerInput(target) || !hasComposerContent(target)) {
      return false;
    }

    return true;
  }

  function isLikelyComposerInput(element) {
    if (!element || isInsideExtensionUi(element)) {
      return false;
    }

    if (!element.matches("textarea,[contenteditable='true'],[role='textbox']")) {
      return false;
    }

    return Boolean(element.closest("form,[data-testid*='composer' i],[class*='composer' i]")) ||
      element.getAttribute("aria-label")?.toLowerCase().includes("message") ||
      element.getAttribute("placeholder")?.toLowerCase().includes("message");
  }

  function findNearbyComposerInput(element) {
    let node = element;
    for (let depth = 0; node && depth < 8; depth += 1) {
      if (node.querySelector) {
        const input = node.querySelector("textarea,[contenteditable='true'],[role='textbox']");
        if (input) {
          return input;
        }
      }
      node = node.parentElement;
    }

    return document.querySelector("form textarea, form [contenteditable='true'], form [role='textbox']");
  }

  function hasComposerContent(element) {
    const input = element && element.matches && element.matches("textarea,[contenteditable='true'],[role='textbox']")
      ? element
      : findNearbyComposerInput(element);
    if (!input) {
      return true;
    }

    const text = "value" in input ? input.value : input.textContent;
    return cleanText(text).length > 0;
  }

  function installUsageMessageObserver() {
    if (state.usageMessageObserver || !document.body) {
      return;
    }

    seedSeenUserMessages();

    state.usageMessageObserver = new MutationObserver((mutations) => {
      if (Date.now() - state.lastComposerActivityAt > 12000) {
        return;
      }

      for (const mutation of mutations) {
        mutation.addedNodes.forEach((node) => {
          collectUserMessageElements(node).forEach((element) => {
            const key = getUserMessageKey(element);
            if (!key || state.seenUserMessageKeys.has(key)) {
              return;
            }

            state.seenUserMessageKeys.add(key);
            scheduleUsageRecord("new-user-message", null);
          });
        });
      }
    });

    state.usageMessageObserver.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  function seedSeenUserMessages() {
    collectUserMessageElements(document.body).forEach((element) => {
      const key = getUserMessageKey(element);
      if (key) {
        state.seenUserMessageKeys.add(key);
      }
    });
  }

  function collectUserMessageElements(root) {
    if (!root || !(root instanceof Element)) {
      return [];
    }

    const selector = '[data-message-author-role="user"], article[data-message-author-role="user"]';
    const elements = root.matches(selector)
      ? [root]
      : Array.from(root.querySelectorAll(selector));

    return elements.filter((element) => !isInsideExtensionUi(element) && isRenderedElement(element));
  }

  function getUserMessageKey(element) {
    const text = extractReadableText(element);
    if (!text) {
      return "";
    }

    return `${text.length}:${text.slice(0, 240)}`;
  }

  function scheduleUsageRecord(reason, sourceElement) {
    if (sourceElement && !hasComposerContent(sourceElement)) {
      return;
    }

    const now = Date.now();
    if (sourceElement) {
      state.lastComposerActivityAt = now;
    }
    const modelLabel = detectCurrentModelLabel();
    const signature = `${modelLabel}|${Math.floor(now / 2500)}`;

    if (signature === state.lastUsageSignature || now - state.lastUsageStartedAt < 900) {
      return;
    }

    state.lastUsageSignature = signature;
    state.lastUsageStartedAt = now;
    window.clearTimeout(state.pendingUsageTimer);
    state.pendingUsageTimer = window.setTimeout(() => {
      recordModelUsage(reason, modelLabel).catch((error) => {
        logMessage(`Usage count failed: ${error.message}`);
      });
    }, 500);
  }

  async function recordModelUsage(reason, modelLabel) {
    const label = normalizeModelLabel(modelLabel || detectCurrentModelLabel());
    const category = classifyUsageCategory(label);
    const stats = normalizeUsageStats(await readUsageStats());
    const now = new Date();
    const nowIso = now.toISOString();
    const day = localDateKey(now);
    const modelStats = stats.models[label] || createEmptyUsageBucket();
    const categoryStats = stats.categories[category] || createEmptyUsageBucket();

    stats.total += 1;
    stats.lastModelLabel = label;
    stats.lastCategory = category;
    stats.lastRecordedAt = nowIso;
    modelStats.total += 1;
    modelStats.dates[day] = (modelStats.dates[day] || 0) + 1;
    modelStats.lastUsedAt = nowIso;
    categoryStats.total += 1;
    categoryStats.dates[day] = (categoryStats.dates[day] || 0) + 1;
    categoryStats.lastUsedAt = nowIso;
    stats.models[label] = modelStats;
    stats.categories[category] = categoryStats;
    await writeUsageStats(stats);
    logMessage(`Recorded usage: ${label} (${category}). Total tracked sends: ${stats.total}.`);
    return stats;
  }

  async function resetModelUsage() {
    const stats = createEmptyUsageStats();
    await writeUsageStats(stats);
    logMessage("Usage statistics reset.");
    return stats;
  }

  function detectCurrentModelLabel() {
    const candidates = collectModelLabelCandidates();
    for (const candidate of candidates) {
      const label = normalizeModelLabel(candidate);
      if (label && label !== DEFAULT_MODEL_LABEL) {
        return label;
      }
    }

    return DEFAULT_MODEL_LABEL;
  }

  function collectModelLabelCandidates() {
    const explicitSelectors = [
      '[data-testid*="model" i]',
      '[aria-label*="model" i]',
      '[title*="model" i]',
      '[data-model]'
    ].join(",");
    const roots = [
      document.querySelector("header"),
      document.querySelector('[role="banner"]'),
      document.querySelector("main"),
      document.body
    ].filter(Boolean);
    const candidates = [];
    const seen = new Set();

    function addText(element) {
      if (!element || seen.has(element) || isInsideExtensionUi(element) || !isVisibleElement(element)) {
        return;
      }
      seen.add(element);

      const text = cleanText([
        element.getAttribute("data-model"),
        element.getAttribute("aria-label"),
        element.getAttribute("title"),
        element.textContent
      ].filter(Boolean).join(" "));

      if (text) {
        candidates.push(text);
      }
    }

    roots.forEach((root) => {
      root.querySelectorAll(explicitSelectors).forEach(addText);
    });
    roots.slice(0, 3).forEach((root) => {
      root.querySelectorAll("button,[role='button']").forEach((element) => {
        const text = getAccessibleText(element);
        if (looksLikeModelLabel(text)) {
          addText(element);
        }
      });
    });

    return candidates;
  }

  function normalizeModelLabel(text) {
    const source = cleanText(text)
      .replace(/\b(model selector|selected model|current model|switch model|choose model)\b[:\s-]*/ig, "")
      .replace(/\b(selected|current)\b/ig, "")
      .trim();

    if (!source) {
      return DEFAULT_MODEL_LABEL;
    }

    const patterns = [
      /ChatGPT\s+(?:Pro|Plus|Team|Enterprise|Free|Go)/i,
      /GPT[-\s]?(?:5|4o|4\.1|4|3\.5)(?:\s*(?:Thinking|mini|Turbo|Pro|High|Medium|Low))?/i,
      /\b(?:o1|o3|o4)(?:[-\s]?(?:mini|pro|high|medium|low))?\b/i,
      /Deep\s+Research/i,
      /Research\s+preview/i
    ];

    for (const pattern of patterns) {
      const match = source.match(pattern);
      if (match) {
        return cleanText(match[0]).replace(/\bgpt\b/i, "GPT");
      }
    }

    if (source.length <= 42 && looksLikeModelLabel(source)) {
      return source;
    }

    return DEFAULT_MODEL_LABEL;
  }

  function looksLikeModelLabel(text) {
    return /(ChatGPT\s+(?:Pro|Plus|Team|Enterprise|Free|Go)|GPT[-\s]?(?:5|4o|4\.1|4|3\.5)|\bo[134]\b|Deep\s+Research|Research\s+preview)/i
      .test(cleanText(text));
  }

  function classifyUsageCategory(label) {
    const source = cleanText(label);
    if (/(^|[\s-])Pro($|[\s-])|ChatGPT\s*Pro|GPT[-\s]?(?:5|4o|4\.1|4|3\.5)?\s*Pro|\bo[134][-\s]*Pro\b/i.test(source)) {
      return "GPT Pro";
    }

    return "GPT";
  }

  function createEmptyUsageStats() {
    const nowIso = new Date().toISOString();
    return {
      version: 2,
      total: 0,
      models: {},
      categories: {
        GPT: createEmptyUsageBucket(),
        "GPT Pro": createEmptyUsageBucket()
      },
      createdAt: nowIso,
      lastRecordedAt: null,
      lastModelLabel: null,
      lastCategory: null
    };
  }

  function createEmptyUsageBucket() {
    return {
      total: 0,
      dates: {},
      lastUsedAt: null
    };
  }

  function normalizeUsageStats(raw) {
    const fallback = createEmptyUsageStats();
    if (!raw || typeof raw !== "object") {
      return fallback;
    }

    const stats = Object.assign(fallback, raw);
    stats.total = Number(stats.total || 0);
    stats.models = stats.models && typeof stats.models === "object" ? stats.models : {};
    stats.categories = stats.categories && typeof stats.categories === "object" ? stats.categories : null;

    Object.keys(stats.models).forEach((label) => {
      const model = stats.models[label] || {};
      model.total = Number(model.total || 0);
      model.dates = model.dates && typeof model.dates === "object" ? model.dates : {};
      model.lastUsedAt = model.lastUsedAt || null;
      stats.models[label] = model;
    });

    if (!stats.categories) {
      stats.categories = {
        GPT: createEmptyUsageBucket(),
        "GPT Pro": createEmptyUsageBucket()
      };

      Object.entries(stats.models).forEach(([label, model]) => {
        mergeUsageBucket(stats.categories[classifyUsageCategory(label)], model);
      });
    } else {
      ["GPT", "GPT Pro"].forEach((category) => {
        const bucket = stats.categories[category] || {};
        bucket.total = Number(bucket.total || 0);
        bucket.dates = bucket.dates && typeof bucket.dates === "object" ? bucket.dates : {};
        bucket.lastUsedAt = bucket.lastUsedAt || null;
        stats.categories[category] = bucket;
      });
    }

    return stats;
  }

  function mergeUsageBucket(target, source) {
    target.total += Number(source.total || 0);
    Object.entries(source.dates || {}).forEach(([date, count]) => {
      target.dates[date] = (target.dates[date] || 0) + Number(count || 0);
    });

    if (!target.lastUsedAt || (source.lastUsedAt && source.lastUsedAt > target.lastUsedAt)) {
      target.lastUsedAt = source.lastUsedAt || target.lastUsedAt;
    }
  }

  async function readUsageStats() {
    if (!hasChromeStorage()) {
      return normalizeUsageStats(state.memoryUsageStats);
    }

    return new Promise((resolve) => {
      chrome.storage.local.get([USAGE_STORAGE_KEY], (items) => {
        resolve(normalizeUsageStats(items && items[USAGE_STORAGE_KEY]));
      });
    });
  }

  async function writeUsageStats(stats) {
    const normalized = normalizeUsageStats(stats);
    state.memoryUsageStats = normalized;

    if (!hasChromeStorage()) {
      return normalized;
    }

    return new Promise((resolve, reject) => {
      chrome.storage.local.set({ [USAGE_STORAGE_KEY]: normalized }, () => {
        const error = chrome.runtime && chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }
        resolve(normalized);
      });
    });
  }

  function hasChromeStorage() {
    return Boolean(globalThis.chrome && chrome.storage && chrome.storage.local);
  }

  function localDateKey(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
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

    if (!isRenderedElement(element)) {
      return false;
    }

    const rect = element.getBoundingClientRect();
    return rect.bottom >= 0 &&
      rect.right >= 0 &&
      rect.top <= (window.innerHeight || document.documentElement.clientHeight) &&
      rect.left <= (window.innerWidth || document.documentElement.clientWidth);
  }

  function isRenderedElement(element) {
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

    return true;
  }

  function isInsideExtensionUi(element) {
    return Boolean(element.closest(`#${CONFIRM_MODAL_ID}, #${TOAST_ID}`));
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
  }

  function estimateVisibleContext(contextWindowValue) {
    const messages = getVisibleMessages();
    const text = messages.map((message) => message.text).join("\n\n");
    const estimate = estimateTokens(text, { messageCount: messages.length });
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
      messageOverheadTokens: estimate.messageOverheadTokens,
      safetyMarginTokens: estimate.safetyMarginTokens,
      warning: "Loaded page content only. This is not the real model backend context."
    };

    logMessage(`Estimated ${formatNumber(estimate.tokens)} loaded-page tokens across ${messages.length} messages.`);
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
        .filter((element) => !isInsideExtensionUi(element) && isRenderedElement(element));

      if (elements.length) {
        break;
      }
    }

    return dedupeMessageElements(elements)
      .map((element) => extractReadableText(element))
      .filter(Boolean)
      .map((text) => ({ text }));
  }

  function dedupeMessageElements(elements) {
    return elements.filter((element, index) => {
      return !elements.some((other, otherIndex) => {
        return otherIndex !== index && other !== element && other.contains(element);
      });
    });
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

  function estimateTokens(text, options = {}) {
    const source = String(text || "");
    const messageCount = Math.max(0, Number(options.messageCount || 0));
    if (!source) {
      return {
        tokens: 0,
        cjkCharacters: 0,
        nonCjkCharacters: 0,
        englishWordCount: 0,
        numberCount: 0,
        urlCount: 0,
        punctuationCount: 0,
        messageOverheadTokens: 0,
        safetyMarginTokens: 0,
        method: "conservative-local-v3"
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
    const urlCharacterCount = sum(urlMatches.map((url) => url.length));

    // Conservative local estimate:
    // - CJK text is close to one token per visible character in many model
    //   tokenizers, so use a high-density estimate.
    // - English, code, URLs, numbers, punctuation, and line breaks often split
    //   more densely than plain "characters / 4".
    // - Add a small per-message overhead plus a safety margin so the meter is
    //   less likely to understate loaded context.
    const cjkTokens = cjkCharacters;
    const urlTokens = sum(urlMatches.map((url) => Math.max(2, url.length / 2.4)));
    const wordTokens = sum(englishWords.map((word) => Math.max(1, word.length / 3.6)));
    const numberTokens = sum(numbers.map((number) => Math.max(1, number.length / 2.8)));
    const punctuationTokens = punctuation.length * 0.55;
    const lineBreakTokens = lineBreaks.length * 0.45;
    const structuralNonCjkTokens = urlTokens + wordTokens + numberTokens + punctuationTokens + lineBreakTokens;
    const characterNonCjkTokens = (Math.max(nonCjkCharacters - urlCharacterCount, 0) / 3.15) + urlTokens;
    const contentTokens = cjkTokens + Math.max(structuralNonCjkTokens, characterNonCjkTokens);
    const messageOverheadTokens = messageCount > 0 ? (messageCount * 8) + 4 : 0;
    const safetyMarginTokens = Math.ceil(contentTokens * 0.16);

    return {
      tokens: Math.ceil(contentTokens + messageOverheadTokens + safetyMarginTokens),
      cjkCharacters,
      nonCjkCharacters,
      englishWordCount: englishWords.length,
      numberCount: numbers.length,
      urlCount: urlMatches.length,
      punctuationCount: punctuation.length,
      messageOverheadTokens,
      safetyMarginTokens,
      method: "conservative-local-v3"
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
      currentModel: detectCurrentModelLabel(),
      usageTrackingInstalled: state.usageTrackingInstalled,
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
      deselectAllConversations,
      deleteSelectedConversations,
      estimateVisibleContext,
      estimateTokens,
      detectCurrentModelLabel,
      recordModelUsage,
      resetModelUsage,
      readUsageStats,
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
