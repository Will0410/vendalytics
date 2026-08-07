/**
 * pool.ts — limitador de concorrência.
 *
 * A tabela de prospecção precisa de N CNPJs. Disparar N `fetch` de uma vez é
 * o caminho mais curto para 429 na BrasilAPI (e para o navegador enfileirar
 * do jeito dele, sem ordem). Aqui a vazão é explícita: no máximo `limite`
 * requisições em voo, o resto espera na fila.
 *
 * Também expõe progresso, porque uma tabela que preenche linha a linha é
 * muito melhor de esperar que um spinner que segura tudo até a última.
 */

export interface PoolOpts {
  limite?: number;
  /** Pausa entre a conclusão de uma tarefa e o início da próxima. Espaça o
   *  tráfego mesmo com concorrência baixa — a BrasilAPI limita por janela de
   *  tempo, não só por simultaneidade. */
  intervaloMs?: number;
  signal?: AbortSignal;
}

export type Resultado<T> = { ok: true; valor: T } | { ok: false; erro: unknown };

/**
 * Roda `tarefa` sobre cada item com concorrência limitada.
 *
 * Nunca rejeita: cada item resolve em `{ok:true}` ou `{ok:false, erro}`, na
 * ordem original. É deliberado — um CNPJ que falhou não pode derrubar os
 * outros dezenove, e a tabela mostra a linha com o erro dela.
 */
export async function mapaComLimite<T, R>(
  itens: readonly T[],
  tarefa: (item: T, indice: number) => Promise<R>,
  opts: PoolOpts & { aoProgredir?: (concluidos: number, total: number) => void } = {},
): Promise<Resultado<R>[]> {
  const { limite = 4, intervaloMs = 0, signal, aoProgredir } = opts;
  const saida = new Array<Resultado<R>>(itens.length);
  let proximo = 0;
  let concluidos = 0;

  const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

  async function trabalhador(): Promise<void> {
    for (;;) {
      if (signal?.aborted) return;
      const i = proximo++;
      if (i >= itens.length) return;

      try {
        saida[i] = { ok: true, valor: await tarefa(itens[i] as T, i) };
      } catch (erro) {
        saida[i] = { ok: false, erro };
      }

      concluidos++;
      aoProgredir?.(concluidos, itens.length);
      if (intervaloMs > 0) await dormir(intervaloMs);
    }
  }

  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limite, itens.length)) }, trabalhador),
  );

  return saida;
}
