// field.js — roteiro de campo: propensão + gap de mix local, correção de
// dado em campo e registro de visita (loop fechado, spec D3).
const TOKEN = localStorage.getItem("vendalytics_token");
if (!TOKEN) location.href = "login.html";

async function api(path, opcoes = {}) {
  const r = await fetch(path, {
    ...opcoes,
    headers: {Authorization: "Bearer " + TOKEN, "Content-Type": "application/json"},
  });
  if (r.status === 401) { localStorage.clear(); location.href = "login.html"; throw new Error("sessão expirada"); }
  if (!r.ok) throw new Error((await r.text()) || r.status);
  return r.json();
}

document.getElementById("btn-sair").addEventListener("click", (e) => {
  e.preventDefault(); localStorage.clear(); location.href = "login.html";
});

const brl = (v) => "R$ " + Number(v || 0).toLocaleString("pt-BR", {maximumFractionDigits: 0});

function cartaoParada(p) {
  const fatoresPropensao = (p.fatores_propensao || []).map(f => `
    <li class="fator ${f.contribuicao >= 0 ? "sobe" : "desce"}">
      <span class="barra"><i style="width:${Math.min(Math.abs(f.contribuicao) * 22, 100)}%"></i></span>
      <span class="txt">${f.rotulo}</span>
    </li>`).join("");
  const gapHTML = (p.gap_de_mix || []).length
    ? `<div class="gap-mix"><b>Gap de mix local:</b><ul>${
        p.gap_de_mix.map(g => `<li>${g.argumento}</li>`).join("")}</ul></div>`
    : `<div class="gap-mix aviso-inline">Sem gap de mix identificado para este cliente.</div>`;

  return `<article class="cartao" id="parada-${p.cliente_id}">
    <header>
      <div class="ident"><b>${p.cliente_id}</b><span>propensão ${p.score_propensao}</span></div>
      <div class="numeros"><div class="ve"><b>${brl(p.valor_esperado)}</b><span>valor esperado</span></div></div>
    </header>
    <ul class="fatores">${fatoresPropensao}</ul>
    ${gapHTML}
    <footer>
      <span class="rotulo-loop">Visita:</span>
      <button class="bt-desfecho ok" data-cliente="${p.cliente_id}" data-acao="pedido">Gerou pedido</button>
      <button class="bt-desfecho" data-cliente="${p.cliente_id}" data-acao="sem-pedido">Sem pedido</button>
      <span class="rotulo-loop">Correção:</span>
      <button class="bt-desfecho ruim" data-cliente="${p.cliente_id}" data-acao="pdv_fechado">PDV fechado</button>
      <button class="bt-desfecho" data-cliente="${p.cliente_id}" data-acao="concorrente_presente">Concorrente</button>
      <span class="aviso"></span>
    </footer>
  </article>`;
}

async function registrarAcao(botao) {
  const cliente = botao.dataset.cliente, acao = botao.dataset.acao;
  const cartao = document.getElementById("parada-" + cliente);
  const aviso = cartao.querySelector(".aviso");
  aviso.textContent = "registrando…";
  try {
    if (acao === "pedido" || acao === "sem-pedido") {
      await api(`/api/field/visita/${encodeURIComponent(cliente)}`, {
        method: "POST", body: JSON.stringify({pedido_gerado: acao === "pedido"}),
      });
    } else {
      await api(`/api/field/correcao/${encodeURIComponent(cliente)}`, {
        method: "POST", body: JSON.stringify({tipo: acao, detalhe: "registrado via app de campo"}),
      });
    }
    aviso.textContent = "registrado";
  } catch (e) {
    aviso.textContent = "falhou — tente de novo";
    console.error(e);
  }
}

async function carregar() {
  const el = document.getElementById("roteiro");
  try {
    const r = await api("/api/field/roteiro-do-dia?limite=10");
    if (!r.disponivel) { el.innerHTML = `<p class="vazio">${r.motivo}</p>`; return; }
    el.innerHTML = r.paradas.length
      ? r.paradas.map(cartaoParada).join("")
      : `<p class="vazio">Nenhuma parada priorizada hoje.</p>`;
    el.querySelectorAll(".bt-desfecho").forEach(b => b.addEventListener("click", () => registrarAcao(b)));
  } catch (e) {
    el.innerHTML = `<p class="vazio">Falha ao carregar roteiro: ${e.message}</p>`;
  }
}

carregar();
