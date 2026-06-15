(function () {
  "use strict";

  const USAGE_STORAGE_KEY = "ccmUsageStats";
  const elements = {};

  document.addEventListener("DOMContentLoaded", () => {
    cacheElements();
    bindEvents();
    refreshStatus();
    refreshUsageStats();
  });

  function cacheElements() {
    elements.select = byId("select-conversations");
    elements.deselect = byId("deselect-all");
    elements.deleteSelected = byId("delete-selected");
    elements.refresh = byId("refresh-list");
    elements.estimate = byId("estimate-context");
    elements.contextWindow = byId("context-window");
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
    setBusy(true);
    elements.estimateOutput.textContent = "Estimating visible context...";

    try {
      const response = await sendToActiveTab({
        type: "CCM_ESTIMATE_CONTEXT",
        contextWindow: Number(elements.contextWindow.value)
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
    elements.estimateOutput.innerHTML = `
      <div class="metric"><span>Visible tokens</span><strong>${formatNumber(estimate.tokens)}</strong></div>
      <div class="metric"><span>Characters</span><strong>${formatNumber(estimate.characters)}</strong></div>
      <div class="metric"><span>Messages</span><strong>${formatNumber(estimate.messages)}</strong></div>
      <div class="metric"><span>Estimator</span><strong>Hybrid local</strong></div>
      <div class="meter" aria-label="Approximate visible context usage">
        <div class="meter-fill" style="width: ${Math.min(percentage, 100).toFixed(2)}%"></div>
      </div>
      <div class="warning">${percentage.toFixed(2)}% of selected ${formatNumber(estimate.contextWindow)} token window. Visible page only, not backend context.</div>
    `;
  }

  function renderUsageStats(stats) {
    const usage = normalizeUsageStats(stats);
    const rows = Object.entries(usage.models)
      .map(([label, value]) => ({
        label,
        total: Number(value.total || 0),
        lastUsedAt: value.lastUsedAt || ""
      }))
      .filter((item) => item.total > 0)
      .sort((a, b) => b.total - a.total || a.label.localeCompare(b.label));

    if (!rows.length) {
      elements.usageOutput.innerHTML = `
        <div class="metric"><span>Tracked sends</span><strong>0</strong></div>
        <div class="warning">No usage counted yet. Send a ChatGPT message or click Record current model.</div>
      `;
      return;
    }

    elements.usageOutput.innerHTML = `
      <div class="metric"><span>Tracked sends</span><strong>${formatNumber(usage.total)}</strong></div>
      <div class="usage-list">
        ${rows.map((row) => `
          <div class="usage-row" title="${escapeHtml(row.label)}">
            <span>${escapeHtml(row.label)}</span>
            <strong>${formatNumber(row.total)}</strong>
          </div>
        `).join("")}
      </div>
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
      elements.estimate,
      elements.recordUsage,
      elements.refreshUsage,
      elements.resetUsage
    ]
      .forEach((button) => {
        button.disabled = isBusy;
      });
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
      version: 1,
      total: 0,
      models: {},
      events: [],
      createdAt: nowIso,
      lastRecordedAt: null,
      lastModelLabel: null
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
    stats.events = Array.isArray(stats.events) ? stats.events : [];
    return stats;
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

  function escapeHtml(text) {
    const span = document.createElement("span");
    span.textContent = text;
    return span.innerHTML;
  }
})();
