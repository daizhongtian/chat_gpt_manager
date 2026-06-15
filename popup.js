(function () {
  "use strict";

  const USAGE_STORAGE_KEY = "ccmUsageStats";
  const SETTINGS_STORAGE_KEY = "ccmSettings";
  const elements = {};

  document.addEventListener("DOMContentLoaded", () => {
    cacheElements();
    bindEvents();
    loadSettings();
    refreshStatus();
    refreshUsageStats();
  });

  function cacheElements() {
    elements.select = byId("select-conversations");
    elements.deselect = byId("deselect-all");
    elements.deleteSelected = byId("delete-selected");
    elements.refresh = byId("refresh-list");
    elements.estimate = byId("estimate-context");
    elements.contextEstimateEnabled = byId("context-estimate-enabled");
    elements.contextWindow = byId("context-window");
    elements.customContextRow = byId("custom-context-row");
    elements.customContextWindow = byId("custom-context-window");
    elements.status = byId("conversation-status");
    elements.estimateOutput = byId("estimate-output");
    elements.currentModel = byId("current-model");
    elements.recordUsage = byId("record-usage");
    elements.refreshUsage = byId("refresh-usage");
    elements.resetUsage = byId("reset-usage");
    elements.usageOutput = byId("usage-output");
  }

  function bindEvents() {
    elements.select.addEventListener("click", () => runAction("CCM_SELECT_CONVERSATIONS"));
    elements.deselect.addEventListener("click", () => runAction("CCM_DESELECT_ALL"));
    elements.deleteSelected.addEventListener("click", () => runAction("CCM_DELETE_SELECTED"));
    elements.refresh.addEventListener("click", () => runAction("CCM_REFRESH_LIST"));
    elements.estimate.addEventListener("click", estimateContext);
    elements.contextEstimateEnabled.addEventListener("change", saveContextEstimateSetting);
    elements.contextWindow.addEventListener("change", updateCustomContextVisibility);
    elements.recordUsage.addEventListener("click", recordCurrentUsage);
    elements.refreshUsage.addEventListener("click", refreshUsageStats);
    elements.resetUsage.addEventListener("click", resetUsageStats);
  }

  async function refreshStatus() {
    try {
      const response = await sendToActiveTab({ type: "CCM_GET_STATUS" });
      renderStatus(response.status);
    } catch (error) {
      setStatus("Open or refresh https://chatgpt.com/, then try again.");
    }
  }

  async function loadSettings() {
    try {
      const settings = await readSettings();
      elements.contextEstimateEnabled.checked = settings.contextEstimateEnabled !== false;
    } catch (error) {
      elements.contextEstimateEnabled.checked = true;
    }

    applyContextEstimateAvailability(false);
  }

  async function runAction(type) {
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
    if (!isContextEstimateEnabled()) {
      elements.estimateOutput.innerHTML = '<div class="warning">Context estimate is turned off.</div>';
      return;
    }

    setBusy(true);
    elements.estimateOutput.textContent = "Estimating loaded context...";

    try {
      const selectedContextWindow = getSelectedContextWindow();
      const response = await sendToActiveTab({
        type: "CCM_ESTIMATE_CONTEXT",
        contextWindow: selectedContextWindow
      });
      renderStatus(response.status);
      renderEstimate(response.estimate);
    } catch (error) {
      elements.estimateOutput.textContent = "";
      setStatus(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function saveContextEstimateSetting() {
    const enabled = isContextEstimateEnabled();
    applyContextEstimateAvailability(false);

    if (!enabled) {
      elements.estimateOutput.innerHTML = '<div class="warning">Context estimate is turned off.</div>';
    }

    try {
      const settings = await readSettings();
      settings.contextEstimateEnabled = enabled;
      await writeSettings(settings);
    } catch (error) {
      // Local file smoke tests do not provide chrome.storage.
    }
  }

  async function recordCurrentUsage() {
    setBusy(true);

    try {
      const response = await sendToActiveTab({ type: "CCM_RECORD_USAGE_NOW" });
      if (response.message) {
        setStatus(response.message);
      }
      renderStatus(response.status);
      renderUsageStats(response.usageStats);
    } catch (error) {
      setStatus(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function refreshUsageStats() {
    try {
      renderUsageStats(await readUsageStats());
    } catch (error) {
      elements.usageOutput.textContent = "Could not read local usage stats.";
    }
  }

  async function resetUsageStats() {
    if (!confirm("Reset local usage counts?")) {
      return;
    }

    setBusy(true);
    try {
      const stats = createEmptyUsageStats();
      await writeUsageStats(stats);
      renderUsageStats(stats);
      setStatus("Usage counts reset.");
    } catch (error) {
      setStatus("Could not reset local usage stats.");
    } finally {
      setBusy(false);
    }
  }

  async function sendToActiveTab(payload) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) {
      throw new Error("No active tab found.");
    }

    try {
      const response = await chrome.tabs.sendMessage(tab.id, Object.assign({
        source: "ccm-popup"
      }, payload));

      if (!response || !response.ok) {
        throw new Error(response && response.error ? response.error : "The content script did not respond.");
      }

      return response;
    } catch (error) {
      throw new Error("Open or refresh https://chatgpt.com/ before using this extension.");
    }
  }

  function renderStatus(status) {
    if (!status) {
      return;
    }

    const visibleText = status.activated
      ? `${formatNumber(status.selected)} selected / ${formatNumber(status.visible)} visible conversations`
      : "Controls are ready. Selection starts only when you click Select conversations.";

    setStatus(status.isDeleting ? `Deleting... ${visibleText}` : visibleText);
    if (status.currentModel) {
      elements.currentModel.textContent = status.currentModel;
      elements.currentModel.title = status.currentModel;
    }
  }

  function renderEstimate(estimate) {
    if (!estimate) {
      return;
    }

    const percentage = Math.max(0, estimate.percentage || 0);
    const estimatedVisibleTokens = Number(estimate.estimatedVisibleTokens || estimate.tokens || 0);
    const selectedContextWindow = Number(estimate.selectedContextWindow || estimate.contextWindow || 128000);
    const methodLabel = formatEstimatorMethod(estimate);
    const mediaRows = renderMediaRows(estimate);
    elements.estimateOutput.innerHTML = `
      <div class="metric"><span>Estimated visible tokens</span><strong>${formatNumber(estimatedVisibleTokens)}</strong></div>
      <div class="metric"><span>Text tokens</span><strong>${formatNumber(estimate.textTokens || estimatedVisibleTokens)}</strong></div>
      <div class="metric"><span>Characters</span><strong>${formatNumber(estimate.characters)}</strong></div>
      <div class="metric"><span>Messages</span><strong>${formatNumber(estimate.messages)}</strong></div>
      ${mediaRows}
      <div class="metric"><span>Estimator</span><strong>${escapeHtml(methodLabel)}</strong></div>
      <div class="meter" aria-label="Approximate loaded-page context usage">
        <div class="meter-fill" style="width: ${Math.min(percentage, 100).toFixed(2)}%"></div>
      </div>
      <div class="warning">${percentage.toFixed(2)}% of selected ${formatNumber(selectedContextWindow)} token window. Loaded page only, not backend context.</div>
    `;
  }

  function renderMediaRows(estimate) {
    const rows = [];
    if (Number(estimate.imageCount || 0) > 0) {
      rows.push(`<div class="metric"><span>Images</span><strong>${formatNumber(estimate.imageCount)} / ${formatNumber(estimate.imageTokens)} tokens</strong></div>`);
    }

    if (Number(estimate.pdfCount || 0) > 0) {
      rows.push(`<div class="metric"><span>PDFs</span><strong>${formatNumber(estimate.analyzedPdfCount || 0)} analyzed / ${formatNumber(estimate.pdfCount)} found</strong></div>`);
      rows.push(`<div class="metric"><span>PDF text</span><strong>${formatNumber(estimate.pdfTextTokens || 0)} tokens</strong></div>`);
      rows.push(`<div class="metric"><span>PDF image pages</span><strong>${formatNumber(estimate.pdfImagePages || 0)} / ${formatNumber(estimate.pdfImageTokens || 0)} tokens</strong></div>`);
      if (Number(estimate.inaccessiblePdfCount || 0) > 0) {
        rows.push(`<div class="warning">${formatNumber(estimate.inaccessiblePdfCount)} PDF attachment(s) detected but not accessible to the browser extension.</div>`);
      }
    }

    return rows.join("");
  }

  function formatEstimatorMethod(estimate) {
    if (estimate && estimate.tokenizerUsed) {
      return "gpt-tokenizer local";
    }

    return "Local fallback";
  }

  function updateCustomContextVisibility() {
    const isCustom = elements.contextWindow.value === "custom";
    elements.customContextRow.classList.toggle("hidden", !isCustom || !isContextEstimateEnabled());

    if (isCustom) {
      elements.customContextWindow.value = sanitizeContextWindow(elements.customContextWindow.value);
    }
  }

  function isContextEstimateEnabled() {
    return Boolean(elements.contextEstimateEnabled && elements.contextEstimateEnabled.checked);
  }

  function applyContextEstimateAvailability(isBusy) {
    const enabled = isContextEstimateEnabled();
    elements.contextWindow.disabled = isBusy || !enabled;
    elements.customContextWindow.disabled = isBusy || !enabled;
    elements.estimate.disabled = isBusy || !enabled;
    updateCustomContextVisibility();
  }

  function getSelectedContextWindow() {
    if (elements.contextWindow.value === "custom") {
      return Number(sanitizeContextWindow(elements.customContextWindow.value));
    }

    return Number(elements.contextWindow.value || 128000);
  }

  function sanitizeContextWindow(value) {
    const numeric = Math.floor(Number(value || 0));
    if (!Number.isFinite(numeric) || numeric < 1000) {
      return "1000";
    }

    return String(numeric);
  }

  function renderUsageStats(stats) {
    const usage = normalizeUsageStats(stats);
    const categoryRows = [
      {
        label: "GPT",
        total: Number(usage.categories.GPT?.total || 0),
        title: "普通 GPT model sends"
      },
      {
        label: "GPT Pro",
        total: Number(usage.categories["GPT Pro"]?.total || 0),
        title: "GPT Pro model sends"
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
      <div class="metric"><span>Tracked sends</span><strong>${formatNumber(usage.total)}</strong></div>
      <div class="usage-list usage-categories">
        ${categoryRows.map((row) => `
          <div class="usage-row usage-category-row" title="${escapeHtml(row.title)}">
            <span>${escapeHtml(row.label)}</span>
            <strong>${formatNumber(row.total)}</strong>
          </div>
        `).join("")}
      </div>
      ${modelRows.length ? `
        <div class="usage-subtitle">Model details</div>
        <div class="usage-list">
          ${modelRows.map((row) => `
            <div class="usage-row" title="${escapeHtml(row.label)}">
              <span>${escapeHtml(row.label)}</span>
              <strong>${formatNumber(row.total)}</strong>
            </div>
          `).join("")}
        </div>
      ` : '<div class="warning">No usage counted yet. Send a ChatGPT message; counting is automatic.</div>'}
    `;
  }

  function setStatus(message) {
    elements.status.textContent = message;
  }

  function setBusy(isBusy) {
    [
      elements.select,
      elements.deselect,
      elements.deleteSelected,
      elements.refresh,
      elements.contextEstimateEnabled,
      elements.recordUsage,
      elements.refreshUsage,
      elements.resetUsage
    ]
      .forEach((button) => {
        button.disabled = isBusy;
      });
    applyContextEstimateAvailability(isBusy);
  }

  function byId(id) {
    return document.getElementById(id);
  }

  function formatNumber(value) {
    return new Intl.NumberFormat().format(Number(value || 0));
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
})();
