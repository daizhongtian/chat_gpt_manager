(function () {
  "use strict";

  const elements = {};

  document.addEventListener("DOMContentLoaded", () => {
    cacheElements();
    bindEvents();
    refreshStatus();
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
  }

  function bindEvents() {
    elements.select.addEventListener("click", () => runAction("CCM_SELECT_CONVERSATIONS"));
    elements.deselect.addEventListener("click", () => runAction("CCM_DESELECT_ALL"));
    elements.deleteSelected.addEventListener("click", () => runAction("CCM_DELETE_SELECTED"));
    elements.refresh.addEventListener("click", () => runAction("CCM_REFRESH_LIST"));
    elements.estimate.addEventListener("click", estimateContext);
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

  function setStatus(message) {
    elements.status.textContent = message;
  }

  function setBusy(isBusy) {
    [elements.select, elements.deselect, elements.deleteSelected, elements.refresh, elements.estimate]
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
})();
