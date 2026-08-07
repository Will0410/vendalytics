/**
 * cache.test.ts — o cache compartilhado.
 *
 * Este arquivo existe por causa de um bug que chegou em produção: um `Map`
 * persistido em sessionStorage volta como `{}`, e a tela morria com
 * "dado is not iterable" — mas **só no segundo carregamento**. Some quando se
 * abre um navegador limpo para investigar, que é exatamente o que todo teste
 * manual fazia.
 *
 * A regressão está amarrada abaixo em `não persiste valores que não sobrevivem
 * ao JSON`.
 */
import { describe, expect, it, vi } from "vitest";
import { comCache, limparCache, limparMemoria } from "./cache";

describe("comCache", () => {
  it("executa o produtor uma vez e reusa o valor dentro do TTL", async () => {
    const produtor = vi.fn(async () => 42);

    expect(await comCache("k", produtor)).toBe(42);
    expect(await comCache("k", produtor)).toBe(42);

    expect(produtor).toHaveBeenCalledTimes(1);
  });

  it("deduplica chamadas simultâneas na mesma chave", async () => {
    /* Três componentes montando juntos pedem a mesma URL. Sem a dedup, são
       três requisições de 800KB para o mesmo dado. */
    let resolver!: (v: number) => void;
    const produtor = vi.fn(() => new Promise<number>((r) => (resolver = r)));

    const p1 = comCache("voo", produtor);
    const p2 = comCache("voo", produtor);
    const p3 = comCache("voo", produtor);

    resolver(7);
    expect(await Promise.all([p1, p2, p3])).toEqual([7, 7, 7]);
    expect(produtor).toHaveBeenCalledTimes(1);
  });

  it("reexecuta depois do TTL expirar", async () => {
    const produtor = vi.fn(async () => Math.random());

    const a = await comCache("ttl", produtor, { ttlMs: 5 });
    await new Promise((r) => setTimeout(r, 20));
    const b = await comCache("ttl", produtor, { ttlMs: 5 });

    expect(produtor).toHaveBeenCalledTimes(2);
    expect(a).not.toBe(b);
  });

  it("não guarda o valor quando o produtor falha", async () => {
    const produtor = vi
      .fn()
      .mockRejectedValueOnce(new Error("rede caiu"))
      .mockResolvedValueOnce("ok");

    await expect(comCache("falha", produtor)).rejects.toThrow("rede caiu");
    /* Um erro cacheado seria permanente até o TTL — a tela ficaria quebrada
       por horas mesmo depois de a rede voltar. */
    expect(await comCache("falha", produtor)).toBe("ok");
  });

  it("limparCache descarta memória e sessionStorage", async () => {
    const produtor = vi.fn(async () => 1);
    await comCache("limpa", produtor);
    limparCache();
    await comCache("limpa", produtor);
    expect(produtor).toHaveBeenCalledTimes(2);
  });

  /* ── REGRESSÃO ─────────────────────────────────────────────────────────
     Bug real: `setoresPorUf()` devolve um Map. O cache persistia em
     sessionStorage via JSON.stringify, que transforma Map em `{}`. Primeira
     visita funcionava (memória); no F5 voltava vazio e o `for...of` de quem
     consome quebrava, derrubando o módulo inteiro. */
  describe("regressão: Map/Set não sobrevivem ao JSON", () => {
    it("não persiste um Map — mas continua servindo da memória", async () => {
      const mapa = new Map([[1, "um"]]);
      await comCache("mapa", async () => mapa, { persistir: true });

      const bruto = sessionStorage.getItem("vendalytics:cache:mapa");
      expect(bruto).toBeNull();

      /* A memória segue funcionando: o valor não é perdido, só não é gravado. */
      const devolvido = await comCache("mapa", async () => new Map(), { persistir: true });
      expect(devolvido).toBe(mapa);
      expect(devolvido.get(1)).toBe("um");
    });

    it("não persiste objeto que CONTÉM um Map", async () => {
      /* É a forma de `cargaNacional`: { municipios: [...], porId: Map }. */
      await comCache("misto", async () => ({ lista: [1, 2], porId: new Map() }), {
        persistir: true,
      });
      expect(sessionStorage.getItem("vendalytics:cache:misto")).toBeNull();
    });

    it("persiste normalmente o que sobrevive ao JSON", async () => {
      await comCache("simples", async () => ({ a: 1, b: ["x"] }), { persistir: true });

      const bruto = sessionStorage.getItem("vendalytics:cache:simples");
      expect(bruto).not.toBeNull();
      expect(JSON.parse(bruto as string).valor).toEqual({ a: 1, b: ["x"] });
    });

    it("qualquer valor persistido volta idêntico do sessionStorage", async () => {
      /* A propriedade que o bug violava: ida e volta pelo storage não pode
         mudar o valor. Vale para qualquer coisa que o cache aceite gravar. */
      const original = { municipios: [{ id: 1, nome: "São Paulo" }], total: 1 };
      await comCache("roundtrip", async () => original, { persistir: true });

      limparCache();
      sessionStorage.setItem(
        "vendalytics:cache:roundtrip",
        JSON.stringify({ valor: original, expiraEm: Date.now() + 60_000 }),
      );

      const naoDeveriaRodar = vi.fn(async () => ({ municipios: [], total: 0 }));
      expect(await comCache("roundtrip", naoDeveriaRodar)).toEqual(original);
      expect(naoDeveriaRodar).not.toHaveBeenCalled();
    });
  });

  /* ── Camada durável (IndexedDB) ─────────────────────────────────────────
     Existe para o que o sessionStorage não aceita: ~2,5MB com um Map dentro.
     Sem ela, todo F5 refazia a carga nacional inteira do IBGE. */
  describe("persistência durável", () => {
    it("guarda e devolve um Map intacto", async () => {
      /* É o caso que quebrava no sessionStorage. IndexedDB usa clonagem
         estruturada — o Map atravessa como Map, não como `{}`. */
      const produtor = vi.fn(async () => new Map([[35, ["G", "C"]]]));

      const ida = await comCache("dur:mapa", produtor, { duravel: true });
      expect(ida.get(35)).toEqual(["G", "C"]);

      limparMemoria();
      const volta = await comCache<Map<number, string[]>>(
        "dur:mapa",
        vi.fn(),
        { duravel: true },
      );

      expect(volta).toBeInstanceOf(Map);
      expect(volta.get(35)).toEqual(["G", "C"]);
      expect(produtor).toHaveBeenCalledTimes(1);
    });

    it("respeita o TTL", async () => {
      const produtor = vi.fn(async () => "v1");
      await comCache("dur:ttl", produtor, { duravel: true, ttlMs: 5 });

      limparMemoria();
      await new Promise((r) => setTimeout(r, 25));

      const outro = vi.fn(async () => "v2");
      expect(await comCache("dur:ttl", outro, { duravel: true, ttlMs: 5 })).toBe("v2");
    });

    it("funciona sem IndexedDB — degrada, não quebra", async () => {
      /* Navegação anônima, política corporativa, cota cheia. Cache que
         derruba a aplicação quando falha não é cache, é dependência. */
      const original = globalThis.indexedDB;
      // @ts-expect-error — remoção deliberada para simular indisponibilidade
      delete globalThis.indexedDB;

      try {
        const produtor = vi.fn(async () => ({ ok: true }));
        expect(await comCache("dur:sem-idb", produtor, { duravel: true })).toEqual({ ok: true });
      } finally {
        globalThis.indexedDB = original;
      }
    });
  });
});
