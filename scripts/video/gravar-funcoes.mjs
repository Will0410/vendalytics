/**
 * funcoes.mjs — percorre as 11 telas do produto.
 *
 * Segue o padrão de `lojaonline/video`: 1440×900, stills numerados e um vídeo
 * único de funções. As pausas são reais — quando o vídeo espera, é o IBGE
 * respondendo.
 *
 *   node funcoes.mjs stills     → só as capturas numeradas
 *   node funcoes.mjs video      → grava o percurso
 */
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const BASE = "http://127.0.0.1:8907";
const MODO = process.argv[2] || "video";
const STILLS = "./stills";
const VIDEO = "./video-funcoes";
mkdirSync(MODO === "stills" ? STILLS : VIDEO, { recursive: true });

const nav = await chromium.launch();
const ctx = await nav.newContext({
  viewport: { width: 1440, height: 900 },
  ...(MODO === "video" ? { recordVideo: { dir: VIDEO, size: { width: 1440, height: 900 } } } : {}),
});
const p = await ctx.newPage();

await p.addInitScript(() => {
  window.__legenda = (titulo, linha, cor) => {
    let el = document.getElementById("__cap");
    if (!el) {
      el = document.createElement("div");
      el.id = "__cap";
      el.style.cssText = [
        "position:fixed", "left:30px", "bottom:30px", "z-index:2147483647",
        "font-family:ui-sans-serif,-apple-system,'Segoe UI',Roboto,sans-serif",
        "pointer-events:none", "max-width:660px",
        "background:rgba(8,11,16,0.9)", "backdrop-filter:blur(12px)",
        "border-radius:11px", "padding:16px 22px 18px",
        "box-shadow:0 20px 56px rgba(0,0,0,0.5)",
        "opacity:0", "transform:translateY(9px)",
        "transition:opacity .32s ease,transform .32s ease",
      ].join(";");
      el.innerHTML =
        '<div id="__b" style="width:38px;height:3px;border-radius:2px;margin-bottom:11px"></div>' +
        '<div id="__t" style="color:#f4f6fa;font-size:25px;font-weight:660;letter-spacing:-0.018em;line-height:1.18"></div>' +
        '<div id="__s" style="color:#9caabe;font-size:15px;line-height:1.42;margin-top:7px"></div>';
      document.body.appendChild(el);
    }
    document.getElementById("__b").style.background = cor || "#22d3ee";
    document.getElementById("__t").textContent = titulo;
    document.getElementById("__s").textContent = linha || "";
    requestAnimationFrame(() => { el.style.opacity = "1"; el.style.transform = "translateY(0)"; });
  };
  window.__semLegenda = () => {
    const el = document.getElementById("__cap");
    if (el) { el.style.opacity = "0"; el.style.transform = "translateY(9px)"; }
  };
});

const gravando = MODO === "video";
const legenda = (t, s, c) => (gravando ? p.evaluate(([t, s, c]) => window.__legenda(t, s, c), [t, s, c]) : null);
const limpar = () => (gravando ? p.evaluate(() => window.__semLegenda()) : null);
const espera = (ms) => p.waitForTimeout(gravando ? ms : Math.min(ms, 700));

const ate = (txt, timeout = 120000) =>
  p.waitForFunction(
    (t) => (document.querySelector("main")?.innerText || "").toUpperCase().includes(t),
    txt.toUpperCase(), { timeout },
  ).catch(() => {});

let n = 0;
const still = async (nome) => {
  if (MODO !== "stills") return;
  n++;
  await p.screenshot({ path: `${STILLS}/${String(n).padStart(2, "0")}-${nome}.png` });
};

const CIANO = "#22d3ee";
const INDIGO = "#7f92ff";
const VERDE = "#3fce3f";

/* ─── Login ────────────────────────────────────────────────────────────── */
await p.goto(BASE, { waitUntil: "domcontentloaded" });
await p.waitForSelector("#senha");
await espera(1200);
await legenda("Vendalytics", "Inteligência de vendas sobre dados públicos brasileiros", CIANO);
await espera(2800);
await limpar();
await still("login");
await p.fill("#email", "demo@vendalytics.local");
await espera(400);
await p.fill("#senha", "demonstracao-8907");
await espera(300);
await p.press("#senha", "Enter");
await p.waitForSelector("aside, nav", { timeout: 30000 });

/* ─── 1. Inteligência de Vendas ────────────────────────────────────────── */
await ate("Inteligência");
await espera(2600);
await legenda("Panorama nacional", "10,6 milhões de empresas do IBGE, quebradas por seção CNAE", CIANO);
await espera(3400);
await limpar();
await still("vendas");
await p.mouse.wheel(0, 700);
await espera(2200);
await still("vendas-setores");
await p.mouse.wheel(0, 800);
await espera(2000);
await still("vendas-analise");
await p.mouse.wheel(0, -1500);
await espera(700);

/* ─── 2. Geomarketing ──────────────────────────────────────────────────── */
await p.goto(`${BASE}/#/geomarketing`);
await ate("cobertura");
await espera(2400);
await legenda("Geomarketing", "Onde estão as empresas do seu setor, município a município", INDIGO);
await espera(3200);
await limpar();
await still("geomarketing");
await p.mouse.wheel(0, 750);
await espera(2200);
await still("geomarketing-curva");
await p.mouse.wheel(0, -750);
await espera(600);

