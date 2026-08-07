/**
 * cache.ts — cache com TTL e deduplicação de chamadas em voo.
 *
 * Dois problemas distintos, mesma solução:
 *
 * 1. **Repetição entre telas.** A carga nacional do IBGE (~1,5MB, 3 chamadas)
 *    alimenta Território, Geomarketing e Vendas. Sem cache, trocar de aba
 *    recarregaria tudo.
 * 2. **Estouro em paralelo.** Três componentes montando juntos pediriam a
 *    mesma URL três vezes. `emVoo` faz os três esperarem a MESMA promise.
 *
 * O TTL é longo de propósito: os agregados do IBGE mudam uma vez por ano.
 * sessionStorage sobrevive ao F5 mas não à sessão — é o equilíbrio certo para
 * dado público que não é sigiloso e não fica velho no meio do dia.
 *
 * ── REGRA INVIOLÁVEL: nada aqui dentro aceita AbortSignal de consumidor ────
 * Uma entrada de cache é COMPARTILHADA. Se o `AbortController` de um
 * componente entrasse no `produzir`, o desmonte desse componente cancelaria a
 * busca de todos os outros que estão esperando a mesma chave.
 *
 * Isso não é teórico — foi exatamente o bug que derrubou as telas de IBGE na
 * primeira execução: no StrictMode do React 18 o efeito monta, desmonta e
 * monta de novo; a limpeza da 1ª montagem abortava a promise que a 2ª
 * montagem ia reaproveitar de `emVoo`, e a tela inteira morria com
 * "signal is aborted without reason".
 *
 * O cancelamento certo acontece uma camada acima: `useAsync` descarta o
 * resultado de quem já desmontou, e `mapaComLimite` para de disparar tarefas
 * novas. A requisição em si roda até o fim e popula o cache — o que, para
 * dado público que outra tela vai pedir em seguida, é melhor que jogar fora.
 */

interface Entrada<T> {
  valor: T;
  expiraEm: number;
}

const memoria = new Map<string, Entrada<unknown>>();
const emVoo = new Map<string, Promise<unknown>>();

const PREFIXO = "vendalytics:cache:";

function lerSessao<T>(chave: string): Entrada<T> | null {
  try {
    const bruto = sessionStorage.getItem(PREFIXO + chave);
    if (!bruto) return null;
    const e = JSON.parse(bruto) as Entrada<T>;
    if (e.expiraEm < Date.now()) {
      sessionStorage.removeItem(PREFIXO + chave);
      return null;
    }
    return e;
  } catch {
    /* JSON corrompido ou storage bloqueado — o cache é otimização. */
    return null;
  }
}

function gravarSessao<T>(chave: string, entrada: Entrada<T>): void {
  try {
    sessionStorage.setItem(PREFIXO + chave, JSON.stringify(entrada));
  } catch {
    /* QuotaExceededError: a carga nacional é grande e pode não caber junto com
       o resto. Perder a persistência é aceitável — a memória continua servindo
       durante a navegação; só o F5 recarrega. */
  }
}

export interface CacheOpts {
  ttlMs?: number;
  /** `false` mantém só em memória. Use para respostas grandes ou voláteis. */
  persistir?: boolean;
}

/** Executa `produzir` no máximo uma vez por chave dentro do TTL. */
export async function comCache<T>(
  chave: string,
  produzir: () => Promise<T>,
  opts: CacheOpts = {},
): Promise<T> {
  const { ttlMs = 6 * 60 * 60 * 1000, persistir = true } = opts;

  const emMemoria = memoria.get(chave) as Entrada<T> | undefined;
  if (emMemoria && emMemoria.expiraEm > Date.now()) return emMemoria.valor;

  if (persistir) {
    const daSessao = lerSessao<T>(chave);
    if (daSessao) {
      memoria.set(chave, daSessao);
      return daSessao.valor;
    }
  }

  const jaPedido = emVoo.get(chave) as Promise<T> | undefined;
  if (jaPedido) return jaPedido;

  const promessa = produzir()
    .then((valor) => {
      const entrada: Entrada<T> = { valor, expiraEm: Date.now() + ttlMs };
      memoria.set(chave, entrada);
      if (persistir) gravarSessao(chave, entrada);
      return valor;
    })
    .finally(() => {
      emVoo.delete(chave);
    });

  emVoo.set(chave, promessa);
  return promessa;
}

/** Limpa tudo — usado pelo botão "Recarregar fontes" do cabeçalho. */
export function limparCache(): void {
  memoria.clear();
  emVoo.clear();
  try {
    Object.keys(sessionStorage)
      .filter((k) => k.startsWith(PREFIXO))
      .forEach((k) => sessionStorage.removeItem(k));
  } catch {
    /* storage bloqueado */
  }
}
