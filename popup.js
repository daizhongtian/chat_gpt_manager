(function () {
  "use strict";

  const USAGE_STORAGE_KEY = "ccmUsageStats";
  const SETTINGS_STORAGE_KEY = "ccmSettings";
  const LOCAL_PDF_STORAGE_KEY = "ccmLocalPdfEstimates";
  const LOCAL_PDF_LIMIT_BYTES = 20 * 1024 * 1024;
  const elements = {};
  let activeEstimate = null;
  let localPdfEstimates = [];
  let pendingMissingAttachment = null;
  let activeLocalPdfStorageKey = "";
  let currentLanguagePreference = "auto";
  let currentLanguage = "en";
  let lastStatus = null;
  let lastUsageStats = null;

  document.addEventListener("DOMContentLoaded", async () => {
    cacheElements();
    populateLanguageOptions();
    bindEvents();
    await loadSettings();
    refreshStatus();
    refreshUsageStats();
  });

  function cacheElements() {
    elements.language = byId("language-select");
    elements.extensionEnabled = byId("extension-enabled");
    elements.select = byId("select-conversations");
    elements.deselect = byId("deselect-all");
    elements.deleteSelected = byId("delete-selected");
    elements.refresh = byId("refresh-list");
    elements.estimate = byId("estimate-context");
    elements.contextEstimateEnabled = byId("context-estimate-enabled");
    elements.contextWindow = byId("context-window");
    elements.status = byId("conversation-status");
    elements.estimateOutput = byId("estimate-output");
    elements.localPdfInput = byId("local-pdf-input");
    elements.currentModel = byId("current-model");
    elements.refreshUsage = byId("refresh-usage");
    elements.resetUsage = byId("reset-usage");
    elements.usageOutput = byId("usage-output");
  }

  function bindEvents() {
    elements.language.addEventListener("change", saveLanguageSetting);
    elements.extensionEnabled.addEventListener("change", saveExtensionEnabledSetting);
    elements.select.addEventListener("click", () => runAction("CCM_SELECT_CONVERSATIONS"));
    elements.deselect.addEventListener("click", () => runAction("CCM_DESELECT_ALL"));
    elements.deleteSelected.addEventListener("click", () => runAction("CCM_DELETE_SELECTED"));
    elements.refresh.addEventListener("click", () => runAction("CCM_REFRESH_LIST"));
    elements.estimate.addEventListener("click", estimateContext);
    elements.estimateOutput.addEventListener("click", handleEstimateOutputClick);
    elements.localPdfInput.addEventListener("change", handleLocalPdfSelection);
    elements.contextEstimateEnabled.addEventListener("change", saveContextEstimateSetting);
    elements.refreshUsage.addEventListener("click", refreshUsageStats);
    elements.resetUsage.addEventListener("click", resetUsageStats);
    bindUsageStorageRefresh();
  }

  function populateLanguageOptions() {
    const i18n = getI18n();
    if (i18n && typeof i18n.populateLanguageSelect === "function") {
      i18n.populateLanguageSelect(elements.language, currentLanguagePreference);
    }
  }

  async function refreshStatus() {
    try {
      const response = await sendToActiveTab({ type: "CCM_GET_STATUS" });
      renderStatus(response.status);
    } catch (error) {
      setStatus(isExtensionEnabled()
        ? t("openRefreshChatgpt")
        : t("extensionDisabledControls"));
    }
  }

  async function loadSettings() {
    try {
      const settings = await readSettings();
      setLanguagePreference(settings.language || "auto");
      elements.extensionEnabled.checked = settings.extensionEnabled !== false;
      elements.contextEstimateEnabled.checked = settings.contextEstimateEnabled !== false;
    } catch (error) {
      setLanguagePreference("auto");
      elements.extensionEnabled.checked = true;
      elements.contextEstimateEnabled.checked = true;
    }

    applyExtensionAvailability(false);
    applyContextEstimateAvailability(false);
    if (!isExtensionEnabled()) {
      setStatus(t("extensionDisabledControls"));
    }
  }

  async function saveLanguageSetting() {
    const language = getLanguagePreferenceFromSelect();
    setLanguagePreference(language);

    try {
      const settings = await readSettings();
      settings.language = language;
      await writeSettings(settings);
    } catch (error) {
      // Local file smoke tests do not provide chrome.storage.
    }

    try {
      await sendToActiveTab({
        type: "CCM_SET_LANGUAGE",
        language
      });
    } catch (error) {
      // The content script will also pick this up through chrome.storage.
    }

    if (lastStatus) {
      renderStatus(lastStatus);
    } else {
      setStatus(t("languageUpdated"));
    }
    if (activeEstimate) {
      renderEstimate(activeEstimate);
    }
    if (lastUsageStats) {
      renderUsageStats(lastUsageStats);
    }
  }

  async function runAction(type) {
    if (!isExtensionEnabled()) {
      setStatus(t("extensionIsDisabledControls"));
      return;
    }

    setBusy(true);
    try {
      const response = await sendToActiveTab({ type });
      if (response.message) {
        setStatus(response.message);
      }
      renderStatus(response.status);
    } catch (error) {
      setStatus(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function estimateContext() {
    if (!isExtensionEnabled()) {
      elements.estimateOutput.innerHTML = `<div class="warning">${escapeHtml(t("extensionDisabledShort"))}</div>`;
      setStatus(t("extensionIsDisabledEstimate"));
      return;
    }

    if (!isContextEstimateEnabled()) {
      elements.estimateOutput.innerHTML = `<div class="warning">${escapeHtml(t("contextEstimateOff"))}</div>`;
      return;
    }

    setBusy(true);
    elements.estimateOutput.textContent = t("scanningContext");

    try {
      const selectedContextWindow = Number(elements.contextWindow.value || 128000);
      const response = await sendToActiveTab({
        type: "CCM_ESTIMATE_CONTEXT",
        contextWindow: selectedContextWindow
      });
      activeEstimate = response.estimate;
      activeLocalPdfStorageKey = getEstimateStorageKey(activeEstimate);
      localPdfEstimates = await readLocalPdfEstimates(activeLocalPdfStorageKey);
      pendingMissingAttachment = null;
      renderStatus(response.status);
      renderEstimate(activeEstimate);
    } catch (error) {
      elements.estimateOutput.innerHTML = `<div class="warning">${escapeHtml(error.message)}</div>`;
      setStatus(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function saveContextEstimateSetting() {
    const enabled = isContextEstimateEnabled();
    applyExtensionAvailability(false);
    applyContextEstimateAvailability(false);

    if (!enabled) {
      elements.estimateOutput.innerHTML = `<div class="warning">${escapeHtml(t("contextEstimateOff"))}</div>`;
    }

    try {
      const settings = await readSettings();
      settings.contextEstimateEnabled = enabled;
      await writeSettings(settings);
    } catch (error) {
      // Local file smoke tests do not provide chrome.storage.
    }
  }

  async function saveExtensionEnabledSetting() {
    const enabled = isExtensionEnabled();
    applyExtensionAvailability(true);
    applyContextEstimateAvailability(true);

    try {
      const settings = await readSettings();
      settings.extensionEnabled = enabled;
      await writeSettings(settings);

      try {
        const response = await sendToActiveTab({
          type: "CCM_SET_EXTENSION_ENABLED",
          enabled
        });
        renderStatus(response.status);
      } catch (error) {
        setStatus(enabled ? t("extensionEnabledOpenRefresh") : t("extensionDisabledShort"));
      }
    } finally {
      applyExtensionAvailability(false);
      applyContextEstimateAvailability(false);
      if (!enabled) {
        elements.estimateOutput.innerHTML = `<div class="warning">${escapeHtml(t("extensionDisabledShort"))}</div>`;
        setStatus(t("extensionDisabledShort"));
      }
    }
  }

  function handleEstimateOutputClick(event) {
    const batchButton = event.target.closest("[data-action='add-local-pdfs']");
    if (!batchButton) {
      return;
    }

    pendingMissingAttachment = null;
    elements.localPdfInput.value = "";
    elements.localPdfInput.click();
  }

  async function handleLocalPdfSelection(event) {
    const files = Array.from(event.target.files || []).filter(Boolean);
    if (!files.length) {
      return;
    }

    if (!activeEstimate) {
      elements.estimateOutput.innerHTML = `<div class="warning">${escapeHtml(t("runEstimateBeforePdf"))}</div>`;
      return;
    }

    const analyzer = globalThis.ChatGPTCleanerPdfAnalyzer;
    if (!analyzer || typeof analyzer.analyzeFile !== "function") {
      elements.estimateOutput.insertAdjacentHTML("afterbegin", `<div class="warning">${escapeHtml(t("localPdfAnalyzerUnavailable"))}</div>`);
      return;
    }

    setBusy(true);
    const added = [];
    const failures = [];
    const oneFilePendingMatch = files.length === 1 ? pendingMissingAttachment : null;

    try {
      for (const file of files) {
        try {
          const localAttachment = await analyzeLocalPdfFile(file, oneFilePendingMatch);
          addOrReplaceLocalPdfEstimate(localAttachment);
          added.push(localAttachment);
        } catch (error) {
          failures.push(`${file.name}: ${error.message}`);
        }
      }

      if (added.length) {
        try {
          await writeLocalPdfEstimates(activeLocalPdfStorageKey || getEstimateStorageKey(activeEstimate), localPdfEstimates);
        } catch (error) {
          failures.push(t("couldNotSaveLocalPdfEstimates", { error: error.message }));
        }
      }
      renderEstimate(activeEstimate);
      if (added.length) {
        setStatus(t("addedLocalPdfEstimate", { count: formatNumber(added.length) }));
      }
      if (failures.length) {
        elements.estimateOutput.insertAdjacentHTML("afterbegin", `<div class="warning">${escapeHtml(failures.join(" "))}</div>`);
      }
    } finally {
      setBusy(false);
      pendingMissingAttachment = null;
      elements.localPdfInput.value = "";
    }
  }

  async function analyzeLocalPdfFile(file, matchedMissing) {
    if (!/\.pdf$/i.test(file.name || "") && file.type !== "application/pdf") {
      throw new Error(t("choosePdfFile"));
    }

    if (file.size > LOCAL_PDF_LIMIT_BYTES) {
      throw new Error(t("pdfTooLarge"));
    }

    const selectedContextWindow = Number(activeEstimate.selectedContextWindow || activeEstimate.contextWindow || elements.contextWindow.value || 128000);
    const result = await globalThis.ChatGPTCleanerPdfAnalyzer.analyzeFile(file, {
      contextWindow: selectedContextWindow
    });
    const textTokens = Number(result.textTokens || 0);
    const imageTokens = Number(result.estimatedImageTokens || 0);

    return {
      kind: "pdf",
      key: `local:${Date.now()}:${file.name}`,
      matchedMissingKey: matchedMissing && matchedMissing.key ? matchedMissing.key : findMissingAttachmentKeyByName(file.name),
      name: matchedMissing && matchedMissing.name ? matchedMissing.name : (result.fileName || file.name || "Local PDF"),
      source: t("localPdfUpload"),
      status: t("counted"),
      tokens: textTokens + imageTokens,
      textTokens,
      imageTokens,
      pages: Number(result.pages || 0),
      imagePages: Number(result.imagePages || 0),
      scannedLikePages: Number(result.scannedLikePages || 0),
      addedAt: new Date().toISOString()
    };
  }

  function addOrReplaceLocalPdfEstimate(localAttachment) {
    localPdfEstimates = localPdfEstimates.filter((existing) => {
      if (localAttachment.matchedMissingKey && existing.matchedMissingKey === localAttachment.matchedMissingKey) {
        return false;
      }

      return normalizeFileName(existing.name) !== normalizeFileName(localAttachment.name);
    });
    localPdfEstimates.push(localAttachment);
  }

  function findMissingAttachmentKeyByName(name) {
    const missing = normalizeAttachmentList(activeEstimate && activeEstimate.missingAttachments);
    const match = missing.find((attachment) => normalizeFileName(attachment.name) === normalizeFileName(name));
    return match ? match.key || "" : "";
  }

  function getEstimateStorageKey(estimate) {
    const key = estimate && (estimate.conversationKey || estimate.conversationUrl);
    return key ? String(key).slice(0, 240) : "unknown-conversation";
  }

  async function readLocalPdfEstimates(storageKey) {
    if (!storageKey || !globalThis.chrome || !chrome.storage || !chrome.storage.local) {
      return [];
    }

    return new Promise((resolve) => {
      chrome.storage.local.get([LOCAL_PDF_STORAGE_KEY], (items) => {
        const store = normalizeLocalPdfStore(items && items[LOCAL_PDF_STORAGE_KEY]);
        resolve(normalizeAttachmentList(store[storageKey]).map(normalizeLocalPdfEstimate).filter(Boolean));
      });
    });
  }

  async function writeLocalPdfEstimates(storageKey, estimates) {
    if (!storageKey || !globalThis.chrome || !chrome.storage || !chrome.storage.local) {
      return;
    }

    return new Promise((resolve, reject) => {
      chrome.storage.local.get([LOCAL_PDF_STORAGE_KEY], (items) => {
        const store = normalizeLocalPdfStore(items && items[LOCAL_PDF_STORAGE_KEY]);
        store[storageKey] = normalizeAttachmentList(estimates)
          .map(normalizeLocalPdfEstimate)
          .filter(Boolean)
          .slice(-40);

        chrome.storage.local.set({ [LOCAL_PDF_STORAGE_KEY]: store }, () => {
          const error = chrome.runtime && chrome.runtime.lastError;
          if (error) {
            reject(new Error(error.message));
            return;
          }
          resolve();
        });
      });
    });
  }

  function normalizeLocalPdfStore(raw) {
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  }

  function normalizeLocalPdfEstimate(raw) {
    if (!raw || typeof raw !== "object") {
      return null;
    }

    const tokens = Number(raw.tokens || 0);
    if (!Number.isFinite(tokens) || tokens <= 0) {
      return null;
    }

    return {
      kind: "pdf",
      key: String(raw.key || `local:${raw.name || "pdf"}`),
      matchedMissingKey: String(raw.matchedMissingKey || ""),
      name: String(raw.name || "Local PDF"),
      source: t("localPdfUpload"),
      status: t("counted"),
      tokens,
      textTokens: Number(raw.textTokens || 0),
      imageTokens: Number(raw.imageTokens || 0),
      pages: Number(raw.pages || 0),
      imagePages: Number(raw.imagePages || 0),
      scannedLikePages: Number(raw.scannedLikePages || 0),
      addedAt: raw.addedAt || null
    };
  }

  async function refreshUsageStats() {
    try {
      renderUsageStats(await readUsageStats());
    } catch (error) {
      elements.usageOutput.textContent = t("couldNotReadUsage");
    }
  }

  async function resetUsageStats() {
    if (!confirm(t("resetUsageConfirm"))) {
      return;
    }

    setBusy(true);
    try {
      const stats = createEmptyUsageStats();
      await writeUsageStats(stats);
      renderUsageStats(stats);
      setStatus(t("usageCountsReset"));
    } catch (error) {
      setStatus(t("couldNotResetUsage"));
    } finally {
      setBusy(false);
    }
  }

  async function sendToActiveTab(payload) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) {
      throw new Error(t("noActiveTab"));
    }

    try {
      const response = await chrome.tabs.sendMessage(tab.id, Object.assign({
        source: "ccm-popup"
      }, payload));

      if (!response || !response.ok) {
        throw new Error(response && response.error ? response.error : t("contentNoRespond"));
      }

      return response;
    } catch (error) {
      throw new Error(t("openRefreshBeforeUse"));
    }
  }

  function renderStatus(status) {
    if (!status) {
      return;
    }

    lastStatus = status;
    if (status.extensionEnabled === false) {
      elements.extensionEnabled.checked = false;
      applyExtensionAvailability(false);
      setStatus(t("extensionDisabledControls"));
      return;
    }

    const visibleText = status.activated
      ? t("selectedVisible", {
        selected: formatNumber(status.selected),
        visible: formatNumber(status.visible)
      })
      : t("controlsReady");

    setStatus(status.isDeleting ? t("deletingStatus", { text: visibleText }) : visibleText);
    if (status.currentModel) {
      elements.currentModel.textContent = status.currentModel === "Unknown model" ? t("autoTracking") : status.currentModel;
      elements.currentModel.title = status.currentModel;
    }
  }

  function renderEstimate(estimate) {
    if (!estimate) {
      return;
    }

    activeEstimate = estimate;
    const adjustedEstimate = applyLocalPdfEstimates(estimate);
    const percentage = Math.max(0, adjustedEstimate.percentage || 0);
    const estimatedVisibleTokens = Number(adjustedEstimate.estimatedVisibleTokens || adjustedEstimate.tokens || 0);
    const selectedContextWindow = Number(adjustedEstimate.selectedContextWindow || adjustedEstimate.contextWindow || 128000);
    const methodLabel = formatEstimatorMethod(adjustedEstimate);
    elements.estimateOutput.innerHTML = `
      <div class="metric"><span>${escapeHtml(t("estimatedScannedTokens"))}</span><strong>${formatNumber(estimatedVisibleTokens)}</strong></div>
      ${renderVisibleTextBlock(adjustedEstimate)}
      ${renderCountedAttachments(adjustedEstimate.countedAttachments)}
      ${renderMissingAttachments(adjustedEstimate.missingAttachments)}
      ${renderEstimateWarnings(adjustedEstimate)}
      <div class="metric"><span>${escapeHtml(t("estimator"))}</span><strong>${escapeHtml(methodLabel)}</strong></div>
      <div class="meter" aria-label="${escapeAttribute(t("approximateUsageAria"))}">
        <div class="meter-fill" style="width: ${Math.min(percentage, 100).toFixed(2)}%"></div>
      </div>
      <div class="warning">${escapeHtml(t("contextUsageWarning", {
        percentage: percentage.toFixed(2),
        window: formatNumber(selectedContextWindow)
      }))}</div>
    `;
  }

  function renderVisibleTextBlock(estimate) {
    const userMessages = Number(estimate.userMessages || 0);
    const assistantMessages = Number(estimate.assistantMessages || 0);
    const otherMessages = Number(estimate.otherMessages || 0);
    const userTextTokens = Number(estimate.userTextTokens || 0);
    const assistantTextTokens = Number(estimate.assistantTextTokens || 0);
    const otherTextTokens = Number(estimate.otherTextTokens || 0);
    const messageBreakdown = userMessages || assistantMessages || otherMessages
      ? ` (${formatNumber(userMessages)} ${t("user")} | ${formatNumber(assistantMessages)} ${t("gptOutput")}${otherMessages ? ` | ${formatNumber(otherMessages)} ${t("other")}` : ""})`
      : "";
    const tokenBreakdown = userTextTokens || assistantTextTokens || otherTextTokens
      ? `<span>${escapeHtml(t("userInput"))} ${formatNumber(userTextTokens)} tokens | ${escapeHtml(t("gptOutput"))} ${formatNumber(assistantTextTokens)} tokens${otherTextTokens ? ` | ${escapeHtml(t("otherTokens"))} ${formatNumber(otherTextTokens)} tokens` : ""}</span>`
      : "";
    const scanDetail = estimate.scanSteps
      ? `<span>${escapeHtml(t("scannedPositions", {
        steps: formatNumber(estimate.scanSteps),
        target: estimate.scanTarget || t("page")
      }))}</span>`
      : "";

    return `
      <div class="estimate-panel">
        <h3>${escapeHtml(t("scannedConversationText"))}</h3>
        <strong>${escapeHtml(t("estimatedTokens", { count: formatNumber(estimate.textTokens || 0) }))}</strong>
        <span>${escapeHtml(t("textStats", {
          characters: formatNumber(estimate.characters),
          messages: formatNumber(estimate.messages)
        }))}${escapeHtml(messageBreakdown)}</span>
        ${tokenBreakdown}
        ${scanDetail}
      </div>
    `;
  }

  function renderCountedAttachments(attachments) {
    const items = normalizeAttachmentList(attachments);
    if (!items.length) {
      return "";
    }

    return `
      <div class="estimate-panel">
        <h3>${escapeHtml(t("countedAttachments"))}</h3>
        ${renderCollapsibleAttachmentList(items, renderCountedAttachment)}
      </div>
    `;
  }

  function renderMissingAttachments(attachments) {
    const items = dedupeMissingAttachments(normalizeAttachmentList(attachments));
    if (!items.length) {
      return "";
    }

    return `
      <div class="estimate-panel">
        <div class="estimate-panel-heading">
          <h3>${escapeHtml(t("missingAttachments"))}</h3>
          <button type="button" class="small-button" data-action="add-local-pdfs">${escapeHtml(t("addLocalPdfs"))}</button>
        </div>
        ${renderCollapsibleAttachmentList(items, renderMissingAttachment)}
      </div>
    `;
  }

  function renderCollapsibleAttachmentList(items, renderItem) {
    const visibleItems = items.slice(0, 3);
    const hiddenItems = items.slice(3);

    return `
      <div class="attachment-list">
        ${visibleItems.map(renderItem).join("")}
      </div>
      ${hiddenItems.length ? `
        <details class="attachment-more">
          <summary>${escapeHtml(t("moreCount", { count: formatNumber(hiddenItems.length) }))}</summary>
          <div class="attachment-list">
            ${hiddenItems.map(renderItem).join("")}
          </div>
        </details>
      ` : ""}
    `;
  }

  function renderCountedAttachment(attachment) {
    return `
      <div class="attachment-item counted-attachment">
        <div>
          <strong>${escapeHtml(attachment.name || t("attachment"))}</strong>
          <span>${escapeHtml(t("source"))}: ${escapeHtml(attachment.source || t("visiblePageAttachment"))}</span>
          ${renderAttachmentDetails(attachment)}
        </div>
        <b>${escapeHtml(t("estimatedTokensShort", { count: formatNumber(attachment.tokens) }))}</b>
      </div>
    `;
  }

  function renderMissingAttachment(attachment) {
    return `
      <div class="attachment-item missing-attachment">
        <div>
          <strong>${escapeHtml(attachment.name || t("pdfFile"))}</strong>
          <span>${escapeHtml(t("status"))}: ${escapeHtml(attachment.status || t("notCounted"))}</span>
          <span>${escapeHtml(t("reason"))}: ${escapeHtml(attachment.reason || t("fileContentUnavailable"))}</span>
        </div>
      </div>
    `;
  }

  function renderAttachmentDetails(attachment) {
    const details = [];
    if (attachment.kind === "pdf") {
      details.push(t("textTokens", { count: formatNumber(attachment.textTokens || 0) }));
      if (Number(attachment.imageTokens || 0) > 0) {
        details.push(t("imageTokens", { count: formatNumber(attachment.imageTokens) }));
      }
      if (Number(attachment.pages || 0) > 0) {
        details.push(t("pages", { count: formatNumber(attachment.pages) }));
      }
    } else if (attachment.kind === "image" && attachment.width && attachment.height) {
      details.push(`${formatNumber(attachment.width)} x ${formatNumber(attachment.height)}`);
    }

    return details.length ? `<span>${escapeHtml(details.join(" | "))}</span>` : "";
  }

  function renderEstimateWarnings(estimate) {
    const rows = [];
    if (estimate.mediaTimedOut) {
      rows.push(`<div class="warning">${escapeHtml(t("mediaTimedOut"))}</div>`);
    }

    if (estimate.mediaError) {
      rows.push(`<div class="warning">${escapeHtml(t("mediaFailed", { error: estimate.mediaError }))}</div>`);
    }

    return rows.join("");
  }

  function applyLocalPdfEstimates(estimate) {
    const countedAttachments = normalizeAttachmentList(estimate.countedAttachments)
      .map((attachment) => Object.assign({}, attachment));
    let missingAttachments = normalizeAttachmentList(estimate.missingAttachments)
      .map((attachment) => Object.assign({}, attachment));

    localPdfEstimates.forEach((localAttachment) => {
      missingAttachments = missingAttachments.filter((missing) => !attachmentMatchesLocalPdf(missing, localAttachment));
      countedAttachments.push(localAttachment);
    });

    const attachmentTokens = countedAttachments.reduce((total, attachment) => total + Number(attachment.tokens || 0), 0);
    const textTokens = Number(estimate.textTokens || 0);
    const selectedContextWindow = Number(estimate.selectedContextWindow || estimate.contextWindow || 128000);
    const estimatedVisibleTokens = textTokens + attachmentTokens;

    return Object.assign({}, estimate, {
      countedAttachments,
      missingAttachments,
      countedAttachmentTokens: attachmentTokens,
      estimatedVisibleTokens,
      tokens: estimatedVisibleTokens,
      percentage: selectedContextWindow > 0 ? (estimatedVisibleTokens / selectedContextWindow) * 100 : 0
    });
  }

  function normalizeAttachmentList(attachments) {
    return Array.isArray(attachments) ? attachments.filter((attachment) => attachment && typeof attachment === "object") : [];
  }

  function dedupeMissingAttachments(attachments) {
    const seen = new Set();
    return attachments.filter((attachment) => {
      const key = normalizeFileName(attachment.name) || String(attachment.key || "");
      if (!key || seen.has(key)) {
        return false;
      }

      seen.add(key);
      return true;
    });
  }

  function attachmentMatchesLocalPdf(missing, localAttachment) {
    if (localAttachment.matchedMissingKey && missing.key === localAttachment.matchedMissingKey) {
      return true;
    }

    return normalizeFileName(missing.name) === normalizeFileName(localAttachment.name);
  }

  function normalizeFileName(name) {
    return String(name || "").trim().toLowerCase().replace(/\s+/g, " ");
  }

  function formatEstimatorMethod(estimate) {
    if (estimate && estimate.tokenizerUsed) {
      return t("gptTokenizerLocal");
    }

    return t("localFallback");
  }

  function isContextEstimateEnabled() {
    return Boolean(elements.contextEstimateEnabled && elements.contextEstimateEnabled.checked);
  }

  function isExtensionEnabled() {
    return Boolean(elements.extensionEnabled && elements.extensionEnabled.checked);
  }

  function applyExtensionAvailability(isBusy) {
    const enabled = isExtensionEnabled();
    [
      elements.select,
      elements.deselect,
      elements.deleteSelected,
      elements.refresh,
      elements.contextEstimateEnabled,
      elements.localPdfInput,
      elements.refreshUsage,
      elements.resetUsage
    ]
      .forEach((button) => {
        button.disabled = isBusy || !enabled;
      });
  }

  function applyContextEstimateAvailability(isBusy) {
    const enabled = isExtensionEnabled() && isContextEstimateEnabled();
    elements.contextWindow.disabled = isBusy || !enabled;
    elements.estimate.disabled = isBusy || !enabled;
  }

  function renderUsageStats(stats) {
    lastUsageStats = stats;
    const usage = normalizeUsageStats(stats);
    const categoryRows = [
      {
        label: "GPT",
        total: Number(usage.categories.GPT?.total || 0),
        title: t("regularGptSends")
      },
      {
        label: "GPT Pro",
        total: Number(usage.categories["GPT Pro"]?.total || 0),
        title: t("gptProSends")
      }
    ];
    const modelRows = Object.entries(usage.models)
      .map(([label, value]) => ({
        label,
        total: Number(value.total || 0),
        lastUsedAt: value.lastUsedAt || ""
      }))
      .filter((item) => item.total > 0)
      .sort((a, b) => b.total - a.total || a.label.localeCompare(b.label));

    elements.usageOutput.innerHTML = `
      <div class="metric"><span>${escapeHtml(t("trackedSends"))}</span><strong>${formatNumber(usage.total)}</strong></div>
      <div class="usage-list usage-categories">
        ${categoryRows.map((row) => `
          <div class="usage-row usage-category-row" title="${escapeHtml(row.title)}">
            <span>${escapeHtml(row.label)}</span>
            <strong>${formatNumber(row.total)}</strong>
          </div>
        `).join("")}
      </div>
      ${modelRows.length ? `
        <div class="usage-subtitle">${escapeHtml(t("modelDetails"))}</div>
        <div class="usage-list">
          ${modelRows.map((row) => `
            <div class="usage-row" title="${escapeHtml(row.label)}">
              <span>${escapeHtml(row.label)}</span>
              <strong>${formatNumber(row.total)}</strong>
            </div>
          `).join("")}
        </div>
      ` : `<div class="warning">${escapeHtml(t("noUsageYet"))}</div>`}
    `;
  }

  function setStatus(message) {
    elements.status.textContent = message;
  }

  function setBusy(isBusy) {
    applyExtensionAvailability(isBusy);
    applyContextEstimateAvailability(isBusy);
  }

  function bindUsageStorageRefresh() {
    if (!globalThis.chrome || !chrome.storage || !chrome.storage.onChanged) {
      return;
    }

    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "local" || !changes[USAGE_STORAGE_KEY]) {
        return;
      }

      renderUsageStats(changes[USAGE_STORAGE_KEY].newValue);
    });
  }

  function byId(id) {
    return document.getElementById(id);
  }

  function getI18n() {
    return globalThis.ChatGPTCleanerI18n || null;
  }

  function t(key, params = {}) {
    const i18n = getI18n();
    return i18n && typeof i18n.t === "function"
      ? i18n.t(key, params, currentLanguage)
      : key;
  }

  function setLanguagePreference(language) {
    const i18n = getI18n();
    currentLanguagePreference = i18n && typeof i18n.normalizeLanguage === "function"
      ? i18n.normalizeLanguage(language || "auto")
      : "en";
    currentLanguage = i18n && typeof i18n.resolveLanguage === "function"
      ? i18n.resolveLanguage(currentLanguagePreference)
      : currentLanguagePreference;

    if (elements.language) {
      elements.language.value = currentLanguagePreference;
    }

    document.documentElement.lang = currentLanguage;
    document.documentElement.dir = i18n && typeof i18n.getDirection === "function"
      ? i18n.getDirection(currentLanguage)
      : "ltr";
    applyStaticText();
  }

  function getLanguagePreferenceFromSelect() {
    return elements.language && elements.language.value ? elements.language.value : "auto";
  }

  function applyStaticText() {
    document.querySelectorAll("[data-i18n]").forEach((element) => {
      element.textContent = t(element.dataset.i18n);
    });
    document.querySelectorAll("[data-i18n-aria-label]").forEach((element) => {
      element.setAttribute("aria-label", t(element.dataset.i18nAriaLabel));
    });
  }

  function formatNumber(value) {
    const i18n = getI18n();
    return i18n && typeof i18n.formatNumber === "function"
      ? i18n.formatNumber(value, currentLanguage)
      : new Intl.NumberFormat().format(Number(value || 0));
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

  function classifyUsageCategory(label) {
    const source = String(label || "").trim();
    if (/(^|[\s-])Pro($|[\s-])|ChatGPT\s*Pro|GPT[-\s]?(?:5|4o|4\.1|4|3\.5)?\s*Pro|\bo[134][-\s]*Pro\b/i.test(source)) {
      return "GPT Pro";
    }

    return "GPT";
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
    return new Promise((resolve) => {
      chrome.storage.local.get([USAGE_STORAGE_KEY], (items) => {
        resolve(normalizeUsageStats(items && items[USAGE_STORAGE_KEY]));
      });
    });
  }

  async function writeUsageStats(stats) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.set({ [USAGE_STORAGE_KEY]: normalizeUsageStats(stats) }, () => {
        const error = chrome.runtime && chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }
        resolve();
      });
    });
  }

  async function readSettings() {
    return new Promise((resolve) => {
      chrome.storage.local.get([SETTINGS_STORAGE_KEY], (items) => {
        const settings = items && items[SETTINGS_STORAGE_KEY];
        resolve(settings && typeof settings === "object" ? settings : {});
      });
    });
  }

  async function writeSettings(settings) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.set({ [SETTINGS_STORAGE_KEY]: settings || {} }, () => {
        const error = chrome.runtime && chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }
        resolve();
      });
    });
  }

  function escapeHtml(text) {
    const span = document.createElement("span");
    span.textContent = text;
    return span.innerHTML;
  }

  function escapeAttribute(text) {
    return escapeHtml(text).replace(/"/g, "&quot;");
  }
})();
