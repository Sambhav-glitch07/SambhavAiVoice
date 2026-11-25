import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { GoogleGenAI } from '@google/genai';

const { GEMINI_API_KEY, SUPABASE_URL, SUPABASE_ANON_KEY, TAVILY_API_KEY } = process.env;
const MODEL = process.env.GEMINI_LIVE_MODEL || 'gemini-2.5-flash-native-audio-preview-12-2025';
const VOICE = process.env.GEMINI_VOICE || 'Aoede';
const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));

const dbFor = jwt => createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  global: { headers: { Authorization: `Bearer ${jwt}` } }, auth: { persistSession: false }
});
const hits = new Map();
async function auth(req, res, next) {
  const jwt = (req.headers.authorization || '').replace(/^Bearer /, '');
  if (!jwt || !SUPABASE_URL || !SUPABASE_ANON_KEY) return res.status(401).json({ error: 'Sign in required' });
  try {
    const db = dbFor(jwt);
    const { data, error } = await db.auth.getUser(jwt);
    if (error || !data?.user) return res.status(401).json({ error: 'Invalid session' });
    const now = Date.now(), h = (hits.get(data.user.id) || []).filter(t => now - t < 60000);
    if (h.length >= 30) return res.status(429).json({ error: 'Slow down' });
    h.push(now); hits.set(data.user.id, h);
    req.user = data.user; req.db = db; next();
  } catch { return res.status(401).json({ error: 'Invalid session' }); }
}
const TOOLS = [{ functionDeclarations: [
  { name: 'save_memory', description: 'Save a lasting personal fact, preference, plan or reminder the user wants remembered. Do not save sensitive personal information.', parameters: { type: 'OBJECT', properties: { content: { type: 'STRING', description: 'One short self-contained sentence.' } }, required: ['content'] } },
  { name: 'recall_memory', description: 'Search the user’s saved memories for a topic.', parameters: { type: 'OBJECT', properties: { query: { type: 'STRING' } }, required: ['query'] } },
  ...(TAVILY_API_KEY ? [{ name: 'web_search', description: 'Search the internet for current or factual information.', parameters: { type: 'OBJECT', properties: { query: { type: 'STRING' } }, required: ['query'] } }] : [])
] }];
const PERSONA = `You are Sambhav, a warm, sharp, personal voice assistant. You are speaking aloud, so keep replies short and natural, with no markdown, lists or emojis.
Speak in the language the person uses: Hindi, English or Hinglish, and mirror their mix. Ask at most one question at a time.
Use save_memory only for lasting, non-sensitive facts or preferences the person clearly wants remembered. Use recall_memory when they refer to past or personal details not already below. Use web_search (if available) for current events or facts you are unsure about.
Only say you saved or looked something up after the tool succeeds. If you don't know, say so plainly.`;

app.get('/api/config', (_q, r) => r.json({ supabaseUrl: SUPABASE_URL || '', supabaseAnonKey: SUPABASE_ANON_KEY || '', search: !!TAVILY_API_KEY }));

app.post('/api/live-token', auth, async (req, res) => {
  try {
    if (!GEMINI_API_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY not set' });
    const [{ data: mem }, { data: recent }] = await Promise.all([
      req.db.from('memories').select('content').order('created_at', { ascending: false }).limit(30),
      req.db.from('messages').select('role,content').order('created_at', { ascending: false }).limit(12)
    ]);
    const systemInstruction = `${PERSONA}\nToday is ${new Date().toDateString()}.` +
      (mem?.length ? `\nWhat you remember about this person:\n- ${mem.map(m => m.content).join('\n- ')}` : '') +
      (recent?.length ? `\nEnd of your last conversation, for continuity:\n${recent.reverse().map(m => `${m.role}: ${m.content}`).join('\n')}` : '');
    const config = {
      responseModalities: ['AUDIO'], systemInstruction,
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE } } },
      inputAudioTranscription: {}, outputAudioTranscription: {}, tools: TOOLS,
      realtimeInputConfig: { automaticActivityDetection: { disabled: false } }
    };
    const client = new GoogleGenAI({ apiKey: GEMINI_API_KEY, httpOptions: { apiVersion: 'v1alpha' } });
    const tok = await client.authTokens.create({ config: {
      uses: 1, expireTime: new Date(Date.now() + 30 * 60e3).toISOString(),
      newSessionExpireTime: new Date(Date.now() + 60e3).toISOString(),
      liveConnectConstraints: { model: MODEL, config }, httpOptions: { apiVersion: 'v1alpha' }
    } });
    res.json({ token: tok.name, model: MODEL, config });
  } catch (e) { console.error('Live token creation failed:', e?.message || e); res.status(502).json({ error: 'Could not create Live token' }); }
});

app.post('/api/tool', auth, async (req, res) => {
  const { name, args = {} } = req.body || {};
  try {
    if (name === 'save_memory') {
      const content = String(args.content || '').trim().slice(0, 500);
      if (!content) return res.json({ ok: false, error: 'empty' });
      const { error } = await req.db.from('memories').insert({ content });
      return res.json(error ? { ok: false, error: 'memory save failed' } : { ok: true });
    }
    if (name === 'recall_memory') {
      const q = String(args.query || '').replace(/[%,()]/g, ' ').trim().slice(0, 80);
      if (!q) return res.json({ ok: true, memories: [] });
      const { data, error } = await req.db.from('memories').select('content,created_at').ilike('content', `%${q}%`).order('created_at', { ascending: false }).limit(8);
      return res.json(error ? { ok: false, error: 'memory lookup failed' } : { ok: true, memories: data });
    }
    if (name === 'web_search' && TAVILY_API_KEY) {
      const query = String(args.query || '').trim().slice(0, 300);
      if (!query) return res.json({ ok: false, error: 'empty query' });
      const r = await fetch('https://api.tavily.com/search', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TAVILY_API_KEY}` },
        body: JSON.stringify({ query, max_results: 4, include_answer: true })
      });
      if (!r.ok) return res.json({ ok: false, error: `search ${r.status}` });
      const j = await r.json();
      return res.json({ ok: true, answer: j.answer, results: (j.results || []).map(x => ({ title: x.title, url: x.url, content: (x.content || '').slice(0, 400) })) });
    }
    res.status(400).json({ ok: false, error: 'unknown tool' });
  } catch (e) { console.error('Tool failed:', e?.message || e); res.status(500).json({ ok: false, error: 'tool failed' }); }
});

app.use(express.static(dist));
app.get('*', (_q, r) => r.sendFile(path.join(dist, 'index.html')));
app.listen(process.env.PORT || 8787, () => console.log('Sambhav AI on :' + (process.env.PORT || 8787)));
