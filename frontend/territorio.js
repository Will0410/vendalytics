// territorio.js — TAM→SAM→SOM por município (spec A2). Usa
// /api/territorio/tam-sam-som e /api/territorio/cobertura, que já existiam
// no backend sem tela nenhuma até agora.
document.getElementById("btn-sair").addEventListener("click", (e) => {
  e.preventDefault(); sair();
});

// ── Visão nacional (IBGE, 27 UFs de uma vez) ────────────────────────────────
let estadosNacional = [];
let ordemNacional = { coluna: "populacao", asc: false };

function fmtNum(v) { return v == null ? "—" : v.toLocaleString("pt-BR"); }
function fmtReais(v) { return v == null ? "—" : "R$ " + Math.round(v).toLocaleString("pt-BR"); }

function renderTabelaNacional() {
  const el = document.getElementById("nacional-tabela");
  const cols = [
    { key: "uf_nome", rotulo: "Estado", fmt: v => v },
    { key: "populacao", rotulo: "População", fmt: fmtNum },
    { key: "pib_per_capita_reais", rotulo: "PIB per capita/ano", fmt: fmtReais },
    { key: "empresas_atuantes_total", rotulo: "Empresas atuantes", fmt: fmtNum },
  ];
  const ordenados = [...estadosNacional].sort((a, b) => {
    const va = a[ordemNacional.coluna], vb = b[ordemNacional.coluna];
    if (va == null) return 1;
    if (vb == null) return -1;
    const cmp = typeof va === "string" ? va.localeCompare(vb) : va - vb;
    return ordemNacional.asc ? cmp : -cmp;
  });
  el.innerHTML = `<table class="tabela-simples"><thead><tr>
      ${cols.map(c => `<th style="cursor:pointer" data-col="${c.key}">${c.rotulo}${ordemNacional.coluna === c.key ? (ordemNacional.asc ? " ▲" : " ▼") : ""}</th>`).join("")}
    </tr></thead><tbody>
      ${ordenados.map(e => `<tr>${cols.map(c => `<td>${c.fmt(e[c.key])}</td>`).join("")}</tr>`).join("")}
    </tbody></table>`;
  el.querySelectorAll("th[data-col]").forEach(th => th.addEventListener("click", () => {
    const col = th.dataset.col;
    ordemNacional = col === ordemNacional.coluna
      ? { coluna: col, asc: !ordemNacional.asc } : { coluna: col, asc: false };
    renderTabelaNacional();
  }));
}

async function carregarVisaoNacional() {
  const el = document.getElementById("nacional-tabela");
  try {
    const r = await api("/api/territorio/visao-nacional");
    estadosNacional = r.estados;
    renderTabelaNacional();
  } catch (e) {
    el.innerHTML = erroComRetry(`Falha ao carregar visão nacional: ${e.message}`, carregarVisaoNacional);
  }
}

carregarVisaoNacional();

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

function skeletonKpis(n) {
  return Array.from({ length: n }, () =>
    `<div class="praca-kpi"><div class="skeleton skeleton-kpi"></div></div>`).join("");
}

async function carregarMunicipiosDaUf(uf) {
  const selMun = document.getElementById("praca-municipio");
  if (!uf) { selMun.innerHTML = `<option value="">Selecione a UF primeiro</option>`; return; }
  selMun.innerHTML = `<option value="">Carregando…</option>`;
  document.getElementById("praca-kpis").innerHTML = skeletonKpis(4);
  try {
    const r = await api(`/api/territorio/municipios?uf=${uf}`);
    municipiosDaUf = r.municipios;
    selMun.innerHTML = `<option value="">${r.municipios.length} municípios — selecione</option>` +
      r.municipios.map(m => `<option value="${m.nome}">${m.nome}</option>`).join("");
    renderPracaKpis(uf, null);
  } catch (e) {
    selMun.innerHTML = `<option value="">Falha ao carregar municípios</option>`;
    renderPracaKpis(uf, null);
  }
}

