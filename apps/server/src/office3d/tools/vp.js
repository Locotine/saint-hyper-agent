#!/usr/bin/env node
// vp — công cụ điều phối của đội AI. Agent (Claude Code, Codex) gọi để ghi vào sổ của văn phòng (thư mục data/):
// hòm thư, lượt DEV, cần anh, việc ưu tiên, gói việc, tiến độ, bài học. Văn phòng chỉ đọc các file này và hiện lên màn hình.
// Chạy: node <thư mục văn phòng>/tools/vp.js <lệnh> …   ·   node tools/vp.js giup   để xem đủ lệnh.
"use strict";
const fs = require("fs");
const path = require("path");
const { loadConfig } = require("../lib/config");
const mailbox = require("../lib/mailbox");
const hopthu = require("../lib/hopthu");

const ROOT = path.join(__dirname, "..");
const CFG = loadConfig(ROOT);
const DATA = process.env.VP_DATA ? path.resolve(process.env.VP_DATA) : CFG ? CFG.dataDir : path.join(ROOT, "data");

// ---------- đọc tham số: vị trí + --cờ giá-trị ----------
const argv = process.argv.slice(2), pos = [], opt = {}, BOOL = new Set(["dang-do", "help"]);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith("--")) { const k = a.slice(2); const v = !BOOL.has(k) && argv[i + 1] !== undefined && !argv[i + 1].startsWith("--") ? argv[++i] : true; opt[k] = v; }
  else pos.push(a);
}
const need = (k, label) => { if (!opt[k] || opt[k] === true) die(`Thiếu --${k}${label ? " (" + label + ")" : ""}.`); return String(opt[k]); };
function die(msg) { console.error("Lỗi: " + msg); process.exit(1); }
const nowIso = () => new Date().toISOString();
const hm = (d = new Date()) => d.toLocaleString("vi-VN", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit", hour12: false });
const cell = (s) => String(s || "").replace(/\|/g, "/").replace(/\r?\n/g, " ").trim();
const readJson = (f, def) => { try { return JSON.parse(fs.readFileSync(f, "utf8").replace(/^﻿/, "")); } catch { return def; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2) + "\n"); };
const appendLine = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.appendFileSync(f, JSON.stringify(v) + "\n"); };

const HELP = `vp — công cụ điều phối của đội (sổ ở ${DATA})

HÒM THƯ (mỗi tin có mã ht-…)
  vp gui --toi "<vai nhận>" [--tu "<vai gửi>"] "nội dung"     gửi một việc
  vp tiep --toi "<vai của mình>"                            đọc tin cũ nhất chưa xong (cuối mỗi lượt)
  vp xong <mã> [--ghi-chu "kết quả 1 dòng"]                  đóng tin đã làm xong (tin trùng/hết hiệu lực cũng đóng)
  vp ds                                                     số tin chưa xong theo từng vai

LƯỢT DEV (môi trường thử chung, mỗi lúc một người)
  vp luot xem                                               ai đang giữ, hàng chờ
  vp luot cho --goi <gói> --vai "<vai>" [--sha <sha>]        xếp hàng
  vp luot huy --vai "<vai>"                                 rời hàng chờ
  vp luot lay --goi <gói> --vai "<vai>" [--loai deploy|doc]  lấy lượt (bị từ chối nếu người khác đang giữ)
  vp luot nha --vai "<vai>" --ket-qua dat|hong [--usd 0.4] [--ghi-chu "…"]   nhả lượt

CẦN ANH (việc chỉ chủ văn phòng quyết được)
  vp cananh hoi --tu "<vai>" "việc cần anh" [--lua-chon "a / b"]
  vp cananh xong <CA-n> "anh đã trả lời gì"
  vp cananh ds

VIỆC ƯU TIÊN (Quản lý ghi)
  vp viec ds
  vp viec them --thu-tu 1 --viec "…" [--de-lam-gi "…"] [--chu "<vai>"] [--duyet "<vai>"] [--can "…"] [--han 2026-10-27T17:00] [--muc goi:MA,goi:MA2]
  vp viec sua <thứ tự> [--viec …] [--can …] [--han …] [--chu …] [--muc …] [--thu-tu-moi N]
  vp viec dung <thứ tự> --ly-do "…"                          chuyển sang tạm dừng
  vp viec xoa <thứ tự>

GÓI VIỆC (mỗi mảng một gói, mỗi gói nhiều mục)
  vp goi tao <gói> [--ten "…"]
  vp goi muc <gói> <MÃ> --yeu-cau "…" [--kiem-that "…"]
  vp goi dat <gói> <MÃ> [--bang-chung "…"] [--sha <sha>]      mục đạt
  vp goi sua <gói> <MÃ> [--ghi-chu "…"]                       sửa thêm một lần (đếm lan_sua)
  vp goi ghichu <gói> <MÃ> "…"
  vp tiendo <gói> "dòng tiến độ" [--dang-do --vai "<vai>"]   ghi tiến độ (Đang dở = chỗ phiên mới đọc trước)

KHÁC
  vp baihoc --the "<thẻ>" "bài học" [--chan "cái chặn tự động"]
  vp giup`;

