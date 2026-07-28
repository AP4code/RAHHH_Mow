(function () {
  "use strict";

  function ready(fn) {
    if (document.readyState !== "loading") fn();
    else document.addEventListener("DOMContentLoaded", fn);
  }

  ready(() => {
    const tauriWindow = window.__TAURI__ && window.__TAURI__.window;
    if (!tauriWindow) {
      console.warn("[Titlebar] Tauri window API unavailable — skipping window controls");
      return;
    }

    const appWindow = tauriWindow.getCurrentWindow();

    const minBtn = document.getElementById("tbMinimize");
    const maxBtn = document.getElementById("tbMaximize");
    const closeBtn = document.getElementById("tbClose");

    if (minBtn) minBtn.addEventListener("click", () => appWindow.minimize());
    if (closeBtn) closeBtn.addEventListener("click", () => appWindow.close());
    if (maxBtn) maxBtn.addEventListener("click", () => appWindow.toggleMaximize());

    document.querySelectorAll(".resize-handle").forEach((el) => {
      el.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        appWindow.startResizeDragging(el.dataset.dir);
      });
    });
  });
})();