// Sempre 4 cards fixos (UF, praça, código IBGE, municípios na UF) + os que
// só existem depois de escolher um município (população, carteira aqui) —
// nunca menos que 4, mesmo antes de qualquer seleção.
async function renderPracaKpis(uf, municipioNome) {
  const el = document.getElementById("praca-kpis");
  const base = [
    { rotulo: "UF selecionada", valor: uf || "—" },
    { rotulo: "Praça selecionada", valor: municipioNome ? `${municipioNome}/${uf}` : "nenhuma ainda" },
    { rotulo: "Município IBGE", valor: uf ? municipiosDaUf.length : "—" },
    { rotulo: "Código IBGE", valor: "—" },
  ];

  if (!municipioNome) { el.innerHTML = renderCards(base); return; }

  el.innerHTML = renderCards(base) + skeletonKpis(4);

  const [info, cobertura] = await Promise.all([
    api(`/api/territorio/municipio-info?municipio=${encodeURIComponent(municipioNome)}&uf=${uf}`).catch(() => null),
    api(`/api/territorio/cobertura`).catch(() => null),
  ]);

  base[3].valor = info && info.disponivel ? info.municipio_ibge_id : "indisponível";
  const populacao = info && info.disponivel
    ? info.populacao.toLocaleString("pt-BR") + ` (${info.populacao_ano_referencia})`
    : "indisponível";
  const pibPerCapita = info && info.disponivel && info.pib_per_capita_reais != null
    ? "R$ " + Math.round(info.pib_per_capita_reais).toLocaleString("pt-BR") + `/ano (${info.pib_ano_referencia})`
    : "indisponível";
  const empresasAtuantes = info && info.disponivel && info.empresas_atuantes_total != null
    ? info.empresas_atuantes_total.toLocaleString("pt-BR") + ` (${info.empresas_atuantes_ano_referencia}, todos os ramos)`
    : "indisponível";
  const linhaMunicipio = cobertura
    ? cobertura.municipios.filter(m => m.municipio.toLowerCase() === municipioNome.toLowerCase())
    : [];
  const naCarteira = linhaMunicipio.reduce((s, m) => s + (m.ativos || 0), 0);

  el.innerHTML = renderCards([...base,
    { rotulo: "População (IBGE)", valor: populacao },
    { rotulo: "PIB per capita (IBGE)", valor: pibPerCapita },
    { rotulo: "Empresas atuantes (IBGE)", valor: empresasAtuantes },
    { rotulo: "Empresas na carteira aqui", valor: naCarteira }]);
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

function skeletonTabela() {
  return `<div class="cartao">` +
    Array.from({ length: 5 }, () => `<div class="skeleton skeleton-row"></div>`).join("") +
    `</div>`;
}

async function carregarProspectsIniciais() {
  const el = document.getElementById("praca-tabela");
  el.innerHTML = skeletonTabela();
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

function statusAddCnpj(msg, tipo) {
  const el = document.getElementById("add-cnpj-status");
  el.textContent = msg;
  el.style.color = tipo === "erro" ? "var(--danger)" : "#94a3b8";
}

document.getElementById("form-add-cnpj").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = document.getElementById("input-novo-cnpj");
  const cnpj = input.value.replace(/\D/g, "");
  statusAddCnpj("");
  if (cnpj.length !== 14) { statusAddCnpj("CNPJ precisa ter 14 dígitos.", "erro"); return; }
  const botao = e.target.querySelector("button");
  botao.disabled = true; botao.textContent = "Consultando…";
  try {
    const r = await api(`/api/territorio/prospects?cnpjs=${cnpj}`);
    if (!r.prospects.length) { statusAddCnpj("CNPJ não encontrado ou fonte indisponível.", "erro"); return; }
    prospects = prospects.filter(p => p.cnpj !== cnpj).concat(r.prospects);
    renderPracaTabela();
    input.value = "";
    statusAddCnpj("Empresa adicionada.", "ok");
  } catch (err) {
    statusAddCnpj(`Falha ao consultar: ${err.message}`, "erro");
  } finally {
    botao.disabled = false; botao.textContent = "Consultar";
  }
});

