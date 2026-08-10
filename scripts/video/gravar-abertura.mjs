import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const SAIDA = "./video-abertura";
mkdirSync(SAIDA, { recursive: true });

const nav = await chromium.launch();
const ctx = await nav.newContext({
  viewport: { width: 1920, height: 1080 },
  recordVideo: { dir: SAIDA, size: { width: 1920, height: 1080 } },
});
const p = await ctx.newPage();
await p.goto(pathToFileURL(resolve("abertura.html")).href);

const dur = await p.evaluate(() => window.__duracao);
await p.waitForTimeout(700); // respiro antes de abrir, para o corte não colar

/* Não retornar a promessa aqui: `evaluate` bloquearia até o fim e o
   `waitForFunction` abaixo nunca teria chance de observar o progresso. */
await p.evaluate(() => { window.__tocar(); });
await p.waitForFunction(() => window.__fim === true, null, { timeout: (dur + 30) * 1000 });
await p.waitForTimeout(900); // deixa o último quadro respirar

await ctx.close();
await nav.close();
console.log(`abertura gravada (${dur}s de roteiro)`);
