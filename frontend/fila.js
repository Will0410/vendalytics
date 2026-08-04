const TOKEN = localStorage.getItem("vendalytics_token");
if (!TOKEN) location.href = "login.html";

async function api(path, opcoes = {}) {
  const r = await fetch(path, {
    ...opcoes,
    headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" },
  });
  if (r.status === 401) { localStorage.clear(); location.href = "login.html"; throw new Error("sessão expirada"); }
  if (!r.ok) throw new Error((await r.text()) || r.status);
  return r.json();
}

document.getElementById("btn-sair").addEventListener("click", (e) => {
  e.preventDefault(); localStorage.clear(); location.href = "login.html";
});

const brl = (v) => "R$ " + Number(v || 0).toLocaleString("pt-BR", { maximumFractionDigits: 0 });

const DESFECHOS = [
  { chave: "ganhou", texto: "Ganhou", classe: "ok" },
  { chave: "aceita", texto: "Aceita", classe: "" },
  { chave: "recusada", texto: "Recusada", classe: "" },
  { chave: "perdeu", texto: "Perdeu", classe: "ruim" },
  { chave: "ignorada", texto: "Ignorar", classe: "neutro" },
];

function gaugeSVG(valor, max, cor, rotulo) {
  const r = 30;
  const circ = 2 * Math.PI * r;
  const pct = Math.min(Math.max(valor / max, 0), 1);
  const offset = circ - pct * circ;
  return `<div class="gauge-card">
    <div class="gauge-tooltip">${rotulo}: ${valor}</div>
    <svg class="gauge-svg" viewBox="0 0 80 80">
      <circle class="gauge-bg" cx="40" cy="40" r="${r}"/>
      <circle class="gauge-fg" cx="40" cy="40" r="${r}"
        stroke="${cor}"
        stroke-dasharray="${circ}"
        stroke-dashoffset="${offset}"/>
    </svg>
    <div class="gauge-value">${valor}</div>
    <div class="gauge-label">${rotulo}</div>
  </div>`;
}

function faixaModelo(m, saude) {
  const el = document.getElementById("gauges");
  if (!el) return;
  const pct = (v) => (v === null || v === undefined ? "—" : v + "%");
  const num = (v) => (v === null || v === undefined ? "—" : v);
  const auc = num(m.auc_out_of_time);
  const ece = num(m.ece);
  const lift = num(m.lift_top_decil) + "×";
  const amostras = num(m.amostras_treino);
  const cobertura = pct(saude && saude.cobertura_pct);
  const aceite = pct(saude && saude.taxa_aceite_pct);

  el.innerHTML =
    gaugeSVG(auc, 1, "#22d3ee", "AUC out-of-time") +
    gaugeSVG(ece, 0.1, "#fbbf24", "Erro de calibração") +
    gaugeSVG(num(m.lift_top_decil), 10, "#a78bfa", "Lift top decil") +
    gaugeSVG(amostras, 10000, "#34d399", "Amostras de treino") +
    gaugeSVG(cobertura === "—" ? 0 : Number(cobertura), 100, "#60a5fa", "Loop fechado") +
    gaugeSVG(aceite === "—" ? 0 : Number(aceite), 100, "#f472b6", "Taxa de aceite");
}

function radarSVG(fatores) {
  const maxFatores = 6;
  const exibir = (fatores || []).slice(0, maxFatores);
  if (!exibir.length) return "";
  const n = exibir.length;
  const cx = 70, cy = 70, r = 50;
  const step = (2 * Math.PI) / n;
  const startAngle = -Math.PI / 2;

  const points = exibir.map((f, i) => {
    const angle = startAngle + i * step;
    const val = Math.min(Math.abs(Number(f.contribuicao) || 0) * 2, 1);
    return `${cx + r * val * Math.cos(angle)},${cy + r * val * Math.sin(angle)}`;
  });

  const gridPoints = [0.25, 0.5, 0.75, 1].map(scale =>
    exibir.map((_, i) => {
      const angle = startAngle + i * step;
      return `${cx + r * scale * Math.cos(angle)},${cy + r * scale * Math.sin(angle)}`;
    }).join(" ")
  );

  const labels = exibir.map((f, i) => {
    const angle = startAngle + i * step;
    const lx = cx + (r + 14) * Math.cos(angle);
    const ly = cy + (r + 14) * Math.sin(angle);
    return `<text x="${lx}" y="${ly}" text-anchor="middle" dominant-baseline="middle" fill="#94a3b8" font-size="8" font-family="sans-serif">${f.rotulo}</text>`;
  }).join("");

  return `<div class="radar-container">
    <svg viewBox="0 0 140 140" xmlns="http://www.w3.org/2000/svg">
      ${gridPoints.map(gp => `<polygon points="${gp}" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="0.5"/>`).join("")}
      <polygon points="${points.join(" ")}" fill="rgba(37,99,235,0.15)" stroke="#2563eb" stroke-width="1.5"/>
      ${exibir.map((f, i) => {
        const angle = startAngle + i * step;
        const val = Math.min(Math.abs(Number(f.contribuicao) || 0) * 2, 1);
        const px = cx + r * val * Math.cos(angle);
        const py = cy + r * val * Math.sin(angle);
        return `<circle cx="${px}" cy="${py}" r="3" fill="#2563eb"/>`;
      }).join("")}
      ${labels}
    </svg>
  </div>`;
}

