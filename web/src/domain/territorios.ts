/**
 * territorios.ts — desenho automático de território de vendas.
 *
 * Responde a pergunta que todo diretor comercial faz e nenhuma ferramenta
 * brasileira responde direito: *"tenho N vendedores, onde coloco cada um?"*
 *
 * ── O problema, em termos honestos ────────────────────────────────────────
 * É agrupamento geográfico COM restrição de equilíbrio. Duas forças que
 * brigam entre si:
 *
 *   • **compacidade** — o vendedor não pode cruzar o estado para visitar dois
 *     clientes. Territórios precisam ser geograficamente coesos.
 *   • **equilíbrio** — de nada adianta um território com 40% do mercado e
 *     outro com 4%. A comissão fica injusta e a cobertura, ruim.
 *
 * k-means puro resolve só a primeira: ele agrupa por proximidade e produz um
 * território com São Paulo dentro e outro com o interior inteiro. Por isso o
 * algoritmo tem duas fases — agrupa por distância, depois **transfere
 * municípios de fronteira** do território sobrecarregado para o vizinho mais
 * fraco, até o desequilíbrio caber num limite.
 *
 * ── O que ele NÃO é ───────────────────────────────────────────────────────
 * Não é ótimo global. Balanceamento capacitado com restrição geográfica é
 * NP-difícil; o que está aqui é uma heurística que converge rápido e produz
 * um desenho defensável. Um solver exato levaria minutos e mudaria a resposta
 * a cada execução por causa de empates — o que, num painel, lê como bug.
 *
 * O algoritmo é determinístico de propósito: mesma entrada, mesmo desenho.
 * Território que muda sozinho entre dois cliques não é usável para dividir
 * comissão.
 */
import type { Praca } from "../app/useUniverso";

export interface Territorio {
  indice: number;
  /** Município com maior mercado — a base sugerida para o vendedor. */
  sede: Praca;
  pracas: Praca[];
  /** Soma de empresas do setor. É o que se equilibra entre territórios. */
  mercado: number;
  populacao: number;
  scoreMedio: number;
  /** Maior distância da sede até uma praça do território, em km. */
  raioKm: number;
  /** Distância média das praças até a sede, ponderada por mercado. */
  distanciaMediaKm: number;
  centro: { lat: number; lon: number };
}

export interface PlanoDeTerritorios {
  territorios: Territorio[];
  /** (maior mercado − menor) ÷ média. 0 = perfeitamente equilibrado. */
  desequilibrio: number;
  mercadoTotal: number;
  pracasAtendidas: number;
  iteracoes: number;
}

/** Ponto com o que o algoritmo precisa — evita passar `Praca` inteira nos
 *  laços quentes. */
interface Ponto {
  praca: Praca;
  lat: number;
  lon: number;
  peso: number;
}

const RAIO_TERRA_KM = 6371;

function haversineKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const r = Math.PI / 180;
  const dLat = (bLat - aLat) * r;
  const dLon = (bLon - aLon) * r;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * RAIO_TERRA_KM * Math.asin(Math.sqrt(s));
}

/**
 * Gerador determinístico.
 *
 * A inicialização precisa de sorteio (k-means++ é probabilístico), mas o
 * resultado NÃO pode variar entre execuções: um território que muda sozinho
 * entre dois cliques é inutilizável para dividir comissão. Semente fixa
 * resolve os dois.
 */
