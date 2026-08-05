// territorio.js — TAM→SAM→SOM por município (spec A2). Usa
// /api/territorio/tam-sam-som e /api/territorio/cobertura, que já existiam
// no backend sem tela nenhuma até agora.
document.getElementById("btn-sair").addEventListener("click", (e) => {
  e.preventDefault(); sair();
});

function gaugeSVG(valor, max, cor, rotulo) {
  const r = 30, circ = 2 * Math.PI * r;
  const pct = max > 0 ? Math.min(Math.max(valor / max, 0), 1) : 0;
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

async function carregarFiliais() {
  try {
    const r = await api("/api/vendedores");
    const filiais = [...new Set(r.vendedores.map(v => v.filial).filter(Boolean))];
    document.getElementById("filtro-filial").innerHTML =
      `<option value="">Todas as filiais</option>` +
      filiais.map(f => `<option value="${f}">${f}</option>`).join("");
  } catch (e) { console.error(e); }
}

async function carregar() {
  const tabela = document.getElementById("tabela-territorio");
  const resumo = document.getElementById("resumo-territorio");
  const avisoEl = document.getElementById("aviso-tam");
  const filial = document.getElementById("filtro-filial").value;
  const segmento = document.getElementById("filtro-segmento").value.trim();
  const uf = document.getElementById("filtro-uf").value.trim();

  tabela.innerHTML = `<p class="vazio">Carregando…</p>`;
  try {
    const params = new URLSearchParams({ filial, segmento, uf });
    const r = await api(`/api/territorio/tam-sam-som?${params}`);

    const totalSom = r.municipios.reduce((s, m) => s + (m.som || 0), 0);
    const totalTam = r.municipios.reduce((s, m) => s + (m.tam || 0), 0);
    const totalWhitespace = r.municipios.reduce((s, m) => s + (m.whitespace || 0), 0);
    const penetracaoGeral = totalTam > 0 ? Math.round(100 * totalSom / totalTam) : null;

    resumo.innerHTML =
      gaugeSVG(r.municipios.length, Math.max(r.municipios.length, 10), "#60a5fa", "Municípios") +
      gaugeSVG(totalSom, Math.max(totalSom, 10), "#10b981", "Clientes na carteira (SOM)") +
      (r.tam_disponivel
        ? gaugeSVG(totalTam, Math.max(totalTam, 10), "#a78bfa", "Mercado potencial (TAM)") +
          gaugeSVG(totalWhitespace, Math.max(totalWhitespace, 10), "#f59e0b", "Whitespace") +
          gaugeSVG(penetracaoGeral ?? 0, 100, "#22d3ee", "Penetração geral (%)")
        : "");

    avisoEl.innerHTML = r.tam_disponivel ? "" :
      `<div class="aviso-modelo"><b>Sem TAM configurado</b>${r.aviso}</div>`;

    if (!r.municipios.length) {
      tabela.innerHTML = `<p class="vazio">Nenhum município com dado para este filtro.</p>`;
      return;
    }

    tabela.innerHTML = `<table class="tabela-simples"><thead>
        <tr>
          <th>Município</th><th>UF</th>
          <th>TAM (mercado)</th><th>SOM (carteira)</th>
          <th>Whitespace</th><th>Penetração</th>
        </tr>
      </thead><tbody>
        ${r.municipios.map(m => `<tr>
          <td>${m.municipio}</td><td>${m.uf}</td>
          <td>${m.tam ?? "—"}</td><td>${m.som}</td>
          <td>${m.whitespace ?? "—"}</td>
          <td>${m.penetracao_pct != null ? m.penetracao_pct + "%" : "—"}</td>
        </tr>`).join("")}
      </tbody></table>`;
  } catch (e) {
    tabela.innerHTML = erroComRetry(`Falha ao carregar território: ${e.message}`, carregar);
    resumo.innerHTML = "";
  }
}

document.getElementById("btn-filtrar").addEventListener("click", carregar);
carregarFiliais().then(carregar).catch(carregar);

// ── Relatório de Praça (IBGE + BrasilAPI/RFB, dados reais) ─────────────────
const UFS = ["AC","AL","AP","AM","BA","CE","DF","ES","GO","MA","MT","MS","MG",
  "PA","PB","PR","PE","PI","RJ","RN","RS","RO","RR","SC","SP","SE","TO"];

const CNPJS_INICIAIS = ["00000000000191", "33000167000101", "60701190000104",
  "47508411000156", "06057223000171", "00360305000104"];

let prospects = [];
let municipiosDaUf = [];

function formatarCnpj(cnpj) {
  return cnpj.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, "$1.$2.$3/$4-$5");
}

function popularUFs() {
  const sel = document.getElementById("praca-uf");
  sel.innerHTML = `<option value="">UF</option>` + UFS.map(u => `<option value="${u}">${u}</option>`).join("");
}

async function carregarMunicipiosDaUf(uf) {
  const selMun = document.getElementById("praca-municipio");
  if (!uf) { selMun.innerHTML = `<option value="">Selecione a UF primeiro</option>`; return; }
  selMun.innerHTML = `<option value="">Carregando…</option>`;
  try {
    const r = await api(`/api/territorio/municipios?uf=${uf}`);
    municipiosDaUf = r.municipios;
    selMun.innerHTML = `<option value="">${r.municipios.length} municípios — selecione</option>` +
      r.municipios.map(m => `<option value="${m.nome}">${m.nome}</option>`).join("");
    renderPracaKpis(uf, null);
  } catch (e) {
    selMun.innerHTML = `<option value="">Falha ao carregar municípios</option>`;
  }
}

