// fila.js — a fila do dia e o fechamento do loop.
//
// Duas regras de interface que vêm direto da spec e não são cosméticas:
//
// 1. Todo score aparece COM os fatores que o geraram, em linguagem de
//    negócio. Um número sozinho não é acionável, e o vendedor que não
//    entende de onde ele veio (com razão) não confia nele.
// 2. Fechar o loop é UM clique, na mesma linha da recomendação. Se fechar o
//    loop custar uma navegação a mais, ninguém fecha — e a cobertura de
//    loop fechado, que é a métrica que faz o produto aprender, vai a zero.
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

const DESFECHOS = [
  {chave: "ganhou",   texto: "Ganhou",   classe: "ok"},
  {chave: "aceita",   texto: "Aceita",   classe: ""},
  {chave: "recusada", texto: "Recusada", classe: ""},
  {chave: "perdeu",   texto: "Perdeu",   classe: "ruim"},
  {chave: "ignorada", texto: "Ignorar",  classe: "neutro"},
];

// A qualidade do modelo é exibida sem maquiagem — inclusive quando é ruim.
// Esconder uma AUC baixa não melhora o modelo, só transfere a surpresa para
// o dia em que o vendedor perceber sozinho que a fila não funciona.
function faixaModelo(m, saude) {
  const item = (rot, val, dica) =>
    `<span class="mi" title="${dica}"><b>${val}</b>${rot}</span>`;
  const pct = (v) => (v === null || v === undefined ? "—" : v + "%");
  const num = (v) => (v === null || v === undefined ? "—" : v);
  return item("AUC out-of-time", num(m.auc_out_of_time),
              "Poder de discriminação numa janela futura. Abaixo de 0,70 a fila vale pouco.") +
         item("Erro de calibração", num(m.ece),
              "O quanto '70%' significa mesmo 70%. Quanto menor, melhor.") +
         item("Lift top decil", num(m.lift_top_decil) + "×",
              "Quantas vezes o topo da fila converte mais que a média.") +
         item("Amostras de treino", num(m.amostras_treino), "Tamanho da base de treino.") +
         item("Loop fechado", pct(saude && saude.cobertura_pct),
              "Recomendações com desfecho registrado. Se cai, o produto para de aprender.") +
         item("Taxa de aceite", pct(saude && saude.taxa_aceite_pct),
              "Recomendações que o vendedor trabalhou.");
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
  return `<article class="cartao" id="c-${item.cliente_id}">
    <header>
      <div class="ident">
        <b>${item.cliente_id}</b>
        <span>ticket médio ${brl(item.ticket_medio)}</span>
      </div>
      <div class="numeros">
        <div class="ve"><b>${brl(item.valor_esperado)}</b><span>valor esperado</span></div>
        <div class="sc"><b>${item.score}</b><span>propensão</span></div>
      </div>
    </header>
    <ul class="fatores">${fatores}</ul>
    <footer><span class="rotulo-loop">Desfecho:</span>${botoes}<span class="aviso"></span></footer>
  </article>`;
}

async function registrarDesfecho(botao) {
  const cliente = botao.dataset.cliente;
  const desfecho = botao.dataset.desfecho;
  const cartaoEl = document.getElementById("c-" + cliente);
  const aviso = cartaoEl.querySelector(".aviso");
  cartaoEl.querySelectorAll(".bt-desfecho").forEach(b => (b.disabled = true));
  aviso.textContent = "gravando…";
  try {
    await api("/api/fila/desfecho/" + encodeURIComponent(cliente), {
      method: "POST",
      body: JSON.stringify({desfecho, motivo: ""}),
    });
    cartaoEl.classList.add("fechado");
    aviso.textContent = "registrado: " + desfecho;
  } catch (e) {
    // Reabilita: um erro de rede não pode deixar a recomendação num limbo
    // onde o vendedor não consegue nem tentar de novo.
    cartaoEl.querySelectorAll(".bt-desfecho").forEach(b => (b.disabled = false));
    aviso.textContent = "falhou — tente de novo";
    console.error(e);
  }
}

async function carregar() {
  const alvo = document.getElementById("fila");
  const faixa = document.getElementById("faixa-modelo");
  try {
    const r = await api("/api/fila/diaria?limite=12");
    if (!r.disponivel) {
      // Não inventa fila quando o modelo não pôde ser treinado com validação
      // honesta: diz o que falta. Uma lista aqui seria pior que nenhuma.
      faixa.innerHTML = `<span class="mi indisponivel"><b>Modelo indisponível</b></span>`;
      alvo.innerHTML = `<p class="vazio">${r.motivo}</p>`;
      return;
    }
    const saude = await api("/api/fila/saude-do-loop").catch(() => null);
    faixa.innerHTML = faixaModelo(r.modelo, saude);
    // Modelo fraco não é escondido nem maquiado: a fila aparece, com o aviso
    // por cima dela. O vendedor decide se vale o tempo dele.
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

carregar();
