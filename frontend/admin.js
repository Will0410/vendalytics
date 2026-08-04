// admin.js — território, identidade, status de integrações e agente de rascunho.
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

function pill(rotulo, ok) {
  return `<span class="mi"><b style="color:${ok ? "#10b981" : "#64748b"}">${ok ? "configurado" : "—"}</b>${rotulo}</span>`;
}

async function carregarIntegracoes() {
  const el = document.getElementById("integracoes-status");
  try {
    const r = await api("/api/integracoes/status");
    el.innerHTML =
      pill("Salesforce", r.salesforce) + pill("HubSpot", r.hubspot) +
      pill("WHAPI", r.whapi) + pill("NewsAPI", r.newsapi) + pill("Agente LLM", r.agente_llm);
  } catch (e) {
    el.innerHTML = `<p class="vazio">Requer perfil admin.</p>`;
  }
}

document.getElementById("btn-simular-territorio").addEventListener("click", async () => {
  const el = document.getElementById("territorio-resultado");
  const extra = document.getElementById("vendedores-extra").value || 0;
  el.innerHTML = `<p class="vazio">Simulando…</p>`;
  try {
    const r = await api(`/api/territorio/simular-carteiras?vendedores_extra=${extra}`);
    if (!r.disponivel) { el.innerHTML = `<p class="vazio">${r.motivo}</p>`; return; }
    el.innerHTML = `<table class="tabela-simples"><thead>
        <tr><th>Vendedor</th><th>Clientes</th><th>Potencial</th><th>Mantidos</th><th>Movidos</th></tr>
      </thead><tbody>
        ${r.carteiras.map(c => `<tr>
          <td>${c.nome}${c.simulado ? " (vaga nova)" : ""}</td>
          <td>${c.clientes}</td><td>${brl(c.potencial)}</td><td>${c.mantidos}</td><td>${c.movidos}</td>
        </tr>`).join("")}
      </tbody></table>
      <p class="aviso-inline">Desvio máx. de potencial entre carteiras: ${r.equilibrio.desvio_max_pct}%.
      Clientes movidos de dono: ${r.ruptura_de_relacionamento.pct_movidos ?? "—"}%. Simulação — nada foi aplicado.</p>`;
  } catch (e) { el.innerHTML = `<p class="vazio">${e.message}</p>`; }
});

async function carregarDuplicatas() {
  const el = document.getElementById("duplicatas-lista");
  try {
    const r = await api("/api/identidade/duplicatas?limite=30");
    if (!r.candidatos.length) { el.innerHTML = `<p class="vazio">Nenhuma duplicata suspeita encontrada.</p>`; return; }
    el.innerHTML = r.candidatos.map(c => `
      <div class="cartao">
        <header><div class="ident"><b>${c.nome_a}</b> ↔ <b>${c.nome_b}</b>
        <span>confiança ${c.confianca} · ${c.evidencias.join(", ")}</span></div></header>
        <footer>
          <button class="bt-desfecho ok" data-a="${c.cliente_a}" data-b="${c.cliente_b}" data-decisao="mesmo">É a mesma conta</button>
          <button class="bt-desfecho" data-a="${c.cliente_a}" data-b="${c.cliente_b}" data-decisao="distinto">Contas distintas</button>
        </footer>
      </div>`).join("");
    el.querySelectorAll(".bt-desfecho").forEach(b => b.addEventListener("click", async () => {
      await api("/api/identidade/decidir", {method: "POST", body: JSON.stringify({
        cliente_a: b.dataset.a, cliente_b: b.dataset.b, decisao: b.dataset.decisao})});
      carregarDuplicatas();
    }));
  } catch (e) { el.innerHTML = `<p class="vazio">${e.message}</p>`; }
}

document.getElementById("btn-resolver-identidade").addEventListener("click", async () => {
  const status = document.getElementById("identidade-status");
  status.textContent = "resolvendo…";
  try {
    const r = await api("/api/identidade/resolver", {method: "POST"});
    status.textContent = `${r.clientes} clientes → ${r.contas_canonicas} contas canônicas (consolidação ${r.taxa_consolidacao_pct}%)`;
    carregarDuplicatas();
  } catch (e) { status.textContent = "falhou: " + e.message; }
});

document.getElementById("btn-rascunho").addEventListener("click", async () => {
  const cliente = document.getElementById("cliente-rascunho").value.trim();
  const el = document.getElementById("rascunho-resultado");
  if (!cliente) return;
  el.innerHTML = `<p class="vazio">Gerando…</p>`;
  try {
    const r = await api(`/api/agente/rascunho/${encodeURIComponent(cliente)}`);
    if (!r.disponivel) { el.innerHTML = `<p class="vazio">${r.motivo}</p>`; return; }
    el.innerHTML = `<div class="cartao">
      <header><div class="ident"><b>Rascunho para ${r.cliente_id}</b><span>modelo: ${r.modelo}</span></div></header>
      <ul class="fatores"><li class="fator"><span class="txt">${r.texto}</span></li></ul>
      <p class="aviso-inline">${r.aviso}</p>
    </div>`;
  } catch (e) { el.innerHTML = `<p class="vazio">${e.message}</p>`; }
});

carregarIntegracoes().catch(e => console.error(e));
carregarDuplicatas().catch(e => console.error(e));
