// Tổng quan cho Giám đốc: việc gì, để làm gì, ai làm, tới đâu, nghẽn ở đâu, các bot đang làm gì.
// CHỈ ĐỌC: thứ tự việc từ data/UU-TIEN.json, trạng thái từ data/goi/<gói>/viec.json (máy chủ đã đọc sẵn ở snapshot.tasks),
// dòng mới nhất của data/goi/<gói>/tien-do.md, hòm thư từ lib/hopthu.js.
"use strict";
const fs = require("fs");
const path = require("path");

const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const bare = (s) => norm(s).replace(/^(claude|codex|antigravity)-/, "");
// "Codex WordPress", "G1", "tro-ly-dieu-phoi" → phiên trong văn phòng (tên trùng hẳn, hoặc tên phiên bắt đầu bằng nhãn: "G1" → "G1 · Kiểm tra…")
function matchAgent(agents, label) {
  const n = bare(label); if (!n) return null;
  let pre = null;
  for (const a of agents) { const m = bare(a.name); if (m === n) return a; if (!pre && m.startsWith(n + "-")) pre = a; }
  return pre;
}
const owners = (s) => String(s || "").split(/\s*(?:\+|,|&|\bvà\b)\s*/).map((x) => x.trim()).filter(Boolean);

// Dòng tiến độ mới nhất: chỉ đọc 512 KB cuối tệp, đọc lại khi tệp đổi. Ưu tiên dòng nhắc đúng mã mục (SG2, D9R…).
const tailCache = new Map();
function tailLines(file) {
  let st; try { st = fs.statSync(file); } catch { return null; }
  const sig = st.mtimeMs + ":" + st.size, c = tailCache.get(file);
  if (c && c.sig === sig) return c;
  const len = Math.min(st.size, 512 * 1024), buf = Buffer.alloc(len);
  const fd = fs.openSync(file, "r"); try { fs.readSync(fd, buf, 0, len, st.size - len); } finally { fs.closeSync(fd); }
  const lines = buf.toString("utf8").split("\n").map((l) => l.replace(/\r$/, "").trim()).filter((l) => l && !/^[-|:\s]+$/.test(l));
  if (st.size > len) lines.shift(); // dòng đầu có thể bị cắt giữa
  const v = { sig, lines, at: st.mtimeMs }; tailCache.set(file, v); return v;
}
function lastProgress(dataDir, muc, mask, clip) {
  let best = null;
  for (const m of muc) {
    const [pkg, id] = m.split(":"), t = tailLines(path.join(dataDir, "goi", pkg, "tien-do.md"));
    if (!t || !t.lines.length) continue;
    const re = id ? new RegExp("\\b" + id.replace(/[^A-Za-z0-9-]/g, "") + "\\b") : null;
    const j = re ? [...t.lines].reverse().findIndex((l) => re.test(l)) : -1;
    const hit = j >= 0, line = t.lines[hit ? t.lines.length - 1 - j : t.lines.length - 1].replace(/^#+\s*|^[-*]\s+/, "");
    // dòng nhắc đúng mã mục thắng dòng cuối gói (gói chung nhiều mục, vd sua-goc-tra-loi SG1…SG6)
    if (!best || (hit && !best.hit) || (hit === best.hit && t.at > best.at)) best = { pkg, id: id || null, hit, text: clip(mask(line), 260), at: t.at };
  }
  return best;
}

function build({ uu, uuErr, snap, ht, dataDir, mask, clip }) {
  const t = snap.now, agents = snap.agents.filter((a) => a.platform !== "human");
  const taskBy = new Map((snap.tasks || []).map((x) => [x.n, x]));
  const work = new Map(); // phiên → các việc đang làm chưa đạt
  const rows = (uu ? uu.dang_lam || [] : []).slice().sort((a, b) => a.thu_tu - b.thu_tu).map((v) => {
    const tk = taskBy.get(v.thu_tu) || {};
    const done = tk.state === "done", due = Date.parse(v.han || "") || null;
    const own = owners(v.chu).map((o) => { const a = matchAgent(agents, o); return { label: o, key: a ? a.key : null }; });
    if (!done) for (const o of own) if (o.key) { if (!work.has(o.key)) work.set(o.key, []); work.get(o.key).push(v.thu_tu); }
    return {
      n: v.thu_tu, viec: mask(v.viec || ""), deLamGi: mask(v.de_lam_gi || ""), muc: v.muc || [], chu: own, duyet: mask(v.duyet || ""),
      state: tk.state || "todo", parts: tk.parts || [], lanSua: tk.lanSua || 0, changedAt: tk.changedAt || 0, stale: !!tk.stale,
      dev: tk.last ? { t: tk.last.t, live: tk.last.live, fail: tk.last.fail, pkg: clip(mask(tk.last.pkg || ""), 80), state: tk.last.state } : null,
      tienDo: lastProgress(dataDir, v.muc || [], mask, clip), can: mask(v.can || ""), han: due, quaHan: !!(due && !done && t > due),
    };
  });
  const mail = new Map(); // phiên → số tin chưa đóng
  for (const r of ht.roles || []) { const a = matchAgent(agents, r.vai); if (!a) continue; const m = mail.get(a.key) || { open: 0, nhac2: 0, roles: [] }; m.open += r.open; m.nhac2 += r.nhac2 || 0; m.roles.push(r.vai); mail.set(a.key, m); }
  const bots = agents.map((a) => {
    const idleMin = a.status === "active" ? 0 : a.lastActive ? Math.round((t - a.lastActive) / 60000) : null;
    const m = mail.get(a.key) || { open: 0, nhac2: 0, roles: [] }, w = work.get(a.key) || [];
    const hasWork = w.length > 0 || m.open > 0;
    return {
      key: a.key, name: a.name, platform: a.platform, role: a.role, status: a.status, where: a.where, idleMin,
      lastText: clip(String(a.lastText || "").replace(/\s+/g, " "), 220), lastTextAt: a.lastTextAt || 0,
      mail: m.open, nhac2: m.nhac2, viec: w, dev: snap.dev.holder === a.key,
      ranhConViec: a.status !== "active" && hasWork && idleMin != null && idleMin >= 10,
      im2h: idleMin != null && idleMin >= 120 && a.status !== "away", hasWork,
    };
  }).filter((b) => b.hasWork || b.status === "active" || b.status === "idle" || (b.idleMin != null && b.idleMin < 24 * 60))
    .sort((x, y) => (y.ranhConViec - x.ranhConViec) || ((y.im2h && y.hasWork) - (x.im2h && x.hasWork)) || ((y.status === "active") - (x.status === "active")) || (y.viec.length - x.viec.length) || ((x.idleMin || 0) - (y.idleMin || 0)));
  const today = snap.money && snap.money.days ? snap.money.days[snap.money.days.length - 1] : null;
  const d = snap.dev || {};
  return {
    at: t, uu: uu ? { capNhat: Date.parse(uu.cap_nhat || "") || null, nguoiGhi: mask(uu.nguoi_ghi || "") } : null, uuErr: uuErr || null,
    rows, tamDung: (uu ? uu.tam_dung || [] : []).map((x) => ({ viec: mask(x.viec || ""), lyDo: mask(x.ly_do || ""), tu: x.tu || "" })), bots,
    dev: { holder: d.holder || null, holderName: d.holder && agents.find((a) => a.key === d.holder) ? agents.find((a) => a.key === d.holder).name : null, holderLabel: d.holderLabel ? mask(d.holderLabel) : null, package: d.package ? mask(d.package) : null, since: d.holderSince || null, queue: (d.queue || []).length },
    money: today ? { usd: today.usd, cap: snap.money.cap, source: snap.money.source, unknown: today.unknown || 0, note: snap.money.note || null } : null,
    mailTong: ht.tong || {},
  };
}

module.exports = { build, matchAgent };
