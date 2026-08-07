/**
 * nanoBanana.ts — provedor de assets generativo, via modelo de imagem do
 * Gemini ("Nano Banana", `gemini-2.5-flash-image`).
 *
 * ── Estado deste código ─────────────────────────────────────────────────
 * Escrito contra a API documentada, mas NÃO executado contra a API real —
 * este ambiente não tem chave do Gemini. Trate como integração pendente de
 * validação, não como caminho testado. O `svgSource` é o provedor padrão
 * justamente por isso, e a cadeia de fallback garante que uma falha aqui
 * nunca deixa a interface sem asset.
 *
 * ── Segurança: leia antes de por em produção ────────────────────────────
 * `VITE_GEMINI_API_KEY` vai para o bundle do cliente — qualquer visitante lê
 * a chave no DevTools e passa a gastar sua cota. Isso serve para desenvolver
 * local, e só. Em produção use `VITE_ASSET_PROXY_URL`: um endpoint seu que
 * guarda a chave no servidor e repassa o prompt. O código abaixo prefere o
 * proxy automaticamente quando ele está configurado.
 *
 * ── Custo ───────────────────────────────────────────────────────────────
 * Cada asset é gerado UMA vez e guardado em IndexedDB, com a versão do prompt
 * na chave. Editar o prompt no catálogo invalida só aquele asset. Sem esse
 * cache, um dashboard com 12 cards geraria 12 imagens a cada F5 — inviável
 * em custo e em latência.
 */
import type { AssetSpec } from "./catalog";
import type { AssetSource, ResolvedAsset } from "./AssetProvider";

const ENDPOINT_GOOGLE = "https://generativelanguage.googleapis.com/v1beta/models";
const MODELO_PADRAO = "gemini-2.5-flash-image";

/** Estilo aplicado a todo prompt do catálogo — é o que mantém 12 imagens
 *  geradas em momentos diferentes parecendo o mesmo sistema visual. */
const DIRECAO_DE_ARTE =
  "Design system corporativo enterprise B2B, tema escuro. Fundo navy #0f172a. " +
  "Acentos em índigo #4f6ef7 e ciano #22d3ee. Geométrico, traço fino, limpo, " +
  "profissional, alto padrão de software SaaS. Sem texto, sem letras, sem " +
  "marca d'água, sem pessoas, sem fotografia.";

/* ─── Cache persistente (IndexedDB) ────────────────────────────────────── */

const DB = "vendalytics-assets";
const STORE = "imagens";

function abrirDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB indisponível"));
  });
}

async function lerCache(chave: string): Promise<string | null> {
  try {
    const db = await abrirDb();
    return await new Promise<string | null>((resolve) => {
      const req = db.transaction(STORE, "readonly").objectStore(STORE).get(chave);
      req.onsuccess = () => resolve((req.result as string | undefined) ?? null);
      req.onerror = () => resolve(null);
    });
  } catch {
    /* Navegação anônima, cota cheia, storage bloqueado — o cache é otimização,
       nunca requisito. Falhar aqui só significa gerar de novo. */
    return null;
  }
}

async function gravarCache(chave: string, dataUri: string): Promise<void> {
  try {
    const db = await abrirDb();
    db.transaction(STORE, "readwrite").objectStore(STORE).put(dataUri, chave);
  } catch {
    /* idem */
  }
}

/** Chave do cache = id + hash do prompt efetivo. Mudar o prompt no catálogo
 *  regenera só o asset alterado, sem limpar o resto. */
function chaveDe(spec: AssetSpec, prompt: string, modelo: string): string {
  let h = 5381;
  for (let i = 0; i < prompt.length; i++) h = ((h << 5) + h + prompt.charCodeAt(i)) >>> 0;
  return `${modelo}:${spec.id}:${h.toString(36)}`;
}

/* ─── Chamada ao modelo ────────────────────────────────────────────────── */

interface ParteGemini {
  inlineData?: { mimeType?: string; data?: string };
  inline_data?: { mime_type?: string; data?: string };
  text?: string;
}

/** Extrai a primeira parte de imagem da resposta. A API já respondeu tanto em
 *  camelCase quanto em snake_case conforme a versão; aceitar os dois é mais
 *  barato que descobrir em produção qual chegou. */
