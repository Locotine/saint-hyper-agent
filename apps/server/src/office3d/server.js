// Văn phòng ảo 3D cho đội AI (Claude Code + Codex + Antigravity).
// Máy chủ CHỈ ĐỌC: nhật ký phiên có sẵn trên máy (~/.claude, ~/.codex, ~/.gemini/antigravity-cli) và sổ điều phối của đội trong thư mục data/
// (việc ưu tiên, gói việc, hòm thư, lượt DEV, cần anh, nội quy…; ghi bằng công cụ tools/vp.js). Mỗi giây đẩy trạng thái lên trình duyệt.
// Không gửi dữ liệu ra ngoài, không sửa file nào của Claude/Codex/Antigravity, che mọi chuỗi giống khóa trước khi hiện.
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { execFile } = require("child_process");
const perf = require("./lib/perf");
const chat = require("./lib/chat");
const docs = require("./lib/docs");
const hopthu = require("./lib/hopthu");
const tongquan = require("./lib/tongquan");
const { loadConfig } = require("./lib/config");

const ROOT = __dirname;
const FIRST_READ = 8_000_000; // lần đầu chỉ đọc 8 MB cuối mỗi nhật ký
const MAX_READ = 16_000_000;
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function copyDirIfMissing(src, dest) {
  try {
    fs.mkdirSync(dest, { recursive: true });
    for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
      const s = path.join(src, ent.name), d = path.join(dest, ent.name);
      if (ent.isDirectory()) copyDirIfMissing(s, d);
      else if (!fs.existsSync(d)) fs.copyFileSync(s, d);
    }
  } catch {}
}

function ensureSampleData(dataDir) {
  try {
    const mauDir = path.join(ROOT, "mau");
    if (!fs.existsSync(path.join(dataDir, "UU-TIEN.json")) && fs.existsSync(mauDir)) {
      copyDirIfMissing(mauDir, dataDir);
    }
    fs.mkdirSync(path.join(dataDir, "hop-thu"), { recursive: true });
  } catch {}
}

function openSqliteReadonly(dbPath) {
  try {
    const { Database } = require("bun:sqlite");
    return {
      kind: "bun",
      db: new Database(dbPath, { readonly: true }),
    };
  } catch {}
  try {
    const { DatabaseSync } = require("node:sqlite");
    return {
      kind: "node",
      db: new DatabaseSync(dbPath, { readOnly: true }),
    };
  } catch {}
  return null;
}

function unquoteJsonValue(val) {
  if (typeof val !== "string") return val;
  const s = val.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("[") && s.endsWith("]")) || (s.startsWith("{") && s.endsWith("}"))) {
    try { return JSON.parse(s); } catch {}
  }
  return val;
}

function stripAntigravityEnvelope(raw) {
  if (!raw) return "";
  let s = String(raw);
  s = s.replace(/<saint_host_context>[\s\S]*?<\/saint_host_context>/gi, "");
  s = s.replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, "");
  s = s.replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/gi, "");
  s = s.replace(/<SYSTEM_MESSAGE>[\s\S]*?<\/SYSTEM_MESSAGE>/gi, "");
  s = s.replace(/<CONTEXT_SUMMARY>[\s\S]*?<\/CONTEXT_SUMMARY>/gi, "");
  const m = s.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i);
  if (m) s = m[1];
  s = s.replace(/<\/?USER_REQUEST>/gi, "");
  return s.trim();
}

