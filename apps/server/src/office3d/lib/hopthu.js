// Hòm thư của đội (chỉ đọc): data/hop-thu/<vai>.jsonl, mỗi dòng một sự kiện theo mã tin ht-…:
//   {"su_kien":"tin","id":"ht-…","luc":"…","tu":"Quản lý","toi":"Kỹ sư Backend","tin":"[VIỆC] …"}
//   {"su_kien":"go","id":"ht-…","luc":"…","da_gui":true}     ← người nhận đã đọc (vp tiep); đọc lại lần nữa = bị nhắc
//   {"su_kien":"nhac","ids":["ht-…"],"luc":"…"}             ← nhắc lại (tùy chọn)
//   {"su_kien":"xong","id":"ht-…","luc":"…","ghi_chu":"…"}   ← người nhận làm xong (vp xong)
// Mỗi tệp chỉ đọc lại khi đổi (mtime + size). Công cụ ghi: tools/vp.js gui / tiep / xong.
"use strict";
const fs = require("fs");
const path = require("path");

const HOUR = 3600000, NHAC_TOI_DA = 2;
const cache = new Map();
function readJsonl(file) {
  let st; try { st = fs.statSync(file); } catch { return []; }
  const sig = st.mtimeMs + ":" + st.size, c = cache.get(file);
  if (c && c.sig === sig) return c.rows;
  const rows = [];
  for (const l of fs.readFileSync(file, "utf8").replace(/^﻿/, "").split("\n")) { if (!l.trim()) continue; try { rows.push(JSON.parse(l)); } catch {} }
  cache.set(file, { sig, rows }); return rows;
}
const list = (dir) => { try { return fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort(); } catch { return []; } };

// Trạng thái từng tin: số lần đọc, đã tới chưa, số lần bị nhắc, đã xong chưa.
function state(dir) {
  const tin = new Map();
  for (const f of list(dir)) for (const e of readJsonl(path.join(dir, f))) {
    const sk = e.su_kien;
    if (sk === "nhac") { for (const ma of e.ids || []) { const b = tin.get(ma); if (b) b.lan_nhac++; } continue; }
    const ma = e.id; if (!ma) continue;
    if (sk === "tin") tin.set(ma, { ...e, lan_go: 0, da_toi: false, lan_nhac: 0, xong: null });
    else if (sk === "go" && tin.has(ma)) { const b = tin.get(ma); b.lan_go++; if (e.da_gui) { b.lan_nhac += b.da_toi ? 1 : 0; b.da_toi = true; b.doc_luc = e.luc; } }
    else if (sk === "xong" && tin.has(ma)) tin.get(ma).xong = e;
  }
  return tin;
}

function build(data, mask) {
  const dir = path.join(data, "hop-thu"), now = Date.now();
  const line = (s) => { const t = mask(String(s || "").split("\n")[0]); return t.length > 90 ? t.slice(0, 89) + "…" : t; };
  const roles = new Map();
  const row = (vai) => { if (!roles.has(vai)) roles.set(vai, { kind: "doi", vai, open: 0, over1h: 0, nhac2: 0, chuaToi: 0, oldest: null }); return roles.get(vai); };
  for (const b of state(dir).values()) {
    if (b.xong) continue;
    const r = row(b.toi || "?"), luc = Date.parse(b.luc || "") || now;
    r.open++;
    if (now - luc > HOUR) r.over1h++;
    if (b.da_toi && b.lan_nhac >= NHAC_TOI_DA) r.nhac2++;
    if (!b.da_toi) r.chuaToi++;
    if (!r.oldest || luc < r.oldest.luc) r.oldest = { id: b.id || null, luc, dong: line(b.tin) };
  }
  const out = [...roles.values()].sort((a, b) => b.nhac2 - a.nhac2 || b.over1h - a.over1h || b.open - a.open);
  return {
    at: now, roles: out,
    tong: { open: out.reduce((s, r) => s + r.open, 0), over1h: out.reduce((s, r) => s + r.over1h, 0), nhac2: out.reduce((s, r) => s + r.nhac2, 0) },
    pending: { n: 0, lauNhatPhut: 0, ds: [] }, pendingAt: now,
  };
}
// Trạng thái từng tin (cho ô nhắn tin của văn phòng): id -> {da_toi, xong}
function statusById(data) { const m = {}; for (const [id, b] of state(path.join(data, "hop-thu"))) m[id] = { da_toi: b.da_toi, xong: !!b.xong }; return m; }

module.exports = { build, statusById, state };
