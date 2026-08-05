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