function createOffice3dApp(overrides) {
  const CFG = loadConfig(ROOT, overrides);
  if (!CFG) return null;
  const DATA = CFG.dataDir;
  ensureSampleData(DATA);
  const KEEP = CFG.keepHours * 3600000;

  // ---------- tiện ích ----------
  const now = () => Date.now();
  function mask(s) {
    if (!s) return "";
    const pin = chat.currentPin(CFG); if (pin && /^\d{6}$/.test(pin)) s = String(s).split(pin).join("‹PIN›"); // không lộ mã PIN nhắn tin
    return String(s)
      .replace(/[A-Za-z]:[\\/][^\s|;,]*secrets?[^\s|;,]*/gi, "‹thư mục khóa›")
      .replace(/((?:api[_-]?)?key|token|secret|password|passwd|pwd|bearer)\s*[:=]\s*\S+/gi, "$1=‹ẩn›")
      .replace(/\b(sk|pk|rk|ghp|gho|github_pat|xox[abp]|AKIA|AIza)[-_A-Za-z0-9]{12,}/g, "‹khóa›")
      .replace(/[A-Za-z0-9_\-+/=]{48,}/g, "…")
      .replace(/\*\*|`/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }
  // Che khóa trong sổ sách mà vẫn giữ xuống dòng và định dạng Markdown (nội quy, bài học…).
  function maskDoc(s) {
    if (!s) return "";
    const pin = chat.currentPin(CFG); if (pin && /^\d{6}$/.test(pin)) s = String(s).split(pin).join("‹PIN›");
    return String(s)
      .replace(/[A-Za-z]:[\\/][^\s|;,`]*secrets?[^\s|;,`]*/gi, "‹thư mục khóa›")
      .replace(/((?:api[_-]?)?key|token|secret|password|passwd|pwd)\s*[:=]\s*[^\s`|]+/gi, "$1=‹ẩn›")
      .replace(/\b(sk|pk|rk|ghp|gho|github_pat|xox[abp]|AKIA|AIza)[-_A-Za-z0-9]{12,}/g, "‹khóa›")
      .replace(/\b(?=[A-Za-z0-9+/=]*[A-Z])(?=[A-Za-z0-9+/=]*[a-z])(?=[A-Za-z0-9+/=]*\d)[A-Za-z0-9+/=]{40,}\b/g, "…");
  }
  const clip = (s, n = 180) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
  function safeStat(p) { try { return fs.statSync(p); } catch { return null; } }
  function readRange(p, start, end) {
    const fd = fs.openSync(p, "r");
    try { const buf = Buffer.alloc(Math.max(0, end - start)); fs.readSync(fd, buf, 0, buf.length, start); return buf; } finally { fs.closeSync(fd); }
  }
  function firstLine(f) {
    const fd = fs.openSync(f, "r");
    try { const b = Buffer.alloc(1 << 20); const n = fs.readSync(fd, b, 0, b.length, 0); const nl = b.subarray(0, n).indexOf(10); return b.subarray(0, nl < 0 ? n : nl).toString("utf8"); } finally { fs.closeSync(fd); }
  }
  const boDau = (s) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D").toLowerCase().trim();

  // ---------- phiên nào thuộc dự án của bạn ----------
  const normP = (p) => path.resolve(String(p || "")).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const PROJECTS = (CFG.projects || []).filter(Boolean);
  const inProject = (cwd) => !PROJECTS.length || PROJECTS.some((p) => { const a = normP(cwd), b = normP(p); return a === b || a.startsWith(b + "/"); });
  // Claude Code đặt tên thư mục nhật ký theo đường dẫn dự án: mọi ký tự không phải chữ/số thành "-".
  const encDir = (p) => path.resolve(p).replace(/[^a-zA-Z0-9]/g, "-").toLowerCase();
  const claudeDirOk = (d) => !PROJECTS.length || PROJECTS.some((p) => { const e = encDir(p), x = d.toLowerCase(); return x === e || x.startsWith(e + "-"); });
  const hidden = new Set(CFG.hide || []);

  // ---------- nhân viên ----------
  // Phòng (mã nội bộ → tên hiện): ceo = Giám đốc (bạn), manager = Quản lý, coord = Điều phối, g1 = Kiểm tra & duyệt, claude, codex, antigravity, dev.
  const agents = [];
  const byKey = {};
  function mark(a, t) { a.mins.add(Math.floor(t / 60000)); if (a.mins.size > 12000) { const cut = Math.floor((now() - 8 * 86400000) / 60000); for (const m of a.mins) if (m < cut) a.mins.delete(m); } }
  function blank(a) { return { ...a, file: null, subFiles: [], size: 0, offset: 0, mtime: 0, lastText: "", lastTail: "", lastTextAt: 0, working: false, subActive: 0, mins: new Set(), done: [], tools: [], lastUserAt: 0, ceoLastAt: 0, ceoLastText: "" }; }
  const ceo = blank({ key: "ceo", name: CFG.ownerName, role: "Chủ văn phòng", platform: "human", room: "ceo", journal: "none:ceo", ceo: true, aliases: [CFG.ownerName, "CEO", "Giám đốc"] });
  agents.push(ceo); byKey.ceo = ceo;
  function override(name, id) { return (CFG.staff || []).find((s) => s.match && (String(name).toLowerCase().includes(String(s.match).toLowerCase()) || String(id).startsWith(s.match))); }
  function roomOf(name, platform, o) {
    if (o && o.room) return o.room;
    if (/quản lý|quan ly|manager|\blead\b|trưởng|truong nhom|giám sát|\bpm\b/i.test(name)) return "manager";
    if (/điều phối|dieu phoi|coordinat|trợ lý|tro ly|assistant|dispatch/i.test(name)) return "coord";
    if (/review|duyệt|duyet|kiểm tra|kiem tra|\btest|\bqa\b|\bg1\b/i.test(name)) return "g1";
    return platform;
  }
  function keyPrefix(platform) {
    return platform === "codex" ? "x-" : platform === "antigravity" ? "a-" : "c-";
  }
  function defaultRole(platform) {
    return platform === "codex" ? "Kỹ sư Codex" : platform === "antigravity" ? "Kỹ sư Antigravity" : "Kỹ sư Claude Code";
  }
  function addAgent(platform, id, file, name, createdAt) {
    const key = keyPrefix(platform) + id.slice(0, 8);
    if (byKey[key]) return byKey[key];
    const o = override(name, id), nm = clip(mask((o && o.name) || name), 40);
    const a = blank({ key, id, platform, journal: platform + ":" + id, autoName: !(o && o.name), name: nm, aliases: [nm],
      role: (o && o.role) || defaultRole(platform), room: roomOf((o && o.name) || name, platform, o), auto: true, createdAt: createdAt || now() });
    a.file = file;
    agents.push(a); byKey[key] = a; return a;
  }
  function setName(a, name) {
    if (!a.autoName || !name) return;
    const n = clip(mask(name), 40); if (!n || n === a.name) return;
    a.name = n; a.aliases = [n]; a.room = roomOf(n, a.platform, override(n, a.id));
  }

  // Sổ đăng ký phiên Claude đang mở (~/.claude/sessions/<pid>.json): phiên nào đang chạy/rảnh, tên phiên, mã giao diện local_….
  // Chỉ đọc file .json; không bao giờ đọc file khóa trong thư mục này.
  let live = new Map(), hostToJournal = new Map(), antigravityLive = new Map();
  function readLive() {
    const dir = path.join(CFG.claudeDir, "sessions"), m = new Map(), hm = new Map();
    let files = []; try { files = fs.readdirSync(dir).filter((f) => /^\d+\.json$/.test(f)); } catch {}
    for (const f of files) {
      let d; try { d = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); } catch { continue; }
      try { process.kill(d.pid, 0); } catch { continue; } // tiến trình đã tắt
      if (!d.sessionId || !inProject(d.cwd || "")) continue;
      m.set(d.sessionId, { name: d.name || null, busy: d.status === "busy", host: String(d.hostSessionId || "").replace(/^local_/, "") || null });
      const host = String(d.hostSessionId || "").replace(/^local_/, ""); if (host) hm.set(host, d.sessionId);
    }
    live = m; hostToJournal = hm;
  }
  const toJournal = (s) => { s = String(s || "").replace(/^local_/, ""); for (const [h, j] of hostToJournal) if (s.length >= 8 && h.startsWith(s.slice(0, 8))) return j; return s; };

  function claudeTitle(f) {
    const st = safeStat(f); if (!st) return null;
    const tail = readRange(f, Math.max(0, st.size - 2_000_000), st.size).toString("utf8");
    const all = [...tail.matchAll(/"(?:customTitle|agentName)":"((?:[^"\\]|\\.){1,80})"/g)];
    if (all.length) { try { return JSON.parse(`"${all[all.length - 1][1]}"`); } catch {} }
    return null;
  }
  function codexNames() {
    const m = {};
    try { for (const l of fs.readFileSync(path.join(CFG.codexDir, "session_index.jsonl"), "utf8").split("\n")) { try { const j = JSON.parse(l); if (j.id && j.thread_name) m[j.id] = j.thread_name; } catch {} } } catch {}
    return m;
  }
  function antigravityTranscriptFile(brainDir, id) {
    const logsDir = path.join(brainDir, id, ".system_generated", "logs");
    const full = path.join(logsDir, "transcript_full.jsonl");
    if (safeStat(full)) return full;
    const compact = path.join(logsDir, "transcript.jsonl");
    if (safeStat(compact)) return compact;
    return null;
  }
  function parseWorkspaceUri(uri) {
    try {
      const s = String(uri || "").trim();
      if (s.startsWith("file://")) return decodeURIComponent(new URL(s).pathname);
      return s;
    } catch { return ""; }
  }
  function readAntigravitySummaries() {
    const agDir = CFG.antigravityDir;
    if (!agDir) return new Map();
    const out = new Map();
    const dbFile = path.join(agDir, "conversation_summaries.db");
    if (safeStat(dbFile)) {
      const handle = openSqliteReadonly(dbFile);
      if (handle) {
        try {
          const rows = handle.db
            .prepare("SELECT conversation_id, title, workspace_uris, status, agent_name, parent_conversation_id, not_fully_idle FROM conversation_summaries")
            .all();
          for (const r of rows) {
            if (!r || !r.conversation_id) continue;
            let uris = [];
            try { uris = JSON.parse(r.workspace_uris || "[]"); } catch {}
            const cwds = Array.isArray(uris) ? uris.map(parseWorkspaceUri).filter(Boolean) : [];
            out.set(r.conversation_id, {
              id: r.conversation_id,
              title: r.title || null,
              cwds,
              busy: r.status === "CASCADE_RUN_STATUS_RUNNING" || !!r.not_fully_idle,
              agentName: r.agent_name || null,
              parentId: r.parent_conversation_id || null,
            });
          }
        } catch {} finally {
          try { handle.db.close(); } catch {}
        }
      }
    }
    return out;
  }
  function walk(dir, out) {
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p, out); else if (e.name.endsWith(".jsonl")) out.push(p); }
  }
  const notStaff = new Set();
  function discover() {
    const t = now();
    // Claude Code: ~/.claude/projects/<thư mục dự án>/<mã phiên>.jsonl
    const pdir = path.join(CFG.claudeDir, "projects");
    let dirs = []; try { dirs = fs.readdirSync(pdir).filter(claudeDirOk); } catch {}
    for (const d of dirs) {
      let files = []; try { files = fs.readdirSync(path.join(pdir, d)).filter((x) => x.endsWith(".jsonl")); } catch {}
      for (const x of files) {
        const id = x.slice(0, -6), f = path.join(pdir, d, x);
        if (hidden.has(id) || byKey["c-" + id.slice(0, 8)]) continue;
        const st = safeStat(f); if (!st || (t - st.mtimeMs > KEEP && !live.has(id))) continue;
        const L = live.get(id);
        addAgent("claude", id, f, (L && L.name) || claudeTitle(f) || `Claude ${id.slice(0, 8)}`, st.birthtimeMs);
      }
    }
    // Codex: ~/.codex/sessions/YYYY/MM/DD/*.jsonl, dòng đầu ghi thư mục làm việc (cwd).
    // Phiên chạy nhiều ngày vẫn ghi vào thư mục của ngày tạo, nên quét cả cây rồi lọc theo giờ sửa file.
    const files = []; walk(path.join(CFG.codexDir, "sessions"), files);
    let names = null;
    for (const f of files) {
      if (notStaff.has(f)) continue;
      const st = safeStat(f); if (!st || t - st.mtimeMs > KEEP) continue;
      let meta; try { meta = JSON.parse(firstLine(f)).payload || {}; } catch { notStaff.add(f); continue; }
      if (!meta.id || hidden.has(meta.id) || !inProject(meta.cwd || "")) { notStaff.add(f); continue; }
      const ex = byKey["x-" + meta.id.slice(0, 8)];
      if (ex) { if (ex.file !== f && st.mtimeMs > (safeStat(ex.file) || { mtimeMs: 0 }).mtimeMs) { ex.file = f; ex.offset = 0; ex.size = 0; } continue; }
      names = names || codexNames();
      addAgent("codex", meta.id, f, names[meta.id] || `Codex ${meta.id.slice(0, 8)}`, Date.parse(meta.timestamp || "") || st.birthtimeMs);
    }
    // Antigravity: ~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/transcript_full.jsonl
    const agSummaries = readAntigravitySummaries();
    const agLive = new Map();
    const brainDir = CFG.antigravityDir ? path.join(CFG.antigravityDir, "brain") : "";
    const presenceDir = CFG.antigravityDir ? path.join(CFG.antigravityDir, "presence") : "";
    let brainIds = [];
    try { brainIds = fs.readdirSync(brainDir); } catch {}
    const subByParent = new Map();
    for (const id of brainIds) {
      if (hidden.has(id)) continue;
      const f = antigravityTranscriptFile(brainDir, id);
      if (!f) continue;
      const st = safeStat(f);
      if (!st) continue;
      const sum = agSummaries.get(id);
      const lockSt = presenceDir ? safeStat(path.join(presenceDir, `${id}.lock`)) : null;
      const isBusy = !!(sum && sum.busy) || !!(lockSt && t - lockSt.mtimeMs < 90000);
      if (t - st.mtimeMs > KEEP && !isBusy) continue;
      if (sum && sum.cwds && sum.cwds.length && !sum.cwds.some(inProject)) continue;
      if (sum && sum.parentId) {
        const list = subByParent.get(sum.parentId) || [];
        list.push({ id, file: f, busy: isBusy || t - st.mtimeMs < 120000 });
        subByParent.set(sum.parentId, list);
        continue;
      }
      agLive.set(id, { title: (sum && sum.title) || null, busy: isBusy });
      const ex = byKey["a-" + id.slice(0, 8)];
      if (ex) {
        if (ex.file !== f) { ex.file = f; ex.offset = 0; ex.size = 0; }
        continue;
      }
      addAgent("antigravity", id, f, (sum && sum.title) || `Antigravity ${id.slice(0, 8)}`, st.birthtimeMs);
    }
    antigravityLive = agLive;
    for (const a of agents) {
      if (a.platform === "antigravity") {
        const subs = subByParent.get(a.id) || [];
        a.subFiles = subs.map((s) => s.file);
        a.subActive = subs.filter((s) => s.busy).length;
      }
    }

    // cập nhật tên (phiên đổi tên giữa chừng) và cho nghỉ người im quá lâu
    for (const a of agents) {
      if (a.ceo) continue;
      if (a.platform === "claude") { const L = live.get(a.id); setName(a, (L && L.name) || claudeTitle(a.file)); }
      else if (a.platform === "codex") { names = names || codexNames(); setName(a, names[a.id]); }
      else if (a.platform === "antigravity") { const A = antigravityLive.get(a.id); if (A && A.title) setName(a, A.title); }
    }
    for (let i = agents.length - 1; i >= 0; i--) {
      const a = agents[i];
      const stillLive = live.has(a.id) || (antigravityLive.has(a.id) && antigravityLive.get(a.id).busy);
      if (!a.ceo && a.mtime && t - a.mtime > KEEP && !stillLive) { agents.splice(i, 1); delete byKey[a.key]; }
    }
  }
  // Tìm người theo mã phiên (đầy đủ hoặc 8 ký tự đầu, cả mã giao diện local_…) hoặc theo tên.
  function agentFromId(id) {
    if (!id) return null;
    const s = toJournal(id).toLowerCase();
    if (s.length < 8) return null;
    for (const a of agents) if (!a.ceo && (a.id.toLowerCase().startsWith(s.slice(0, 13)) || s.startsWith(a.id.toLowerCase().slice(0, 13)))) return a.key;
    return null;
  }
  function agentFromLabel(label) {
    if (!label) return null;
    const s = String(label).toLowerCase().trim();
    const hex = (s.match(/\b[0-9a-f]{8}(?:-[0-9a-f]{4})?/) || [])[0];
    if (hex) { const k = agentFromId(hex); if (k) return k; }
    const b = boDau(s);
    for (const a of agents) { if (a.ceo) continue; if ((a.aliases || [a.name]).some((x) => x && (s.includes(x.toLowerCase()) || b.includes(boDau(x))))) return a.key; }
    if (/\b(ceo|giám đốc|giam doc)\b/i.test(s) || s.includes(String(CFG.ownerName).toLowerCase())) return "ceo";
    return null;
  }

  // ---------- tin nhắn ----------
  const events = [];
  const seenEvt = new Set();
  function pushEvent(e) {
    if (!e.body) e.body = e.title;
    const key = `${e.kind}|${e.from}|${e.to}|${e.title.slice(0, 60)}`, b = Math.floor(e.t / 60000);
    if (seenEvt.has(key + b) || seenEvt.has(key + (b - 1))) return;
    seenEvt.add(key + b); if (seenEvt.size > 20000) seenEvt.clear();
    events.push(e); events.sort((x, y) => x.t - y.t);
    if (events.length > 500) events.splice(0, events.length - 500);
  }
  function titleOf(text) { const first = mask(String(text).split("\n").find((l) => l.trim()) || ""); return clip(first.replace(/^<[^>]+>\s*/, ""), 120); }
  function textOfContent(c) {
    if (typeof c === "string") return c;
    if (Array.isArray(c)) return c.filter((x) => x && /^(text|output_text|input_text)$/.test(x.type)).map((x) => x.text || "").join("\n");
    return "";
  }
  const NOT_HUMAN = /^(<|# AGENTS\.md|This session is being continued|\[Request interrupted|Caveat:|Another Claude session)/;
  // Bạn gõ việc cho một phiên: Giám đốc "nói" với phiên đó.
  function ownerSays(a, t, txt) {
    if (t > ceo.ceoLastAt) { ceo.ceoLastAt = t; ceo.ceoLastText = clip(mask(txt), 160); }
    mark(ceo, t);
    pushEvent({ t, kind: "ceo", from: "ceo", to: a.key, title: clip(mask(txt), 110), body: clip(mask(txt), 700) });
  }
  function keep7(arr) { const cut = now() - 7 * 86400000; while (arr.length && arr[0].t < cut) arr.shift(); }

  // ---------- đọc nhật ký Claude Code ----------
  function parseClaude(a, line) {
    let j; try { j = JSON.parse(line); } catch { return; }
    const t = Date.parse(j.timestamp || "") || now();
    const msg = j.message || {};
    if (j.type === "assistant") {
      mark(a, t);
      if (msg.stop_reason === "end_turn") { a.done.push({ t }); keep7(a.done); }
      for (const c of Array.isArray(msg.content) ? msg.content : []) {
        if (c.type === "text" && c.text && c.text.trim()) { a.lastText = clip(mask(c.text), 600); a.lastTail = mask(c.text).slice(-500); a.lastTextAt = t; }
        if (c.type === "tool_use") {
          const inp = c.input || {}, n = c.name || "";
          if (/SendMessage|send_message/.test(n)) {
            const to = agentFromId(inp.session_id || inp.to) || agentFromLabel(inp.to);
            const body = inp.message || "";
            if (to && to !== a.key && body) pushEvent({ t, kind: "msg", from: a.key, to, title: titleOf(body), body: clip(mask(body), 700) });
          }
          if (n === "AskUserQuestion" || n === "ExitPlanMode") {
            const q = n === "ExitPlanMode" ? "Duyệt kế hoạch trước khi làm" : ((inp.questions || []).map((x) => `${x.question} ${(x.options || []).map((o, i) => `(${String.fromCharCode(97 + i)}) ${o.label}`).join("; ")}`).join(" · ") || "Câu hỏi cho bạn");
            a.pendingAsk = { id: c.id, t, text: clip(mask(q), 300) };
          }
        }
      }
    }
    if (j.type === "user") {
      const content = msg.content;
      if (Array.isArray(content)) for (const x of content) if (x && x.type === "tool_result") {
        a.tools.push({ t, err: !!x.is_error }); if (a.tools.length > 5000) a.tools.splice(0, 1000);
        if (a.pendingAsk && x.tool_use_id === a.pendingAsk.id) a.pendingAsk = null; // bạn đã trả lời hộp hỏi
      }
      const txt = textOfContent(content);
      if (!txt) return;
      const m = txt.match(/<cross-session-message from="([^"]+)"(?: from-session="([^"]+)")?(?: from-name="([^"]+)")?[^>]*>\s*([\s\S]*)/);
      if (m) {
        const from = agentFromId(m[2]) || agentFromId(m[1]) || agentFromLabel(m[3]);
        const raw = m[4].replace(/<\/cross-session-message>[\s\S]*$/, "");
        if (from && from !== a.key) pushEvent({ t, kind: "msg", from, to: a.key, title: titleOf(raw), body: clip(mask(raw), 700) });
        return;
      }
      const typed = typeof content === "string" || (Array.isArray(content) && !content.some((x) => x.type === "tool_result"));
      const s = txt.trim();
      if (typed && !j.isMeta && s && !NOT_HUMAN.test(s)) { a.lastUserAt = t; ownerSays(a, t, s); }
    }
  }
  // ---------- đọc nhật ký Codex ----------
  function parseCodex(a, line) {
    if (line.length > 200000) return;
    let j; try { j = JSON.parse(line); } catch { return; }
    const t = Date.parse(j.timestamp || "") || now();
    const p = j.payload || {};
    if (j.type === "response_item" || j.type === "event_msg") mark(a, t);
    if (j.type === "response_item" && p.type === "message") {
      const txt = textOfContent(p.content);
      if (p.role === "assistant" && txt.trim()) { a.lastText = clip(mask(txt), 600); a.lastTail = mask(txt).slice(-500); a.lastTextAt = t; }
      if (p.role === "user" && txt.trim()) {
        const peer = txt.match(/\[PEER MESSAGE[^\]]*\]\s*([^\n(]+)/);
        const body = peer ? txt.slice(txt.indexOf(peer[0]) + peer[0].length) : txt;
        const tag = body.match(/\[(VIỆC|GẤP|BÁO|CHẶN|REVIEW|CẦN ANH)[^\n]*/);
        if (peer || tag) {
          const from = agentFromLabel(peer ? peer[1] : (body.match(/—\s*([^\n→]+)→/) || [])[1] || body);
          if (from && from !== a.key) pushEvent({ t, kind: "msg", from, to: a.key, title: titleOf(tag ? tag[0] : body), body: clip(mask(body), 700) });
        } else if (!NOT_HUMAN.test(txt.trim())) { a.lastUserAt = t; ownerSays(a, t, txt.trim()); }
      }
    }
    if (j.type === "response_item" && p.type === "function_call_output") {
      const out = typeof p.output === "string" ? p.output : JSON.stringify(p.output || "");
      a.tools.push({ t, err: /exit code:?\s*[1-9]|"exit_code":\s*[1-9]/i.test(out.slice(0, 400)) }); if (a.tools.length > 5000) a.tools.splice(0, 1000);
    }
    if (j.type === "event_msg") {
      if (p.type === "task_started") a.working = true;
      if (p.type === "task_complete") { a.working = false; a.done.push({ t }); keep7(a.done); }
    }
  }
  // ---------- đọc nhật ký Antigravity ----------
  function parseAntigravity(a, line) {
    if (line.length > 500000) return;
    let j; try { j = JSON.parse(line); } catch { return; }
    const t = Date.parse(j.created_at || "") || now();
    if (j.type === "USER_INPUT" && j.source === "USER_EXPLICIT") {
      const s = stripAntigravityEnvelope(j.content || "");
      if (a.pendingAsk) a.pendingAsk = null;
      if (s && !NOT_HUMAN.test(s)) {
        a.lastUserAt = t;
        a.working = true;
        ownerSays(a, t, s);
        if (a.autoName && /^Antigravity\s+[0-9a-f]{8}$/i.test(a.name)) {
          const first = s.split("\n").find((l) => l.trim());
          if (first) setName(a, clip(first.trim(), 40));
        }
      }
      return;
    }
    if (j.type === "PLANNER_RESPONSE") {
      mark(a, t);
      const txt = typeof j.content === "string" ? j.content.trim() : "";
      if (txt) {
        a.lastText = clip(mask(txt), 600);
        a.lastTail = mask(txt).slice(-500);
        a.lastTextAt = t;
      }
      const tcs = Array.isArray(j.tool_calls) ? j.tool_calls : [];
      for (const tc of tcs) {
        if (!tc || !tc.name) continue;
        a.tools.push({ t, err: j.status === "ERROR" });
        if (a.tools.length > 5000) a.tools.splice(0, 1000);
        const args = tc.args || {};
        if (/send_message|SendMessage/.test(tc.name)) {
          const rec = unquoteJsonValue(args.Recipient || args.to || args.session_id || "");
          const body = String(unquoteJsonValue(args.Message || args.message || "") || "");
          const to = agentFromId(rec) || agentFromLabel(rec);
          if (to && to !== a.key && body) pushEvent({ t, kind: "msg", from: a.key, to, title: titleOf(body), body: clip(mask(body), 700) });
        }
        if (tc.name === "ask_question") {
          const qs = unquoteJsonValue(args.questions) || [];
          const q = (Array.isArray(qs) ? qs : []).map((x) => `${x.question || ""} ${(x.options || []).map((o, i) => `(${String.fromCharCode(97 + i)}) ${typeof o === "string" ? o : o.label || ""}`).join("; ")}`).join(" · ") || "Câu hỏi cho bạn";
          a.pendingAsk = { id: String(j.step_index || t), t, text: clip(mask(q), 300) };
        }
      }
      if (j.status === "DONE" && tcs.length === 0) {
        a.working = false;
        a.done.push({ t });
        keep7(a.done);
      } else if (tcs.length > 0) {
        a.working = true;
      }
    }
  }
  function pollAgent(a) {
    if (!a.file) return;
    const st = safeStat(a.file); if (!st) return;
    a.mtime = st.mtimeMs;
    if (st.size === a.size) return;
    if (st.size < a.offset) a.offset = 0;
    let start = a.offset || Math.max(0, st.size - FIRST_READ);
    if (st.size - start > MAX_READ) start = st.size - MAX_READ;
    const jumped = start !== a.offset;
    const buf = readRange(a.file, start, st.size);
    const skip = jumped && start > 0 ? buf.indexOf(10) + 1 : 0;
    const lastNl = buf.lastIndexOf(10);
    if (lastNl < skip) return;
    a.offset = start + lastNl + 1; a.size = st.size;
    const parse = a.platform === "codex" ? parseCodex : a.platform === "antigravity" ? parseAntigravity : parseClaude;
    for (const line of buf.slice(skip, lastNl).toString("utf8").split("\n")) if (line) parse(a, line);
    if (a.platform === "claude") { // phiên con (subagent) đang chạy
      const sub = path.join(path.dirname(a.file), path.basename(a.file, ".jsonl"), "subagents");
      let n = 0; try { for (const f of fs.readdirSync(sub)) { const s = safeStat(path.join(sub, f)); if (s && now() - s.mtimeMs < 120000) n++; } } catch {}
      a.subActive = n;
    }
  }

  // ---------- lượt DEV (môi trường thử chung của đội) ----------
  let dev = { holder: null, holderLabel: null, holderSince: null, package: null, lastRows: [], weekRows: [], idleSince: null, queue: [], lastRowAt: null };
  let luotSig = "";
  function readDev() {
    let lock = null;
    try { const raw = fs.readFileSync(path.join(DATA, "DEV.lock"), "utf8").trim(); if (raw) lock = JSON.parse(raw); } catch {}
    dev.holder = null; dev.package = null; dev.holderSince = null; dev.holderLabel = null;
    if (lock) {
      dev.holderLabel = clip(mask(lock.owner || ""), 60);
      dev.holder = agentFromId((String(lock.owner || "").match(/[0-9a-f]{8}(?:-[0-9a-f]{4})?/) || [])[0]) || agentFromLabel(lock.owner);
      dev.package = clip(mask(lock.package || ""), 80);
      dev.holderSince = Date.parse(lock.started || "") || null;
    }
    const f = path.join(DATA, "DEV-LUOT.jsonl"), st = safeStat(f);
    const sig = st ? st.mtimeMs + ":" + st.size : "-";
    if (sig !== luotSig) {
      luotSig = sig;
      const ev = []; if (st) for (const l of fs.readFileSync(f, "utf8").replace(/^\uFEFF/, "").split("\n")) { try { if (l.trim()) ev.push(JSON.parse(l)); } catch {} }
      const who = (e) => agentFromId((String(e.phien || "").match(/[0-9a-f]{8}(?:-[0-9a-f]{4})?/) || [])[0]) || agentFromLabel(e.vai || e.phien);
      const same = (a, b) => (a.phien && a.phien === b.phien) || (a.vai && b.vai && boDau(a.vai) === boDau(b.vai));
      const open = ev.filter((e, i) => e.su_kien === "cho" && !ev.slice(i + 1).some((x) => (x.su_kien === "lay" || x.su_kien === "huy_cho") && same(e, x)));
      dev.queue = open.map((e, i) => ({ n: String(i + 1), what: clip(mask(`${e.goi || "?"}${e.sha ? " · " + String(e.sha).slice(0, 8) : ""}`), 70), who: clip(mask(e.vai || e.phien || ""), 60), since: Date.parse(e.luc || "") || null, agent: who(e) }));
      const rows = [];
      ev.forEach((e, i) => {
        if (e.su_kien !== "lay") return;
        const end = ev.slice(i + 1).find((x) => x.su_kien === "nha" && same(e, x));
        const t0 = Date.parse(e.luc || "") || 0, t1 = end ? Date.parse(end.luc || "") || t0 : null;
        const fail = !!(end && /hỏng|hong|fail|chưa đạt|chua dat|quay về|rollback/i.test(String(end.ket_qua || "")));
        rows.push({ start: t0, end: t1, t: t1 || t0, agent: who(e), who: clip(mask(e.vai || e.phien || ""), 60), pkg: clip(mask(e.goi || "?"), 60),
          state: end ? clip(mask(`NHẢ · ${end.ket_qua || ""}`), 140) : "ĐANG GIỮ", result: end ? clip(mask(end.ghi_chu || ""), 260) : "", released: !!end, fail,
          usd: end && end.usd != null && !isNaN(+end.usd) ? +end.usd : null, raw: clip(mask(JSON.stringify(e)), 300), loai: e.loai || "" });
      });
      dev.lastRows = rows.slice(-40);
      dev.weekRows = rows.filter((r) => r.start >= now() - 7 * 86400000);
    }
    dev.lastRowAt = dev.lastRows.length ? Math.max(...dev.lastRows.map((r) => r.t)) : null;
    dev.idleSince = dev.holder || dev.holderLabel ? null : dev.lastRowAt;
  }

  // ---------- việc ưu tiên + gói việc ----------
  let uu = { sig: "", data: null, err: null };
  function readUuTien() {
    const f = path.join(DATA, "UU-TIEN.json"), st = safeStat(f), sig = st ? st.mtimeMs + ":" + st.size : "-";
    if (sig === uu.sig) return uu;
    try { uu = { sig, data: JSON.parse(fs.readFileSync(f, "utf8").replace(/^\uFEFF/, "")), err: null }; }
    catch (e) { uu = { sig, data: null, err: st ? "UU-TIEN.json đọc lỗi: " + clip(String(e.message || e), 120) : "chưa có data/UU-TIEN.json" }; }
    return uu;
  }
  let tasks = [], tasksSig = "";
  const SEEN_FILE = path.join(DATA, ".task-seen.json");
  const itemSeen = new Map(Object.entries((() => { try { return JSON.parse(fs.readFileSync(SEEN_FILE, "utf8")); } catch { return {}; } })()));
  function readTasks() {
    const d = readUuTien().data;
    const defs = d && Array.isArray(d.dang_lam) ? d.dang_lam.map((v) => ({ n: v.thu_tu, name: v.viec, items: v.muc || [] })) : [];
    const pkgs = [...new Set(defs.flatMap((t) => t.items.map((x) => x.split(":")[0])))];
    const sig = uu.sig + "|" + pkgs.map((p) => { const st = safeStat(path.join(DATA, "goi", p, "viec.json")); return st ? st.mtimeMs + ":" + st.size : "-"; }).join("|") + "|" + luotSig;
    if (sig === tasksSig) return;
    tasksSig = sig;
    const cache = {};
    const item = (pkg, id) => {
      if (!cache[pkg]) { try { cache[pkg] = JSON.parse(fs.readFileSync(path.join(DATA, "goi", pkg, "viec.json"), "utf8").replace(/^\uFEFF/, "")); } catch { cache[pkg] = { viec: [] }; } }
      return (cache[pkg].viec || []).find((v) => v.id === id);
    };
    const mtimeOf = (t) => { let m = 0; for (const x of t.items) { const st = safeStat(path.join(DATA, "goi", x.split(":")[0], "viec.json")); if (st) m = Math.max(m, st.mtimeMs); } return m || now(); };
    tasks = defs.map((t) => {
      const its = t.items.map((x) => { const [p, id] = x.split(":"); return { id, pkg: p, v: item(p, id) }; });
      let state = "todo", lanSua = 0;
      if (its.length) {
        const done = its.filter((x) => x.v && x.v.dat).length;
        state = done === its.length ? "done" : done > 0 || its.some((x) => x.v && (x.v.sha || x.v.lan_sua || x.v.bang_chung)) ? "doing" : "todo";
        lanSua = Math.max(0, ...its.map((x) => (x.v && x.v.lan_sua) || 0));
      }
      const open = its.find((x) => x.v && !x.v.dat) || its[0];
      const gc = String((open && open.v && open.v.ghi_chu) || "");
      let changedAt = 0;
      for (const x of its) {
        const k = t.n + ":" + x.pkg + ":" + x.id, sg = JSON.stringify(x.v || null), old = itemSeen.get(k);
        if (!old) itemSeen.set(k, { sg, at: mtimeOf(t) }); else if (old.sg !== sg) itemSeen.set(k, { sg, at: now() });
        changedAt = Math.max(changedAt, itemSeen.get(k).at);
      }
      const holder = agentFromLabel((d.dang_lam.find((v) => v.thu_tu === t.n) || {}).chu);
      return { n: t.n, name: t.name, pkgs: [...new Set(its.map((x) => x.pkg))], state, lanSua, parts: its.map((x) => ({ id: x.id, dat: !!(x.v && x.v.dat) })),
        evidence: clip(mask(String((its.find((x) => x.v && x.v.bang_chung) || {}).v?.bang_chung || "")), 160), openId: open ? open.id : null, holderKey: holder, note: clip(mask(gc.split(" | ").pop()), 240), changedAt };
    });
    try { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(SEEN_FILE, JSON.stringify(Object.fromEntries(itemSeen))); } catch {}
  }

  // ---------- máy: ổ đĩa + dịch vụ Docker (tùy chọn) ----------
  const badSince = {};
  const RETIRED = new Set(CFG.dockerRetired || []);
  let sys = { cFreeGB: null, diskLabel: path.parse(os.homedir()).root, containers: [], checkedAt: 0 };
  function readSys() {
    try { const s = fs.statfsSync(path.parse(os.homedir()).root); sys.cFreeGB = +(s.bavail * s.bsize / 1e9).toFixed(1); } catch {}
    if (!CFG.dockerFilter) return;
    execFile("docker", ["ps", "-a", "--filter", CFG.dockerFilter, "--format", "{{.Names}}|{{.State}}|{{.Status}}"], { timeout: 8000, windowsHide: true }, (err, out) => {
      if (err) return;
      sys.containers = out.trim().split("\n").filter(Boolean).map((l) => { const [n, s, st] = l.split("|"); const pre = String(CFG.dockerStrip || ""), name = pre && n.startsWith(pre) ? n.slice(pre.length) : n; return { name, state: s, status: st, retired: RETIRED.has(name) && s !== "running" }; });
      sys.checkedAt = now();
    });
  }

  // ---------- cần anh làm ----------
  let canAnh = [], canAnhSig = "";
  function readCanAnh() {
    const f = path.join(DATA, "CAN-ANH.md"), st = safeStat(f); if (!st) { canAnh = []; return; }
    const sig = st.mtimeMs + ":" + st.size; if (sig === canAnhSig) return; canAnhSig = sig;
    const rows = [];
    for (const l of fs.readFileSync(f, "utf8").split("\n")) {
      if (!/^\|\s*CA-/.test(l)) continue;
      const c = l.split("|").map((x) => x.trim());
      const at = Date.parse((c[2] || "").replace(" ", "T")) || st.mtimeMs;
      const who = agentFromId((c[3].match(/\b([0-9a-f]{8})\b/) || [])[1]) || agentFromLabel(c[3]);
      rows.push({ id: c[1], since: at, whoLabel: clip(mask(c[3]), 60), who, text: clip(mask(c[4]), 300), options: clip(mask(c[5] || ""), 300), open: /^CHỜ/i.test(c[6] || "") });
    }
    canAnh = rows;
  }
  const ASK_REPLY = /\?|anh (duyệt|chọn|quyết|cho phép|xác nhận|có muốn)|nói "?làm đi|anh trả lời|(chờ|đợi) anh (duyệt|quyết|trả lời|chọn|xác nhận)/i;
  const ASK_EXPLICIT = /(chờ|cần|xin|hỏi|đợi)\s+(CEO|anh|chị|sếp)\s+(quyết|duyệt|xác nhận|trả lời|cho phép|chọn|bấm|làm|đăng nhập|cấp|mở)|CEO (cần|phải) (quyết|duyệt|xác nhận)|\b(cần|chờ) (CEO|sếp)\b/i;
  const NOT_ASK = /không (cần|chờ|phải chờ) (CEO|anh|sếp)|không chờ CEO/i;
  function askLine(text, re) {
    const parts = String(text).split(/(?<=[.?!])\s+|\n+/).map((x) => x.trim()).filter((x) => x && (x.match(/\|/g) || []).length < 2);
    for (let i = parts.length - 1; i >= 0; i--) if (re.test(parts[i])) return clip(parts[i], 240);
    return clip(parts[parts.length - 1] || "", 240);
  }
  function ceoAsks(out, t) {
    const items = [], seen = new Set();
    for (const r of canAnh) if (r.open) { items.push({ kind: "so", exact: true, who: r.who, whoLabel: r.whoLabel, since: r.since, text: r.text + (r.options ? " — " + r.options : ""), id: r.id, answered: !!(r.who && byKey[r.who] && byKey[r.who].lastUserAt > r.since) }); if (r.who) seen.add(r.who); }
    for (const s of out) { const a = byKey[s.key]; if (a && a.pendingAsk && t - a.pendingAsk.t < 24 * 3600000) { items.push({ kind: "hoi", exact: true, who: s.key, since: a.pendingAsk.t, text: a.pendingAsk.text }); seen.add(s.key); } }
    for (const e of events) if (t - e.t < 24 * 3600000 && /^\s*\[CẦN ANH/.test(e.body || e.title) && !seen.has(e.from)) { items.push({ kind: "tag", exact: true, who: e.from, to: e.to, since: e.t, text: clip(e.body || e.title, 300) }); seen.add(e.from); }
    for (const s of out) {
      const a = byKey[s.key]; if (!a || a.ceo || !a.lastTail || s.status === "active" || seen.has(s.key)) continue;
      const tail = a.lastTail.split(/(?<=[.?!])\s+/).filter((x) => (x.match(/\|/g) || []).length < 2).join(" ");
      if (a.lastUserAt && a.lastTextAt > a.lastUserAt && t - a.lastTextAt < 24 * 3600000 && /\b(anh|chị|sếp|CEO)\b/i.test(tail) && ASK_REPLY.test(tail.slice(-300)) && !NOT_ASK.test(tail)) {
        items.push({ kind: "reply", guess: true, who: s.key, since: a.lastTextAt, text: askLine(tail, /\?|anh (duyệt|chọn|quyết|cho phép|xác nhận|muốn|nói)|làm đi/i) }); seen.add(s.key);
      } else if (t - a.lastTextAt < 12 * 3600000 && ASK_EXPLICIT.test(tail) && !NOT_ASK.test(tail)) {
        items.push({ kind: "stop", guess: true, who: s.key, since: a.lastTextAt, text: askLine(tail, ASK_EXPLICIT) }); seen.add(s.key);
      }
    }
    return items.sort((x, y) => (!!x.guess - !!y.guess) || x.since - y.since).slice(0, 14);
  }

  // ---------- tiền AI theo ngày ----------
  function moneyOf(week, t) {
    const day0 = new Date(t); day0.setHours(0, 0, 0, 0);
    const est = perf.costDays(CFG.prices, 7);
    const days = Array.from({ length: 7 }, (_, i) => ({ t: +day0 - (6 - i) * 86400000, usd: est[i] || 0, est: est[i] || 0, turns: 0, unknown: 0, calls: 0 }));
    const today = [];
    for (const r of week) {
      if (!r.end) continue;
      const d = days.find((x) => r.end >= x.t && r.end < x.t + 86400000); if (!d) continue;
      if (r.usd == null) d.unknown++; else { d.usd += r.usd; d.turns++; }
      if (d === days[6]) today.push({ t: r.end, who: r.agent, pkg: r.pkg, usd: r.usd });
    }
    return { cap: CFG.aiCapUsd, days, today: today.reverse(), source: "uoc-tinh", note: "ước tính theo giá API trong config.json + tiền lượt DEV tự khai" };
  }

  // ---------- ảnh chụp trạng thái ----------
  function statusOf(a, t) {
    if (a.ceo) return a.ceoLastAt && t - a.ceoLastAt < 15 * 60000 ? "active" : "away";
    const quiet = a.mtime ? t - a.mtime : Infinity;
    let st = quiet < 90000 || (a.working && quiet < 10 * 60000) ? "active" : quiet < 6 * 3600000 ? "idle" : "away";
    if (a.platform === "claude") { const L = live.get(a.id); if (L) st = L.busy ? "active" : "idle"; else if (live.size && quiet > 90000) st = "away"; }
    else if (a.platform === "antigravity") {
      const A = antigravityLive.get(a.id);
      if (A && A.busy) st = "active";
    }
    return st;
  }
  function snapshot() {
    const t = now(), nowMin = Math.floor(t / 60000);
    const out = agents.map((a) => {
      let status = statusOf(a, t), where = a.room, flag = null;
      if (dev.holder === a.key) { where = "dev"; status = "active"; }
      const qi = (dev.queue || []).findIndex((q) => q.agent === a.key);
      const lt = a.ceo ? a.ceoLastText : a.lastText;
      if (!a.ceo && /\[CHẶN\]|bị chặn|đang chặn|\bblocked\b/i.test(lt) && status !== "active" && status !== "away" && t - a.lastTextAt < 3 * 3600000) flag = "blocked";
      else if (qi >= 0 && where !== "dev") { flag = "waiting"; where = "g1q"; }
      const L = !a.ceo && live.get(a.id);
      return { key: a.key, name: a.name, role: a.role, platform: a.platform, room: a.room, where, status, flag, session: a.ceo ? null : a.id.slice(0, 8), host: L && L.host ? L.host.slice(0, 8) : null,
        lastText: lt, lastTextAt: a.ceo ? a.ceoLastAt : a.lastTextAt, queuePos: qi >= 0 ? qi + 1 : null, lastActive: a.ceo ? a.ceoLastAt : a.mtime, sub: a.subActive || 0,
        hasJournal: !!(a.file || a.ceo), isNew: !a.ceo && t - a.createdAt < 3600000, createdAt: a.ceo ? null : a.createdAt, hist: Array.from({ length: 60 }, (_, i) => (a.mins.has(nowMin - 59 + i) ? 1 : 0)) };
    });
    const recent = events.filter((e) => t - e.t < 24 * 3600000);
    const alerts = [];
    if (dev.idleSince && t - dev.idleSince > 15 * 60000 && dev.queue.length) alerts.push({ level: "warn", text: `DEV trống ${Math.round((t - dev.idleSince) / 60000)} phút, hàng chờ còn ${dev.queue.length} gói` });
    if (dev.holderSince && t - dev.holderSince > 60 * 60000) alerts.push({ level: "warn", text: `Lượt DEV đã giữ ${Math.round((t - dev.holderSince) / 60000)} phút (${dev.holderLabel || "?"})` });
    for (const a of out) if (a.flag === "blocked") alerts.push({ level: "bad", text: `${a.name} đang bị chặn` });
    if (sys.cFreeGB != null && sys.cFreeGB < 15) alerts.push({ level: "bad", text: `Ổ ${sys.diskLabel} chỉ còn ${sys.cFreeGB} GB` });
    const bad = sys.containers.filter((c) => !c.retired && (c.state !== "running" || /unhealthy|Restarting/i.test(c.status)));
    for (const c of sys.containers) { if (bad.includes(c)) badSince[c.name] = badSince[c.name] || t; else delete badSince[c.name]; }
    const longBad = bad.filter((c) => t - badSince[c.name] >= 180000);
    if (longBad.length) alerts.push({ level: "bad", text: `DEV: ${longBad.map((c) => c.name).join(", ")} không khỏe hơn 3 phút` });
    const team = Array.from({ length: 180 }, (_, i) => {
      const m = nowMin - 179 + i;
      let c = 0, cx = 0, cl = 0, ag = 0;
      for (const a of agents) if (!a.ceo && a.mins.has(m)) {
        c++;
        if (a.platform === "codex") cx++;
        else if (a.platform === "antigravity") ag++;
        else cl++;
      }
      return { t: m * 60000, n: c, codex: cx, claude: cl, antigravity: ag };
    });
    const day0 = new Date(); day0.setHours(0, 0, 0, 0);
    const turns = dev.lastRows.filter((r) => r.end && r.end >= +day0).map((r) => ({ start: r.start, end: r.end, agent: r.agent, who: r.who, pkg: r.pkg, fail: r.fail, state: r.state }));
    if (dev.holderSince) turns.push({ start: dev.holderSince, end: t, agent: dev.holder, who: dev.holderLabel, pkg: dev.package, fail: false, live: true, state: "đang giữ lượt" });
    const week = dev.weekRows || [];
    const unclosed = week.filter((r) => !r.end && !(dev.holderLabel && r === week[week.length - 1]));
    const match = { total: week.length, ok: week.length - unclosed.length, pct: week.length ? Math.floor(((week.length - unclosed.length) / week.length) * 100) : 100, bad: unclosed.slice(-20).map((r) => ({ t: r.start, pkg: r.pkg, why: "lấy lượt mà chưa nhả", line: r.raw })) };
    const st = Object.fromEntries(out.map((a) => [a.key, a]));
    const taskView = tasks.map((tk) => {
      const rows = week.filter((r) => tk.pkgs.some((p) => r.pkg === p || r.pkg.startsWith(p)));
      const lt = rows[rows.length - 1] || null;
      const holder = tk.holderKey || (lt && lt.agent) || null;
      const since = Math.max(tk.changedAt || 0, lt ? lt.t : 0);
      const stale = tk.state !== "done" && since && t - since > 3600000 && !(holder && st[holder] && st[holder].status === "active");
      const liveT = !!(lt && !lt.end && (dev.holder || dev.holderLabel) && lt === week[week.length - 1]);
      return { ...tk, holder, since, stale, last: lt && { t: lt.t, live: liveT, unread: !lt.end && !liveT, fail: lt.fail, pkg: lt.pkg, state: lt.state, result: lt.result, usd: lt.usd, raw: !lt.end && !liveT ? lt.raw : null } };
    });
    const ht = hopthuNow();
    if (ht.tong && ht.tong.nhac2) alerts.push({ level: "bad", text: `Hòm thư: ${ht.tong.nhac2} tin đã đọc lại ≥ 2 lần mà chưa xong` });
    const { weekRows, ...devOut } = dev;
    return { now: t, title: CFG.title, subtitle: CFG.subtitle, ownerName: CFG.ownerName, tinKet: { at: t, items: [] }, agents: out, dev: { ...devOut, lastRows: dev.lastRows.slice(-25), match },
      turns, team, tasks: taskView, sys, events: recent.slice(-300), alerts, asks: ceoAsks(out, t), money: moneyOf(week, t) };
  }

  // hòm thư, tổng quan, sổ sách: tính lại vài giây/lần, file chỉ đọc lại khi đổi
  let hopthuCache = { at: 0, data: null };
  function hopthuNow() {
    if (!hopthuCache.data || now() - hopthuCache.at >= 10000) { try { hopthuCache = { at: now(), data: hopthu.build(DATA, mask, agents) }; } catch (e) { hopthuCache = { at: now(), data: { error: String(e.message || e), roles: [], tong: {}, pending: { n: 0, ds: [] } } }; } }
    return hopthuCache.data;
  }
  let tqCache = { at: 0, json: null };
  function tongquanNow() {
    if (tqCache.json && now() - tqCache.at < 3000) return tqCache.json;
    let json;
    try { const u = readUuTien(); json = JSON.stringify(tongquan.build({ uu: u.data, uuErr: u.err, snap: snapshot(), ht: hopthuNow(), dataDir: DATA, mask, clip })); }
    catch (e) { json = JSON.stringify({ error: clip(mask(String(e.message || e)), 200), rows: [], bots: [] }); }
    tqCache = { at: now(), json }; return json;
  }
  let docsCache = { at: 0, json: null };
  function docsNow() {
    if (docsCache.json && now() - docsCache.at < 1500) return docsCache.json;
    const s = snapshot();
    const d = docs.build(CFG, DATA, mask, maskDoc, { tasks: s.tasks, asks: s.asks, dev: { holder: s.dev.holder, holderLabel: s.dev.holderLabel, package: s.dev.package, holderSince: s.dev.holderSince, idleSince: s.dev.idleSince, queue: s.dev.queue },
      agents: s.agents.map((a) => ({ key: a.key, name: a.name, session: a.session, host: a.host, status: a.status, room: a.room, platform: a.platform, role: a.role })) });
    docsCache = { at: now(), json: JSON.stringify(d) }; return docsCache.json;
  }

  // ---------- máy chủ web + vòng lặp ----------
  const clients = new Set(), perfClients = new Set();
  let perfCache = null;
  const perfNow = () => { if (!perfCache || now() - perfCache.at > 1500) perfCache = { at: now(), data: perf.compute(agents.filter((a) => !a.ceo), snapshot().agents, events, dev.weekRows || []) }; return perfCache.data; };
  function tick() { for (const a of agents) { try { pollAgent(a); } catch {} } try { readDev(); } catch {} }

  let started = false;
  const timers = [];
  function ensureStarted() {
    if (started) return;
    started = true;
    try { readLive(); } catch {}
    try { discover(); } catch {}
    tick();
    try { readTasks(); } catch {}
    try { readSys(); } catch {}
    try { readCanAnh(); } catch {}
    perf.scanAll(agents.filter((a) => !a.ceo));
    timers.push(
      setInterval(() => { try { readLive(); } catch {} }, 3000),
      setInterval(() => { try { discover(); } catch (e) { console.error("discover:", e.message); } }, 5000),
      setInterval(tick, 1000),
      setInterval(() => { try { readTasks(); } catch {} try { readCanAnh(); } catch {} }, 1000),
      setInterval(readSys, 15000),
      setInterval(() => perf.scanAll(agents.filter((a) => !a.ceo)), 3000),
      setInterval(() => { if (!clients.size) return; const d = "data: " + JSON.stringify(snapshot()) + "\n\n"; for (const r of clients) r.write(d); }, 1000),
      setInterval(() => { if (!perfClients.size) return; const d = "data: " + JSON.stringify(perfNow()) + "\n\n"; for (const r of perfClients) r.write(d); }, 2000),
    );
    for (const tm of timers) if (tm && typeof tm.unref === "function") tm.unref();
  }
  function close() {
    while (timers.length) clearInterval(timers.pop());
    for (const r of clients) { try { r.end(); } catch {} }
    for (const r of perfClients) { try { r.end(); } catch {} }
    clients.clear();
    perfClients.clear();
    started = false;
  }

  const KEY = String(CFG.accessKey || "");
  const keyHash = KEY ? crypto.createHash("sha256").update(KEY).digest("hex").slice(0, 32) : "";
  const sameKey = (x) => { const a = Buffer.from(String(x || "")), b = Buffer.from(KEY); return a.length === b.length && crypto.timingSafeEqual(a, b); };
  function authed(req, url) {
    if (!KEY) return true;
    const ck = (req.headers.cookie || "").split(/;\s*/).find((c) => c.startsWith("vpk="));
    return (ck && ck.slice(4) === keyHash) || sameKey(url.searchParams.get("key"));
  }
  const LOGIN = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Văn phòng AI</title>
<body style="margin:0;height:100vh;display:grid;place-items:center;background:#05070a;color:#eee;font-family:system-ui,sans-serif">
<form method="get" style="display:grid;gap:10px;width:min(320px,90vw)"><b style="font-size:18px">Nhập khóa xem văn phòng</b>
<input name="key" type="password" autofocus style="padding:12px;border-radius:10px;border:1px solid #333;background:#111;color:#eee;font-size:16px">
<button style="padding:12px;border-radius:10px;border:0;background:#ecc970;font-weight:700;font-size:15px">Vào xem</button></form></body>`;
  const json = (res, body) => { res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-cache" }); res.end(typeof body === "string" ? body : JSON.stringify(body)); };
  function sse(req, res, set, first) {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.write("data: " + JSON.stringify(first) + "\n\n"); set.add(res); req.on("close", () => set.delete(res));
  }

  function handleRequest(req, res, subUrl) {
    ensureStarted();
    const url = subUrl || new URL(req.url, "http://x");
    if (!authed(req, url)) { res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" }); return res.end(LOGIN); }
    if (KEY && url.searchParams.has("key")) { res.writeHead(302, { "Set-Cookie": `vpk=${keyHash}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`, Location: url.pathname }); return res.end(); }
    if (url.pathname === "/events") return sse(req, res, clients, snapshot());
    if (url.pathname === "/state") return json(res, snapshot());
    if (url.pathname === "/perf-events") return sse(req, res, perfClients, perfNow());
    if (url.pathname === "/perf") return json(res, perfNow());
    if (url.pathname === "/hopthu") return json(res, hopthuNow());
    if (url.pathname === "/tongquan") return json(res, tongquanNow());
    if (url.pathname === "/docs") return json(res, docsNow());
    if (url.pathname.startsWith("/chat/")) {
      chat.handle(req, res, url, { CFG, DATA, agentByKey: (k) => byKey[k], onEvent: pushEvent, ht: hopthuNow }).then((r) => { if (r === false) { res.writeHead(404); res.end(); } }).catch(() => { if (!res.headersSent) { res.writeHead(500); res.end(); } });
      return;
    }
    const file = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "");
    const p = path.join(ROOT, "public", path.normalize(file).replace(/^(\.\.[\\/])+/, ""));
    if (!p.startsWith(path.join(ROOT, "public"))) { res.writeHead(403); return res.end(); }
    fs.readFile(p, (err, buf) => {
      if (err) { res.writeHead(404); return res.end("không có"); }
      res.writeHead(200, { "Content-Type": MIME[path.extname(p)] || "application/octet-stream", "Cache-Control": "no-cache" }); res.end(buf);
    });
  }

  return { CFG, DATA, ensureStarted, close, handleRequest, snapshot, perfNow };
}

module.exports = { createOffice3dApp, stripAntigravityEnvelope };

if (require.main === module) {
  const app = createOffice3dApp();
  if (!app) { console.error("Chưa có config.json. Chạy trước: npm run setup"); process.exit(1); }
  app.ensureStarted();
  const PORT = Number(process.env.PORT || app.CFG.port);
  const PROJECTS = (app.CFG.projects || []).filter(Boolean);
  http.createServer((req, res) => app.handleRequest(req, res)).listen(PORT, app.CFG.host, () => {
    console.log(`\n  ${app.CFG.title} đang chạy`);
    console.log(`  Mở trên máy này:  http://localhost:${PORT}`);
    console.log(`  Dự án theo dõi:   ${PROJECTS.length ? PROJECTS.join(", ") : "mọi dự án trên máy"}`);
    console.log(`  Sổ điều phối:     ${app.DATA}`);
    console.log(`  Khóa xem:         ${app.CFG.accessKey ? "đang bật" : "tắt (chỉ máy này xem được nếu host = 127.0.0.1)"}\n`);
  });
}
