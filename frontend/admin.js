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

document.getElementById("btn-ciclo").addEventListener("click", async () => {
  const el = document.getElementById("ciclo-resultado");
  el.innerHTML = `<p class="vazio">Rodando o ciclo…</p>`;
  try {
    const r = await api("/api/orquestrador/executar-ciclo", {method: "POST"});
    const e = r.etapas;
    el.innerHTML = `<div class="cartao"><ul class="fatores">
      <li class="fator"><span class="txt"><b>Planejar/priorizar:</b> ${e.planejar_priorizar.itens_priorizados} contas na fila
        (confiável: ${e.planejar_priorizar.confiavel ?? "—"})</span></li>
      <li class="fator"><span class="txt"><b>Executar:</b> ${e.executar.rascunhos_gerados} rascunhos gerados,
        ${e.executar.rascunhos_indisponiveis} indisponíveis (agente configurado: ${e.executar.agente_configurado})</span></li>
      <li class="fator"><span class="txt"><b>Medir:</b> cobertura de loop fechado ${e.medir.cobertura_pct ?? "—"}%</span></li>
      <li class="fator"><span class="txt"><b>Re-aprender:</b> cache invalidado</span></li>
    </ul><p class="aviso-inline">${r.aviso}</p></div>`;
  } catch (err) { el.innerHTML = `<p class="vazio">${err.message}</p>`; }
});

async function carregarModeloSemantico() {
  const r = await api("/api/semantico/modelo");
  document.getElementById("semantico-metrica").innerHTML =
    Object.entries(r.metricas).map(([k, v]) => `<option value="${k}">${v}</option>`).join("");
  document.getElementById("semantico-dimensao").innerHTML =
    `<option value="">(sem dimensão)</option>` +
    Object.entries(r.dimensoes).map(([k, v]) => `<option value="${k}">${v}</option>`).join("");
}

function renderConsultaSemantica(r) {
  const el = document.getElementById("semantico-resultado");
  if (!r.disponivel) { el.innerHTML = `<p class="vazio">${r.motivo}</p>`; return; }
  el.innerHTML = `<table class="tabela-simples"><thead><tr><th>${r.dimensao || "total"}</th><th>${r.metrica_rotulo}</th></tr></thead>
    <tbody>${r.resultados.map(x => `<tr><td>${x.chave}</td><td>${x.valor.toLocaleString("pt-BR")}</td></tr>`).join("")}</tbody></table>
    <p class="aviso-inline"><code>${r.consulta_equivalente}</code><br/>${r.aviso}</p>`;
}

document.getElementById("btn-semantico-consultar").addEventListener("click", async () => {
  const metrica = document.getElementById("semantico-metrica").value;
  const dimensao = document.getElementById("semantico-dimensao").value;
  try {
    renderConsultaSemantica(await api(`/api/semantico/consultar?metrica=${metrica}&dimensao=${dimensao}`));
  } catch (e) { document.getElementById("semantico-resultado").innerHTML = `<p class="vazio">${e.message}</p>`; }
});

document.getElementById("btn-semantico-perguntar").addEventListener("click", async () => {
  const pergunta = document.getElementById("semantico-pergunta").value.trim();
  if (!pergunta) return;
  try {
    const r = await api(`/api/semantico/perguntar?pergunta=${encodeURIComponent(pergunta)}`);
    renderConsultaSemantica(r);
    if (r.interpretacao) {
      document.getElementById("semantico-resultado").innerHTML += `<p class="aviso-inline">interpretado como: ${r.interpretacao.metrica}${r.interpretacao.dimensao ? " por " + r.interpretacao.dimensao : ""} (método: ${r.interpretacao.metodo})</p>`;
    }
  } catch (e) { document.getElementById("semantico-resultado").innerHTML = `<p class="vazio">${e.message}</p>`; }
});

document.getElementById("btn-relatorio").addEventListener("click", async () => {
  const el = document.getElementById("relatorio-resultado");
  el.innerHTML = `<p class="vazio">Gerando…</p>`;
  try {
    const r = await api("/api/reputacao/relatorio-executivo", {method: "POST"});
    const mud = r.o_que_mudou_desde_o_ultimo;
    el.innerHTML = `<div class="cartao">
      <header><div class="ident"><b>Relatório ${r.gerado_em}</b><span>modo: ${r.modo}</span></div></header>
      ${r.texto_executivo ? `<ul class="fatores"><li class="fator"><span class="txt">${r.texto_executivo}</span></li></ul>` : ""}
      <p class="aviso-inline">${mud.disponivel
        ? `Desde o último relatório: sentimento ${mud.delta_sentimento_ponderado >= 0 ? "+" : ""}${mud.delta_sentimento_ponderado}, volume ${mud.delta_volume_mencoes >= 0 ? "+" : ""}${mud.delta_volume_mencoes}, ${mud.novos_alertas} novos alertas.`
        : mud.motivo}</p>
    </div>`;
  } catch (e) { el.innerHTML = `<p class="vazio">${e.message}</p>`; }
});

carregarIntegracoes().catch(e => console.error(e));
carregarDuplicatas().catch(e => console.error(e));
carregarModeloSemantico().catch(e => console.error(e));
