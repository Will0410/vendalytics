/**
 * movimento.ts — animação que serve à leitura, e some quando não é bem-vinda.
 *
 * ── A regra que decide o que entra ────────────────────────────────────────
 * Só anima o que ajuda a LER O DADO. Barra que cresce da base mostra a
 * magnitude sendo construída; número que sobe até o valor dá tempo de a ordem
 * de grandeza registrar. Card que desliza, ícone que pulsa e gradiente que
 * respira não mostram nada — atrasam a informação e cansam quem usa a
 * ferramenta oito horas por dia.
 *
 * ── Por que um módulo, e não `@motion` direto ─────────────────────────────
 * O `globalStyles` já zera animações CSS em `prefers-reduced-motion: reduce`,
 * e isso cobre transição e keyframe. Não cobre nada movido por JavaScript: um
 * contador em `requestAnimationFrame` continuaria correndo, e é justamente o
 * tipo de movimento que provoca enjoo em quem pediu para não ter movimento.
 *
 * Daí `prefereMovimento()` — a mesma pergunta, respondida em JS.
 */
import { useEffect, useRef, useState } from "react";

/** O usuário aceita movimento? Falso também quando não dá para saber. */
export function prefereMovimento(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-reduced-motion: no-preference)").matches;
}

/**
 * Desaceleração cúbica.
 *
 * Contador linear parece bomba de posto: passa por todos os valores com a
 * mesma pressa e o olho não fixa nenhum. Com desaceleração, os últimos dígitos
 * chegam devagar e o número final é o que fica.
 */
const suavizar = (t: number): number => 1 - Math.pow(1 - t, 3);

/**
 * Anima um número até o alvo e devolve o valor corrente.
 *
 * Com `prefers-reduced-motion: reduce`, devolve o alvo direto — sem quadro
 * intermediário nenhum.
 */
export function useContagem(alvo: number, duracaoMs = 900): number {
  const [valor, setValor] = useState(() => (prefereMovimento() ? 0 : alvo));
  const anterior = useRef(prefereMovimento() ? 0 : alvo);
  const quadro = useRef(0);

  useEffect(() => {
    if (!Number.isFinite(alvo)) {
      setValor(alvo);
      return;
    }
    if (!prefereMovimento() || duracaoMs <= 0) {
      anterior.current = alvo;
      setValor(alvo);
      return;
    }

    /* Anima a partir do valor ATUAL, não de zero: quando o usuário troca de
       filtro, recomeçar do zero apaga a comparação que ele está fazendo entre
       o número de antes e o de agora. */
    const de = anterior.current;

    /**
     * O instante zero vem do PRIMEIRO quadro, não de `performance.now()`.
     *
     * São dois relógios. O `requestAnimationFrame` entrega um timestamp que só
     * por convenção compartilha a origem com `performance.now()` — e onde não
     * compartilha, a diferença entre eles é enorme e o progresso `t` sai
     * negativo. Medido no jsdom: o contador de 1.000 chegava a -8.442.603.
     *
     * Tomando o zero do próprio quadro, os dois lados da subtração vêm sempre
     * da mesma fonte.
     */
    let inicio = 0;
    const passo = (agora: number) => {
      if (inicio === 0) inicio = agora;
      /* Clamp nos DOIS lados. `Math.min(x, 1)` sozinho deixa passar negativo,
         e a suavização cúbica transforma isso em um salto absurdo. */
      const t = Math.max(0, Math.min((agora - inicio) / duracaoMs, 1));
      setValor(de + (alvo - de) * suavizar(t));
      if (t < 1) quadro.current = requestAnimationFrame(passo);
      else anterior.current = alvo;
    };
    quadro.current = requestAnimationFrame(passo);
    return () => cancelAnimationFrame(quadro.current);
  }, [alvo, duracaoMs]);

  return valor;
}

/**
 * Duração para o Recharts, já respeitando a preferência.
 *
 * Devolver 0 é diferente de `isAnimationActive={false}`: com duração zero o
 * gráfico ainda passa pelo ciclo de animação e chega ao estado final no
 * primeiro quadro, sem o salto que o desligamento total provoca ao
 * reidratar.
 */
export function duracaoGrafico(ms = 700): number {
  return prefereMovimento() ? ms : 0;
}

/**
 * Atraso escalonado para entrada em lista.
 *
 * Teto de 6 itens de propósito: escalonar 25 linhas faria a última aparecer
 * um segundo e meio depois da primeira, e quem abriu a tela para ler a tabela
 * fica esperando o enfeite terminar.
 */
export function atraso(indice: number, passoMs = 55, maximo = 6): number {
  if (!prefereMovimento()) return 0;
  return Math.min(indice, maximo) * passoMs;
}
