# SAMBHAV AI

A voice-first personal AI web app with a large Three.js glass globe, Gemini Live audio, Supabase authentication/storage, personal memory tools, and optional Tavily web search.

## Project status

This is an assembled starter project based on the source files supplied in chat. The source has **not** been run against your Gemini or Supabase projects, and live microphone/audio behavior has not been verified in a real browser yet.

## Requirements

- Node.js 20 or newer (the project uses `node --env-file`)
- A Supabase project
- A Google Gemini API key with access to the selected Live API model
- Optional Tavily API key for web search

## Setup

1. In Supabase, enable Email authentication.
2. Open the Supabase SQL Editor and run `supabase/schema.sql`.
3. Copy `.env.example` to `.env`.
4. Fill in `GEMINI_API_KEY`, `SUPABASE_URL`, and `SUPABASE_ANON_KEY`. Add `TAVILY_API_KEY` only if you want web search.
5. Install and build:

   ```bash
   npm install
   npm run build
   npm start
   ```

6. Open `http://localhost:8787`.

For development, run `npm run dev` and open the Vite URL printed in the terminal (normally `http://localhost:5173`).

## Environment variables

- `GEMINI_API_KEY`: server-only secret. Never put it in frontend code.
- `SUPABASE_URL`: Supabase project URL.
- `SUPABASE_ANON_KEY`: Supabase anon/publishable key. Keep RLS enabled.
- `TAVILY_API_KEY`: optional server-only search key.
- `GEMINI_LIVE_MODEL`: Live API model name. Confirm that the model is enabled for your API key and supported by the current Gemini Live API before deployment.
- `GEMINI_VOICE`: prebuilt voice name supported by the selected model.
- `PORT`: Express server port (default 8787).

## Security notes

- Never commit `.env`.
- Never use a Supabase service-role key in the browser.
- RLS policies restrict rows to `auth.uid()`.
- The Express API validates Supabase access tokens with `auth.getUser()`.
- The in-memory API rate limiter is per-process and resets on restart; replace it with a shared rate limiter before scaling to multiple instances.
- Do not store sensitive personal information in memory.

## Deployment

Deploy the Node/Express server and Vite-built `dist/` directory together on a host that supports a persistent Node process. Set the environment variables in the host's secret manager. Serve the site over HTTPS because microphone access requires a secure context. Configure Supabase Auth's allowed redirect URLs for your production domain.

## Current limitations to test before production

- Confirm the configured Gemini Live model and ephemeral-token flow work with your Google project.
- Test microphone permissions, audio playback, interruption, and repeated start/stop on Android Chrome and iPhone Safari.
- The frontend's manual `interrupt()` currently stops queued local playback; verify and implement server-side generation interruption if required by the selected Live API version.
- Conversation continuity currently loads the latest messages for the signed-in user across conversations, rather than restricting to one conversation.
- Tool calls, memory saving, and Tavily search should be tested with real credentials.