function extrairImagem(corpo: unknown): { mime: string; base64: string } | null {
  const partes = (corpo as { candidates?: { content?: { parts?: ParteGemini[] } }[] })?.candidates?.[0]
    ?.content?.parts;
  if (!Array.isArray(partes)) return null;
  for (const p of partes) {
    const inline = p.inlineData ?? p.inline_data;
    if (!inline) continue;
    const base64 = inline.data;
    if (!base64) continue;
    const mime =
      ("mimeType" in inline ? inline.mimeType : undefined) ??
      ("mime_type" in inline ? inline.mime_type : undefined) ??
      "image/png";
    return { mime, base64 };
  }
  return null;
}

export interface NanoBananaOpts {
  /** Chave do Gemini. Só para desenvolvimento — ver aviso no topo do arquivo. */
  apiKey?: string;
  /** Endpoint próprio que guarda a chave no servidor. Preferido em produção.
   *  Contrato esperado: POST { prompt, width, height, assetId } →
   *  { dataUri } ou { mimeType, data }. */
  proxyUrl?: string;
  modelo?: string;
  timeoutMs?: number;
}

export function createNanoBananaSource(opts: NanoBananaOpts = {}): AssetSource {
  const {
    apiKey = import.meta.env.VITE_GEMINI_API_KEY as string | undefined,
    proxyUrl = import.meta.env.VITE_ASSET_PROXY_URL as string | undefined,
    modelo = (import.meta.env.VITE_GEMINI_IMAGE_MODEL as string | undefined) ?? MODELO_PADRAO,
    timeoutMs = 30_000,
  } = opts;

  if (!proxyUrl && apiKey && import.meta.env.PROD) {
    console.warn(
      "[nano-banana] Chave do Gemini exposta no bundle do cliente. " +
        "Configure VITE_ASSET_PROXY_URL antes de publicar.",
    );
  }

  return {
    name: `nano-banana(${modelo})`,

    async resolve(spec: AssetSpec): Promise<ResolvedAsset> {
      if (!proxyUrl && !apiKey) {
        return { kind: "missing", reason: "sem VITE_ASSET_PROXY_URL nem VITE_GEMINI_API_KEY" };
      }

      const prompt =
        `${spec.prompt}\n\n${DIRECAO_DE_ARTE}\n` +
        `Proporção ${spec.width}x${spec.height}px.` +
        (spec.kind === "icon" || spec.kind === "logo" ? " Fundo transparente." : "");

      const chave = chaveDe(spec, prompt, modelo);

      const cacheado = await lerCache(chave);
      if (cacheado) return { kind: "url", url: cacheado };

      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);

      try {
        let dataUri: string;

        if (proxyUrl) {
          const r = await fetch(proxyUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              prompt,
              width: spec.width,
              height: spec.height,
              assetId: spec.id,
            }),
            signal: ctrl.signal,
          });
          if (!r.ok) return { kind: "missing", reason: `proxy respondeu ${r.status}` };
          const corpo = (await r.json()) as { dataUri?: string; mimeType?: string; data?: string };
          if (corpo.dataUri) dataUri = corpo.dataUri;
          else if (corpo.data) dataUri = `data:${corpo.mimeType ?? "image/png"};base64,${corpo.data}`;
          else return { kind: "missing", reason: "proxy não devolveu imagem" };
        } else {
          const r = await fetch(`${ENDPOINT_GOOGLE}/${modelo}:generateContent`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey as string },
            body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
            signal: ctrl.signal,
          });
          if (!r.ok) {
            const detalhe = await r.text().catch(() => "");
            return { kind: "missing", reason: `Gemini ${r.status}: ${detalhe.slice(0, 160)}` };
          }
          const img = extrairImagem(await r.json());
          if (!img) return { kind: "missing", reason: "resposta do Gemini sem parte de imagem" };
          dataUri = `data:${img.mime};base64,${img.base64}`;
        }

        void gravarCache(chave, dataUri);
        return { kind: "url", url: dataUri };
      } catch (e) {
        const motivo =
          e instanceof DOMException && e.name === "AbortError"
            ? `sem resposta em ${timeoutMs}ms`
            : e instanceof Error
              ? e.message
              : String(e);
        return { kind: "missing", reason: motivo };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** `true` quando há como gerar — usado no `main.tsx` para só montar a cadeia
 *  generativa se ela tiver chance de funcionar. */
export function nanoBananaConfigurado(): boolean {
  return Boolean(import.meta.env.VITE_ASSET_PROXY_URL || import.meta.env.VITE_GEMINI_API_KEY);
}
