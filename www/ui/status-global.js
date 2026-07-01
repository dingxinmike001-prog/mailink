(function () {
  const timers = new Map();

  function getStatusArea(elId) {
    if (typeof document === 'undefined') return null;
    return document.getElementById(elId);
  }

  function clearStatus(options) {
    const elId = (options && options.elId) ? options.elId : 'statusArea';
    const statusArea = getStatusArea(elId);
    if (statusArea) {
      statusArea.innerHTML = '';
    }

    const timer = timers.get(elId);
    if (timer) {
      clearTimeout(timer);
      timers.delete(elId);
    }
  }

  function showStatus(message, type, options) {
    const statusType = type || 'info';
    const elId = (options && options.elId) ? options.elId : 'statusArea';
    const timeoutMs = (options && typeof options.timeoutMs === 'number') ? options.timeoutMs : 2000;
    const statusArea = getStatusArea(elId);
    if (!statusArea) return;

    statusArea.innerHTML = `<div class="status status-${statusType} status-animation">${message}</div>`;

    const existing = timers.get(elId);
    if (existing) {
      clearTimeout(existing);
    }

    const timer = setTimeout(() => {
      clearStatus({ elId });
    }, timeoutMs);
    timers.set(elId, timer);
  }

  const existing = (typeof window !== 'undefined' && window.uiStatus && typeof window.uiStatus === 'object') ? window.uiStatus : {};
  if (typeof window !== 'undefined') {
    window.uiStatus = {
      ...existing,
      showStatus,
      clearStatus
    };
  }
})();

