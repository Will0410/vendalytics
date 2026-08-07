/**
 * armazem.ts — persistência de cache em IndexedDB.
 *
 * ── O problema que isto resolve ───────────────────────────────────────────
 * A carga nacional do IBGE são ~2,5MB em três a quatro requisições. Hoje ela
 * vive só em memória (`persistir: false`), por duas razões que se somam:
 * `Map` não sobrevive ao JSON do sessionStorage, e 2,5MB não cabem
 * confortavelmente nos ~5MB de cota dele.
 *
 * Resultado: **todo F5 refaz a carga inteira**. Quem usa a ferramenta ao longo
 * do dia paga 3 a 6 segundos de espera a cada recarga, para buscar um dado que
 * o IBGE atualiza uma vez por ano.
 *
 * IndexedDB resolve os dois de uma vez: guarda estruturas nativas (Map, Set,
 * Date) pelo algoritmo de clonagem estruturada — sem serializar para texto — e
 * a cota é de centenas de MB.
 *
 * ── Por que continua sendo um cache, e não uma base ───────────────────────
 * Toda leitura verifica o TTL, e toda falha é engolida. Se o IndexedDB estiver
 * bloqueado (navegação anônima, política corporativa, cota cheia), o app
 * funciona exatamente como antes — só sem o ganho. Cache que derruba a
 * aplicação quando falha não é cache, é dependência.
 */

const BANCO = "vendalytics";
const DEPOSITO = "cache";
const VERSAO = 1;

interface Entrada<T> {
  valor: T;
  expiraEm: number;
}

/** Uma conexão só, reaproveitada. Abrir por operação custa caro e enfileira. */
let conexao: Promise<IDBDatabase> | null = null;

function abrir(): Promise<IDBDatabase> {
  if (conexao) return conexao;

  conexao = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB indisponível"));
      return;
    }
    const req = indexedDB.open(BANCO, VERSAO);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(DEPOSITO)) {
        req.result.createObjectStore(DEPOSITO);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("falha ao abrir IndexedDB"));
    req.onblocked = () => reject(new Error("IndexedDB bloqueado por outra aba"));
  }).catch((e) => {
    /* Não mantém a promise rejeitada em cache: uma falha transitória
       (banco travado por outra aba fechando) condenaria a sessão inteira. */
    conexao = null;
    throw e;
  });

  return conexao;
}

/**
 * Lê uma entrada válida. `undefined` quando não existe, expirou, ou o
 * IndexedDB não está disponível — o chamador não distingue os casos porque
 * a ação é a mesma: buscar de novo.
 */
export async function ler<T>(chave: string): Promise<T | undefined> {
  try {
    const db = await abrir();
    const entrada = await new Promise<Entrada<T> | undefined>((resolve) => {
      const req = db.transaction(DEPOSITO, "readonly").objectStore(DEPOSITO).get(chave);
      req.onsuccess = () => resolve(req.result as Entrada<T> | undefined);
      req.onerror = () => resolve(undefined);
    });

    if (!entrada) return undefined;
    if (entrada.expiraEm < Date.now()) {
      void remover(chave);
      return undefined;
    }
    return entrada.valor;
  } catch {
    return undefined;
  }
}

/** Grava. Nunca levanta: perder a persistência é degradação, não erro. */
export async function gravar<T>(chave: string, valor: T, ttlMs: number): Promise<void> {
  try {
    const db = await abrir();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(DEPOSITO, "readwrite");
      tx.objectStore(DEPOSITO).put({ valor, expiraEm: Date.now() + ttlMs }, chave);
      tx.oncomplete = () => resolve();
      /* QuotaExceededError e DataCloneError caem aqui. O segundo acontece com
         valor que contém função ou nó de DOM — nada que este cache guarde,
         mas o guarda evita que uma mudança futura quebre em produção. */
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  } catch {
    /* IndexedDB indisponível — segue sem persistir. */
  }
}

export async function remover(chave: string): Promise<void> {
  try {
    const db = await abrir();
    db.transaction(DEPOSITO, "readwrite").objectStore(DEPOSITO).delete(chave);
  } catch {
    /* idem */
  }
}

/** Esvazia tudo — usado pelo botão "Recarregar fontes" do cabeçalho. */
export async function limpar(): Promise<void> {
  try {
    const db = await abrir();
    db.transaction(DEPOSITO, "readwrite").objectStore(DEPOSITO).clear();
  } catch {
    /* idem */
  }
}

export function disponivel(): boolean {
  return typeof indexedDB !== "undefined";
}
