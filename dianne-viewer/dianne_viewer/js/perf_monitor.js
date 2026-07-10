/**
 * perf_monitor.js
 *
 * Lightweight performance monitor: JS heap memory (when available) + FPS,
 * displayed in the status bar's right-hand performance span.
 *
 * Exposes:
 *   createPerfMonitor({ statusPerf })
 *   → (no public API after construction)
 */
function createPerfMonitor({ statusPerf }) {
  const hasMem = !!(window.performance && performance.memory);
  const frameTimes = [];
  const WIN = 60;  // rolling window of N rAF timestamps
  function rafTick(now) {
    frameTimes.push(now);
    if (frameTimes.length > WIN) frameTimes.shift();
    requestAnimationFrame(rafTick);
  }
  requestAnimationFrame(rafTick);
  function fmtMB(b) { return (b / 1048576).toFixed(0) + ' MB'; }
  function curFps() {
    if (frameTimes.length < 2) return 0;
    const span = frameTimes[frameTimes.length - 1] - frameTimes[0];
    return span > 0 ? Math.round((frameTimes.length - 1) * 1000 / span) : 0;
  }
  setInterval(function () {
    const parts = [];
    if (hasMem) {
      parts.push('heap ' + fmtMB(performance.memory.usedJSHeapSize) +
                 ' / ' + fmtMB(performance.memory.totalJSHeapSize));
    }
    parts.push(curFps() + ' fps');
    statusPerf.textContent = parts.join('  |  ');
  }, 2000);
}