// ---------- hòm thư ----------
function cmdGui() {
  const toi = need("toi", "vai nhận"), text = pos.slice(1).join(" ").trim(); if (!text) die("Thiếu nội dung tin.");
  const id = mailbox.newId();
  mailbox.append(DATA, toi, { su_kien: "tin", id, tu: opt.tu && opt.tu !== true ? String(opt.tu) : "?", toi, tin: text });
  console.log(`Đã gửi ${id} → ${toi}`);
}
function openFor(vai) {
  const st = hopthu.state(path.join(DATA, "hop-thu")), want = mailbox.slug(vai);
  return [...st.values()].filter((b) => !b.xong && mailbox.slug(b.toi) === want).sort((a, b) => String(a.luc).localeCompare(String(b.luc)));
}
function cmdTiep() {
  const vai = need("toi", "vai của mình"), list = openFor(vai);
  if (!list.length) return console.log("Hết tin.");
  const b = list[0];
  mailbox.append(DATA, b.toi, { su_kien: "go", id: b.id, da_gui: true });
  console.log(`Mã: ${b.id}   (còn ${list.length - 1} tin khác chưa xong)\nTừ: ${b.tu}   Lúc: ${hm(new Date(b.luc))}${b.lan_go ? `   Đã đọc ${b.lan_go} lần trước` : ""}\n\n${b.tin}\n\nLàm xong: node "${__filename}" xong ${b.id} --ghi-chu "<kết quả 1 dòng>"`);
}
function cmdXong() {
  const id = pos[1]; if (!id) die("Thiếu mã tin ht-….");
  const vai = mailbox.findVai(DATA, id); if (!vai) die(`Không thấy tin ${id}.`);
  mailbox.append(DATA, vai, { su_kien: "xong", id, ghi_chu: opt["ghi-chu"] && opt["ghi-chu"] !== true ? String(opt["ghi-chu"]) : "" });
  console.log(`Đã đóng ${id}`);
}
function cmdDs() {
  const d = hopthu.build(DATA, (s) => s);
  if (!d.roles.length) return console.log("Không có tin nào chưa xong.");
  console.log("Vai".padEnd(28) + "Chưa xong  Chờ>1h  Đọc≥3  Chưa đọc  Tin cũ nhất");
  for (const r of d.roles) console.log(r.vai.slice(0, 27).padEnd(28) + String(r.open).padEnd(11) + String(r.over1h).padEnd(8) + String(r.nhac2).padEnd(7) + String(r.chuaToi).padEnd(10) + (r.oldest ? `${r.oldest.id} ${r.oldest.dong}` : ""));
}