/* ─── 3. Mapa Territorial ──────────────────────────────────────────────── */
await p.goto(`${BASE}/#/mapa`);
await p.waitForSelector(".leaflet-container", { timeout: 60000 });
await espera(3400);
await legenda("Mapa Territorial", "Os 5.570 municípios, com coordenadas da malha oficial do IBGE", INDIGO);
await espera(3400);
await limpar();
await still("mapa");
for (let i = 0; i < 3; i++) {
  await p.mouse.move(760, 480);
  await p.mouse.wheel(0, -420);
  await espera(1000);
}
await espera(1800);
await still("mapa-aproximado");

/* ─── 4. Planejamento de Território ────────────────────────────────────── */
await p.goto(`${BASE}/#/territorios`);
await p.waitForSelector(".leaflet-container", { timeout: 60000 });
await espera(3400);
await legenda("Planejamento de Território", "k-means ponderado por potencial — divisão equilibrada entre vendedores", INDIGO);
await espera(3600);
await limpar();
await still("territorios");
await espera(1400);

/* ─── 5. Ecossistema ───────────────────────────────────────────────────── */
await p.goto(`${BASE}/#/ecossistema`);
await ate("por que cada uma");
await espera(1600);
await legenda("Ecossistema", "Atividades surgem onde as capacidades vizinhas já existem", VERDE);
await espera(3600);
await limpar();
await still("ecossistema");
await p.mouse.wheel(0, 780);
await espera(1800);
await legenda("O argumento, não só o número", "As capacidades que a praça já domina e puxam a atividade", VERDE);
await espera(3400);
await limpar();
await still("ecossistema-porque");
await p.mouse.wheel(0, -780);
await espera(600);

/* ─── 6. Vazios de Mercado ─────────────────────────────────────────────── */
await p.goto(`${BASE}/#/vazios`);
await ate("onde ir primeiro");
await espera(1600);
await legenda("Vazios de Mercado", "Onde falta empresa que deveria existir, dado porte e poder de compra", VERDE);
await espera(3600);
await limpar();
await still("vazios");
await p.mouse.wheel(0, 900);
await espera(2000);
await still("vazios-dispersao");
await p.mouse.wheel(0, 700);
await espera(1800);
await legenda("Validado fora da amostra", "Ajuste de 2013 conferido contra o crescimento de 2015 a 2020", VERDE);
await espera(3400);
await limpar();
await still("vazios-acuracia");
await p.mouse.wheel(0, -1600);
await espera(600);

/* ─── 7. Relatório de Praça ────────────────────────────────────────────── */
await p.goto(`${BASE}/#/praca?uf=SP&mun=3543402&cnae=G`);
await ate("Score");
await espera(2600);
await legenda("Relatório de Praça", "TAM, SAM, SOM, densidade e saturação de um município", INDIGO);
await espera(3200);
await limpar();
await still("praca");
await p.mouse.wheel(0, 800);
await espera(2200);
await still("praca-score");
await p.mouse.wheel(0, -800);
await espera(600);

/* ─── 8. Copiloto ──────────────────────────────────────────────────────── */
await p.goto(`${BASE}/#/copiloto`);
const campo = p.locator('input[placeholder*="Pergunte"]');
await campo.waitFor({ state: "visible", timeout: 60000 });
await p.waitForFunction(
  () => !document.querySelector('input[placeholder*="Pergunte"]')?.disabled,
  null, { timeout: 120000 },
).catch(() => {});
await espera(900);
await legenda("Copiloto de Mercado", "O modelo não recebe os dados — recebe funções", CIANO);
await espera(3000);
await limpar();
await campo.click();
await campo.type("Quais praças de Santa Catarina têm mais empresas de comércio?", { delay: 36 });
await espera(500);
await p.keyboard.press("Enter");
await espera(11000);
await legenda("Cada número passou por um cálculo", "A resposta cita a consulta que fez, não a memória do modelo", CIANO);
await espera(3400);
await limpar();
await still("copiloto");
await espera(800);

/* ─── 9. Prospecção B2B ────────────────────────────────────────────────── */
await p.goto(`${BASE}/#/prospeccao`);
await espera(3000);
await legenda("Prospecção B2B", "Score ICP explicável sobre cadastro real da Receita Federal", INDIGO);
await espera(3200);
await limpar();
await still("prospeccao");
await p.mouse.wheel(0, 700);
await espera(2000);
await still("prospeccao-carteira");
await p.mouse.wheel(0, -700);
await espera(600);

/* ─── 10. Enriquecimento ───────────────────────────────────────────────── */
await p.goto(`${BASE}/#/enriquecimento`);
await espera(2600);
await legenda("Enriquecimento", "Cadastro completo por CNPJ, direto da Receita Federal", INDIGO);
await espera(3000);
await limpar();
await still("enriquecimento");
await espera(1000);

/* ─── 11. Usuários ─────────────────────────────────────────────────────── */
await p.goto(`${BASE}/#/usuarios`);
await espera(2400);
await legenda("Usuários", "Contas, perfis e senhas — com as travas de administração", CIANO);
await espera(2800);
await limpar();
await still("usuarios");
await espera(900);

/* ─── Fecho ────────────────────────────────────────────────────────────── */
await p.goto(`${BASE}/#/vendas`);
await ate("Inteligência");
await espera(2000);
await legenda("Vendalytics", "Dois modelos preditivos validados. Três hipóteses descartadas.", CIANO);
await espera(4200);

await ctx.close();
await nav.close();
console.log(MODO === "stills" ? `${n} stills gravados` : "vídeo de funções gravado");
