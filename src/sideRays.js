(function () {
  "use strict";

  function hexToRgb(hex) {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return m
      ? [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255]
      : [1, 1, 1];
  }

  function originToFlip(origin) {
    switch (origin) {
      case "top-left": return [1, 0];
      case "bottom-right": return [0, 1];
      case "bottom-left": return [1, 1];
      default: return [0, 0]; // top-right
    }
  }

  const VERT_SRC = `
attribute vec2 position;
void main() {
  gl_Position = vec4(position, 0.0, 1.0);
}`;

  const FRAG_SRC = `precision highp float;

uniform float iTime;
uniform vec2 iResolution;
uniform float iSpeed;
uniform vec3 iRayColor1;
uniform vec3 iRayColor2;
uniform float iIntensity;
uniform float iSpread;
uniform float iFlipX;
uniform float iFlipY;
uniform float iTilt;
uniform float iSaturation;
uniform float iBlend;
uniform float iFalloff;
uniform float iOpacity;

float rayStrength(vec2 raySource, vec2 rayRefDirection, vec2 coord, float seedA, float seedB, float speed) {
  vec2 sourceToCoord = coord - raySource;
  float cosAngle = dot(normalize(sourceToCoord), rayRefDirection);
  return clamp(
    (0.45 + 0.15 * sin(cosAngle * seedA + iTime * speed)) +
    (0.3 + 0.2 * cos(-cosAngle * seedB + iTime * speed)),
    0.0, 1.0) *
    clamp((iResolution.x - length(sourceToCoord)) / iResolution.x, 0.5, 1.0);
}

void main() {
  vec2 fragCoord = gl_FragCoord.xy;
  if (iFlipX > 0.5) fragCoord.x = iResolution.x - fragCoord.x;
  if (iFlipY > 0.5) fragCoord.y = iResolution.y - fragCoord.y;

  vec2 coord = vec2(fragCoord.x, iResolution.y - fragCoord.y);
  vec2 rayPos = vec2(iResolution.x * 1.1, -0.5 * iResolution.y);

  float tiltRad = iTilt * 3.14159265 / 180.0;
  float cs = cos(tiltRad);
  float sn = sin(tiltRad);
  vec2 rel = coord - rayPos;
  vec2 tiltedCoord = vec2(rel.x * cs - rel.y * sn, rel.x * sn + rel.y * cs) + rayPos;

  float halfSpread = iSpread * 0.275;
  vec2 rayRefDir1 = normalize(vec2(cos(0.785398 + halfSpread), sin(0.785398 + halfSpread)));
  vec2 rayRefDir2 = normalize(vec2(cos(0.785398 - halfSpread), sin(0.785398 - halfSpread)));

  vec4 rays1 = vec4(iRayColor1, 1.0) * rayStrength(rayPos, rayRefDir1, tiltedCoord, 36.2214, 21.11349, iSpeed);
  vec4 rays2 = vec4(iRayColor2, 1.0) * rayStrength(rayPos, rayRefDir2, tiltedCoord, 22.3991, 18.0234, iSpeed * 0.2);

  vec4 color = rays1 * (1.0 - iBlend) * 0.9 + rays2 * iBlend * 0.9;

  float distanceToLight = length(fragCoord.xy - vec2(rayPos.x, iResolution.y - rayPos.y)) / iResolution.y;
  float brightness = iIntensity * 0.4 / pow(max(distanceToLight, 0.001), iFalloff);
  color.rgb *= brightness;

  float gray = dot(color.rgb, vec3(0.299, 0.587, 0.114));
  color.rgb = mix(vec3(gray), color.rgb, iSaturation);

  color.a = max(color.r, max(color.g, color.b)) * iOpacity;
  gl_FragColor = color;
}`;

  function compileShader(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.error("[SideRays] Shader compile error:", gl.getShaderInfoLog(shader));
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  }

  function createProgram(gl, vertSrc, fragSrc) {
    const vs = compileShader(gl, gl.VERTEX_SHADER, vertSrc);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragSrc);
    if (!vs || !fs) return null;

    const program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error("[SideRays] Program link error:", gl.getProgramInfoLog(program));
      return null;
    }
    return program;
  }

  function initSideRays(container, options) {
    if (!container) return null;

    const opts = Object.assign(
      {
        speed: 2.5,
        rayColor1: "#A78BFA",
        rayColor2: "#6D28D9",
        intensity: 2,
        spread: 2,
        origin: "top-right",
        tilt: 0,
        saturation: 1.5,
        blend: 0.75,
        falloff: 1.6,
        opacity: 1.0,
      },
      options
    );

    const canvas = document.createElement("canvas");
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    canvas.style.display = "block";
    container.appendChild(canvas);

    const gl =
      canvas.getContext("webgl", { alpha: true }) ||
      canvas.getContext("experimental-webgl", { alpha: true });

    if (!gl) {
      console.warn("[SideRays] WebGL not supported — skipping background effect");
      return null;
    }

    const program = createProgram(gl, VERT_SRC, FRAG_SRC);
    if (!program) return null;

    gl.useProgram(program);

    // fullscreen triangle trick — one triangle covering the whole clip space
    const positionBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

    const positionLoc = gl.getAttribLocation(program, "position");
    gl.enableVertexAttribArray(positionLoc);
    gl.vertexAttribPointer(positionLoc, 2, gl.FLOAT, false, 0, 0);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    const uniformLoc = {};
    [
      "iTime", "iResolution", "iSpeed", "iRayColor1", "iRayColor2",
      "iIntensity", "iSpread", "iFlipX", "iFlipY", "iTilt",
      "iSaturation", "iBlend", "iFalloff", "iOpacity",
    ].forEach((name) => {
      uniformLoc[name] = gl.getUniformLocation(program, name);
    });

    function applyOptions() {
      const [flipX, flipY] = originToFlip(opts.origin);
      const c1 = hexToRgb(opts.rayColor1);
      const c2 = hexToRgb(opts.rayColor2);

      gl.uniform1f(uniformLoc.iSpeed, opts.speed);
      gl.uniform3f(uniformLoc.iRayColor1, c1[0], c1[1], c1[2]);
      gl.uniform3f(uniformLoc.iRayColor2, c2[0], c2[1], c2[2]);
      gl.uniform1f(uniformLoc.iIntensity, opts.intensity);
      gl.uniform1f(uniformLoc.iSpread, opts.spread);
      gl.uniform1f(uniformLoc.iFlipX, flipX);
      gl.uniform1f(uniformLoc.iFlipY, flipY);
      gl.uniform1f(uniformLoc.iTilt, opts.tilt);
      gl.uniform1f(uniformLoc.iSaturation, opts.saturation);
      gl.uniform1f(uniformLoc.iBlend, opts.blend);
      gl.uniform1f(uniformLoc.iFalloff, opts.falloff);
      gl.uniform1f(uniformLoc.iOpacity, opts.opacity);
    }

    applyOptions();

    let rafId = null;
    let paused = false;

    function resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = container.clientWidth || 1;
      const h = container.clientHeight || 1;

      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.uniform2f(uniformLoc.iResolution, canvas.width, canvas.height);
    }

    function render(t) {
      if (paused) return;
      gl.uniform1f(uniformLoc.iTime, t * 0.001);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      rafId = requestAnimationFrame(render);
    }

    function start() {
      if (rafId !== null) return;
      paused = false;
      rafId = requestAnimationFrame(render);
    }

    function stop() {
      paused = true;
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
    }

    // pause the render loop while the app window is minimized/hidden
    function onVisibilityChange() {
      if (document.hidden) stop();
      else start();
    }

    window.addEventListener("resize", resize);
    document.addEventListener("visibilitychange", onVisibilityChange);

    resize();
    start();

    return {
      setOptions(next) {
        Object.assign(opts, next);
        applyOptions();
      },
      destroy() {
        stop();
        window.removeEventListener("resize", resize);
        document.removeEventListener("visibilitychange", onVisibilityChange);
        const lose = gl.getExtension("WEBGL_lose_context");
        if (lose) lose.loseContext();
        if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
      },
    };
  }

  window.SideRays = { init: initSideRays, instance: null };

  document.addEventListener("DOMContentLoaded", () => {
    const container = document.getElementById("sideRaysBg");
    if (container) window.SideRays.instance = initSideRays(container);
  });
})();
