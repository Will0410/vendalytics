// app.js — tela principal: dashboard de KPIs + mapa de clientes. Consome só
// a API do Vendalytics (/api/metrics/dashboard, /api/clientes); nenhum dado
// hardcoded aqui — tudo vem do adapter configurado no backend.
const TOKEN = localStorage.getItem("vendalytics_token");
if (!TOKEN) location.href = "login.html";

async function api(path) {
  const r = await fetch(path, {headers: {Authorization: "Bearer " + TOKEN}});
  if (r.status === 401) { localStorage.clear(); location.href = "login.html"; throw new Error("sessão expirada"); }
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

document.getElementById("btn-sair").addEventListener("click", (e) => {
  e.preventDefault(); localStorage.clear(); location.href = "login.html";
});

async function carregarKpis() {
  const d = await api("/api/metrics/dashboard");
  const el = document.getElementById("kpis");
  const kpi = (valor, rotulo) => `<div class="kpi"><b>${valor}</b><span>${rotulo}</span></div>`;
  el.innerHTML =
    kpi(d.total_clientes.toLocaleString("pt-BR"), "Clientes") +
    kpi(d.clientes_ativos.toLocaleString("pt-BR"), "Ativos") +
    kpi("R$ " + d.faturamento_30d.toLocaleString("pt-BR", {maximumFractionDigits: 0}), "Faturamento 30d") +
    kpi(d.total_vendedores, "Vendedores");
}

async function carregarMapa() {
  const map = L.map("map").setView([-24.9, -53.5], 8);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {attribution: "© OpenStreetMap"}).addTo(map);
  const d = await api("/api/clientes?limit=1500");
  const grupo = L.layerGroup().addTo(map);
  d.clientes.forEach(c => {
    if (!c.lat || !c.lon) return;
    const cor = c.status === "ativo" ? "#2563eb" : "#ef4444";
    L.circleMarker([c.lat, c.lon], {radius: 5, fillColor: cor, fillOpacity: .85, color: "#fff", weight: 1})
      .bindPopup(`<b>${c.nome}</b><br>${c.municipio || ""} - ${c.uf || ""}<br>${c.segmento || ""}`)
      .addTo(grupo);
  });
  if (d.clientes.length) {
    const pontos = d.clientes.filter(c => c.lat && c.lon).map(c => [c.lat, c.lon]);
    if (pontos.length) map.fitBounds(pontos, {padding: [30, 30]});
  }
}

carregarKpis().catch(e => console.error(e));
carregarMapa().catch(e => console.error(e));
