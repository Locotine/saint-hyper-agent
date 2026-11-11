// Hiển thị Markdown gọn cho sổ sách điều phối: tiêu đề, gạch đầu dòng, đánh số, bảng, đậm, mã, liên kết.
// Luôn thoát HTML trước (nội dung do agent viết là dữ liệu, không phải mã), rồi mới thêm định dạng.
(function () {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  function inline(s) {
    s = esc(s);
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    s = s.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
    s = s.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<i>$2</i>");
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    return s;
  }
  function render(md) {
    const lines = String(md || "").replace(/\r\n/g, "\n").split("\n"), out = [];
    let i = 0;
    while (i < lines.length) {
      const l = lines[i];
      if (!l.trim()) { i++; continue; }
      let m;
      if ((m = l.match(/^(#{1,4})\s+(.*)/))) { const n = Math.min(6, m[1].length + 2); out.push(`<h${n}>${inline(m[2])}</h${n}>`); i++; continue; }
      if (/^\|/.test(l)) { // bảng
        const rows = [];
        while (i < lines.length && /^\|/.test(lines[i])) { if (!/^\|\s*:?-{2,}/.test(lines[i])) rows.push(lines[i].replace(/^\||\|\s*$/g, "").split("|").map((c) => c.trim())); i++; }
        const [head, ...body] = rows;
        out.push(`<div class="mdt"><table><thead><tr>${(head || []).map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
        continue;
      }
      if (/^\s*([-*]|\d+\.)\s+/.test(l)) { // danh sách (cả lồng một cấp)
        const ordered = /^\s*\d+\./.test(l), items = [];
        while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) {
          const sub = /^\s{2,}/.test(lines[i]); const t = inline(lines[i].replace(/^\s*([-*]|\d+\.)\s+/, ""));
          items.push(sub ? `<li class="sub">${t}</li>` : `<li>${t}</li>`); i++;
          while (i < lines.length && lines[i].trim() && !/^\s*([-*]|\d+\.)\s+/.test(lines[i]) && !/^(#|\|)/.test(lines[i])) { items[items.length - 1] = items[items.length - 1].replace(/<\/li>$/, " " + inline(lines[i].trim()) + "</li>"); i++; }
        }
        out.push(ordered ? `<ol>${items.join("")}</ol>` : `<ul>${items.join("")}</ul>`); continue;
      }
      const para = [];
      while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|\||\s*([-*]|\d+\.)\s)/.test(lines[i])) { para.push(lines[i].trim()); i++; }
      out.push(`<p>${inline(para.join(" "))}</p>`);
    }
    return out.join("");
  }
  window.MD = { render, esc };
})();
