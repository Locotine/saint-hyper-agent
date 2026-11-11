// Ô nhắn tin cho agent, dùng chung cho văn phòng 3D và bảng điều hành.
// Ô được tạo một lần cho mỗi người đang chọn và giữ nguyên khi thẻ cập nhật mỗi giây, để không mất chữ đang gõ.
(function () {
  const css = `
.chat{margin-top:10px;border-top:1px solid rgba(255,255,255,.1);padding-top:9px;font-size:12px}
.chat .ch{display:flex;justify-content:space-between;align-items:baseline;gap:8px;color:#ecc970;font-weight:700;font-size:11px;letter-spacing:.06em;text-transform:uppercase}
.chat .ch small{color:#8a929c;font-weight:500;letter-spacing:0;text-transform:none}
.chat textarea{width:100%;min-height:62px;margin-top:6px;resize:vertical;background:#050608;color:#eee;border:1px solid rgba(255,255,255,.14);border-radius:9px;padding:7px 9px;font:inherit;font-size:12.5px;line-height:1.4}
.chat textarea:focus{outline:none;border-color:rgba(236,201,112,.6)}
.chat .row{display:flex;gap:6px;align-items:center;margin-top:6px;flex-wrap:wrap}
.chat button{cursor:pointer;font:inherit;font-size:12px;font-weight:700;border-radius:8px;padding:5px 12px;border:0;background:#ecc970;color:#000}
.chat button.gh{background:none;border:1px solid rgba(255,255,255,.16);color:#bbb;font-weight:500}
.chat button:disabled{opacity:.5;cursor:default}
.chat input{width:110px;background:#050608;color:#eee;border:1px solid rgba(255,255,255,.14);border-radius:8px;padding:5px 8px;font:inherit;letter-spacing:.2em}
.chat .err{color:#e8a39b;font-size:11.5px}
.chat .note{color:#8a929c;font-size:11px;line-height:1.45;margin-top:5px}
.chat .hist{margin-top:7px;display:grid;gap:4px}
.chat .hist div{font-size:11.5px;color:#cfcfcf;background:rgba(255,255,255,.03);border-radius:7px;padding:4px 7px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.chat .hist b{font-weight:700;margin-right:5px}
.chat .s-ok{color:#7ccf9b}.chat .s-wait{color:#ecc970}.chat .s-bad{color:#e8a39b}`;
  const st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);
  const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
  const getPin = () => { try { return localStorage.getItem("vp-pin") || ""; } catch { return ""; } };
  const setPin = (p) => { try { localStorage.setItem("vp-pin", p); } catch {} };
  let status = null, statusAt = 0;
  async function loadStatus(force, attempt) {
    if (!force && status && Date.now() - statusAt < 3000) return status;
    const headers = { "x-pin": getPin() }; if (attempt) headers["x-pin-try"] = "1";
    try { const r = await fetch("chat/status", { headers, cache: "no-store" }); status = await r.json(); statusAt = Date.now(); } catch { status = status || { authorized: false, msg: "Không kết nối được máy chủ văn phòng." }; }
    if (!status.authorized && status.msg === "Sai mã PIN.") setPin(""); // mã sai thì xóa, không gửi lại mãi
    return status;
  }
  const cls = (s) => /đã xong|đã đọc|đã gửi/.test(s) ? "s-ok" : /lỗi|không/.test(s) ? "s-bad" : "s-wait";
  const hhmm = (t) => new Date(t).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" });

  function build(a) {
    const box = el("div", "chat"); box.dataset.key = a.key;
    const head = el("div", "ch"); head.append(`Nhắn cho ${a.name.split(" · ")[0]}`, el("small", "", "vào hòm thư · agent đọc ở cuối lượt")); box.appendChild(head);
    const lock = el("div", "row"); const pinIn = el("input"); pinIn.type = "password"; pinIn.inputMode = "numeric"; pinIn.maxLength = 6; pinIn.placeholder = "Mã PIN";
    const unlock = el("button", "", "Mở khóa"); lock.append(pinIn, unlock); box.appendChild(lock);
    const ta = el("textarea"); ta.placeholder = "Gõ tin cho agent… (Ctrl+Enter để gửi)"; box.appendChild(ta);
    const row = el("div", "row"); const send = el("button", "", "Gửi"); const err = el("span", "err"); row.append(send, err); box.appendChild(row);
    const pinShow = el("div", "note"); box.appendChild(pinShow);
    box.appendChild(el("div", "note", `Tin vào hòm thư "${a.name}"; agent đọc bằng vp tiep ở cuối mỗi lượt (đã cài theo HUONG-DAN-CHO-AGENT.md). Việc hệ trọng (production, khóa, tiền, xóa dữ liệu) thì gõ thẳng trong phiên. Mã phiên: ${a.session || "–"}`));
    const hist = el("div", "hist"); box.appendChild(hist);
    unlock.onclick = async () => { setPin(pinIn.value.replace(/\D/g, "")); pinIn.value = ""; await refresh(box, a, true, true); };
    pinIn.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") unlock.click(); });
    const doSend = async () => {
      const text = ta.value.trim(); if (!text) return;
      send.disabled = true; err.textContent = "";
      try {
        const r = await fetch("chat/send", { method: "POST", headers: { "Content-Type": "application/json", "x-pin": getPin() }, body: JSON.stringify({ to: a.key, text }) });
        const j = await r.json();
        if (!r.ok) err.textContent = j.error || "Gửi không được."; else { ta.value = ""; err.textContent = ""; }
      } catch { err.textContent = "Không kết nối được máy chủ văn phòng."; }
      send.disabled = false; refresh(box, a, true);
    };
    send.onclick = doSend;
    ta.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) doSend(); });
    ["keyup", "keypress", "pointerdown", "wheel"].forEach((ev) => ta.addEventListener(ev, (e) => e.stopPropagation()));
    box._parts = { lock, ta, row, pinShow, hist, err };
    return box;
  }
  async function refresh(box, a, force, attempt) {
    const s = await loadStatus(force, attempt), p = box._parts;
    p.lock.style.display = s.authorized ? "none" : "flex";
    p.ta.style.display = p.row.style.display = s.authorized ? "" : "none";
    if (!s.authorized) p.err.textContent = "";
    if (!s.authorized && s.msg) { p.lock.querySelector(".err") || p.lock.appendChild(el("span", "err")); p.lock.querySelector(".err").textContent = s.msg; }
    p.pinShow.textContent = "";
    if (s.local && s.pin) { const b = el("button", "gh", "Hiện mã PIN cho điện thoại"); b.onclick = () => { b.replaceWith(el("span", "", `Mã PIN: ${s.pin} (chỉ hiện trên máy này)`)); }; p.pinShow.append(b); }
    p.hist.textContent = "";
    for (const m of (s.outbox || []).filter((x) => x.to === a.key).slice(0, 4)) {
      const d = el("div"); const b = el("b", cls(m.status), m.status); d.append(b, `${hhmm(m.t)} · ${m.text}`); d.title = m.text + (m.note ? "\n" + m.note : ""); p.hist.appendChild(d);
    }
  }
  // Gắn ô nhắn tin vào khung thẻ; giữ nguyên ô nếu vẫn là người đó.
  window.ChatBox = {
    mount(container, a) {
      if (!a || a.platform === "human") { container.querySelector(".chat")?.remove(); return; }
      let box = container.querySelector(".chat");
      if (box && box.dataset.key !== a.key) { box.remove(); box = null; }
      if (!box) { box = build(a); container.appendChild(box); refresh(box, a, true); }
      else if (Date.now() - statusAt > 3000) refresh(box, a, false);
    },
  };
})();