async function renderPracaKpis(uf, municipioNome) {
  const el = document.getElementById("praca-kpis");
  const cards = [
    { rotulo: "Municípios na UF", valor: municipiosDaUf.length || "—" },
  ];

  if (municipioNome) {
    cards.unshift({ rotulo: "Praça selecionada", valor: `${municipioNome}/${uf}` });
    el.innerHTML = renderCards([...cards,
      { rotulo: "População (IBGE)", valor: "…" },
      { rotulo: "Empresas na carteira aqui", valor: "…" }]);

    const [info, cobertura] = await Promise.all([
      api(`/api/territorio/municipio-info?municipio=${encodeURIComponent(municipioNome)}&uf=${uf}`).catch(() => null),
      api(`/api/territorio/cobertura`).catch(() => null),
    ]);

    const populacao = info && info.disponivel
      ? info.populacao.toLocaleString("pt-BR") + ` (${info.populacao_ano_referencia})`
      : "indisponível";
    const linhaMunicipio = cobertura
      ? cobertura.municipios.filter(m => m.municipio.toLowerCase() === municipioNome.toLowerCase())
      : [];
    const naCarteira = linhaMunicipio.reduce((s, m) => s + (m.ativos || 0), 0);

    el.innerHTML = renderCards([...cards,
      { rotulo: "População (IBGE)", valor: populacao },
      { rotulo: "Empresas na carteira aqui", valor: naCarteira }]);
  } else {
    el.innerHTML = renderCards(cards);
  }
}

function renderCards(cards) {
  return cards.map(c => `<div class="praca-kpi"><b>${c.valor}</b><span>${c.rotulo}</span></div>`).join("");
}

function renderPracaTabela() {
  const el = document.getElementById("praca-tabela");
  const filtro = document.getElementById("praca-filtro-cnae").value.trim().toLowerCase();
  const filtrados = filtro
    ? prospects.filter(p => (p.cnae_principal_descricao || "").toLowerCase().includes(filtro)
        || (p.cnae_principal || "").includes(filtro))
    : prospects;

  if (!filtrados.length) {
    el.innerHTML = `<p class="vazio">${prospects.length ? "Nenhuma empresa bate com o filtro." : "Nenhuma empresa consultada ainda."}</p>`;
    return;
  }

  el.innerHTML = `<table class="tabela-simples tabela-densa"><thead>
      <tr>
        <th>Razão social / fantasia</th><th>CNPJ</th><th>CNAE principal</th>
        <th>Porte</th><th>Município/UF</th><th>Situação</th>
      </tr>
    </thead><tbody>
      ${filtrados.map(p => `<tr>
        <td><b>${p.razao_social}</b>${p.nome_fantasia ? `<br><span class="mi-sub">${p.nome_fantasia}</span>` : ""}</td>
        <td>${formatarCnpj(p.cnpj)}</td>
        <td>${p.cnae_principal_descricao || p.cnae_principal || "—"}</td>
        <td>${p.porte || "—"}</td>
        <td>${p.municipio}/${p.uf}</td>
        <td><span class="badge ${p.ativa ? "badge-ok" : "badge-off"}">${p.situacao || "—"}</span></td>
      </tr>`).join("")}
    </tbody></table>`;
}

async function carregarProspectsIniciais() {
  const el = document.getElementById("praca-tabela");
  try {
    const r = await api(`/api/territorio/prospects?cnpjs=${CNPJS_INICIAIS.join(",")}`);
    prospects = r.prospects;
    renderPracaTabela();
  } catch (e) {
    el.innerHTML = erroComRetry(`Falha ao consultar empresas: ${e.message}`, carregarProspectsIniciais);
  }
}

document.getElementById("praca-uf").addEventListener("change", (e) => carregarMunicipiosDaUf(e.target.value));
document.getElementById("praca-municipio").addEventListener("change", (e) => {
  const uf = document.getElementById("praca-uf").value;
  if (e.target.value) renderPracaKpis(uf, e.target.value);
});
document.getElementById("praca-filtro-cnae").addEventListener("input", renderPracaTabela);

document.getElementById("form-add-cnpj").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = document.getElementById("input-novo-cnpj");
  const cnpj = input.value.replace(/\D/g, "");
  if (cnpj.length !== 14) { alert("CNPJ precisa ter 14 dígitos."); return; }
  const botao = e.target.querySelector("button");
  botao.disabled = true; botao.textContent = "Consultando…";
  try {
    const r = await api(`/api/territorio/prospects?cnpjs=${cnpj}`);
    if (!r.prospects.length) { alert("CNPJ não encontrado ou fonte indisponível."); return; }
    prospects = prospects.filter(p => p.cnpj !== cnpj).concat(r.prospects);
    renderPracaTabela();
    input.value = "";
  } catch (err) {
    alert(`Falha ao consultar: ${err.message}`);
  } finally {
    botao.disabled = false; botao.textContent = "Consultar";
  }
});

popularUFs();
renderPracaKpis("", null);
carregarProspectsIniciais();
