// Đánh giá nhân sự AI: đếm token thật từ nhật ký (7 ngày) và chấm điểm theo số liệu đo được.
// Chỉ đọc. Codex: sự kiện token_count (tổng dồn theo phiên). Claude: message.usage của từng tin (bỏ trùng theo message.id).
"use strict";
const fs = require("fs");
const path = require("path");

const DAYS = 7, H = 3600000, WINDOW = DAYS * 24 * H, CHUNK = 8 << 20;
const now = () => Date.now();
const hourOf = (t) => Math.floor(t / H) * H;

const usage = new Map(); // key -> { files: Map(path -> {off, prev}), hours: Map(hour -> {i,c,o}), mins: Set, ids: Set, busy }
let quota = { usedPct: null, resetsAt: null, credits: null, at: 0 }; // quỹ Codex tuần (sự kiện mới nhất)

function stateOf(key) {
  let u = usage.get(key);
  if (!u) usage.set(key, (u = { files: new Map(), hours: new Map(), mins: new Set(), ids: new Set() }));
  return u;
}
function readAt(fd, pos, len) { const b = Buffer.alloc(len); const n = fs.readSync(fd, b, 0, len, pos); return b.subarray(0, n); }
const TS = /"(?:timestamp|created_at)":"([^"]+)"/;
// Nhật ký ghi theo thứ tự thời gian: tìm nhị phân vị trí dòng đầu tiên mới hơn mốc tMin.
function seekTime(file, size, tMin) {
  const fd = fs.openSync(file, "r");
  try {
    let lo = 0, hi = size;
    while (hi - lo > 1 << 20) {
      const mid = Math.floor((lo + hi) / 2);
      const b = readAt(fd, mid, 1 << 18).toString("utf8");
      const nl = b.indexOf("\n"); const m = nl >= 0 && TS.exec(b.slice(nl + 1, nl + 1 + 65536));
      const t = m ? Date.parse(m[1]) : NaN;
      if (!t) { lo = mid; continue; } // dòng quá dài: dịch lên
      if (t < tMin) lo = mid; else hi = mid;
    }
    return lo;
  } finally { fs.closeSync(fd); }
}
function add(u, t, i, c, o) {
  if (t < now() - WINDOW) return;
  const k = hourOf(t); const b = u.hours.get(k) || { i: 0, c: 0, o: 0 };
  b.i += i; b.c += c; b.o += o; u.hours.set(k, b);
  u.mins.add(Math.floor(t / 60000));
}
function lineCodex(u, f, line) {
  if (!line.includes('"token_count"')) return;
  let j; try { j = JSON.parse(line); } catch { return; }
  const p = j.payload || {}, t = Date.parse(j.timestamp || "");
  if (p.type !== "token_count" || !t) return;
  const rl = p.rate_limits;
  if (rl && rl.primary && t >= quota.at) quota = { usedPct: rl.primary.used_percent, resetsAt: rl.primary.resets_at ? rl.primary.resets_at * 1000 : null, credits: rl.credits && rl.credits.balance != null ? Math.round(+rl.credits.balance) : null, at: t };
  const tot = p.info && p.info.total_token_usage; if (!tot) return;
  const prev = f.prev; f.prev = tot;
  let d;
  if (prev && tot.total_tokens >= prev.total_tokens) d = { input_tokens: tot.input_tokens - prev.input_tokens, cached_input_tokens: tot.cached_input_tokens - prev.cached_input_tokens, output_tokens: tot.output_tokens - prev.output_tokens };
  else d = p.info.last_token_usage || null; // đầu cửa sổ hoặc phiên đặt lại bộ đếm
  if (!d || !(d.input_tokens + d.output_tokens)) return;
  add(u, t, Math.max(0, d.input_tokens - d.cached_input_tokens), d.cached_input_tokens, d.output_tokens);
}
function lineClaude(u, f, line) {
  if (!line.includes('"usage"') || !line.includes('"assistant"')) return;
  let j; try { j = JSON.parse(line); } catch { return; }
  const m = j.message || {}, us = m.usage, t = Date.parse(j.timestamp || "");
  if (j.type !== "assistant" || !us || !t) return;
  const id = m.id || j.uuid; if (u.ids.has(id)) return; u.ids.add(id); // một tin tách nhiều dòng cùng usage
  add(u, t, (us.input_tokens || 0) + (us.cache_creation_input_tokens || 0), us.cache_read_input_tokens || 0, us.output_tokens || 0);
}
function lineAntigravity(u, f, line) {
  if (!line.includes('"PLANNER_RESPONSE"') || !line.includes('"input_tokens"')) return;
  let j; try { j = JSON.parse(line); } catch { return; }
  const t = Date.parse(j.created_at || "");
  if (j.type !== "PLANNER_RESPONSE" || !t) return;
  const id = `${f.file || ""}:${j.step_index != null ? j.step_index : t}`;
  if (u.ids.has(id)) return;
  u.ids.add(id);
  const inp = j.input_tokens || 0, cr = j.cache_read_tokens || 0, out = j.output_tokens || 0;
  if (!(inp + cr + out)) return;
  add(u, t, inp, cr, out);
}
// Đọc tiếp một file từ vị trí cũ; lần đầu nhảy tới mốc 7 ngày. Trả về true nếu còn dữ liệu chưa đọc.
function step(key, file, platform) {
  const u = stateOf(key);
  let st; try { st = fs.statSync(file); } catch { return false; }
  let f = u.files.get(file);
  if (!f) u.files.set(file, (f = { file, off: st.size > CHUNK ? seekTime(file, st.size, now() - WINDOW) : 0, prev: null, first: true }));
  if (st.size < f.off) { f.off = 0; f.prev = null; }
  if (st.size === f.off) return false;
  const fd = fs.openSync(file, "r");
  try {
    const b = readAt(fd, f.off, Math.min(CHUNK, st.size - f.off));
    let s = 0;
    if (f.first) { f.first = false; if (f.off > 0) s = b.indexOf(10) + 1; }
    const end = b.lastIndexOf(10);
    if (end < s) { if (b.length === CHUNK) f.off += b.length; return b.length === CHUNK; } // dòng khổng lồ: bỏ qua
    const fn = platform === "codex" ? lineCodex : platform === "antigravity" ? lineAntigravity : lineClaude;
    for (const line of b.subarray(s, end).toString("utf8").split("\n")) if (line) fn(u, f, line);
    f.off += end + 1;
    return f.off < st.size;
  } finally { fs.closeSync(fd); }
}
function filesOf(a) {
  if (!a.file) return [];
  const out = [a.file];
  if (a.platform === "claude") { // phiên con (subagent) tính vào người tạo
    const sub = path.join(path.dirname(a.file), path.basename(a.file, ".jsonl"), "subagents");
    try { for (const f of fs.readdirSync(sub)) if (f.endsWith(".jsonl")) out.push(path.join(sub, f)); } catch {}
  } else if (a.platform === "antigravity" && Array.isArray(a.subFiles)) {
    for (const sf of a.subFiles) if (sf) out.push(sf);
  }
  return out;
}
// Quét lần lượt, mỗi lần một khúc 8 MB rồi nhường để máy chủ vẫn trả lời nhanh.
let running = false;
function scanAll(agents) {
  if (running) return; running = true;
  const jobs = [];
  for (const a of agents) for (const f of filesOf(a)) jobs.push([a.key, f, a.platform]);
  const next = () => {
    const j = jobs[0]; if (!j) { running = false; return; }
    let more = false; try { more = step(j[0], j[1], j[2]); } catch { more = false; }
    if (!more) jobs.shift();
    setImmediate(next);
  };
  next();
}
function prune() {
  const cutH = hourOf(now() - WINDOW), cutM = Math.floor((now() - WINDOW) / 60000);
  for (const u of usage.values()) {
    for (const k of u.hours.keys()) if (k < cutH) u.hours.delete(k);
    for (const m of u.mins) if (m < cutM) u.mins.delete(m);
  }
}

