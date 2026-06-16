(function () {
  "use strict";

  const TOAST_ID = "ccm-toast";
  const CHECKBOX_CLASS = "ccm-conversation-checkbox";
  const ENHANCED_ATTR = "data-ccm-enhanced";
  const DELETE_DELAY_MS = 80;
  const MENU_HOVER_DELAY_MS = 40;
  const UI_POLL_INTERVAL_MS = 40;
  const MEDIA_ESTIMATE_TIMEOUT_MS = 6500;
  const PDF_FETCH_TIMEOUT_MS = 5000;
  const PDF_AUTO_ANALYSIS_LIMIT_BYTES = 20 * 1024 * 1024;
  const PDF_AUTO_ANALYSIS_LIMIT = 3;
  const USAGE_STORAGE_KEY = "ccmUsageStats";
  const SETTINGS_STORAGE_KEY = "ccmSettings";
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
    extensionEnabled: true,
    memoryUsageStats: createEmptyUsageStats()
  };

  function init() {
    installSettingsSync();
    installMessageBridge();
    installUsageTracking();
    exposeTestApi();
  }

  function installSettingsSync() {
    readExtensionSettings()
      .then(applyExtensionSettings)
      .catch((error) => logMessage(`Settings read failed: ${error.message}`));

    if (!globalThis.chrome || !chrome.storage || !chrome.storage.onChanged) {
      return;
    }

    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "local" || !changes[SETTINGS_STORAGE_KEY]) {
        return;
      }

      applyExtensionSettings(changes[SETTINGS_STORAGE_KEY].newValue || {});
    });
  }

  async function readExtensionSettings() {
    if (!hasChromeStorage()) {
      return {};
    }

    return new Promise((resolve) => {
      chrome.storage.local.get([SETTINGS_STORAGE_KEY], (items) => {
        const settings = items && items[SETTINGS_STORAGE_KEY];
        resolve(settings && typeof settings === "object" ? settings : {});
      });
    });
  }

  function applyExtensionSettings(settings) {
    const wasEnabled = isExtensionEnabled();
    state.extensionEnabled = !settings || settings.extensionEnabled !== false;

    if (wasEnabled && !state.extensionEnabled) {
      deactivateConversationTools();
      window.clearTimeout(state.pendingUsageTimer);
      state.pendingUsageTimer = null;
      showToast("ChatGPT Cleaner & Context Viewer is disabled.");
    }
  }

  function isExtensionEnabled() {
    return state.extensionEnabled !== false;
  }

  function requireExtensionEnabled() {
    if (!isExtensionEnabled()) {
      throw new Error("Extension is disabled. Turn it on in the popup to use this action.");
    }
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
        if (isExtensionEnabled() && state.isActivated) {
          refreshConversationCheckboxes();
        }
        return ok({ status: getStatus() });

      case "CCM_SET_EXTENSION_ENABLED":
        applyExtensionSettings({ extensionEnabled: message.enabled !== false });
        return ok({
          message: isExtensionEnabled() ? "Extension enabled." : "Extension disabled.",
          status: getStatus()
        });

      case "CCM_SELECT_CONVERSATIONS":
        requireExtensionEnabled();
        activateConversationTools();
        showToast("Conversation checkboxes are ready in the sidebar.");
        return ok({
          message: "Conversation checkboxes are ready in the sidebar.",
          status: getStatus()
        });

      case "CCM_DESELECT_ALL":
        requireExtensionEnabled();
        activateConversationTools();
        deselectAllConversations();
        showToast("All selected conversations were cleared.");
        return ok({
          message: "Selection cleared.",
          status: getStatus()
        });

      case "CCM_DELETE_SELECTED":
        requireExtensionEnabled();
        activateConversationTools();
        // Let the page-side progress continue even if the extension popup closes.
        deleteSelectedConversations();
        return ok({
          message: "Deletion started.",
          status: getStatus()
        });

      case "CCM_REFRESH_LIST":
        requireExtensionEnabled();
        activateConversationTools();
        refreshConversationCheckboxes();
        showToast("Conversation list refreshed.");
        return ok({
          message: "Conversation list refreshed.",
          status: getStatus()
        });

      case "CCM_ESTIMATE_CONTEXT":
        requireExtensionEnabled();
        return ok({
          estimate: await estimateVisibleContext(Number(message.contextWindow)),
          status: getStatus()
        });

      case "CCM_RECORD_USAGE_NOW": {
        requireExtensionEnabled();
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
    requireExtensionEnabled();
    state.isActivated = true;
    refreshConversationCheckboxes();
    installMutationObserver();
  }

  function deactivateConversationTools() {
    state.isActivated = false;
    state.selectedConversationKeys.clear();

    document.querySelectorAll(`.${CHECKBOX_CLASS}`).forEach((checkbox) => {
      const link = checkbox.closest("a");
      checkbox.remove();
      if (link) {
        link.classList.remove("ccm-enhanced-link");
        link.removeAttribute(ENHANCED_ATTR);
      }
    });

    if (state.observer) {
      state.observer.disconnect();
      state.observer = null;
    }
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

    ["pointerdown", "click"].forEach((eventName) => {
      document.addEventListener(eventName, handlePotentialSendAction, true);
    });

    document.addEventListener("submit", (event) => {
      if (isExtensionEnabled() && event.target instanceof Element && isLikelyComposerForm(event.target)) {
        scheduleUsageRecord("composer-submit", event.target);
      }
    }, true);

    document.addEventListener("keydown", (event) => {
      if (isExtensionEnabled() && isLikelyComposerEnter(event)) {
        scheduleUsageRecord("enter-key", event.target);
      }
    }, true);

    ["beforeinput", "input", "paste", "compositionend"].forEach((eventName) => {
      document.addEventListener(eventName, markComposerActivity, true);
    });

    installUsageMessageObserver();
  }

  function handlePotentialSendAction(event) {
    if (!isExtensionEnabled()) {
      return;
    }

    const target = event.target instanceof Element ? event.target : null;
    const button = target ? target.closest("button,[role='button'],input[type='submit']") : null;
    if (button && isLikelySendButton(button)) {
      scheduleUsageRecord(`send-${event.type}`, button);
    }
  }

  function markComposerActivity(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (target && isLikelyComposerInput(target)) {
      state.lastComposerActivityAt = Date.now();
    }
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
      button.getAttribute("name"),
      button.getAttribute("type"),
      button.textContent
    ].filter(Boolean).join(" "));
    const hasSendLabel = /(send|submit|\u53d1\u9001|\u63d0\u4ea4|\u50b3\u9001|\u9001\u51fa)/i.test(label);
    const hasSendTestId = /send/i.test(button.getAttribute("data-testid") || "");
    const composerInput = findNearbyComposerInput(button);
    const isSubmitButton = button.matches("input[type='submit'],button[type='submit']") ||
      (button.tagName === "BUTTON" && !button.getAttribute("type") && Boolean(button.closest("form")));

    return Boolean(composerInput) && (hasSendLabel || hasSendTestId || isSubmitButton);
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

    const dataTestId = element.getAttribute("data-testid") || "";
    const ariaLabel = element.getAttribute("aria-label") || "";
    const placeholder = element.getAttribute("placeholder") || "";

    return Boolean(element.closest("form,[data-testid*='composer' i],[aria-label*='composer' i],[class*='composer' i]")) ||
      /prompt|message|composer/i.test(dataTestId) ||
      /prompt|message|\u6d88\u606f|\u63d0\u793a/i.test(ariaLabel) ||
      /prompt|message|\u6d88\u606f|\u63d0\u793a/i.test(placeholder);
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
    if (!isExtensionEnabled()) {
      return;
    }

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
    requireExtensionEnabled();

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
    if (!isExtensionEnabled()) {
      deactivateConversationTools();
      return 0;
    }

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

  function dedupeStrings(values) {
    return Array.from(new Set(values.filter(Boolean)));
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
    return Boolean(element.closest(`#${TOAST_ID}`));
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
    requireExtensionEnabled();

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

    state.isDeleting = true;
    const failures = [];
    let deleted = 0;

    try {
      for (let index = 0; index < conversations.length; index += 1) {
        if (!isExtensionEnabled()) {
          logMessage("Deletion stopped because the extension was disabled.");
          break;
        }

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
        if (index < conversations.length - 1) {
          await sleep(DELETE_DELAY_MS);
        }
      }
    } finally {
      state.isDeleting = false;
      refreshConversationCheckboxes();
      setProgress(`Finished. Deleted ${deleted} / ${conversations.length}. Failures: ${failures.length}.`);
    }
  }

  async function deleteConversation(conversation) {
    requireExtensionEnabled();

    const link = findConversationLinkByKey(conversation.key);
    if (!link) {
      throw new Error("Conversation link is no longer visible.");
    }

    const row = findConversationRow(link);
    link.scrollIntoView({ block: "center", inline: "nearest" });
    dispatchHover(row || link);
    await sleep(MENU_HOVER_DELAY_MS);

    const menuButton = findMenuButton(row || link, link);
    if (!menuButton) {
      throw new Error("Could not find the conversation menu button.");
    }

    logMessage(`Opening menu: ${conversation.title}`);
    clickElement(menuButton);
    const deleteItem = await waitFor(() => findDeleteMenuItem(), 5000, UI_POLL_INTERVAL_MS);
    logMessage(`Clicking delete menu item: ${conversation.title}`);
    clickElement(deleteItem);

    const confirmButton = await waitFor(() => findConfirmDeleteButton(), 7000, UI_POLL_INTERVAL_MS);
    logMessage(`Confirming deletion: ${conversation.title}`);
    clickElement(confirmButton);

    await waitFor(() => {
      const currentLink = findConversationLinkByKey(conversation.key);
      return !currentLink || !isVisibleElement(currentLink);
    }, 9000, UI_POLL_INTERVAL_MS);
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

  async function estimateVisibleContext(contextWindowValue) {
    requireExtensionEnabled();

    const scanResult = await collectConversationMessagesForEstimate();
    const messages = scanResult.messages;
    const text = messages.map((message) => message.text).join("\n\n");
    const estimate = estimateTokens(text, { messageCount: messages.length });
    const roleSummary = estimateMessageRoles(messages);
    const mediaEstimate = await estimateVisibleMediaSafely(contextWindowValue);
    const selectedContextWindow = sanitizeContextWindow(contextWindowValue);
    const estimatedVisibleTokens = estimate.tokens + Number(mediaEstimate.totalTokens || 0);
    const percentage = selectedContextWindow > 0 ? (estimatedVisibleTokens / selectedContextWindow) * 100 : 0;

    state.lastEstimate = {
      estimatedVisibleTokens,
      tokens: estimatedVisibleTokens,
      textTokens: estimate.tokens,
      imageTokens: mediaEstimate.imageTokens,
      imageCount: mediaEstimate.imageCount,
      pdfCount: mediaEstimate.pdfCount,
      analyzedPdfCount: mediaEstimate.analyzedPdfCount,
      inaccessiblePdfCount: mediaEstimate.inaccessiblePdfCount,
      pdfPages: mediaEstimate.pdfPages,
      pdfTextTokens: mediaEstimate.pdfTextTokens,
      pdfImageTokens: mediaEstimate.pdfImageTokens,
      pdfImagePages: mediaEstimate.pdfImagePages,
      pdfScannedLikePages: mediaEstimate.pdfScannedLikePages,
      countedAttachments: mediaEstimate.countedAttachments,
      missingAttachments: mediaEstimate.missingAttachments,
      mediaTimedOut: mediaEstimate.mediaTimedOut,
      mediaError: mediaEstimate.mediaError,
      characters: text.length,
      messages: messages.length,
      userMessages: roleSummary.user.messages,
      assistantMessages: roleSummary.assistant.messages,
      otherMessages: roleSummary.other.messages,
      userTextTokens: roleSummary.user.tokens,
      assistantTextTokens: roleSummary.assistant.tokens,
      otherTextTokens: roleSummary.other.tokens,
      scanTarget: scanResult.scanInfo.target,
      scanSteps: scanResult.scanInfo.steps,
      scanScrollMax: scanResult.scanInfo.scrollMax,
      selectedContextWindow,
      contextWindow: selectedContextWindow,
      conversationKey: getCurrentConversationKey(),
      conversationUrl: location.href,
      percentage,
      method: estimate.method,
      cjkCharacters: estimate.cjkCharacters,
      chineseCharacters: estimate.chineseCharacters,
      japaneseCharacters: estimate.japaneseCharacters,
      koreanCharacters: estimate.koreanCharacters,
      codeCharacters: estimate.codeCharacters,
      urlJsonCharacters: estimate.urlJsonCharacters,
      emojiCount: estimate.emojiCount,
      nonCjkCharacters: estimate.nonCjkCharacters,
      englishWordCount: estimate.englishWordCount,
      numberCount: estimate.numberCount,
      urlCount: estimate.urlCount,
      punctuationCount: estimate.punctuationCount,
      tokenizerUsed: estimate.tokenizerUsed,
      tokenizerError: estimate.tokenizerError,
      warning: "Scanned loaded page content only. This is not the real model backend context."
    };

    logMessage(`Estimated ${formatNumber(estimatedVisibleTokens)} scanned-page tokens across ${messages.length} messages.`);
    return state.lastEstimate;
  }

  function estimateMessageRoles(messages) {
    const groups = {
      user: [],
      assistant: [],
      other: []
    };

    messages.forEach((message) => {
      const role = message.role === "user" || message.role === "assistant" ? message.role : "other";
      groups[role].push(message.text);
    });

    return {
      user: estimateRoleGroup(groups.user),
      assistant: estimateRoleGroup(groups.assistant),
      other: estimateRoleGroup(groups.other)
    };
  }

  function estimateRoleGroup(texts) {
    const text = texts.join("\n\n");
    return {
      messages: texts.length,
      tokens: text ? estimateTokens(text, { messageCount: texts.length }).tokens : 0
    };
  }

  async function estimateVisibleMediaSafely(contextWindowValue) {
    try {
      return await withTimeout(
        estimateVisibleMedia(contextWindowValue),
        MEDIA_ESTIMATE_TIMEOUT_MS,
        createEmptyMediaEstimate({ mediaTimedOut: true })
      );
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      logMessage(`Media estimate failed: ${message}`);
      return createEmptyMediaEstimate({ mediaError: message });
    }
  }

  function createEmptyMediaEstimate(overrides = {}) {
    return Object.assign({
      imageCount: 0,
      imageTokens: 0,
      pdfCount: 0,
      analyzedPdfCount: 0,
      inaccessiblePdfCount: 0,
      pdfPages: 0,
      pdfTextTokens: 0,
      pdfImageTokens: 0,
      pdfImagePages: 0,
      pdfScannedLikePages: 0,
      countedAttachments: [],
      missingAttachments: [],
      totalTokens: 0,
      mediaTimedOut: false,
      mediaError: ""
    }, overrides);
  }

  function withTimeout(promise, timeoutMs, fallback) {
    let timer = 0;
    return Promise.race([
      promise,
      new Promise((resolve) => {
        timer = window.setTimeout(() => resolve(fallback), timeoutMs);
      })
    ]).finally(() => {
      window.clearTimeout(timer);
    });
  }

  function sanitizeContextWindow(value) {
    const numeric = Math.floor(Number(value || 128000));
    if (!Number.isFinite(numeric) || numeric <= 0) {
      return 128000;
    }

    return numeric;
  }

  async function estimateVisibleMedia(contextWindowValue) {
    const selectedContextWindow = sanitizeContextWindow(contextWindowValue);
    const images = getVisibleContentImages();
    const imageAttachments = images
      .map((image, index) => createImageAttachmentEstimate(image, index))
      .filter((attachment) => attachment.tokens > 0);
    const imageTokens = sum(imageAttachments.map((attachment) => attachment.tokens));
    const pdfs = getVisiblePdfAttachments();
    const pdfEstimate = await estimatePdfAttachments(pdfs, selectedContextWindow);

    return {
      imageCount: images.length,
      imageTokens,
      pdfCount: pdfs.length,
      analyzedPdfCount: pdfEstimate.analyzedPdfCount,
      inaccessiblePdfCount: pdfEstimate.inaccessiblePdfCount,
      pdfPages: pdfEstimate.pdfPages,
      pdfTextTokens: pdfEstimate.pdfTextTokens,
      pdfImageTokens: pdfEstimate.pdfImageTokens,
      pdfImagePages: pdfEstimate.pdfImagePages,
      pdfScannedLikePages: pdfEstimate.pdfScannedLikePages,
      countedAttachments: imageAttachments.concat(pdfEstimate.countedAttachments),
      missingAttachments: pdfEstimate.missingAttachments,
      totalTokens: imageTokens + pdfEstimate.pdfTextTokens + pdfEstimate.pdfImageTokens,
      mediaTimedOut: false,
      mediaError: ""
    };
  }

  function createImageAttachmentEstimate(image, index) {
    const tokens = estimateImageTokens(image.width, image.height);
    return {
      kind: "image",
      key: image.key || `visible-image-${index + 1}`,
      name: image.alt ? `Image: ${image.alt.slice(0, 42)}` : `Visible image ${index + 1}`,
      source: "Visible page image",
      status: "Counted",
      tokens,
      width: Math.round(Number(image.width || 0)),
      height: Math.round(Number(image.height || 0))
    };
  }

  function getVisibleContentImages() {
    const main = document.querySelector("main") || document.body;
    const seen = new Set();

    return Array.from(main.querySelectorAll("img"))
      .filter((image) => !isInsideExtensionUi(image) && isRenderedElement(image))
      .map((image) => {
        const rect = image.getBoundingClientRect();
        const width = Number(image.naturalWidth || rect.width || 0);
        const height = Number(image.naturalHeight || rect.height || 0);
        return {
          key: image.currentSrc || image.src || `${Math.round(width)}x${Math.round(height)}:${image.alt || ""}`,
          width,
          height,
          alt: image.alt || ""
        };
      })
      .filter((image) => image.width >= 96 && image.height >= 96)
      .filter((image) => {
        const label = cleanText(image.alt);
        return !/(avatar|icon|logo|profile)/i.test(label);
      })
      .filter((image) => {
        if (seen.has(image.key)) {
          return false;
        }
        seen.add(image.key);
        return true;
      });
  }

  function estimateImageTokens(width, height) {
    let scaledWidth = Number(width || 0);
    let scaledHeight = Number(height || 0);
    if (!scaledWidth || !scaledHeight) {
      return 0;
    }

    const maxSide = Math.max(scaledWidth, scaledHeight);
    if (maxSide > 2048) {
      const ratio = 2048 / maxSide;
      scaledWidth *= ratio;
      scaledHeight *= ratio;
    }

    const minSide = Math.min(scaledWidth, scaledHeight);
    if (minSide > 768) {
      const ratio = 768 / minSide;
      scaledWidth *= ratio;
      scaledHeight *= ratio;
    }

    const tiles = Math.max(1, Math.ceil(scaledWidth / 512) * Math.ceil(scaledHeight / 512));
    return 85 + (170 * tiles);
  }

  function getVisiblePdfAttachments() {
    const main = document.querySelector("main") || document.body;
    const candidates = collectPdfCandidateElements(main);
    const seen = new Set();

    return candidates
      .map((element) => createPdfAttachment(element))
      .filter(Boolean)
      .filter((attachment) => {
        const dedupeKey = getPdfAttachmentDedupeKey(attachment);
        if (!dedupeKey || seen.has(dedupeKey)) {
          return false;
        }
        seen.add(dedupeKey);
        return true;
      });
  }

  function getPdfAttachmentDedupeKey(attachment) {
    const fetchUrl = attachment.fetchUrl || "";
    if (fetchUrl) {
      return fetchUrl;
    }

    const name = cleanText(attachment.name).toLowerCase();
    return name || attachment.key || "";
  }

  function collectPdfCandidateElements(root) {
    const selector = [
      "a[href]",
      "object[data]",
      "embed[src]",
      "iframe[src]",
      "[download]",
      "[aria-label]",
      "[title]",
      "[data-testid*='file' i]",
      "[data-testid*='attachment' i]",
      "[data-testid*='document' i]",
      "[data-testid*='pdf' i]",
      "[data-file-name]",
      "[data-filename]",
      "[data-name]",
      "[data-file-id]",
      "[data-url]",
      "[data-href]",
      "[data-src]",
      "[data-file-url]",
      "[data-download-url]",
      "[data-content-url]"
    ].join(",");
    const elements = Array.from(root.querySelectorAll(selector));
    const candidates = new Set();

    elements.forEach((element) => {
      if (isInsideExtensionUi(element) || !isRenderedElement(element)) {
        return;
      }

      const container = findPdfAttachmentContainer(element);
      if (container) {
        candidates.add(container);
      }
      candidates.add(element);
    });

    return Array.from(candidates);
  }

  function findPdfAttachmentContainer(element) {
    let node = element;
    for (let depth = 0; node && depth < 5; depth += 1) {
      if (isInsideExtensionUi(node)) {
        return null;
      }

      const directLabel = getPdfElementDirectLabel(node);
      const compactText = cleanText(node.textContent).slice(0, 320);
      const isCompact = cleanText(node.textContent).length <= 320;
      const isAttachmentLike = /file|attachment|document|pdf/i.test([
        node.getAttribute("data-testid"),
        node.getAttribute("role"),
        node.className
      ].filter(Boolean).join(" "));

      if (isLikelyPdfText(directLabel) || (isAttachmentLike && isCompact && isLikelyPdfText(`${directLabel} ${compactText}`))) {
        return node;
      }

      node = node.parentElement;
    }

    return element;
  }

  function createPdfAttachment(element) {
    const sourceUrls = collectPdfSourceUrls(element);
    const href = sourceUrls[0] || "";
    const fetchUrl = sourceUrls.map((url) => getFetchablePdfUrl(url)).find(Boolean) || "";
    const label = getPdfElementLabel(element, sourceUrls);

    if (!isLikelyPdfText(`${label} ${sourceUrls.join(" ")}`)) {
      return null;
    }

    return {
      key: fetchUrl || href || getPdfElementStableKey(element, label),
      name: extractPdfName(label, href),
      href,
      fetchUrl
    };
  }

  function getPdfElementLabel(element, sourceUrls = []) {
    const pieces = [
      getPdfElementDirectLabel(element),
      element.textContent,
      ...sourceUrls
    ];

    collectAttributeStrings(element).forEach((value) => {
      if (/\.pdf|application\/pdf|pdf document/i.test(value)) {
        pieces.push(value);
      }
    });

    return cleanText(pieces.filter(Boolean).join(" "));
  }

  function getPdfElementDirectLabel(element) {
    const pieces = [
      element.getAttribute("aria-label"),
      element.getAttribute("title"),
      element.getAttribute("download"),
      element.getAttribute("type"),
      element.getAttribute("data-testid"),
      element.getAttribute("data-file-name"),
      element.getAttribute("data-filename"),
      element.getAttribute("data-name")
    ];

    collectAttributeStrings(element).forEach((value) => {
      if (/\.pdf|application\/pdf|pdf document/i.test(value)) {
        pieces.push(value);
      }
    });

    return cleanText(pieces.filter(Boolean).join(" "));
  }

  function collectPdfSourceUrls(element) {
    const urls = [];
    const nodes = [element, ...Array.from(element.querySelectorAll ? element.querySelectorAll("[href],[src],[data],[download],[type],[aria-label],[title],[data-testid],[data-file-name],[data-filename],[data-name]") : [])];

    nodes.slice(0, 80).forEach((node) => {
      collectAttributeStrings(node, { includeDescendants: false }).forEach((value) => {
        extractUrlLikeValues(value).forEach((url) => urls.push(url));
      });
    });

    return dedupeStrings(urls)
      .map((url) => normalizePdfSourceUrl(url))
      .filter(Boolean);
  }

  function collectAttributeStrings(element) {
    const values = [];
    if (!element || !element.attributes) {
      return values;
    }

    Array.from(element.attributes).forEach((attribute) => {
      const name = attribute.name || "";
      const value = attribute.value || "";
      if (!value) {
        return;
      }

      if (/^(href|src|data|download|type|title|aria-label|data-)/i.test(name)) {
        values.push(value);
        collectJsonStringValues(value).forEach((nestedValue) => values.push(nestedValue));
      }
    });

    return values;
  }

  function collectJsonStringValues(value) {
    const trimmed = String(value || "").trim();
    if (!trimmed || !/^[{[]/.test(trimmed)) {
      return [];
    }

    try {
      const parsed = JSON.parse(trimmed);
      const results = [];
      const visit = (item, depth) => {
        if (depth > 4 || item == null) {
          return;
        }

        if (typeof item === "string") {
          results.push(item);
          return;
        }

        if (Array.isArray(item)) {
          item.forEach((entry) => visit(entry, depth + 1));
          return;
        }

        if (typeof item === "object") {
          Object.keys(item).forEach((key) => visit(item[key], depth + 1));
        }
      };

      visit(parsed, 0);
      return results;
    } catch (error) {
      return [];
    }
  }

  function extractUrlLikeValues(value) {
    const text = String(value || "");
    const urls = [];
    const urlPattern = /(https?:\/\/[^\s"'<>]+|blob:[^\s"'<>]+|data:application\/pdf[^ "'<>]+|\/[^\s"'<>]+(?:\.pdf|\/files?\/|\/attachments?\/)[^\s"'<>]*)/gi;
    let match = urlPattern.exec(text);

    while (match) {
      urls.push(match[1].replace(/[),.;\]]+$/g, ""));
      match = urlPattern.exec(text);
    }

    return urls;
  }

  function normalizePdfSourceUrl(value) {
    if (!value) {
      return "";
    }

    try {
      return new URL(value, location.href).href;
    } catch (error) {
      return "";
    }
  }

  function isLikelyPdfText(text) {
    return /\.pdf(?:$|[?#\s])|pdf document|application\/pdf|attached pdf|pdf file|\u9644\u4ef6.*pdf|pdf.*\u9644\u4ef6/i.test(String(text || ""));
  }

  function getPdfElementStableKey(element, label) {
    const dataId = element.getAttribute("data-file-id") || element.getAttribute("data-id") || "";
    if (dataId) {
      return dataId;
    }

    return cleanText(label).slice(0, 160);
  }

  function extractPdfName(label, href) {
    const source = cleanText(label) || href || "PDF file";
    const match = source.match(/[^/\\?#\s]+\.pdf/i);
    return match ? match[0] : "PDF file";
  }

  function getFetchablePdfUrl(href) {
    if (!href) {
      return "";
    }

    try {
      const url = new URL(href, location.href);
      if (url.protocol === "blob:" || url.protocol === "data:" || url.origin === location.origin || isOpenAiFileHost(url.hostname)) {
        return url.href;
      }
    } catch (error) {
      return "";
    }

    return "";
  }

  function isOpenAiFileHost(hostname) {
    return /(^|\.)oaiusercontent\.com$/i.test(hostname || "");
  }

  async function estimatePdfAttachments(pdfs, contextWindow) {
    const summary = {
      analyzedPdfCount: 0,
      inaccessiblePdfCount: 0,
      pdfPages: 0,
      pdfTextTokens: 0,
      pdfImageTokens: 0,
      pdfImagePages: 0,
      pdfScannedLikePages: 0,
      countedAttachments: [],
      missingAttachments: []
    };
    const analyzer = globalThis.ChatGPTCleanerPdfAnalyzer;

    for (const pdf of pdfs.slice(0, PDF_AUTO_ANALYSIS_LIMIT)) {
      if (!pdf.fetchUrl || !analyzer || typeof analyzer.analyzeArrayBuffer !== "function") {
        summary.inaccessiblePdfCount += 1;
        summary.missingAttachments.push(createMissingPdfAttachment(pdf, !pdf.fetchUrl
          ? "File content is not available to the browser."
          : "Local PDF analyzer is not available."));
        continue;
      }

      try {
        const arrayBuffer = await fetchPdfArrayBuffer(pdf.fetchUrl);
        const result = await analyzer.analyzeArrayBuffer(arrayBuffer, {
          fileName: pdf.name,
          fileSize: arrayBuffer.byteLength,
          contextWindow
        });
        summary.analyzedPdfCount += 1;
        summary.pdfPages += Number(result.pages || 0);
        summary.pdfTextTokens += Number(result.textTokens || 0);
        summary.pdfImageTokens += Number(result.estimatedImageTokens || 0);
        summary.pdfImagePages += Number(result.imagePages || 0);
        summary.pdfScannedLikePages += Number(result.scannedLikePages || 0);
        summary.countedAttachments.push(createCountedPdfAttachment(pdf, result));
      } catch (error) {
        summary.inaccessiblePdfCount += 1;
        summary.missingAttachments.push(createMissingPdfAttachment(pdf, error.message || "PDF could not be analyzed."));
        logMessage(`PDF estimate failed for ${pdf.name}: ${error.message}`);
      }
    }

    if (pdfs.length > PDF_AUTO_ANALYSIS_LIMIT) {
      summary.inaccessiblePdfCount += pdfs.length - PDF_AUTO_ANALYSIS_LIMIT;
      pdfs.slice(PDF_AUTO_ANALYSIS_LIMIT).forEach((pdf) => {
        summary.missingAttachments.push(createMissingPdfAttachment(pdf, "Skipped by the automatic PDF analysis limit."));
      });
    }

    return summary;
  }

  function createCountedPdfAttachment(pdf, result) {
    const textTokens = Number(result.textTokens || 0);
    const imageTokens = Number(result.estimatedImageTokens || 0);
    return {
      kind: "pdf",
      key: pdf.key,
      name: result.fileName || pdf.name || "PDF file",
      source: "Browser-accessible PDF",
      status: "Counted",
      tokens: textTokens + imageTokens,
      textTokens,
      imageTokens,
      pages: Number(result.pages || 0),
      imagePages: Number(result.imagePages || 0),
      scannedLikePages: Number(result.scannedLikePages || 0)
    };
  }

  function createMissingPdfAttachment(pdf, reason) {
    return {
      kind: "pdf",
      key: pdf.key,
      name: pdf.name || "PDF file",
      source: "Unavailable PDF",
      status: "Not counted",
      reason: reason || "File content is not available to the browser.",
      tokens: 0
    };
  }

  async function fetchPdfArrayBuffer(url) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), PDF_FETCH_TIMEOUT_MS);

    try {
      const parsedUrl = new URL(url, location.href);
      const fetchOptions = { signal: controller.signal };
      if (parsedUrl.protocol === "http:" || parsedUrl.protocol === "https:") {
        fetchOptions.credentials = "include";
      }

      const response = await fetch(parsedUrl.href, fetchOptions);
      if (!response.ok) {
        throw new Error(`PDF fetch failed with ${response.status}`);
      }

      const length = Number(response.headers.get("content-length") || 0);
      if (length > PDF_AUTO_ANALYSIS_LIMIT_BYTES) {
        throw new Error("PDF is larger than the 20 MB auto-analysis limit.");
      }

      const arrayBuffer = await response.arrayBuffer();
      if (arrayBuffer.byteLength > PDF_AUTO_ANALYSIS_LIMIT_BYTES) {
        throw new Error("PDF is larger than the 20 MB auto-analysis limit.");
      }

      return arrayBuffer;
    } finally {
      window.clearTimeout(timeout);
    }
  }

  async function collectConversationMessagesForEstimate() {
    const scrollTarget = findConversationScrollTarget();
    const originalPosition = getScrollPosition(scrollTarget);
    const messageMap = new Map();
    const scanInfo = {
      target: describeScrollTarget(scrollTarget),
      steps: 0,
      scrollMax: getScrollMax(scrollTarget)
    };

    collectCurrentMessages(messageMap);

    if (!scrollTarget || getScrollMax(scrollTarget) <= 0) {
      return {
        messages: Array.from(messageMap.values()),
        scanInfo
      };
    }

    try {
      await setScrollPosition(scrollTarget, 0);
      scanInfo.steps += 1;
      scanInfo.scrollMax = Math.max(scanInfo.scrollMax, getScrollMax(scrollTarget));
      collectCurrentMessages(messageMap);

      const maxSteps = getMaxScanSteps(scrollTarget);
      for (let step = 0; step < maxSteps; step += 1) {
        const currentPosition = getScrollPosition(scrollTarget);
        const maxScroll = getScrollMax(scrollTarget);
        scanInfo.scrollMax = Math.max(scanInfo.scrollMax, maxScroll);

        if (currentPosition >= maxScroll - 4) {
          break;
        }

        const nextPosition = Math.min(currentPosition + getScrollPageSize(scrollTarget), maxScroll);
        if (Math.abs(nextPosition - currentPosition) < 2) {
          break;
        }

        await setScrollPosition(scrollTarget, nextPosition);
        scanInfo.steps += 1;
        collectCurrentMessages(messageMap);
      }
    } finally {
      await setScrollPosition(scrollTarget, originalPosition);
    }

    return {
      messages: Array.from(messageMap.values()),
      scanInfo
    };
  }

  function collectCurrentMessages(messageMap) {
    getVisibleMessages().forEach((message) => {
      const key = cleanText(message.text).slice(0, 500);
      if (key && !messageMap.has(key)) {
        messageMap.set(key, message);
      }
    });
  }

  function findConversationScrollTarget() {
    const main = document.querySelector("main") || document.body;
    const currentMessages = Array.from(main.querySelectorAll(getMessageCandidateSelector()))
      .filter((element) => !isInsideExtensionUi(element) && isRenderedElement(element));
    const candidates = collectScrollCandidates(main, currentMessages);
    let best = null;
    let bestScore = -1;

    candidates.forEach((candidate) => {
      const score = scoreScrollCandidate(candidate, currentMessages, main);
      if (score > bestScore) {
        best = candidate;
        bestScore = score;
      }
    });

    return best || document.scrollingElement || document.documentElement;
  }

  function collectScrollCandidates(main, messages) {
    const candidates = new Set([
      document.scrollingElement,
      document.documentElement,
      document.body,
      main
    ].filter(Boolean));

    let node = main;
    while (node && node !== document.body && candidates.size < 8) {
      candidates.add(node);
      node = node.parentElement;
    }

    messages.slice(0, 80).forEach((message) => {
      let ancestor = message;
      for (let depth = 0; ancestor && depth < 12; depth += 1) {
        candidates.add(ancestor);
        ancestor = ancestor.parentElement;
      }
    });

    Array.from(main.querySelectorAll("*")).forEach((element) => {
      if (isPotentialScrollTarget(element)) {
        candidates.add(element);
      }
    });

    return Array.from(candidates).filter(Boolean);
  }

  function isPotentialScrollTarget(element) {
    if (!element || !(element instanceof Element) || isInsideExtensionUi(element)) {
      return false;
    }

    if (getScrollMax(element) < 80) {
      return false;
    }

    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function scoreScrollCandidate(candidate, messages, main) {
    const maxScroll = getScrollMax(candidate);
    if (!candidate || maxScroll < 80) {
      return -1;
    }

    const containsMessages = messages.filter((message) => candidate === message || candidate.contains(message)).length;
    const containsMain = candidate === main || candidate.contains(main) || main.contains(candidate);
    if (!containsMessages && !containsMain) {
      return -1;
    }

    const isDocumentScroller = candidate === document.scrollingElement ||
      candidate === document.documentElement ||
      candidate === document.body;
    const style = isDocumentScroller ? null : window.getComputedStyle(candidate);
    const overflowText = style ? `${style.overflowY} ${style.overflow}` : "auto";
    const overflowBonus = /(auto|scroll|overlay)/i.test(overflowText) ? 1000 : 0;
    const rect = getScrollTargetRect(candidate);
    const viewportOverlap = Math.max(0, Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0));
    const sizeBonus = Math.min(800, viewportOverlap);

    // Prefer the actual message scroll container over document/body when both
    // technically contain the same messages.
    const documentPenalty = isDocumentScroller ? 250 : 0;
    return (containsMessages * 10000) + overflowBonus + sizeBonus + Math.min(maxScroll, 50000) / 10 - documentPenalty;
  }

  function getScrollTargetRect(target) {
    if (!target || target === document.scrollingElement || target === document.documentElement || target === document.body) {
      return {
        top: 0,
        bottom: window.innerHeight,
        height: window.innerHeight
      };
    }

    return target.getBoundingClientRect();
  }

  function describeScrollTarget(target) {
    if (!target) {
      return "none";
    }

    if (target === document.scrollingElement || target === document.documentElement || target === document.body) {
      return "document";
    }

    const tag = target.tagName ? target.tagName.toLowerCase() : "element";
    const role = target.getAttribute("role");
    const testId = target.getAttribute("data-testid");
    const label = target.getAttribute("aria-label");
    const pieces = [tag, role && `[role="${role}"]`, testId && `[data-testid="${testId}"]`, label && `[aria-label="${label}"]`];
    return pieces.filter(Boolean).join("");
  }

  function getMaxScanSteps(target) {
    const maxScroll = getScrollMax(target);
    const pageSize = getScrollPageSize(target);
    return Math.min(140, Math.max(12, Math.ceil(maxScroll / Math.max(pageSize, 320)) + 4));
  }

  function getScrollPosition(target) {
    if (!target || target === document.scrollingElement || target === document.documentElement || target === document.body) {
      return window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0;
    }

    return target.scrollTop || 0;
  }

  function getScrollMax(target) {
    if (!target || target === document.scrollingElement || target === document.documentElement || target === document.body) {
      const root = document.scrollingElement || document.documentElement;
      return Math.max(0, root.scrollHeight - window.innerHeight);
    }

    return Math.max(0, target.scrollHeight - target.clientHeight);
  }

  function getScrollPageSize(target) {
    if (!target || target === document.scrollingElement || target === document.documentElement || target === document.body) {
      return Math.max(320, Math.floor(window.innerHeight * 0.85));
    }

    return Math.max(320, Math.floor(target.clientHeight * 0.85));
  }

  async function setScrollPosition(target, position) {
    if (!target || target === document.scrollingElement || target === document.documentElement || target === document.body) {
      window.scrollTo({ top: position, behavior: "auto" });
      window.dispatchEvent(new Event("scroll"));
    } else {
      target.scrollTop = position;
      target.dispatchEvent(new Event("scroll", { bubbles: true }));
    }

    await sleep(240);
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
      .map((element) => ({
        text: extractReadableText(element),
        role: getMessageRole(element)
      }))
      .filter((message) => Boolean(message.text));
  }

  function getMessageCandidateSelector() {
    return [
      "[data-message-author-role]",
      '[data-testid^="conversation-turn"]',
      "article",
      ".markdown, [class*='markdown']"
    ].join(",");
  }

  function getMessageRole(element) {
    const explicitRole = cleanText(element.getAttribute("data-message-author-role")).toLowerCase();
    if (explicitRole === "user" || explicitRole === "assistant") {
      return explicitRole;
    }

    const label = cleanText([
      element.getAttribute("aria-label"),
      element.getAttribute("data-testid"),
      element.getAttribute("class")
    ].filter(Boolean).join(" ")).toLowerCase();

    if (/(assistant|chatgpt|gpt|model)/i.test(label)) {
      return "assistant";
    }

    if (/(user|you|human)/i.test(label)) {
      return "user";
    }

    return "other";
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
    if (!source) {
      return {
        tokens: 0,
        tokenizerUsed: false,
        cjkCharacters: 0,
        chineseCharacters: 0,
        japaneseCharacters: 0,
        koreanCharacters: 0,
        codeCharacters: 0,
        urlJsonCharacters: 0,
        emojiCount: 0,
        nonCjkCharacters: 0,
        englishWordCount: 0,
        numberCount: 0,
        urlCount: 0,
        punctuationCount: 0,
        tokenizerError: "",
        method: "empty"
      };
    }

    const fallback = estimateTokensFallback(source, options);
    const tokenizerEstimate = estimateTokensWithLocalTokenizer(source);
    if (tokenizerEstimate.ok) {
      return Object.assign({}, fallback, {
        tokens: tokenizerEstimate.tokens,
        tokenizerUsed: true,
        tokenizerError: "",
        method: "gpt-tokenizer-local"
      });
    }

    return Object.assign({}, fallback, {
      tokenizerUsed: false,
      tokenizerError: tokenizerEstimate.error,
      method: "local-fallback"
    });
  }

  function estimateTokensWithLocalTokenizer(text) {
    try {
      const tokenizer = globalThis.ChatGPTCleanerTokenizer;
      if (!tokenizer || typeof tokenizer.count !== "function") {
        return {
          ok: false,
          error: "Local gpt-tokenizer is not loaded."
        };
      }

      const tokens = Number(tokenizer.count(text));
      if (!Number.isFinite(tokens) || tokens < 0) {
        return {
          ok: false,
          error: "Local gpt-tokenizer returned an invalid count."
        };
      }

      return {
        ok: true,
        tokens
      };
    } catch (error) {
      return {
        ok: false,
        error: error && error.message ? error.message : String(error)
      };
    }
  }

  function estimateTokensFallback(text, options = {}) {
    const source = String(text || "");
    const messageCount = Math.max(0, Number(options.messageCount || 0));
    const urlRegex = /(?:https?:\/\/|www\.)[^\s<>"']+/gi;
    const emojiRegex = /\p{Extended_Pictographic}/gu;
    const chineseRegex = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/g;
    const japaneseRegex = /[\u3040-\u30FF\u31F0-\u31FF]/g;
    const koreanRegex = /[\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F]/g;
    const englishWordRegex = /[A-Za-zÀ-ÖØ-öø-ÿ]+(?:['-][A-Za-zÀ-ÖØ-öø-ÿ]+)?/g;
    const numberRegex = /\b\d+(?:[.,:/-]\d+)*\b/g;
    const punctuationRegex = /[^\sA-Za-zÀ-ÖØ-öø-ÿ0-9\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF\u31F0-\u31FF\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F]/g;
    const lines = source.split(/\n+/);
    let chineseCharacters = 0;
    let japaneseCharacters = 0;
    let koreanCharacters = 0;
    let codeCharacters = 0;
    let urlJsonCharacters = 0;
    let emojiCount = 0;
    let latinLikeCharacters = 0;
    let urlCount = 0;
    let numberCount = 0;
    let punctuationCount = 0;
    let estimated = 0;

    lines.forEach((line) => {
      const sourceLine = String(line || "");
      if (!sourceLine) {
        return;
      }

      const urls = sourceLine.match(urlRegex) || [];
      urlCount += urls.length;
      urlJsonCharacters += sum(urls.map((url) => url.length));
      estimated += sum(urls.map((url) => url.length / 2.5));

      let remainder = sourceLine.replace(urlRegex, " ");
      if (isJsonLikeText(remainder)) {
        const jsonLength = cleanText(remainder).length;
        urlJsonCharacters += jsonLength;
        estimated += jsonLength / 2.5;
        return;
      }

      if (isCodeLikeText(remainder)) {
        const codeLength = cleanText(remainder).length;
        codeCharacters += codeLength;
        estimated += codeLength / 3;
        return;
      }

      const emojiMatches = remainder.match(emojiRegex) || [];
      emojiCount += emojiMatches.length;
      estimated += emojiMatches.length * 3;
      remainder = remainder.replace(emojiRegex, " ");

      const chineseMatches = remainder.match(chineseRegex) || [];
      chineseCharacters += chineseMatches.length;
      estimated += chineseMatches.length / 1.5;
      remainder = remainder.replace(chineseRegex, " ");

      const japaneseMatches = remainder.match(japaneseRegex) || [];
      japaneseCharacters += japaneseMatches.length;
      estimated += japaneseMatches.length / 1.2;
      remainder = remainder.replace(japaneseRegex, " ");

      const koreanMatches = remainder.match(koreanRegex) || [];
      koreanCharacters += koreanMatches.length;
      estimated += koreanMatches.length / 1.3;
      remainder = remainder.replace(koreanRegex, " ");

      const numbers = remainder.match(numberRegex) || [];
      numberCount += numbers.length;
      const punctuation = remainder.match(punctuationRegex) || [];
      punctuationCount += punctuation.length;
      const latinText = cleanText(remainder);
      latinLikeCharacters += latinText.length;
      estimated += latinText.length / 4;
    });

    const englishWords = source.match(englishWordRegex) || [];
    const cjkCharacters = chineseCharacters + japaneseCharacters + koreanCharacters;
    const nonCjkCharacters = Math.max(source.length - cjkCharacters, 0);

    return {
      tokens: Math.ceil(estimated),
      cjkCharacters,
      chineseCharacters,
      japaneseCharacters,
      koreanCharacters,
      codeCharacters,
      urlJsonCharacters,
      emojiCount,
      nonCjkCharacters,
      englishWordCount: englishWords.length,
      numberCount,
      urlCount,
      punctuationCount,
      messageCount,
      tokenizerUsed: false,
      tokenizerError: "",
      method: "local-fallback"
    };
  }

  function isJsonLikeText(text) {
    const value = cleanText(text);
    if (value.length < 8) {
      return false;
    }

    return /^[\[{]/.test(value) &&
      /[\]}]$/.test(value) &&
      /["']?[A-Za-z0-9_-]+["']?\s*:/.test(value);
  }

  function isCodeLikeText(text) {
    const value = cleanText(text);
    if (value.length < 8) {
      return false;
    }

    const syntaxHits = (value.match(/[{}()[\];=<>]|=>|::|\.\w+\(/g) || []).length;
    const keywordHit = /\b(function|const|let|var|return|class|import|export|if|else|for|while|try|catch|def|print|public|private|SELECT|FROM|WHERE)\b/.test(value);
    return keywordHit || syntaxHits >= 3;
  }

  function sum(values) {
    return values.reduce((total, value) => total + value, 0);
  }

  function getCurrentConversationKey() {
    const match = location.pathname.match(/\/c\/([^/?#]+)/);
    return match ? `/c/${match[1]}` : location.pathname || location.href;
  }

  function getStatus() {
    const visible = state.isActivated ? getConversationLinks().length : 0;
    return {
      activated: state.isActivated,
      extensionEnabled: isExtensionEnabled(),
      isDeleting: state.isDeleting,
      selected: state.selectedConversationKeys.size,
      visible,
      conversationKey: getCurrentConversationKey(),
      conversationUrl: location.href,
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
      setExtensionEnabled: (enabled) => applyExtensionSettings({ extensionEnabled: enabled !== false }),
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
