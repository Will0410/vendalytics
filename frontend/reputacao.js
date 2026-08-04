// reputacao.js — dashboard de Reputation Intelligence.
const TOKEN = localStorage.getItem("vendalytics_token");
if (!TOKEN) location.href = "login.html";

async function api(path, opcoes = {}) {
  const r = await fetch(path, {
    ...opcoes,
    headers: {Authorization: "Bearer " + TOKEN, ...(opcoes.headers || {})},
  });
  if (r.status === 401) { localStorage.clear(); location.href = "login.html"; throw new Error("sessão expirada"); }
  if (!r.ok) throw new Error((await r.text()) || r.status);
  return r.json();
}

document.getElementById("btn-sair").addEventListener("click", (e) => {
  e.preventDefault(); localStorage.clear(); location.href = "login.html";
});

const brl = (v) => "R$ " + Number(v || 0).toLocaleString("pt-BR", {maximumFractionDigits: 0});

function gaugeSVG(valor, max, cor, rotulo) {
  const r = 30, circ = 2 * Math.PI * r;
  const pct = Math.min(Math.max(valor / max, 0), 1);
  return `<div class="gauge-card">
    <div class="gauge-tooltip">${rotulo}: ${valor}</div>
    <svg class="gauge-svg" viewBox="0 0 80 80">
      <circle class="gauge-bg" cx="40" cy="40" r="${r}"/>
      <circle class="gauge-fg" cx="40" cy="40" r="${r}" stroke="${cor}"
        stroke-dasharray="${circ}" stroke-dashoffset="${circ - pct * circ}"/>
    </svg>
    <div class="gauge-value">${valor}</div>
    <div class="gauge-label">${rotulo}</div>
  </div>`;
}

async function carregarResumo() {
  const el = document.getElementById("resumo");
  const r = await api("/api/reputacao/resumo?dias=30");
  if (!r.disponivel) {
    el.innerHTML = `<span class="mi indisponivel"><b>Sem menções</b><small>${r.motivo}</small></span>`;
    return;
  }
  el.innerHTML =
    gaugeSVG(r.total_mencoes, Math.max(r.total_mencoes, 10), "#60a5fa", "Total (30d)") +
    gaugeSVG(r.positivas, r.total_mencoes, "#10b981", "Positivas") +
    gaugeSVG(r.negativas, r.total_mencoes, "#ef4444", "Negativas") +
    gaugeSVG(Math.round((r.sentimento_medio_ponderado + 1) * 50), 100, "#a78bfa", "Sentimento ponderado");
}

async function carregarMencoes() {
  const el = document.getElementById("mencoes-lista");
  const r = await api("/api/reputacao/mencoes?dias=90&limit=50");
  if (!r.mencoes.length) { el.innerHTML = `<p class="vazio">Nenhuma menção nos últimos 90 dias.</p>`; return; }
  el.innerHTML = r.mencoes.map(m => {
    const sinal = m.sentimento > 0.15 ? "sobe" : m.sentimento < -0.15 ? "desce" : "";
    const cor = m.sentimento > 0.15 ? "#10b981" : m.sentimento < -0.15 ? "#ef4444" : "#64748b";
    return `<article class="cartao">
      <header>
        <div class="ident">
          <b>${m.veiculo || "(sem veículo)"}</b>
          <span>${m.canal} · ${m.publicado_em} ${m.conta_ref ? "· conta: " + m.conta_ref : ""}</span>
        </div>
        <div class="numeros">
          <div class="sc"><b style="color:${cor}">${m.sentimento.toFixed(2)}</b><span>sentimento</span></div>
        </div>
      </header>
      <ul class="fatores"><li class="fator ${sinal}"><span class="txt">${m.texto}</span></li></ul>
    </article>`;
  }).join("");
}

async function carregarAlertas() {
  const el = document.getElementById("alertas-lista");
  const r = await api("/api/reputacao/alertas?limit=20");
  if (!r.alertas.length) { el.innerHTML = `<p class="vazio">Nenhum alerta.</p>`; return; }
  el.innerHTML = r.alertas.map(a => `
    <div class="linha-alerta">
      <b>${a.tipo}</b>
      <span>${a.janela_de} → ${a.janela_ate}: ${a.volume} menções (esperado ~${Math.round(a.volume_esperado)}, z=${a.zscore})</span>
    </div>`).join("");
}

async function carregarBenchmark() {
  const el = document.getElementById("benchmark-tabela");
  const r = await api("/api/reputacao/benchmarking?dias=90");
  if (!r.disponivel) { el.innerHTML = `<p class="vazio">${r.motivo}</p>`; return; }
  el.innerHTML = `<table class="tabela-simples"><thead>
      <tr><th>Veículo</th><th>Menções</th><th>Share of voice</th><th>Sentimento médio</th></tr>
    </thead><tbody>
      ${r.por_veiculo.map(v => `<tr>
        <td>${v.veiculo}</td><td>${v.mencoes}</td>
        <td>${v.share_of_voice_pct}%</td><td>${v.sentimento_medio.toFixed(2)}</td>
      </tr>`).join("")}
    </tbody></table>`;
}

document.getElementById("form-import").addEventListener("submit", async (e) => {
  e.preventDefault();
  const arquivo = document.getElementById("arquivo-csv").files[0];
  const status = document.getElementById("import-status");
  if (!arquivo) return;
  status.textContent = "importando…";
  try {
    const r = await api("/api/reputacao/importar-csv", {method: "POST", body: await arquivo.text()});
    status.textContent = `importadas: ${r.importadas} · duplicadas: ${r.duplicadas} · casadas com conta: ${r.casadas_com_conta}`;
    carregarResumo(); carregarMencoes(); carregarBenchmark();
  } catch (err) {
    status.textContent = "falhou: " + err.message;
  }
});

document.getElementById("btn-checar-anomalia").addEventListener("click", async () => {
  try {
    await api("/api/reputacao/checar-anomalia", {method: "POST"});
    carregarAlertas();
  } catch (err) { console.error(err); }
});

carregarResumo().catch(e => console.error(e));
carregarMencoes().catch(e => console.error(e));
carregarAlertas().catch(e => console.error(e));
carregarBenchmark().catch(e => console.error(e));
