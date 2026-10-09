# ASIQPAI PRO MIX — isolated preview

This page is a browser-only recording and A/B mixing QA surface. It contains no auth, wallet, payment or production backend calls. It does not persist user audio.

## Run locally
From the repository root:

```bash
node preview/serve.mjs
```

Open `http://localhost:3000/` (Chrome/Firefox desktop). On a real phone, host the preview over **HTTPS**; microphone access requires a secure context. The browser must support MediaRecorder and OfflineAudioContext.

## Publish without touching production
Create a **separate Railway service** or a separate project, connected to branch `feature/ai-pro-mix-v1`, with start command:

```bash
node preview/serve.mjs
```

Generate a fresh Railway-provided HTTPS domain for **that preview service only**. Do **not** modify or redeploy the existing `asiqpai` service and do not reuse its production hostname. Do not copy production environment variables: this server needs only `PORT` (provided by Railway).

Note: a new active Railway service may increase the user's bill; get their confirmation before provisioning. No Railway service is created by merely committing this preview.

## Test procedure
1. Open the isolated HTTPS URL. Choose beat and upload MID, or record MID with headphones.
2. Export with PRO MIX OFF (control version). Turn PRO MIX ON, DRY PUNCH 65%, export.
3. Compare the two audio players at matched listening volume. Try HEAVY, 0%, 100%; note any distortion.
4. Test uploaded MID/BACK/ADLIBS as well as recording on iPhone and Android.
5. Save downloaded WAV before closing the page; no server storage is used.
6. Full Telegram Mini App integration still requires separate real-world testing; the preview works without Telegram authentication by design.

## Security
The server serves only four allowlisted files (`index.html`, `app.js`, `studio/audio.js`, `studio/pro-mix.js`). It refuses non-GET/HEAD requests and does not proxy production APIs. No secret environment variables are read or output.