// ---------- lượt DEV ----------
const LOCK = path.join(DATA, "DEV.lock"), LUOT = path.join(DATA, "DEV-LUOT.jsonl");
function cmdLuot() {
  const sub = pos[1] || "xem", lock = readJson(LOCK, null);
  if (sub === "xem") {
    console.log(lock ? `Đang giữ: ${lock.owner} · gói ${lock.package} · từ ${hm(new Date(lock.started))}` : "DEV đang trống.");
    const ev = fs.existsSync(LUOT) ? fs.readFileSync(LUOT, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } }) : [];
    const same = (a, b) => a.vai && b.vai && mailbox.slug(a.vai) === mailbox.slug(b.vai);
    const q = ev.filter((e, i) => e.su_kien === "cho" && !ev.slice(i + 1).some((x) => (x.su_kien === "lay" || x.su_kien === "huy_cho") && same(e, x)));
    console.log(q.length ? "Hàng chờ:\n" + q.map((e, i) => `  ${i + 1}. ${e.vai} — ${e.goi}${e.sha ? " · " + e.sha : ""}`).join("\n") : "Hàng chờ trống.");
    return;
  }
  const vai = need("vai");
  if (sub === "cho") { appendLine(LUOT, { su_kien: "cho", luc: nowIso(), vai, goi: need("goi"), sha: opt.sha || undefined }); return console.log(`${vai} đã xếp hàng chờ DEV.`); }
  if (sub === "huy") { appendLine(LUOT, { su_kien: "huy_cho", luc: nowIso(), vai }); return console.log(`${vai} đã rời hàng chờ.`); }
  if (sub === "lay") {
    if (lock && mailbox.slug(lock.owner) !== mailbox.slug(vai)) die(`DEV đang do ${lock.owner} giữ (gói ${lock.package}). Xếp hàng: vp luot cho --goi … --vai "${vai}"`);
    const goi = need("goi");
    writeJson(LOCK, { owner: vai, package: goi, started: nowIso(), loai_luot: opt.loai || "deploy" });
    appendLine(LUOT, { su_kien: "lay", luc: nowIso(), vai, goi, loai: opt.loai || "deploy" });
    return console.log(`${vai} đã lấy lượt DEV cho gói ${goi}. Xong nhớ: vp luot nha --vai "${vai}" --ket-qua dat|hong`);
  }
  if (sub === "nha") {
    if (lock && mailbox.slug(lock.owner) !== mailbox.slug(vai)) die(`Lượt đang do ${lock.owner} giữ, không phải ${vai}.`);
    const kq = need("ket-qua", "dat hoặc hong");
    appendLine(LUOT, { su_kien: "nha", luc: nowIso(), vai, goi: lock ? lock.package : opt.goi, ket_qua: /^h/i.test(kq) ? "hỏng" : /^d/i.test(kq) ? "đạt" : kq, usd: opt.usd ? +String(opt.usd).replace(",", ".") : undefined, ghi_chu: opt["ghi-chu"] && opt["ghi-chu"] !== true ? String(opt["ghi-chu"]) : undefined });
    try { fs.unlinkSync(LOCK); } catch {}
    return console.log(`${vai} đã nhả lượt DEV. Người kế tiếp trong hàng chờ: vp luot xem`);
  }
  die("Lệnh luot không rõ. Dùng: xem | cho | huy | lay | nha");
}

// ---------- cần anh ----------
const CA = path.join(DATA, "CAN-ANH.md");
const CA_HEAD = "# Cần anh\n\nViệc chỉ chủ văn phòng quyết được. Người hỏi tự đổi trạng thái sang XONG khi đã có trả lời (vp cananh xong).\n\n## Bảng\n\n| Mã | Lúc | Ai hỏi | Việc cần anh | Lựa chọn | Trạng thái |\n|---|---|---|---|---|---|\n";
function cmdCanAnh() {
  const sub = pos[1] || "ds";
  let text = fs.existsSync(CA) ? fs.readFileSync(CA, "utf8") : CA_HEAD;
  const rows = text.split("\n").filter((l) => /^\|\s*CA-\d+/.test(l));
  if (sub === "ds") { console.log(rows.length ? rows.join("\n") : "Sổ Cần anh trống."); return; }
  if (sub === "hoi") {
    const viec = pos.slice(2).join(" ").trim(); if (!viec) die("Thiếu nội dung việc cần anh.");
    const n = Math.max(0, ...rows.map((l) => +(l.match(/CA-(\d+)/) || [0, 0])[1])) + 1;
    const now = new Date(), luc = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    text = text.replace(/\n*$/, "\n") + `| CA-${n} | ${luc} | ${cell(need("tu", "vai hỏi"))} | ${cell(viec)} | ${cell(opt["lua-chon"] === true ? "" : opt["lua-chon"])} | CHỜ |\n`;
    fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(CA, text);
    return console.log(`Đã ghi CA-${n} vào sổ Cần anh.`);
  }
  if (sub === "xong") {
    const ma = pos[2], tl = pos.slice(3).join(" ").trim(); if (!ma) die("Thiếu mã CA-n.");
    let hit = false;
    text = text.split("\n").map((l) => { if (!new RegExp(`^\\|\\s*${ma}\\s*\\|`).test(l)) return l; hit = true; const c = l.split("|"); c[6] = ` XONG ${hm()}: ${cell(tl || "đã trả lời")} `; return c.join("|"); }).join("\n");
    if (!hit) die(`Không thấy ${ma}.`);
    fs.writeFileSync(CA, text); return console.log(`Đã đóng ${ma}.`);
  }
  die("Lệnh cananh không rõ. Dùng: hoi | xong | ds");
}

