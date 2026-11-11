// Đọc sổ sách điều phối (chỉ đọc) cho hai màn hình tường: "Công việc & tiến độ" và "Nội quy & đội ngũ".
// Tất cả nằm trong thư mục data/ (khung mẫu ở mau/, setup chép sang). Mỗi file chỉ đọc lại khi đổi. Mọi chữ đi qua mask() trước khi gửi.
"use strict";
const fs = require("fs");
const path = require("path");

const cache = new Map();
function read(file) {
  let st; try { st = fs.statSync(file); } catch { return null; }
  const sig = st.mtimeMs + ":" + st.size, c = cache.get(file);
  if (c && c.sig === sig) return c;
  const v = { sig, text: fs.readFileSync(file, "utf8").replace(/^﻿/, "").replace(/\r\n/g, "\n"), mtime: st.mtimeMs };
  cache.set(file, v); return v;
}
// Bảng Markdown ngay sau tiêu đề khớp re (hoặc bảng đầu tiên nếu re rỗng): mảng hàng, hàng đầu là tiêu đề cột.
function table(text, re) {
  const lines = text.split("\n"); let i = 0;
  if (re) { i = lines.findIndex((l) => /^#{1,4}\s/.test(l) && re.test(l)); if (i < 0) return []; }
  const rows = [];
  for (let j = i; j < lines.length; j++) {
    const l = lines[j];
    if (re && j > i && /^#{1,4}\s/.test(l)) break;
    if (!/^\|/.test(l)) { if (rows.length) break; continue; }
    if (/^\|\s*:?-{2,}/.test(l)) continue;
    rows.push(l.replace(/^\||\|\s*$/g, "").split("|").map((x) => x.trim()));
  }
  return rows;
}
function sections(text, level = 2) {
  const out = []; let cur = { title: "", body: [] };
  const re = new RegExp(`^#{1,${level}}\\s+(.*)`);
  for (const l of text.split("\n")) {
    const m = l.match(re);
    if (m) { if (cur.title || cur.body.join("").trim()) out.push(cur); cur = { title: m[1].trim(), body: [] }; } else cur.body.push(l);
  }
  out.push(cur);
  return out.map((s) => ({ title: s.title, body: s.body.join("\n").trim() }));
}

// Mục nội quy mới đổi: lưu băm từng mục + lúc thấy đổi lần đầu.
let seen = null, seenFile = null;
const hash = (s) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return String(h); };
function rulesWithAge(secs, data) {
  if (!seenFile) { seenFile = path.join(data, ".noiquy-seen.json"); try { seen = JSON.parse(fs.readFileSync(seenFile, "utf8")); } catch { seen = null; } }
  const first = !seen; seen = seen || {};
  const now = Date.now(), out = [];
  for (const s of secs) {
    const k = s.title || "(đầu file)", h = hash(s.body);
    if (!seen[k] || seen[k].h !== h) seen[k] = { h, at: first ? 0 : now }; // lần chạy đầu: coi mọi mục là cũ
    out.push({ ...s, changedAt: seen[k].at });
  }
  try { fs.writeFileSync(seenFile, JSON.stringify(seen)); } catch {}
  return out;
}
function rulesPath(cfg, data) {
  if (cfg.rulesFile) return path.resolve(cfg.rulesFile);
  if (fs.existsSync(path.join(data, "NOI-QUY.md"))) return path.join(data, "NOI-QUY.md");
  for (const p of cfg.projects || []) for (const f of ["AGENTS.md", "CLAUDE.md"]) if (fs.existsSync(path.join(p, f))) return path.join(p, f);
  return path.join(data, "NOI-QUY.md");
}

function build(cfg, D, mask, maskDoc, extra) {
  const R = (f) => read(path.join(D, f));
  const clip = (s, n) => { s = mask(s || ""); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
  const out = { now: Date.now() };

  // --- việc đang áp dụng (UU-TIEN.json) + nhật ký quyết định (QUYET-DINH.md) ---
  const uu = R("UU-TIEN.json"), qd = R("QUYET-DINH.md");
  out.viec = { file: uu ? "UU-TIEN.json" : null, at: uu ? uu.mtime : null, history: qd ? table(qd.text, /Lịch sử|Nhật ký/).slice(1).map((r) => ({ tu: clip(r[0], 40), noiDung: clip(r[1], 600), nguon: clip(r[2], 300) })).reverse() : [] };
  if (uu) {
    try {
      const j = JSON.parse(uu.text);
      out.viec.listAt = uu.mtime;
      out.viec.title = clip(j.tieu_de || `Cập nhật ${j.cap_nhat || ""} · ${j.nguoi_ghi || ""}`, 120);
      out.viec.list = (j.dang_lam || []).slice().sort((a, b) => a.thu_tu - b.thu_tu).map((v) => ({ n: String(v.thu_tu), viec: clip(v.viec, 400), chu: clip(v.chu || "", 120), datKhi: clip(v.de_lam_gi || "", 300) }));
      out.viec.dangDung = clip((j.tam_dung || []).map((x) => `${x.viec}${x.ly_do ? " (" + x.ly_do + ")" : ""}`).join(" · "), 500);
    } catch (e) { out.viec.error = "UU-TIEN.json đọc lỗi: " + String(e.message).slice(0, 120); }
  }
  // --- tiến độ các gói ---
  out.goi = [];
  let pk = []; try { pk = fs.readdirSync(path.join(D, "goi"), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch {}
  for (const g of pk) {
    const vj = R(`goi/${g}/viec.json`); if (!vj) continue;
    let j; try { j = JSON.parse(vj.text); } catch { continue; }
    const items = (j.viec || []).map((v) => ({ id: clip(v.id, 30), yeuCau: clip(v.yeu_cau, 260), dat: !!v.dat, lanSua: v.lan_sua || 0, sha: v.sha ? String(v.sha).slice(0, 8) : null, ghiChu: clip(String(v.ghi_chu || "").split(" | ").pop(), 260) }));
    const td = R(`goi/${g}/tien-do.md`);
    let dangDo = null, tdAt = null;
    if (td) {
      tdAt = td.mtime;
      const secs = sections(td.text, 3), dd = [...secs].reverse().find((s) => /Đang dở/i.test(s.title));
      if (dd) dangDo = { title: clip(dd.title, 160), body: clip(dd.body, 700) };
    }
    out.goi.push({ ten: g, ten2: clip(j.ten || j.goi || "", 120), items, dat: items.filter((x) => x.dat).length, total: items.length,
      maxLanSua: Math.max(0, ...items.map((x) => x.lanSua)), at: Math.max(vj.mtime, tdAt || 0), dangDo });
  }
  out.goi.sort((a, b) => b.at - a.at);
  // --- cần anh ---
  const ca = R("CAN-ANH.md");
  out.canAnh = ca ? table(ca.text, /Bảng/).slice(1).map((r) => ({ ma: clip(r[0], 20), luc: clip(r[1], 20), ai: clip(r[2], 80), viec: clip(r[3], 400), luaChon: clip(r[4], 300), trangThai: clip(r[5], 300), mo: /^CHỜ/i.test(r[5] || "") })).reverse() : [];

  // --- nội quy, cấp bậc, đội ngũ, sổ tay ---
  const rp = rulesPath(cfg, D), ag = read(rp);
  if (ag) out.noiQuy = { file: path.basename(rp), at: ag.mtime, sections: rulesWithAge(sections(ag.text), D).map((s) => ({ title: clip(s.title, 200), body: maskDoc(s.body), changedAt: s.changedAt })) };
  const cc = R("CAP-BAC.md"); if (cc) out.camCo = { at: cc.mtime, body: maskDoc(cc.text) };
  const dn = R("DOI-NGU.md");
  if (dn) out.doiNgu = { at: dn.mtime, title: clip((dn.text.match(/^#\s+(.*)/m) || [])[1], 160), groups: sections(dn.text).filter((s) => s.title && /^\|/m.test(s.body)).map((s) => ({ title: clip(s.title, 80), rows: table(s.body).map((r) => r.map((c) => clip(c, 200))) })) };
  const bh = R("BAI-HOC.md");
  if (bh) { const t = table(bh.text, /Bảng bài học/); out.baiHoc = { at: bh.mtime, head: t[0] || [], rows: t.slice(1).map((r) => r.map((c) => clip(c, 400))).reverse() }; }
  const vls = R("VIEC-LAM-SAU.md");
  if (vls) out.viecLamSau = { at: vls.mtime, sections: sections(vls.text).filter((s) => s.title && !/^Việc làm sau/i.test(s.title)).map((s) => ({ title: clip(s.title, 160), body: maskDoc(s.body), n: (s.body.match(/^\s*[-*|]\s/gm) || []).length })) };
  const td = R("TU-DIEN.md");
  if (td) { const t = table(td.text); out.tuDien = { at: td.mtime, head: t[0] || [], rows: t.slice(1).map((r) => r.map((c) => clip(c, 300))) }; }
  let files = []; try { files = fs.readdirSync(path.join(D, "spec")).filter((f) => /\.md$/i.test(f)); } catch {}
  out.specs = files.map((f) => { const r = read(path.join(D, "spec", f)); return { file: "spec/" + f, at: r.mtime, title: clip((r.text.match(/^#\s+(.*)/m) || [])[1] || f, 160) }; }).sort((a, b) => b.at - a.at);
  return { ...out, ...extra };
}

module.exports = { build };
