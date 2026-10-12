// Shared demo behaviour for the v2 suite mockups (static, sample data only).
(function () {
  let h = 24230;
  const fmt = (n) => n.toLocaleString("en");
  function tickBlocks() {
    h++;
    document.querySelectorAll("[data-block]").forEach((el) => (el.textContent = "#" + fmt(h)));
    const row = document.querySelector("[data-blocks]");
    if (row) {
      const el = document.createElement("div");
      el.className = "blk new";
      const tx = Math.random() < 0.45 ? Math.ceil(Math.random() * 3) : 0;
      el.innerHTML = `<span class="mono di">block</span><b>#${fmt(h)}</b><span class="mono di">0x${Math.random().toString(16).slice(2, 6)}…</span><div style="margin-top:5px;color:${tx ? "#22E3F0" : "#5F6B82"}">${tx} tx · 4/4 signed</div>`;
      row.prepend(el);
      [...row.children].slice(1).forEach((e) => e.classList.remove("new"));
      while (row.children.length > 9) row.lastChild.remove();
    }
  }
  const row = document.querySelector("[data-blocks]");
  if (row) for (let i = 0; i < 7; i++) { tickBlocks(); row.firstChild.classList.remove("new"); }
  setInterval(tickBlocks, 2000);

  document.querySelectorAll("[data-clock]").forEach((el) => {
    const f = () => (el.textContent = new Date().toLocaleTimeString("en-GB", { timeZone: "Asia/Karachi" }));
    f(); setInterval(f, 1000);
  });

  document.querySelectorAll("[data-type]").forEach((el) => {
    const full = el.innerHTML, plain = full.replace(/<[^>]+>/g, "");
    let i = 0;
    const go = () => { i += 2; if (i >= plain.length) { el.innerHTML = full; return; } el.innerHTML = plain.slice(0, i) + '<span style="display:inline-block;width:8px;height:15px;background:#22E3F0;vertical-align:-2px"></span>'; setTimeout(go, 16); };
    const io = new IntersectionObserver((e) => { if (e[0].isIntersecting) { go(); io.disconnect(); } });
    io.observe(el);
  });

  document.querySelectorAll("[data-range]").forEach((r) => {
    const out = document.querySelectorAll("[data-calc]");
    const upd = () => {
      const v = +r.value, y = v * 0.092, f = (n) => "Rs " + Math.round(n).toLocaleString("en-PK");
      out.forEach((o) => { const k = o.dataset.calc; o.textContent = k === "amt" ? f(v) : k === "m" ? f(y / 12) : k === "y" ? f(y) : k === "t" ? Math.floor(v / 503).toLocaleString("en-PK") : f(y * 5); });
    };
    r.addEventListener("input", upd); upd();
  });

  document.querySelectorAll(".tilt").forEach((el) => {
    el.addEventListener("mousemove", (e) => { const b = el.getBoundingClientRect(), x = (e.clientX - b.left) / b.width - .5, y = (e.clientY - b.top) / b.height - .5; el.style.transform = `perspective(900px) rotateX(${(-y * 6).toFixed(2)}deg) rotateY(${(x * 8).toFixed(2)}deg) translateY(-4px)`; });
    el.addEventListener("mouseleave", () => (el.style.transform = ""));
  });

  const net = document.getElementById("net");
  if (net) {
    const x = net.getContext("2d"), dpr = devicePixelRatio || 1; let W, H, pts = [], pulses = [];
    const size = () => { const r = net.getBoundingClientRect(); W = net.width = r.width * dpr; H = net.height = r.height * dpr; pts = Array.from({ length: 46 }, () => ({ x: Math.random() * W, y: Math.random() * H, vx: (Math.random() - .5) * .35 * dpr, vy: (Math.random() - .5) * .35 * dpr, r: (Math.random() * 1.8 + 1) * dpr })); };
    size(); addEventListener("resize", size);
    const frame = () => {
      x.clearRect(0, 0, W, H); const d = 150 * dpr;
      for (const p of pts) { p.x += p.vx; p.y += p.vy; if (p.x < 0 || p.x > W) p.vx *= -1; if (p.y < 0 || p.y > H) p.vy *= -1; }
      for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) { const a = pts[i], b = pts[j], dist = Math.hypot(a.x - b.x, a.y - b.y); if (dist < d) { x.strokeStyle = `rgba(34,227,240,${(1 - dist / d) * .28})`; x.lineWidth = dpr; x.beginPath(); x.moveTo(a.x, a.y); x.lineTo(b.x, b.y); x.stroke(); } }
      for (const p of pts) { x.fillStyle = "rgba(139,92,246,.9)"; x.beginPath(); x.arc(p.x, p.y, p.r, 0, 7); x.fill(); }
      if (Math.random() < .04) pulses.push({ a: pts[Math.random() * pts.length | 0], b: pts[Math.random() * pts.length | 0], t: 0 });
      pulses = pulses.filter((q) => q.t <= 1); for (const q of pulses) { q.t += .02; x.fillStyle = "rgba(46,242,181,.95)"; x.shadowColor = "#2EF2B5"; x.shadowBlur = 12 * dpr; x.beginPath(); x.arc(q.a.x + (q.b.x - q.a.x) * q.t, q.a.y + (q.b.y - q.a.y) * q.t, 2.6 * dpr, 0, 7); x.fill(); x.shadowBlur = 0; }
      requestAnimationFrame(frame);
    };
    frame();
  }
})();