// ---------- chấm điểm ----------
function sum(u, from) { const r = { i: 0, c: 0, o: 0 }; if (u) for (const [k, b] of u.hours) if (k >= from) { r.i += b.i; r.c += b.c; r.o += b.o; } r.t = r.i + r.c + r.o; return r; }
function hoursActive(a, u, from) { const fm = Math.floor(from / 60000); const s = new Set(); for (const m of a.mins) if (m >= fm) s.add(m); if (u) for (const m of u.mins) if (m >= fm) s.add(m); return s.size / 60; }
const median = (xs) => { const v = xs.filter((x) => x > 0).sort((p, q) => p - q); return v.length ? v[Math.floor(v.length / 2)] : 0; };
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const fmtM = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1).replace(".", ",") + " triệu" : n >= 1e3 ? Math.round(n / 1e3) + " nghìn" : String(n));
const vn1 = (x) => String(x).replace(".", ",");

// Thang 100 điểm, chỉ dùng số đo được từ nhật ký:
//  Kết quả 40  = số lượt việc làm xong trong 24 giờ (Claude: câu trả lời kết thúc lượt; Codex: task_complete) ×4, cộng lượt DEV 7 ngày (đạt +12, chưa đạt −4).
//  Tin cậy 20  = tỉ lệ lệnh/công cụ chạy không lỗi trong 24 giờ (lỗi 25% trở lên = 0 điểm; chưa chạy lệnh nào = 15).
//  Chăm chỉ 20 = số giờ có hoạt động trong 24 giờ (10 giờ trở lên = đủ).
//  Tiết kiệm 20 = token mới mỗi giờ làm so với mức giữa của đội cùng nền tảng (bằng hoặc thấp hơn = đủ, gấp 4 lần = 0).
function compute(agents, snapAgents, events, devRows) {
  devRows = devRows || [];
  prune();
  const t = now(), d1 = t - 24 * H, d7 = t - WINDOW, h0 = hourOf(t) - 23 * H;
  const day0 = new Date(); day0.setHours(0, 0, 0, 0);
  const days = Array.from({ length: DAYS }, (_, i) => +day0 - (DAYS - 1 - i) * 24 * H);
  const rows = agents.map((a) => {
    const u = usage.get(a.key), s = snapAgents.find((x) => x.key === a.key) || {};
    const t24 = sum(u, d1), t7 = sum(u, d7);
    const hr24 = hoursActive(a, u, d1), hr7 = hoursActive(a, u, d7);
    const done24 = a.done.filter((x) => x.t >= d1).length, done7 = a.done.filter((x) => x.t >= d7).length;
    const tl = a.tools.filter((x) => x.t >= d1), err = tl.filter((x) => x.err).length;
    const ev = events.filter((e) => e.t >= d1);
    const sent = ev.filter((e) => e.from === a.key).length, recv = ev.filter((e) => e.to === a.key).length;
    const turns = devRows.filter((r) => r.agent === a.key && r.start >= d7 && r.end), ok = turns.filter((r) => !r.fail).length;
    const hourly = Array.from({ length: 24 }, (_, i) => { const b = u && u.hours.get(h0 + i * H); return b ? b.i + b.c + b.o : 0; });
    const daily = days.map((d) => { let n = 0; if (u) for (const [k, b] of u.hours) if (k >= d && k < d + 24 * H) n += b.i + b.c + b.o; return n; });
    return { key: a.key, name: a.name, role: a.role, platform: a.platform, isNew: !!s.isNew, createdAt: a.createdAt || null,
      status: s.status || "offline", flag: s.flag || null,
      hr24: +hr24.toFixed(1), hr7: +hr7.toFixed(1), t24, t7, perHour: hr7 > 0.2 ? Math.round((t7.i + t7.o) / hr7) : 0, // token mới (không tính phần đọc lại từ bộ nhớ đệm)
      cache7: t7.t ? Math.round((t7.c / t7.t) * 100) : null, done: { d24: done24, d7: done7 }, dev: { turns: turns.length, ok, fail: turns.length - ok }, tool: { n: tl.length, err }, msg: { sent, recv }, hourly, daily };
  });
  const med = {
    codex: median(rows.filter((r) => r.platform === "codex").map((r) => r.perHour)),
    claude: median(rows.filter((r) => r.platform === "claude").map((r) => r.perHour)),
    antigravity: median(rows.filter((r) => r.platform === "antigravity").map((r) => r.perHour)),
  };
  for (const r of rows) {
    const notes = [];
    const ketqua = clamp(r.done.d24 * 4 + r.dev.ok * 12 - r.dev.fail * 4, 0, 40);
    notes.push(`Làm xong ${r.done.d24} lượt việc trong 24 giờ, ${r.done.d7} lượt trong 7 ngày.`);
    if (r.dev.turns) notes.push(`${r.dev.turns} lượt DEV trong 7 ngày: ${r.dev.ok} đạt, ${r.dev.fail} chưa đạt.`);
    const errRate = r.tool.n ? r.tool.err / r.tool.n : 0;
    const tincay = r.tool.n ? clamp(20 * (1 - errRate / 0.25), 0, 20) : 15;
    notes.push(r.tool.n ? `Chạy ${r.tool.n} lệnh/công cụ trong 24 giờ, ${r.tool.err} lần lỗi (${Math.round(errRate * 100)}%).` : "Chưa chạy lệnh nào trong 24 giờ: tin cậy tính mức giữa.");
    const chamchi = clamp((r.hr24 / 10) * 20, 0, 20);
    const m = med[r.platform] || 0, ratio = m && r.perHour ? r.perHour / m : 1;
    const tietkiem = ratio <= 1 ? 20 : clamp(20 * (1 - Math.log2(ratio) / 2), 0, 20);
    notes.push(`Làm ${vn1(r.hr24)} giờ trong 24 giờ qua, ${vn1(r.hr7)} giờ trong 7 ngày.`);
    const pLabel = r.platform === "codex" ? "Codex" : r.platform === "antigravity" ? "Antigravity" : "Claude";
    if (r.perHour) notes.push(`Dùng ${fmtM(r.perHour)} token mới mỗi giờ làm, ${ratio >= 1.15 ? `gấp ${ratio.toFixed(1).replace(".", ",")} lần` : ratio <= .85 ? `bằng ${Math.round(ratio * 100)}%` : "ngang"} mức giữa của đội ${pLabel}.`);
    if (r.cache7 != null && r.cache7 < 60) notes.push(`Chỉ ${r.cache7}% token đọc lại từ bộ nhớ đệm: phiên hay đổi ngữ cảnh, tốn hơn.`);
    if (r.msg.sent || r.msg.recv) notes.push(`Gửi ${r.msg.sent} tin, nhận ${r.msg.recv} tin từ phiên khác trong 24 giờ.`);
    if (r.flag === "blocked") notes.push("Đang báo bị chặn, cần người gỡ.");
    const total = Math.round(ketqua + tincay + chamchi + tietkiem);
    const thin = r.hr7 < 1; // dưới 1 giờ làm trong 7 ngày: chưa đủ số liệu để xếp loại
    r.score = { total, grade: thin ? "–" : total >= 80 ? "A" : total >= 65 ? "B" : total >= 50 ? "C" : "D", thin,
      parts: { ketqua: Math.round(ketqua), tincay: Math.round(tincay), chamchi: Math.round(chamchi), tietkiem: Math.round(tietkiem) } };
    r.notes = notes;
  }
  rows.sort((p, q) => (p.score.thin - q.score.thin) || q.score.total - p.score.total);
  const team = { t24: { codex: 0, claude: 0, antigravity: 0 }, t7: { codex: 0, claude: 0, antigravity: 0 }, c7: 0, all7: 0,
    hourly: Array.from({ length: 24 }, (_, i) => ({ t: h0 + i * H, codex: 0, claude: 0, antigravity: 0 })), daily: days.map((d) => ({ t: d, codex: 0, claude: 0, antigravity: 0 })) };
  for (const r of rows) {
    const p = r.platform === "codex" ? "codex" : r.platform === "antigravity" ? "antigravity" : "claude";
    team.t24[p] += r.t24.t; team.t7[p] += r.t7.t; team.c7 += r.t7.c; team.all7 += r.t7.t;
    r.hourly.forEach((n, i) => (team.hourly[i][p] += n)); r.daily.forEach((n, i) => (team.daily[i][p] += n));
  }
  return { now: t, rows, team, quota, median: med, scanning: running };
}

// Tiền AI ước tính theo ngày (n ngày gần nhất, cũ → mới) = token × giá API (USD / 1 triệu token) theo nền tảng.
function costDays(prices, n) {
  const day0 = new Date(); day0.setHours(0, 0, 0, 0);
  const out = Array.from({ length: n }, () => 0);
  const keys = [...usage.keys()];
  for (const k of keys) {
    const p = prices[k.startsWith("x-") ? "codex" : k.startsWith("a-") ? "antigravity" : "claude"] || {};
    for (const [h, b] of usage.get(k).hours) {
      const i = n - 1 - Math.floor((+day0 + 86400000 - 1 - h) / 86400000); if (i < 0 || i >= n) continue;
      out[i] += (b.i * (p.input || 0) + b.c * (p.cacheRead || 0) + b.o * (p.output || 0)) / 1e6;
    }
  }
  return out.map((x) => Math.round(x * 100) / 100);
}

module.exports = { scanAll, compute, costDays };