// ---------- việc ưu tiên ----------
const UU = path.join(DATA, "UU-TIEN.json");
function cmdViec() {
  const sub = pos[1] || "ds", d = readJson(UU, { cap_nhat: "", nguoi_ghi: "", dang_lam: [], tam_dung: [] });
  d.dang_lam = d.dang_lam || []; d.tam_dung = d.tam_dung || [];
  const save = () => { d.cap_nhat = nowIso(); if (opt.vai && opt.vai !== true) d.nguoi_ghi = String(opt.vai); d.dang_lam.sort((a, b) => a.thu_tu - b.thu_tu); writeJson(UU, d); };
  const fields = (v) => {
    for (const [k, f] of [["viec", "viec"], ["de-lam-gi", "de_lam_gi"], ["chu", "chu"], ["duyet", "duyet"], ["can", "can"], ["han", "han"]]) if (opt[k] !== undefined) v[f] = opt[k] === true ? "" : String(opt[k]);
    if (opt.han && opt.han !== true && !/[zZ]|[+-]\d\d:?\d\d$/.test(String(opt.han))) v.han = new Date(String(opt.han)).toISOString(); // giờ máy → ISO
    if (opt.muc !== undefined) v.muc = opt.muc === true ? [] : String(opt.muc).split(",").map((x) => x.trim()).filter(Boolean);
    return v;
  };
  if (sub === "ds") {
    if (!d.dang_lam.length) return console.log("Chưa có việc ưu tiên.");
    for (const v of d.dang_lam) console.log(`${v.thu_tu}. ${v.viec}  · chủ ${v.chu || "?"}${v.han ? " · hạn " + hm(new Date(v.han)) : ""}${v.can ? " · cần: " + v.can : ""}${v.muc && v.muc.length ? " · mục " + v.muc.join(",") : ""}`);
    if (d.tam_dung.length) console.log("Tạm dừng: " + d.tam_dung.map((x) => x.viec).join(" · "));
    return;
  }
  if (sub === "them") { const n = +need("thu-tu"); if (d.dang_lam.some((v) => v.thu_tu === n)) die(`Đã có việc thứ tự ${n}; dùng vp viec sua.`); need("viec"); d.dang_lam.push(fields({ thu_tu: n, viec: "", de_lam_gi: "", muc: [], chu: "", duyet: "", can: "", han: "" })); save(); return console.log(`Đã thêm việc ${n}.`); }
  const n = +pos[2], v = d.dang_lam.find((x) => x.thu_tu === n); if (!v) die(`Không có việc thứ tự ${pos[2]}.`);
  if (sub === "sua") { fields(v); if (opt["thu-tu-moi"]) v.thu_tu = +opt["thu-tu-moi"]; save(); return console.log(`Đã sửa việc ${n}.`); }
  if (sub === "dung") { d.dang_lam = d.dang_lam.filter((x) => x !== v); d.tam_dung.push({ viec: v.viec, muc: v.muc, ly_do: need("ly-do"), tu: nowIso().slice(0, 10) }); save(); return console.log(`Đã chuyển việc ${n} sang tạm dừng.`); }
  if (sub === "xoa") { d.dang_lam = d.dang_lam.filter((x) => x !== v); save(); return console.log(`Đã xóa việc ${n}.`); }
  die("Lệnh viec không rõ. Dùng: ds | them | sua | dung | xoa");
}

