// geo.js — simulador de ponto candidato, similaridade entre filiais e
// previsão de faturamento com intervalo de confiança.
// TOKEN, api() e sair() vêm de api.js (compartilhado, com timeout real).
document.getElementById("btn-sair").addEventListener("click", (e) => {
  e.preventDefault(); sair();
});

const brl = (v) => "R$ " + Number(v || 0).toLocaleString("pt-BR", {maximumFractionDigits: 0});

const map = L.map("geo-map", {zoomControl: false, attributionControl: false}).setView([-24.9, -53.5], 7);
L.control.zoom({position: "bottomright"}).addTo(map);
L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {maxZoom: 19}).addTo(map);

let marcador = null, circuloRaio = null;
const RAIO_KM = 3;

function corDoScore(score) {
  if (score >= 65) return "#10b981";
  if (score >= 35) return "#f59e0b";
  return "#ef4444";
}

async function simular(lat, lon) {
  const painel = document.getElementById("geo-resultado");
  painel.innerHTML = `<p class="vazio">Calculando…</p>`;

  if (marcador) map.removeLayer(marcador);
  if (circuloRaio) map.removeLayer(circuloRaio);
  marcador = L.marker([lat, lon]).addTo(map);
  circuloRaio = L.circle([lat, lon], {radius: RAIO_KM * 1000, color: "#60a5fa", fillOpacity: 0.06}).addTo(map);

  try {
    const r = await api(`/api/geo/simular?lat=${lat}&lon=${lon}&raio_km=${RAIO_KM}`);
    if (!r.disponivel) { painel.innerHTML = `<p class="vazio">${r.motivo}</p>`; return; }

    const cor = corDoScore(r.score_atratividade);
    const fatoresHTML = r.fatores.map(f => `
      <li class="fator"><span class="barra"><i style="width:${f.contribuicao_pct}%;background:${cor}"></i></span>
      <span class="txt">${f.rotulo}</span></li>`).join("");
    const ausentesHTML = Object.entries(r.componentes_nao_disponiveis || {}).map(([k, v]) =>
      `<li class="fator"><span class="txt" style="color:#64748b">${k}: indisponível — ${v}</span></li>`).join("");
    const regiaoHTML = r.municipio
      ? `<div class="geo-regiao">📍 ${r.municipio.municipio}/${r.municipio.uf}</div>`
      : `<div class="geo-regiao" style="color:#64748b">Município não identificado para este ponto</div>`;

    painel.innerHTML = `
      ${regiaoHTML}
      <div class="geo-score" style="color:${cor}">${r.score_atratividade}</div>
      <div class="geo-score-label">score de atratividade (0–100)</div>
      <ul class="fatores">${fatoresHTML}${ausentesHTML}</ul>
      <p class="aviso-inline">${r.aviso_isocrona}. Raio de deslocamento aproximado: ${r.raio_deslocamento_aproximado_km} km.</p>
    `;
  } catch (e) {
    painel.innerHTML = `<p class="vazio">Falha ao simular: ${e.message}</p>`;
  }
}

map.on("click", (e) => simular(e.latlng.lat, e.latlng.lng));

async function carregarSimilaridade() {
  const el = document.getElementById("similaridade-tabela");
  const r = await api("/api/geo/similaridade-filiais");
  if (!r.disponivel) { el.innerHTML = `<p class="vazio">${r.motivo}</p>`; return; }
  el.innerHTML = `<table class="tabela-simples"><thead>
      <tr><th>Filial A</th><th>Filial B</th><th>Similaridade</th></tr>
    </thead><tbody>
      ${r.pares.map(p => `<tr><td>${p.filial_a}</td><td>${p.filial_b}</td><td>${p.similaridade}</td></tr>`).join("")}
    </tbody></table>`;

  const select = document.getElementById("select-filial");
  select.innerHTML = r.filiais_avaliadas.map(f => `<option value="${f}">${f}</option>`).join("");
}

document.getElementById("btn-prever").addEventListener("click", async () => {
  const filial = document.getElementById("select-filial").value;
  const el = document.getElementById("previsao-resultado");
  el.innerHTML = `<p class="vazio">Calculando…</p>`;
  try {
    const r = await api(`/api/geo/faturamento-previsto?filial=${encodeURIComponent(filial)}`);
    if (!r.disponivel) { el.innerHTML = `<p class="vazio">${r.motivo}</p>`; return; }
    el.innerHTML = `<div class="cartao">
      <header><div class="ident"><b>${brl(r.faturamento_esperado)}</b>
      <span>intervalo 80%: ${brl(r.intervalo_confianca_80pct[0])} — ${brl(r.intervalo_confianca_80pct[1])}</span></div></header>
      <p class="aviso-inline">${r.metodo}. MAPE de backtest: ${r.mape_backtest_pct}%. Histórico: ${r.meses_historico} meses.</p>
    </div>`;
  } catch (e) {
    el.innerHTML = `<p class="vazio">${e.message}</p>`;
  }
});

carregarSimilaridade().catch(e => console.error(e));
