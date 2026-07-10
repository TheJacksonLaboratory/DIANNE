/**
 * network_gauges.js
 *
 * Monkey-patches window.fetch to track in-flight tile requests and
 * accumulate received bytes, then drives two miniature gauge bars in
 * the status bar (↑ pending, ↓ received last 60 s).
 *
 * Exposes:
 *   createNetworkGauges({ gaugePendFill, gaugePendTxt, gaugeRxFill, gaugeRxTxt })
 *   → (no public API needed after construction — runs on its own interval)
 */
function createNetworkGauges({ gaugePendFill, gaugePendTxt, gaugeRxFill, gaugeRxTxt }) {
  let pending = 0;
  const rxLog = [];          // [{time, bytes}]
  let pendPeak = 8;          // soft-max for pending gauge; grows automatically
  let rxPeak   = 4194304;    // soft-max for rx gauge, starts at 4 MB/min

  function fmtBytes(b) {
    if (b >= 1073741824) return (b / 1073741824).toFixed(1) + ' GB';
    if (b >= 1048576)    return (b / 1048576).toFixed(1) + ' MB';
    if (b >= 1024)       return (b / 1024).toFixed(0) + ' kB';
    return b + ' B';
  }

  // Monkey-patch window.fetch to count in-flight requests and log response sizes.
  // pending is decremented as soon as response headers arrive (TTFB) — this
  // correctly handles all response types (blob, json, text, …) without
  // needing to know which body-consuming method the caller will use.
  // Bytes are tracked only for blob() responses (tile images dominate traffic).
  const _origFetch = window.fetch;
  window.fetch = function (input, init) {
    pending++;
    return _origFetch.call(this, input, init).then(function (resp) {
      pending = Math.max(0, pending - 1);   // server responded (headers received)
      // wrap blob() to record transferred bytes
      const _origBlob = resp.blob.bind(resp);
      resp.blob = function () {
        return _origBlob().then(function (b) {
          rxLog.push({ time: Date.now(), bytes: b.size });
          return b;
        });
      };
      return resp;
    }, function (err) {
      // fetch rejected: network error or AbortError
      pending = Math.max(0, pending - 1);
      throw err;
    });
  };

  setInterval(function () {
    // pending gauge
    pendPeak = Math.max(pendPeak * 0.98, pending, 4);
    gaugePendFill.style.width = Math.min(100, pending / pendPeak * 100) + '%';
    gaugePendTxt.textContent  = String(pending);

    // rx/min gauge — rolling 60 s window
    const now = Date.now();
    while (rxLog.length && rxLog[0].time < now - 60000) rxLog.shift();
    const rxBytes = rxLog.reduce(function (s, e) { return s + e.bytes; }, 0);
    rxPeak = Math.max(rxPeak * 0.99, rxBytes, 524288);  // floor 512 kB
    gaugeRxFill.style.width = Math.min(100, rxBytes / rxPeak * 100) + '%';
    gaugeRxTxt.textContent  = fmtBytes(rxBytes);
  }, 500);
}
