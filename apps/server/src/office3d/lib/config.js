// Đọc config.json + giá trị mặc định. Dùng chung cho máy chủ (server.js) và công cụ của đội (tools/vp.js).
"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");

const DEFAULTS = {
  title: "Văn phòng AI", subtitle: "Công ty AI · trực tiếp", ownerName: "Giám đốc",
  port: 7788, host: "127.0.0.1", projects: [], staff: [], hide: [], keepHours: 24, accessKey: "",
  claudeDir: path.join(os.homedir(), ".claude"), codexDir: path.join(os.homedir(), ".codex"),
  antigravityDir: path.join(os.homedir(), ".gemini", "antigravity-cli"),
  dataDir: "data",          // sổ điều phối của đội (việc, gói, hòm thư, lượt DEV, cần anh, nội quy…)
  rulesFile: "",            // nội quy hiện trên màn "Nội quy": để trống = data/NOI-QUY.md, không có thì AGENTS.md / CLAUDE.md của dự án đầu tiên
  aiCapUsd: 100,            // trần tiền AI mỗi ngày (USD) để tô vàng/đỏ ô "Tiền AI hôm nay"
  // Giá API (USD cho 1 triệu token) để ước tính tiền AI từ token đếm được. Gói thuê bao tháng thì số này chỉ để so sánh.
  prices: {
    claude: { input: 3, cacheRead: 0.3, output: 15 },
    codex: { input: 1.25, cacheRead: 0.125, output: 10 },
    antigravity: { input: 1.25, cacheRead: 0.125, output: 10 },
  },
  dockerFilter: "",         // ví dụ "name=myapp-dev": hiện các container này trong Phòng DEV (để trống = không dùng Docker)
  dockerStrip: "",          // phần đầu tên container bỏ đi khi hiện, ví dụ "myapp-dev-"
  dockerRetired: [],        // container đã cho nghỉ: dừng thì không báo lỗi
};

function loadConfig(root, overrides) {
  const f = path.join(root, "config.json");
  if (!fs.existsSync(f) && !overrides) return null;
  const user = fs.existsSync(f)
    ? JSON.parse(fs.readFileSync(f, "utf8").replace(/^\uFEFF/, ""))
    : {};
  const merged = { ...user, ...(overrides || {}) };
  const cfg = {
    ...DEFAULTS,
    ...merged,
    prices: { ...DEFAULTS.prices, ...(user.prices || {}), ...((overrides && overrides.prices) || {}) },
  };
  cfg.dataDir = path.resolve(root, cfg.dataDir || "data");
  return cfg;
}

module.exports = { loadConfig, DEFAULTS };
