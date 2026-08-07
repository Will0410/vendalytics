/**
 * http.ts — cliente HTTP com política de repetição.
 *
 * Existe porque as duas fontes deste produto são públicas e gratuitas, e por
 * isso mesmo limitam por IP. A BrasilAPI devolve 429 com facilidade quando
 * vários CNPJs saem em paralelo; o IBGE cai eventualmente com 5xx. Um `fetch`
 * cru transformaria isso em tela quebrada.
 *
 * Regra que atravessa o arquivo: **falha nunca vira dado**. Um erro sobe como
 * `ApiError` e a interface mostra o erro. Em nenhum ponto um valor ausente é
 * substituído por zero ou por estimativa — um "0 empresas" inventado é pior
 * que um "indisponível" honesto, porque o usuário acredita nele.
 */

export class ApiError extends Error {
  readonly status: number | null;
  readonly url: string;
  readonly repetivel: boolean;

  constructor(
    mensagem: string,
    opts: { status?: number | null; url: string; repetivel?: boolean },
  ) {
    super(mensagem);
    this.name = "ApiError";
    this.status = opts.status ?? null;
    this.url = opts.url;
    this.repetivel = opts.repetivel ?? false;
  }

  /** Mensagem para o usuário final — sem jargão de status HTTP solto. */
  get amigavel(): string {
    if (this.status === 429) return "Limite de requisições da fonte atingido. Tente em instantes.";
    if (this.status === 404) return "Registro não encontrado na fonte.";
    if (this.status === 400) return "Consulta inválida para esta fonte.";
    if (this.status && this.status >= 500) return "A fonte pública está instável no momento.";
    if (this.status === null) return "Sem resposta da fonte (rede ou tempo esgotado).";
    return this.message;
  }
}

export interface FetchOpts {
  /** Tentativas totais, incluindo a primeira. */
  tentativas?: number;
  timeoutMs?: number;
  /** Base do backoff exponencial. */
  backoffBaseMs?: number;
  signal?: AbortSignal;
}

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Espera até a próxima tentativa. Exponencial com **jitter**: sem o jitter,
 *  N requisições que tomaram 429 juntas voltariam juntas e tomariam 429 de
 *  novo, em manada. */
function esperaDe(tentativa: number, base: number, retryAfter: number | null): number {
  if (retryAfter !== null) return Math.min(retryAfter, 20_000);
  const exponencial = base * 2 ** (tentativa - 1);
  return Math.round(exponencial * (0.7 + Math.random() * 0.6));
}

function lerRetryAfter(r: Response): number | null {
  const h = r.headers.get("retry-after");
  if (!h) return null;
  const segundos = Number(h);
  if (Number.isFinite(segundos)) return segundos * 1000;
  const data = Date.parse(h);
  return Number.isNaN(data) ? null : Math.max(0, data - Date.now());
}

/**
 * GET + JSON, com repetição em 429/5xx/erro de rede. 4xx (fora de 429) não
 * repete: o pedido está errado, insistir só queima cota.
 */
export async function fetchJson<T>(url: string, opts: FetchOpts = {}): Promise<T> {
  const { tentativas = 3, timeoutMs = 20_000, backoffBaseMs = 700, signal } = opts;

  let ultimoErro: ApiError = new ApiError("falha desconhecida", { url });

  for (let tentativa = 1; tentativa <= tentativas; tentativa++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const abortarExterno = () => ctrl.abort();
    signal?.addEventListener("abort", abortarExterno);

    try {
      const r = await fetch(url, {
        signal: ctrl.signal,
        headers: { Accept: "application/json" },
      });

      if (r.ok) return (await r.json()) as T;

      const repetivel = r.status === 429 || r.status >= 500;
      ultimoErro = new ApiError(`HTTP ${r.status} em ${url}`, {
        status: r.status,
        url,
        repetivel,
      });

      if (!repetivel || tentativa === tentativas) throw ultimoErro;
      await dormir(esperaDe(tentativa, backoffBaseMs, lerRetryAfter(r)));
    } catch (e) {
      if (e instanceof ApiError) {
        if (!e.repetivel || tentativa === tentativas) throw e;
        ultimoErro = e;
        continue;
      }

      /* Abort do chamador (troca de filtro, desmontagem) não é falha — sobe
         limpo para o hook descartar sem pintar erro. */
      if (signal?.aborted) throw e;

      ultimoErro = new ApiError(
        e instanceof DOMException && e.name === "AbortError"
          ? `tempo esgotado (${timeoutMs}ms)`
          : e instanceof Error
            ? e.message
            : String(e),
        { status: null, url, repetivel: true },
      );
      if (tentativa === tentativas) throw ultimoErro;
      await dormir(esperaDe(tentativa, backoffBaseMs, null));
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abortarExterno);
    }
  }

  throw ultimoErro;
}
