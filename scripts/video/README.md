# Vídeo de apresentação

Três peças, todas geradas por script — nada é editado à mão, então regravar
depois de mudar o produto é um comando.

| arquivo | o que faz |
|---|---|
| `abertura.html` | a apresentação animada (1920×1080, 92s). HTML/CSS puro, com o roteiro em `ROTEIRO` no fim do arquivo |
| `gravar-abertura.mjs` | grava `abertura.html` em vídeo |
| `gravar-funcoes.mjs` | percorre as 11 telas do produto — `stills` para capturas numeradas, `video` para gravar |

## Rodando

```bash
# backend servindo o web/dist na porta 8907
ADMIN_RESET_EMAIL=demo@vendalytics.local ADMIN_RESET_PASSWORD=... DEMO_MODE=true \
  python -m uvicorn backend.vendalytics.main:app --port 8907

npm i playwright-core ffmpeg-static
node gravar-funcoes.mjs stills
node gravar-funcoes.mjs video
node gravar-abertura.mjs
```

O Playwright grava em `.webm`; converta para MP4 (o que o LinkedIn aceita):

```bash
ffmpeg -i entrada.webm -c:v libx264 -preset slow -crf 21 -pix_fmt yuv420p \
  -profile:v high -movflags +faststart -an saida.mp4
```

## Duas armadilhas que custaram tempo

**`page.evaluate(() => window.__tocar())` aguarda a promessa.** Como `tocar()`
só resolve no fim dos 92 segundos, todas as capturas saíam no fim, com as cenas
já escondidas. Tem que ser `evaluate(() => { window.__tocar(); })`.

**O ffmpeg que vem com o Playwright é reduzido** — só faz VP8, não tem H.264 e
não aceita filtros. Para MP4, use `ffmpeg-static` do npm.
