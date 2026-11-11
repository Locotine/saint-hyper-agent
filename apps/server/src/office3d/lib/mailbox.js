// Ghi hòm thư của đội: data/hop-thu/<vai>.jsonl (dùng chung cho tools/vp.js và ô nhắn tin của văn phòng).
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// Tên tệp theo vai: bỏ dấu, chữ thường, khoảng trắng thành "-" ("Kỹ sư Backend" → "ky-su-backend").
const slug = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "chung";
const newId = () => "ht-" + new Date().toISOString().replace(/\D/g, "").slice(0, 14) + "-" + crypto.randomBytes(2).toString("hex");
const fileOf = (data, vai) => path.join(data, "hop-thu", slug(vai) + ".jsonl");
function append(data, vai, ev) {
  fs.mkdirSync(path.join(data, "hop-thu"), { recursive: true });
  fs.appendFileSync(fileOf(data, vai), JSON.stringify({ luc: new Date().toISOString(), ...ev }) + "\n");
}
// Tìm tệp đang chứa mã tin (để ghi "go"/"xong" vào đúng tệp của người nhận).
function findVai(data, id) {
  const dir = path.join(data, "hop-thu");
  let files = []; try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")); } catch {}
  for (const f of files) for (const l of fs.readFileSync(path.join(dir, f), "utf8").split("\n")) { if (!l.includes(id)) continue; try { const e = JSON.parse(l); if (e.su_kien === "tin" && e.id === id) return e.toi; } catch {} }
  return null;
}

module.exports = { slug, newId, fileOf, append, findVai };
