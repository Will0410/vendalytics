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
import { comCache, limparCache } from "./cache";

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
});