function barraFator(f) {
  const c = Number(f.contribuicao) || 0;
  const largura = Math.min(Math.abs(c) * 22, 100);
  const sinal = c >= 0 ? "sobe" : "desce";
  return `<li class="fator ${sinal}">
    <span class="barra"><i style="width:${largura}%"></i></span>
    <span class="txt">${f.rotulo}</span>
  </li>`;
}

function cartao(item) {
  const fatores = (item.fatores || []).map(barraFator).join("");
  const botoes = DESFECHOS.map(d =>
    `<button class="bt-desfecho ${d.classe}" data-cliente="${item.cliente_id}" data-desfecho="${d.chave}">${d.texto}</button>`
  ).join("");
  const radar = radarSVG(item.fatores || []);
  return `<article class="cartao" id="c-${item.cliente_id}">
    <header>
      <div class="ident">
        <div class="id-row">
          <div class="confidence-ring" title="Confiança do modelo para este cliente">
            <svg viewBox="0 0 36 36">
              <circle class="ring-bg" cx="18" cy="18" r="14"/>
              <circle class="ring-fg" cx="18" cy="18" r="14"
                stroke="${item.confianca >= 0.7 ? '#10b981' : item.confianca >= 0.4 ? '#fbbf24' : '#ef4444'}"
                stroke-dasharray="${2 * Math.PI * 14}"
                stroke-dashoffset="${2 * Math.PI * 14 * (1 - (item.confianca || 0.5))}"/>
            </svg>
            <span class="ring-label">${Math.round((item.confianca || 0.5) * 100)}%</span>
          </div>
          <b>${item.cliente_id}</b>
        </div>
        <span>ticket médio ${brl(item.ticket_medio)}</span>
      </div>
      <div class="numeros">
        <div class="ve"><b>${brl(item.valor_esperado)}</b><span>valor esperado</span></div>
        <div class="sc"><b>${item.score}</b><span>propensão</span></div>
      </div>
    </header>
    ${radar}
    <ul class="fatores">${fatores}</ul>
    <footer><span class="rotulo-loop">Desfecho:</span>${botoes}<span class="aviso"></span></footer>
  </article>`;
}

async function registrarDesfecho(botao) {
  const cliente = botao.dataset.cliente;
  const desfecho = botao.dataset.desfecho;
  const cartaoEl = document.getElementById("c-" + cliente);
  if (!cartaoEl) return;
  const aviso = cartaoEl.querySelector(".aviso");
  cartaoEl.querySelectorAll(".bt-desfecho").forEach(b => (b.disabled = true));
  aviso.textContent = "registrando…";
  try {
    await api("/api/fila/desfecho/" + encodeURIComponent(cliente), {
      method: "POST",
      body: JSON.stringify({ desfecho, motivo: "" }),
    });
    cartaoEl.classList.add("fechado");
    aviso.textContent = "registrado: " + desfecho;
  } catch (e) {
    cartaoEl.querySelectorAll(".bt-desfecho").forEach(b => (b.disabled = false));
    aviso.textContent = "falhou — tente de novo";
    console.error(e);
  }
}

async function carregar() {
  const alvo = document.getElementById("fila");
  const gaugesEl = document.getElementById("gauges");
  try {
    const r = await api("/api/fila/diaria?limite=12");
    if (!r.disponivel) {
      if (gaugesEl) gaugesEl.innerHTML = `<span class="mi indisponivel"><b>Modelo indisponível</b></span>`;
      alvo.innerHTML = `<p class="vazio">${r.motivo}</p>`;
      return;
    }
    const saude = await api("/api/fila/saude-do-loop").catch(() => null);
    faixaModelo(r.modelo, saude);
    const aviso = r.confiavel ? "" :
      `<div class="aviso-modelo"><b>Fila exploratória</b>${r.aviso}</div>`;
    alvo.innerHTML = aviso + (r.itens.length
      ? r.itens.map(cartao).join("")
      : `<p class="vazio">Nenhuma conta priorizada hoje.</p>`);
    alvo.querySelectorAll(".bt-desfecho").forEach(b =>
      b.addEventListener("click", () => registrarDesfecho(b)));
  } catch (e) {
    alvo.innerHTML = `<p class="vazio">Não foi possível carregar a fila: ${e.message}</p>`;
    console.error(e);
  }
}

document.addEventListener("DOMContentLoaded", carregar);