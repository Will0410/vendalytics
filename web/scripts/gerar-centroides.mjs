/**
 * gerar-centroides.mjs — extrai o centro geográfico dos 5.570 municípios
 * brasileiros a partir da malha territorial oficial do IBGE.
 *
 *     node scripts/gerar-centroides.mjs
 *
 * ── Por que pré-computar em vez de buscar em tempo de execução ─────────────
 * A malha do IBGE são 836KB comprimidos / 3,6MB de JSON. Buscar e parsear
 * isso a cada sessão só para descobrir onde desenhar 5.570 bolinhas é caro em
 * banda e em tempo de parse na thread principal. O resultado deste script tem
 * ~120KB e carrega junto do bundle.
 *
 * A troca é consciente e tem prazo: a malha municipal muda quando o IBGE
 * republica (a cada poucos anos, em geral após criação/fusão de municípios).
 * Quando isso acontecer, rode este script de novo. A fonte está registrada no
 * cabeçalho do arquivo gerado, então dá para auditar de onde veio cada ponto.
 *
 * ── Centroide de área, não centro do retângulo ─────────────────────────────
 * O centro da caixa delimitadora (bbox) é mais simples de calcular e cai fora
 * do município em qualquer forma côncava — municípios em "C" ou com litoral
 * recortado colocariam a bolinha no mar ou dentro do vizinho. Aqui é o
 * centroide de área do maior anel do polígono, que fica dentro da forma para
 * a esmagadora maioria dos casos reais.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const URL_MALHA =
  "https://servicodados.ibge.gov.br/api/v3/malhas/paises/BR" +
  "?formato=application/vnd.geo+json&intrarregiao=municipio&qualidade=minima";

const AQUI = dirname(fileURLToPath(import.meta.url));
const SAIDA = join(AQUI, "..", "src", "data", "centroides.json");

/** Centroide de área de um anel [[lon,lat], …] pela fórmula do polígono. */
function centroideDoAnel(anel) {
  let areaDupla = 0;
  let cx = 0;
  let cy = 0;

  for (let i = 0, j = anel.length - 1; i < anel.length; j = i++) {
    const [x0, y0] = anel[j];
    const [x1, y1] = anel[i];
    const cruz = x0 * y1 - x1 * y0;
    areaDupla += cruz;
    cx += (x0 + x1) * cruz;
    cy += (y0 + y1) * cruz;
  }

  /* Área ~zero: polígono degenerado (ilhota minúscula na malha simplificada).
     A fórmula dividiria por zero, então cai para a média dos vértices — pior
     em precisão, mas nunca produz NaN, que viraria bolinha invisível. */
  if (Math.abs(areaDupla) < 1e-12) {
    const soma = anel.reduce((a, [x, y]) => [a[0] + x, a[1] + y], [0, 0]);
    return [soma[0] / anel.length, soma[1] / anel.length];
  }

  const area6 = areaDupla * 3;
  return [cx / area6, cy / area6];
}

/** Área absoluta do anel — usada só para escolher o maior. */
function areaDoAnel(anel) {
  let a = 0;
  for (let i = 0, j = anel.length - 1; i < anel.length; j = i++) {
    a += anel[j][0] * anel[i][1] - anel[i][0] * anel[j][1];
  }
  return Math.abs(a / 2);
}

/** O maior anel externo da geometria — arquipélagos não puxam o ponto para o
 *  meio do oceano; a bolinha fica na massa de terra principal. */
function maiorAnel(geometria) {
  const poligonos =
    geometria.type === "MultiPolygon" ? geometria.coordinates : [geometria.coordinates];

  let melhor = null;
  let melhorArea = -1;
  for (const poligono of poligonos) {
    const externo = poligono[0];
    if (!externo || externo.length < 3) continue;
    const a = areaDoAnel(externo);
    if (a > melhorArea) {
      melhorArea = a;
      melhor = externo;
    }
  }
  return melhor;
}

console.log("Buscando a malha municipal do IBGE…");
const r = await fetch(URL_MALHA);
if (!r.ok) throw new Error(`IBGE respondeu ${r.status}`);
const malha = await r.json();
console.log(`  ${malha.features.length} municípios recebidos`);

const centroides = {};
let ignorados = 0;

for (const f of malha.features) {
  const codigo = Number(f.properties?.codarea);
  const anel = f.geometry ? maiorAnel(f.geometry) : null;
  if (!Number.isFinite(codigo) || !anel) {
    ignorados++;
    continue;
  }
  const [lon, lat] = centroideDoAnel(anel);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    ignorados++;
    continue;
  }
  /* 4 casas ≈ 11 metros. Muito além do necessário para posicionar a bolinha
     de um município, e corta o arquivo quase pela metade. */
  centroides[codigo] = [Number(lat.toFixed(4)), Number(lon.toFixed(4))];
}

const saida = {
  _fonte: "IBGE · malha territorial municipal (API v3 /malhas, qualidade mínima)",
  _url: URL_MALHA,
  _gerado_em: new Date().toISOString().slice(0, 10),
  _formato: "codigoIBGE: [latitude, longitude] — centroide de área do maior anel",
  _script: "web/scripts/gerar-centroides.mjs",
  centroides,
};

writeFileSync(SAIDA, JSON.stringify(saida), "utf-8");

const bytes = JSON.stringify(saida).length;
console.log(`  ${Object.keys(centroides).length} centroides gravados (${ignorados} ignorados)`);
console.log(`  ${SAIDA} — ${(bytes / 1024).toFixed(0)} KB`);