function rng(semente: number) {
  let s = semente >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/**
 * k-means++ ponderado pelo mercado.
 *
 * A semente inicial não é aleatória uniforme: municípios com mais empresas têm
 * mais chance de virar centro. Sem isso, um sorteio uniforme escolhe cidades
 * pequenas (que são a maioria) e o algoritmo gasta iterações corrigindo.
 */
function semear(pontos: Ponto[], k: number, aleatorio: () => number): Ponto[] {
  const centros: Ponto[] = [];
  const pesoTotal = pontos.reduce((s, p) => s + p.peso, 0);

  /* Primeiro centro: sorteio ponderado por mercado. */
  let alvo = aleatorio() * pesoTotal;
  for (const p of pontos) {
    alvo -= p.peso;
    if (alvo <= 0) {
      centros.push(p);
      break;
    }
  }
  if (centros.length === 0) centros.push(pontos[0] as Ponto);

  /* Demais: probabilidade ∝ distância² até o centro mais próximo × mercado.
     É o k-means++ clássico, com o peso comercial entrando no sorteio. */
  while (centros.length < k) {
    const custos = pontos.map((p) => {
      let menor = Infinity;
      for (const c of centros) {
        const d = haversineKm(p.lat, p.lon, c.lat, c.lon);
        if (d < menor) menor = d;
      }
      return menor * menor * p.peso;
    });
    const soma = custos.reduce((a, b) => a + b, 0);
    if (soma <= 0) break;

    let acumulado = aleatorio() * soma;
    let escolhido = pontos.length - 1;
    for (let i = 0; i < pontos.length; i++) {
      acumulado -= custos[i] as number;
      if (acumulado <= 0) {
        escolhido = i;
        break;
      }
    }
    centros.push(pontos[escolhido] as Ponto);
  }
  return centros;
}

export interface OpcoesPlano {
  /** Quantos territórios. Limitado a 8 — ver comentário no módulo da tela. */
  quantidade: number;
  /** Desequilíbrio tolerado antes de parar de transferir. 0.25 = ±25%. */
  toleranciaDesequilibrio?: number;
  maxIteracoes?: number;
}

/**
 * Desenha os territórios.
 *
 * `coordenadas` vem de fora porque quem tem os centroides é a camada de
 * apresentação — o domínio não deveria conhecer o arquivo de centroides.
 */
export function planejarTerritorios(
  pracas: Praca[],
  coordenadas: (id: number) => [number, number] | null,
  opts: OpcoesPlano,
): PlanoDeTerritorios | null {
  const k = Math.max(1, Math.min(8, Math.floor(opts.quantidade)));
  const tolerancia = opts.toleranciaDesequilibrio ?? 0.25;
  const maxIter = opts.maxIteracoes ?? 40;

  const pontos: Ponto[] = [];
  for (const p of pracas) {
    const c = coordenadas(p.id);
    const peso = p.setor ?? 0;
    /* Praça sem mercado no setor não entra: alocar um vendedor para cobrir
       município onde não há um único cliente potencial é ruído no desenho. */
    if (!c || peso <= 0) continue;
    pontos.push({ praca: p, lat: c[0] as number, lon: c[1] as number, peso });
  }

  if (pontos.length < k) return null;

  const aleatorio = rng(20260807);
  let centros = semear(pontos, k, aleatorio).map((c) => ({ lat: c.lat, lon: c.lon }));

  let atribuicao = new Array<number>(pontos.length).fill(0);
  let iteracoes = 0;

  /* ── Fase 1: k-means geográfico ponderado ── */
  for (; iteracoes < maxIter; iteracoes++) {
    let mudou = false;

    for (let i = 0; i < pontos.length; i++) {
      const p = pontos[i] as Ponto;
      let melhor = 0;
      let menor = Infinity;
      for (let c = 0; c < centros.length; c++) {
        const ct = centros[c] as { lat: number; lon: number };
        const d = haversineKm(p.lat, p.lon, ct.lat, ct.lon);
        if (d < menor) {
          menor = d;
          melhor = c;
        }
      }
      if (atribuicao[i] !== melhor) {
        atribuicao[i] = melhor;
        mudou = true;
      }
    }

    /* Novo centro = centroide PONDERADO pelo mercado. Sem o peso, o centro
       migra para onde há muitos municípios pequenos em vez de para onde está
       o cliente. */
    const somaLat = new Array<number>(k).fill(0);
    const somaLon = new Array<number>(k).fill(0);
    const somaPeso = new Array<number>(k).fill(0);
    for (let i = 0; i < pontos.length; i++) {
      const p = pontos[i] as Ponto;
      const t = atribuicao[i] as number;
      somaLat[t] = (somaLat[t] as number) + p.lat * p.peso;
      somaLon[t] = (somaLon[t] as number) + p.lon * p.peso;
      somaPeso[t] = (somaPeso[t] as number) + p.peso;
    }
    centros = centros.map((c, t) =>
      (somaPeso[t] as number) > 0
        ? {
            lat: (somaLat[t] as number) / (somaPeso[t] as number),
            lon: (somaLon[t] as number) / (somaPeso[t] as number),
          }
        : c,
    );

    if (!mudou) break;
  }

  /* ── Fase 2: equilíbrio de mercado ──
     Transfere praças de FRONTEIRA (as mais próximas do território vizinho) do
     mais carregado para o mais fraco. Só de fronteira: mover uma praça do
     miolo quebraria a compacidade que a fase 1 construiu. */
  const mercadoDe = () => {
    const m = new Array<number>(k).fill(0);
    for (let i = 0; i < pontos.length; i++) {
      m[atribuicao[i] as number] = (m[atribuicao[i] as number] as number) + (pontos[i] as Ponto).peso;
    }
    return m;
  };

  for (let passo = 0; passo < 60; passo++) {
    const mercado = mercadoDe();
    const media = mercado.reduce((a, b) => a + b, 0) / k;
    if (media <= 0) break;

    let iMax = 0;
    let iMin = 0;
    for (let t = 1; t < k; t++) {
      if ((mercado[t] as number) > (mercado[iMax] as number)) iMax = t;
      if ((mercado[t] as number) < (mercado[iMin] as number)) iMin = t;
    }

    const desequilibrio = ((mercado[iMax] as number) - (mercado[iMin] as number)) / media;
    if (desequilibrio <= tolerancia) break;

    /* Candidata: praça do território cheio mais próxima do centro do vazio,
       e que não seja grande demais para não inverter o desequilíbrio. */
    const centroDestino = centros[iMin] as { lat: number; lon: number };
    const limite = ((mercado[iMax] as number) - (mercado[iMin] as number)) / 2;

    let melhorIdx = -1;
    let melhorDist = Infinity;
    for (let i = 0; i < pontos.length; i++) {
      if (atribuicao[i] !== iMax) continue;
      const p = pontos[i] as Ponto;
      if (p.peso > limite) continue;
      const d = haversineKm(p.lat, p.lon, centroDestino.lat, centroDestino.lon);
      if (d < melhorDist) {
        melhorDist = d;
        melhorIdx = i;
      }
    }

    /* Nada transferível sem inverter o problema — o desenho já é o melhor que
       esta heurística alcança com este k. */
    if (melhorIdx < 0) break;
    atribuicao[melhorIdx] = iMin;
  }

  /* ── Monta o resultado ── */
  const grupos: Ponto[][] = Array.from({ length: k }, () => []);
  for (let i = 0; i < pontos.length; i++) {
    (grupos[atribuicao[i] as number] as Ponto[]).push(pontos[i] as Ponto);
  }

  const territorios: Territorio[] = [];
  for (let t = 0; t < k; t++) {
    const g = grupos[t] as Ponto[];
    if (g.length === 0) continue;

    /* A sede é a praça de MAIOR mercado, não o centro geométrico: o vendedor
       mora onde estão os clientes, não no meio do mapa. */
    const sede = g.reduce((a, b) => (b.peso > a.peso ? b : a));
    const mercado = g.reduce((s, p) => s + p.peso, 0);
    const populacao = g.reduce((s, p) => s + (p.praca.populacao ?? 0), 0);
    const scoreMedio = g.reduce((s, p) => s + p.praca.atratividade.score, 0) / g.length;

    let raioKm = 0;
    let somaDist = 0;
    for (const p of g) {
      const d = haversineKm(sede.lat, sede.lon, p.lat, p.lon);
      if (d > raioKm) raioKm = d;
      somaDist += d * p.peso;
    }

    territorios.push({
      indice: territorios.length,
      sede: sede.praca,
      pracas: g.map((p) => p.praca).sort((a, b) => (b.setor ?? 0) - (a.setor ?? 0)),
      mercado,
      populacao,
      scoreMedio: Math.round(scoreMedio),
      raioKm: Math.round(raioKm),
      distanciaMediaKm: mercado > 0 ? Math.round(somaDist / mercado) : 0,
      centro: centros[t] as { lat: number; lon: number },
    });
  }

  territorios.sort((a, b) => b.mercado - a.mercado);
  territorios.forEach((t, i) => (t.indice = i));

  const mercados = territorios.map((t) => t.mercado);
  const mercadoTotal = mercados.reduce((a, b) => a + b, 0);
  const media = mercadoTotal / Math.max(1, territorios.length);

  return {
    territorios,
    desequilibrio:
      media > 0 ? (Math.max(...mercados) - Math.min(...mercados)) / media : 0,
    mercadoTotal,
    pracasAtendidas: pontos.length,
    iteracoes,
  };
}
