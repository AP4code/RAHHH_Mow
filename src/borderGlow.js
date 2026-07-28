(function () {
  "use strict";

  function parseHSL(hslStr) {
    const match = hslStr.match(/([\d.]+)\s*([\d.]+)%?\s*([\d.]+)%?/);
    if (!match) return { h: 40, s: 80, l: 80 };
    return { h: parseFloat(match[1]), s: parseFloat(match[2]), l: parseFloat(match[3]) };
  }

  function buildGlowVars(glowColor, intensity) {
    const { h, s, l } = parseHSL(glowColor);
    const base = `${h}deg ${s}% ${l}%`;
    const opacities = [100, 60, 50, 40, 30, 20, 10];
    const keys = ["", "-60", "-50", "-40", "-30", "-20", "-10"];
    const vars = {};
    for (let i = 0; i < opacities.length; i++) {
      vars[`--glow-color${keys[i]}`] = `hsl(${base} / ${Math.min(opacities[i] * intensity, 100)}%)`;
    }
    return vars;
  }

  const GRADIENT_POSITIONS = ["80% 55%", "69% 34%", "8% 6%", "41% 38%", "86% 85%", "82% 18%", "51% 4%"];
  const GRADIENT_KEYS = [
    "--gradient-one", "--gradient-two", "--gradient-three", "--gradient-four",
    "--gradient-five", "--gradient-six", "--gradient-seven",
  ];
  const COLOR_MAP = [0, 1, 2, 0, 1, 2, 1];

  function buildGradientVars(colors) {
    const vars = {};
    for (let i = 0; i < GRADIENT_KEYS.length; i++) {
      const c = colors[Math.min(COLOR_MAP[i], colors.length - 1)];
      vars[GRADIENT_KEYS[i]] = `radial-gradient(at ${GRADIENT_POSITIONS[i]}, ${c} 0px, transparent 50%)`;
    }
    vars["--gradient-base"] = `linear-gradient(${colors[0]} 0 100%)`;
    return vars;
  }

  function setVars(el, vars) {
    for (const key in vars) el.style.setProperty(key, vars[key]);
  }

  /**
   * Wraps `el` with the interactive border-glow effect (mouse-tracking
   * colored edge + outer halo). `el` should already carry class
   * "border-glow-card" (or pass wrap: true to add it, e.g. for a wrapper
   * div placed around an already-styled control).
   */
  function initBorderGlow(el, options) {
    const opts = Object.assign({
      edgeSensitivity: 30,
      glowColor: "40 80 80",
      backgroundColor: "#120F17",
      borderRadius: 28,
      glowRadius: 40,
      glowIntensity: 1.0,
      coneSpread: 25,
      colors: ["#c084fc", "#f472b6", "#38bdf8"],
      fillOpacity: 0.5,
      wrap: false,
    }, options || {});

    el.classList.add("border-glow-card");
    if (opts.wrap) el.classList.add("glow-wrap");

    if (!el.querySelector(":scope > .edge-light")) {
      const span = document.createElement("span");
      span.className = "edge-light";
      el.prepend(span);
    }

    setVars(el, Object.assign({
      "--card-bg": opts.backgroundColor,
      "--edge-sensitivity": opts.edgeSensitivity,
      "--border-radius": `${opts.borderRadius}px`,
      "--glow-padding": `${opts.glowRadius}px`,
      "--cone-spread": opts.coneSpread,
      "--fill-opacity": opts.fillOpacity,
    }, buildGlowVars(opts.glowColor, opts.glowIntensity), buildGradientVars(opts.colors)));

    function getCenter() {
      const rect = el.getBoundingClientRect();
      return [rect.width / 2, rect.height / 2];
    }

    function edgeProximity(x, y) {
      const [cx, cy] = getCenter();
      const dx = x - cx;
      const dy = y - cy;
      let kx = Infinity;
      let ky = Infinity;
      if (dx !== 0) kx = cx / Math.abs(dx);
      if (dy !== 0) ky = cy / Math.abs(dy);
      return Math.min(Math.max(1 / Math.min(kx, ky), 0), 1);
    }

    // Normalized (unit-ish) offset from center, scaled by half-width/
    // half-height. We hand these two numbers to CSS and let it compute the
    // cone angle itself via atan2() at paint time — see the note on
    // --cursor-nx/--cursor-ny in borderGlow.css for why: transitioning a
    // raw angle wraps the wrong way at the 0/360 seam, but transitioning a
    // coordinate pair has no seam to snag on, so the browser can smooth
    // out the residual whip near a wide button's center for free.
    function normalizedOffset(x, y) {
      const [cx, cy] = getCenter();
      const dx = x - cx;
      const dy = y - cy;
      const nx = cx ? dx / cx : dx;
      const ny = cy ? dy / cy : dy;
      return (nx === 0 && ny === 0) ? [0.0001, 0] : [nx, ny];
    }

    // Pointer fires far more often than the display refreshes (some mice
    // report at 500-1000Hz); only the most recent position per frame
    // matters, so batch through rAF rather than writing styles per event.
    let raf = null;
    let pending = null;

    function flush() {
      raf = null;
      if (!pending) return;
      const { x, y } = pending;
      const [nx, ny] = normalizedOffset(x, y);
      el.style.setProperty("--edge-proximity", (edgeProximity(x, y) * 100).toFixed(3));
      el.style.setProperty("--cursor-nx", nx.toFixed(4));
      el.style.setProperty("--cursor-ny", ny.toFixed(4));
    }

    function onPointerMove(e) {
      const rect = el.getBoundingClientRect();
      pending = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      if (raf == null) raf = requestAnimationFrame(flush);
    }

    el.addEventListener("pointermove", onPointerMove);

    return {
      setColors(colors) { setVars(el, buildGradientVars(colors)); },
      setGlowColor(glowColor, intensity = opts.glowIntensity) { setVars(el, buildGlowVars(glowColor, intensity)); },
      destroy() {
        el.removeEventListener("pointermove", onPointerMove);
        if (raf != null) cancelAnimationFrame(raf);
      },
    };
  }

  window.BorderGlow = { init: initBorderGlow };
})();
