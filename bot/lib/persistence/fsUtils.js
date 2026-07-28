const fs = require("fs");
const { DATA_DIR } = require("../paths");

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function atomicWriteFileSync(filePath, data) {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, data, "utf8");
  fs.renameSync(tmp, filePath);
}

module.exports = { ensureDataDir, atomicWriteFileSync };