popularUFs();
renderPracaKpis("", null);
carregarProspectsIniciais();

// ── Comércios reais na região (OpenStreetMap via BizData) ──────────────────
let comerciosMap = null;
let comerciosMarcadores = null;

function inicializarComerciosMap() {
  if (comerciosMap) return;
  comerciosMap = L.map("comercios-map", {zoomControl: false, attributionControl: false}).setView([-14.2, -51.9], 4);
  L.control.zoom({position: "bottomright"}).addTo(comerciosMap);
  L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {maxZoom: 19}).addTo(comerciosMap);
  comerciosMarcadores = L.layerGroup().addTo(comerciosMap);
}

async function carregarCategoriasComercio() {
  try {
    const r = await api("/api/territorio/comercios-categorias");
    const sel = document.getElementById("comercios-categoria");
    sel.innerHTML = `<option value="">Selecione uma categoria</option>` +
      r.categorias.map(c => `<option value="${c}">${c.replace(/_/g, " ")}</option>`).join("");
  } catch (e) { console.error(e); }
}

function statusComercios(msg, tipo) {
  const el = document.getElementById("comercios-status");
  el.textContent = msg;
  el.style.color = tipo === "erro" ? "var(--danger)" : "#94a3b8";
}

async function buscarComerciosReais() {
  const municipio = document.getElementById("praca-municipio").value;
  const uf = document.getElementById("praca-uf").value;
  const categoria = document.getElementById("comercios-categoria").value;
  const raio = document.getElementById("comercios-raio").value || 8;
  const tabelaEl = document.getElementById("comercios-tabela");

  if (!municipio || !uf) { statusComercios("Selecione Estado e Município no Relatório de Praça acima primeiro.", "erro"); return; }
  if (!categoria) { statusComercios("Selecione uma categoria.", "erro"); return; }

  inicializarComerciosMap();
  statusComercios("Buscando… a 1ª consulta de um local novo pode levar alguns segundos.");
  tabelaEl.innerHTML = skeletonTabela();
  comerciosMarcadores.clearLayers();

  try {
    const params = new URLSearchParams({municipio, uf, categoria, raio_km: raio});
    const r = await api(`/api/territorio/comercios?${params}`);
    if (!r.disponivel) { statusComercios(r.motivo || "indisponível", "erro"); tabelaEl.innerHTML = ""; return; }

    const comercios = r.comercios || [];
    statusComercios(`${comercios.length} encontrados — fonte: ${r.fonte}`);

    const pontos = [];
    comercios.forEach(c => {
      if (!c.lat || !c.lon) return;
      const marker = L.circleMarker([c.lat, c.lon], {
        radius: 6, fillColor: "#6366f1", fillOpacity: 0.85, color: "#fff", weight: 1,
      });
      marker.bindPopup(`<b>${c.name || "—"}</b><br>${c.address || ""}${c.phone ? "<br>" + c.phone : ""}`);
      marker.addTo(comerciosMarcadores);
      pontos.push([c.lat, c.lon]);
    });
    if (pontos.length) comerciosMap.fitBounds(pontos, {padding: [30, 30]});

    if (!comercios.length) {
      tabelaEl.innerHTML = `<p class="vazio">Nenhum resultado para essa categoria/raio.</p>`;
      return;
    }
    tabelaEl.innerHTML = `<table class="tabela-simples tabela-densa"><thead><tr>
        <th>Nome</th><th>Endereço</th><th>Telefone</th>
      </tr></thead><tbody>
        ${comercios.map(c => `<tr>
          <td>${c.name || "—"}</td><td>${c.address || "—"}</td><td>${c.phone || "—"}</td>
        </tr>`).join("")}
      </tbody></table>`;
  } catch (e) {
    statusComercios(`Falha na busca: ${e.message}`, "erro");
    tabelaEl.innerHTML = "";
  }
}

document.getElementById("btn-buscar-comercios").addEventListener("click", buscarComerciosReais);
carregarCategoriasComercio();