// ---------- gói việc + tiến độ ----------
function cmdGoi() {
  const sub = pos[1], goi = pos[2]; if (!sub || !goi) die("Dùng: vp goi tao|muc|dat|sua|ghichu <gói> …");
  if (!/^[a-z0-9][a-z0-9-]*$/.test(goi)) die("Tên gói chỉ dùng chữ thường không dấu, số và dấu gạch: ví dụ dang-nhap-google.");
  const f = path.join(DATA, "goi", goi, "viec.json");
  const d = readJson(f, null);
  if (sub === "tao") {
    if (d) die(`Gói ${goi} đã có.`);
    writeJson(f, { goi, ten: opt.ten && opt.ten !== true ? String(opt.ten) : goi, viec: [] });
    const td = path.join(DATA, "goi", goi, "tien-do.md"); if (!fs.existsSync(td)) fs.writeFileSync(td, `# Tiến độ gói ${goi}\n\n`);
    return console.log(`Đã tạo gói ${goi}.`);
  }
  if (!d) die(`Chưa có gói ${goi}: vp goi tao ${goi}`);
  const ma = pos[3]; if (!ma) die("Thiếu mã mục.");
  let v = d.viec.find((x) => x.id === ma);
  if (sub === "muc") {
    if (v) die(`Mục ${ma} đã có.`);
    d.viec.push({ id: ma, yeu_cau: need("yeu-cau"), kiem_that: opt["kiem-that"] && opt["kiem-that"] !== true ? String(opt["kiem-that"]) : "", dat: false, bang_chung: "", sha: "", lan_sua: 0, ghi_chu: "" });
    writeJson(f, d); return console.log(`Đã thêm mục ${goi}:${ma}. Đưa vào việc ưu tiên: vp viec sua <thứ tự> --muc ${goi}:${ma}`);
  }
  if (!v) die(`Không có mục ${ma} trong gói ${goi}.`);
  if (sub === "dat") { v.dat = true; if (opt["bang-chung"] && opt["bang-chung"] !== true) v.bang_chung = String(opt["bang-chung"]); if (opt.sha && opt.sha !== true) v.sha = String(opt.sha); }
  else if (sub === "sua") { v.lan_sua = (v.lan_sua || 0) + 1; v.dat = false; if (opt["ghi-chu"] && opt["ghi-chu"] !== true) v.ghi_chu = (v.ghi_chu ? v.ghi_chu + " | " : "") + String(opt["ghi-chu"]); if (v.lan_sua >= 3) console.log("Cảnh báo: đã sửa 3 lần. Dừng lại, ghi đã thử gì và báo Quản lý."); }
  else if (sub === "ghichu") { const g = pos.slice(4).join(" ").trim(); if (!g) die("Thiếu ghi chú."); v.ghi_chu = (v.ghi_chu ? v.ghi_chu + " | " : "") + g; }
  else die("Lệnh goi không rõ.");
  writeJson(f, d); console.log(`Đã cập nhật ${goi}:${ma}.`);
}
function cmdTienDo() {
  const goi = pos[1], dong = pos.slice(2).join(" ").trim(); if (!goi || !dong) die("Dùng: vp tiendo <gói> \"dòng tiến độ\"");
  const f = path.join(DATA, "goi", goi, "tien-do.md"); fs.mkdirSync(path.dirname(f), { recursive: true });
  const t = new Date(), stamp = `${String(t.getDate()).padStart(2, "0")}/${String(t.getMonth() + 1).padStart(2, "0")} ${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
  const block = opt["dang-do"] ? `\n### Đang dở — ${opt.vai && opt.vai !== true ? opt.vai : "?"}, ${stamp}\n${dong}\n` : `- ${stamp} ${dong}\n`;
  fs.appendFileSync(f, block); console.log(`Đã ghi tiến độ gói ${goi}.`);
}
function cmdBaiHoc() {
  const f = path.join(DATA, "BAI-HOC.md"), bai = pos.slice(1).join(" ").trim(); if (!bai) die("Thiếu nội dung bài học.");
  let text = fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "# Bài học của đội\n\nGặp lỗi mới mất ≥ 20 phút thì thêm một dòng, kèm cái chặn tự động.\n\n## Bảng bài học\n\n| Ngày | Thẻ | Bài học | Cái chặn |\n|---|---|---|---|\n";
  const t = new Date(), ngay = `${String(t.getDate()).padStart(2, "0")}/${String(t.getMonth() + 1).padStart(2, "0")}/${t.getFullYear()}`;
  text = text.replace(/\n*$/, "\n") + `| ${ngay} | ${cell(opt.the === true ? "" : opt.the)} | ${cell(bai)} | ${cell(opt.chan === true ? "" : opt.chan)} |\n`;
  fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(f, text); console.log("Đã ghi bài học.");
}

const CMD = { gui: cmdGui, tiep: cmdTiep, xong: cmdXong, ds: cmdDs, luot: cmdLuot, cananh: cmdCanAnh, viec: cmdViec, goi: cmdGoi, tiendo: cmdTienDo, baihoc: cmdBaiHoc };
const c = pos[0];
if (!c || c === "giup" || c === "help" || opt.help) console.log(HELP);
else if (CMD[c]) CMD[c]();
else die(`Không có lệnh "${c}". Gõ: node tools/vp.js giup`);
