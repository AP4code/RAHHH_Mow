const state = require("./state");
const { modToken, helix } = require("./auth");

/* ------------------------------------------------------------------ */
/* clips — always smoothcheese01 (modToken)                            */
/* ------------------------------------------------------------------ */

async function createClip() {
  try {
    const { data } = await helix(modToken, {
      method: "post",
      url: "https://api.twitch.tv/helix/clips",
      params: { broadcaster_id: state.broadcasterId, has_delay: false },
    });

    const clipId = data.data?.[0]?.id;
    if (!clipId) {
      console.error("[CLIP] No clip ID returned");
      return null;
    }

    console.log(`[CLIP] Created → ${clipId}`);
    return clipId;
  } catch (e) {
    console.error("[CLIP] Failed:", e.response?.data || e.message);
    return null;
  }
}

async function renameClip(clipId, title) {
  try {
    await helix(modToken, {
      method: "patch",
      url: "https://api.twitch.tv/helix/clips",
      headers: { "Content-Type": "application/json" },
      data: { title },
      params: { id: clipId },
    });
    console.log(`[CLIP] Renamed → "${title}"`);
  } catch (e) {
    console.warn("[CLIP] Failed to rename clip:", e.response?.data || e.message);
  }
}

module.exports = { createClip, renameClip };
