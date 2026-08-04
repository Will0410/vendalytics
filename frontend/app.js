const TOKEN = localStorage.getItem("vendalytics_token");
if (!TOKEN) location.href = "login.html";

const API_BASE = "";

async function api(path) {
  const r = await fetch(path, { headers: { Authorization: "Bearer " + TOKEN } });
  if (r.status === 401) { localStorage.clear(); location.href = "login.html"; throw new Error("sessão expirada"); }
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

document.getElementById("btn-sair").addEventListener("click", (e) => {
  e.preventDefault(); localStorage.clear(); location.href = "login.html";
});

function kpiRingHTML(valor, rotulo, pct) {
  const circ = 2 * Math.PI * 18;
  const offset = circ - (pct / 100) * circ;
  return `<div class="kpi">
    <div class="kpi-ring">
      <svg viewBox="0 0 48 48">
        <circle class="ring-bg" cx="24" cy="24" r="18"/>
        <circle class="ring-fg" cx="24" cy="24" r="18"
          stroke-dasharray="${circ}" stroke-dashoffset="${offset}"/>
      </svg>
    </div>
    <b>${valor}</b>
    <span>${rotulo}</span>
  </div>`;
}

function animateCounters() {
  document.querySelectorAll(".kpi b").forEach(el => {
    const raw = el.textContent.replace(/[^0-9.,]/g, "");
    const target = parseFloat(raw.replace(".", "").replace(",", "."));
    if (isNaN(target)) return;
    const prefix = el.textContent.includes("R$") ? "R$ " : "";
    const suffix = el.textContent.includes("Clientes") ? "" : "";
    const duration = 1200;
    const start = performance.now();
    function tick(now) {
      const progress = Math.min((now - start) / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      const current = Math.round(target * eased);
      el.textContent = prefix + current.toLocaleString("pt-BR") + suffix;
      if (progress < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  });
}

async function carregarKpis() {
  const d = await api("/api/metrics/dashboard");
  const el = document.getElementById("kpis");
  const total = d.total_clientes || 1;
  const pcts = {
    "Clientes": 75,
    "Ativos": Math.round((d.clientes_ativos / total) * 100),
    "Faturamento 30d": 60,
    "Vendedores": Math.round((d.total_vendedores / 20) * 100),
  };
  el.innerHTML =
    kpiRingHTML(d.total_clientes.toLocaleString("pt-BR"), "Clientes", pcts["Clientes"]) +
    kpiRingHTML(d.clientes_ativos.toLocaleString("pt-BR"), "Ativos", pcts["Ativos"]) +
    kpiRingHTML("R$ " + d.faturamento_30d.toLocaleString("pt-BR", { maximumFractionDigits: 0 }), "Faturamento 30d", pcts["Faturamento 30d"]) +
    kpiRingHTML(String(d.total_vendedores), "Vendedores", pcts["Vendedores"]);
  animateCounters();
}

function initParticles() {
  const canvas = document.getElementById("bg-canvas");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  let w, h, particles = [];
  const COUNT = 40;

  function resize() {
    w = canvas.width = window.innerWidth;
    h = canvas.height = window.innerHeight;
  }
  resize();
  window.addEventListener("resize", resize);

  for (let i = 0; i < COUNT; i++) {
    particles.push({
      x: Math.random() * w,
      y: Math.random() * h,
      vx: (Math.random() - 0.5) * 0.3,
      vy: (Math.random() - 0.5) * 0.3,
      r: Math.random() * 2 + 0.5,
      alpha: Math.random() * 0.3 + 0.1,
    });
  }

  let mouse = { x: -1000, y: -1000 };
  document.addEventListener("mousemove", (e) => {
    mouse.x = e.clientX;
    mouse.y = e.clientY;
  });

  function draw() {
    ctx.clearRect(0, 0, w, h);
    particles.forEach(p => {
      const dx = mouse.x - p.x;
      const dy = mouse.y - p.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 200) {
        p.vx += dx * 0.00005;
        p.vy += dy * 0.00005;
      }
      p.x += p.vx;
      p.y += p.vy;
      if (p.x < 0) p.x = w;
      if (p.x > w) p.x = 0;
      if (p.y < 0) p.y = h;
      if (p.y > h) p.y = 0;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(37,99,235,${p.alpha})`;
      ctx.fill();
    });
    for (let i = 0; i < particles.length; i++) {
      for (let j = i + 1; j < particles.length; j++) {
        const dx = particles[i].x - particles[j].x;
        const dy = particles[i].y - particles[j].y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 150) {
          ctx.beginPath();
          ctx.moveTo(particles[i].x, particles[i].y);
          ctx.lineTo(particles[j].x, particles[j].y);
          ctx.strokeStyle = `rgba(37,99,235,${0.06 * (1 - dist / 150)})`;
          ctx.lineWidth = 0.5;
          ctx.stroke();
        }
      }
    }
    requestAnimationFrame(draw);
  }
  draw();
}

async function carregarMapa() {
  const map = L.map("map", {
    center: [-24.9, -53.5],
    zoom: 8,
    zoomControl: false,
    attributionControl: false,
  });

  L.control.zoom({ position: "bottomright" }).addTo(map);

  L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
    maxZoom: 19,
  }).addTo(map);

  let heatLayer = null;
  const btnHeat = document.getElementById("btn-heatmap");

  const d = await api("/api/clientes?limit=1500");
  const grupo = L.layerGroup().addTo(map);
  const pontos = [];

  d.clientes.forEach(c => {
    if (!c.lat || !c.lon) return;
    const cor = c.status === "ativo" ? "#22d3ee" : "#f87171";
    const raio = Math.max(4, Math.min(14, (c.valor_esperado || 50000) / 8000));
    const marker = L.circleMarker([c.lat, c.lon], {
      radius: raio,
      fillColor: cor,
      fillOpacity: 0.85,
      color: "rgba(255,255,255,0.3)",
      weight: 1,
    });

    const sparkHTML = (c.atividade || []).map(v => {
      const h = Math.abs(v) * 3;
      const color = v >= 0 ? "#22d3ee" : "#f87171";
      return `<div style="display:inline-block;width:3px;height:${h}px;background:${color};border-radius:1px;margin:0 1px;vertical-align:bottom;"></div>`;
    }).join("");

    marker.bindPopup(
      `<b>${c.nome}</b><br>${c.municipio || ""} - ${c.uf || ""}<br>Segmento: ${c.segmento || "—"}<br>Valor esperado: R$ ${(c.valor_esperado || 0).toLocaleString("pt-BR")}<br><div style="margin-top:4px;display:flex;align-items:flex-end;gap:1px;">${sparkHTML}</div>`,
      { className: "dark-popup" }
    );

    marker.addTo(grupo);
    pontos.push([c.lat, c.lon]);
  });

  if (pontos.length) map.fitBounds(pontos, { padding: [30, 30] });

  btnHeat.addEventListener("click", () => {
    if (heatLayer) {
      map.removeLayer(heatLayer);
      heatLayer = null;
      btnHeat.classList.remove("active");
      return;
    }
    heatLayer = L.heatLayer(
      d.clientes.filter(c => c.lat && c.lon).map(c => [c.lat, c.lon, 0.5]),
      { radius: 25, blur: 15, maxZoom: 12, max: 1.0 }
    ).addTo(map);
    btnHeat.classList.add("active");
  });

  document.getElementById("btn-reset").addEventListener("click", () => {
    map.setView([-24.9, -53.5], 8);
  });
}

document.addEventListener("DOMContentLoaded", () => {
  initParticles();
  carregarKpis().catch(e => console.error(e));
  carregarMapa().catch(e => console.error(e));
});