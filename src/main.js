import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { GoogleGenAI } from '@google/genai';

const {
GEMINI_API_KEY,
SUPABASE_URL,
SUPABASE_ANON_KEY,
TAVILY_API_KEY
} = process.env;

const MODEL =
process.env.GEMINI_LIVE_MODEL ||
'gemini-2.5-flash-native-audio-preview-12-2025';

const VOICE = process.env.GEMINI_VOICE || 'Aoede';
const PORT = process.env.PORT || 8787;

const CACHE_TTL = 20000;
const MAX_CACHE_ENTRIES = 500;

const dist = path.join(
path.dirname(fileURLToPath(import.meta.url)),
'..',
'dist'
);

const app = express();

app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));

// Reusable Gemini client
const gemini = GEMINI_API_KEY
? new GoogleGenAI({
apiKey: GEMINI_API_KEY,
httpOptions: { apiVersion: 'v1alpha' }
})
: null;

// Short-lived user context cache
const contextCache = new Map();
const hits = new Map();

function dbFor(jwt) {
return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
global: {
headers: {
Authorization: Bearer ${jwt}
}
},
auth: {
persistSession: false,
autoRefreshToken: false,
detectSessionInUrl: false
}
});
}

function clearUserCache(userId) {
contextCache.delete(userId);
}

function trimCache() {
if (contextCache.size <= MAX_CACHE_ENTRIES) return;

const oldest = contextCache.keys().next().value;
if (oldest) contextCache.delete(oldest);
}

// Authentication and rate limiting
async function auth(req, res, next) {
const jwt = (req.headers.authorization || '')
.replace(/^Bearer\s+/i, '')
.trim();

if (!jwt || !SUPABASE_URL || !SUPABASE_ANON_KEY) {
return res.status(401).json({
error: 'Sign in required'
});
}

try {
const db = dbFor(jwt);
const { data, error } = await db.auth.getUser(jwt);

if (error || !data?.user) {  
  return res.status(401).json({  
    error: 'Invalid session'  
  });  
}  

const userId = data.user.id;  
const now = Date.now();  

const recent = (hits.get(userId) || [])  
  .filter(t => now - t < 60000);  

if (recent.length >= 30) {  
  return res.status(429).json({  
    error: 'Slow down'  
  });  
}  

recent.push(now);  
hits.set(userId, recent);  

req.user = data.user;  
req.db = db;  

next();

} catch (e) {
console.error('Auth error:', e?.message || e);

return res.status(401).json({  
  error: 'Invalid session'  
});

}
}

// Assistant identity and behavior
const PERSONA = `
IDENTITY — HIGHEST PRIORITY:

Your name is Sambhav AI.

Your creator and owner is Sambhav.
Sambhav is the human developer who created and owns this assistant.

You are NOT Google Gemini.
You are NOT Google's assistant.
Google provides the Gemini AI technology used as your underlying model.

Never confuse your creator with your underlying model provider.

IDENTITY ANSWERS:

If asked "Who made you?" or "Who created you?":
Say: "I was created by Sambhav."

If asked "Who is your owner?":
Say: "My owner is Sambhav, who built me."

If asked "Are you made by Google?":
Say: "No, I'm Sambhav AI, built by Sambhav. I use Google's Gemini technology."

If asked "What is your name?":
Say: "I'm Sambhav AI."

Do not claim Google created or owns Sambhav AI.

PERSONALITY:

You are a warm, intelligent, sharp and natural personal voice assistant.
Speak naturally and confidently.
Keep spoken replies concise.
Use Hindi, English or Hinglish depending on the user.
Mirror the user's language and speaking style.
Ask at most one question at a time.

MEMORY:

Use save_memory for lasting, non-sensitive facts or preferences
the user clearly wants remembered.
Use recall_memory when the user refers to past details.
Never claim a memory was saved unless the tool succeeds.

SEARCH:

Use web_search for current information when needed.
Never claim you searched unless the tool succeeds.

Be honest, helpful, confident and conversational.
`;

// Function declarations
const TOOLS = [
{
functionDeclarations: [
{
name: 'save_memory',
description:
'Save a lasting, non-sensitive personal fact or preference.',
parameters: {
type: 'OBJECT',
properties: {
content: {
type: 'STRING',
description: 'One short self-contained sentence.'
}
},
required: ['content']
}
},
{
name: 'recall_memory',
description:
'Search the user memories for a particular topic.',
parameters: {
type: 'OBJECT',
properties: {
query: { type: 'STRING' }
},
required: ['query']
}
},
...(TAVILY_API_KEY
? [{
name: 'web_search',
description:
'Search the internet for current or factual information.',
parameters: {
type: 'OBJECT',
properties: {
query: { type: 'STRING' }
},
required: ['query']
}
}]
: [])
]
}
];

// Fetch and cache conversation context
async function getUserContext(userId, db) {
const cached = contextCache.get(userId);

if (cached && Date.now() - cached.time < CACHE_TTL) {
return cached.value;
}

const [memResult, msgResult] = await Promise.all([
db
.from('memories')
.select('content')
.order('created_at', { ascending: false })
.limit(30),

db  
  .from('messages')  
  .select('role,content')  
  .order('created_at', { ascending: false })  
  .limit(12)

]);

if (memResult.error) {
console.error('Memory fetch:', memResult.error.message);
}

if (msgResult.error) {
console.error('Message fetch:', msgResult.error.message);
}

const memories = memResult.data || [];
const messages = msgResult.data || [];

const context =
${PERSONA}\nToday is ${new Date().toDateString()}. +

(memories.length  
  ? `\nUser memories:\n- ${  
      memories.map(m => m.content).join('\n- ')  
    }`  
  : '') +  

(messages.length  
  ? `\nRecent conversation:\n${  
      messages.reverse()  
        .map(m => `${m.role}: ${m.content}`)  
        .join('\n')  
    }`  
  : '');

contextCache.set(userId, {
time: Date.now(),
value: context
});

trimCache();

return context;
}

// Frontend configuration
app.get('/api/config', (_req, res) => {
res.set('Cache-Control', 'no-store');

res.json({
supabaseUrl: SUPABASE_URL || '',
supabaseAnonKey: SUPABASE_ANON_KEY || '',
search: !!TAVILY_API_KEY
});
});

// Gemini Live temporary token
app.post('/api/live-token', auth, async (req, res) => {
res.set('Cache-Control', 'no-store');

try {
if (!gemini) {
return res.status(500).json({
error: 'GEMINI_API_KEY not set'
});
}

const systemInstruction = await getUserContext(  
  req.user.id,  
  req.db  
);  

const config = {  
  responseModalities: ['AUDIO'],  

  systemInstruction,  

  speechConfig: {  
    voiceConfig: {  
      prebuiltVoiceConfig: {  
        voiceName: VOICE  
      }  
    }  
  },  

  inputAudioTranscription: {},  
  outputAudioTranscription: {},  

  tools: TOOLS,  

  realtimeInputConfig: {  
    automaticActivityDetection: {  
      disabled: false  
    }  
  }  
};  

const token = await gemini.authTokens.create({  
  config: {  
    uses: 1,  

    expireTime: new Date(  
      Date.now() + 30 * 60 * 1000  
    ).toISOString(),  

    newSessionExpireTime: new Date(  
      Date.now() + 60 * 1000  
    ).toISOString(),  

    liveConnectConstraints: {  
      model: MODEL,  
      config  
    },  

    httpOptions: {  
      apiVersion: 'v1alpha'  
    }  
  }  
});  

return res.json({  
  token: token.name,  
  model: MODEL,  
  config  
});

} catch (e) {
console.error(
'Token creation error:',
e?.message || e
);

return res.status(502).json({  
  error: 'Could not create Live token'  
});

}
});

// Gemini function execution
app.post('/api/tool', auth, async (req, res) => {
const { name, args = {} } = req.body || {};

try {
// Save memory
if (name === 'save_memory') {
const content = String(args.content || '')
.trim()
.slice(0, 500);

if (!content) {  
    return res.json({  
      ok: false,  
      error: 'empty'  
    });  
  }  

  const { error } = await req.db  
    .from('memories')  
    .insert({ content });  

  if (error) {  
    console.error('Save memory:', error.message);  

    return res.json({  
      ok: false,  
      error: 'memory save failed'  
    });  
  }  

  clearUserCache(req.user.id);  

  return res.json({  
    ok: true  
  });  
}  

// Recall memory  
if (name === 'recall_memory') {  
  const query = String(args.query || '')  
    .replace(/[%,()]/g, ' ')  
    .trim()  
    .slice(0, 80);  

  if (!query) {  
    return res.json({  
      ok: true,  
      memories: []  
    });  
  }  

  const { data, error } = await req.db  
    .from('memories')  
    .select('content,created_at')  
    .ilike('content', `%${query}%`)  
    .order('created_at', { ascending: false })  
    .limit(8);  

  if (error) {  
    console.error('Recall memory:', error.message);  

    return res.json({  
      ok: false,  
      error: 'memory lookup failed'  
    });  
  }  

  return res.json({  
    ok: true,  
    memories: data || []  
  });  
}  

// Web search  
if (name === 'web_search' && TAVILY_API_KEY) {  
  const query = String(args.query || '')  
    .trim()  
    .slice(0, 300);  

  if (!query) {  
    return res.json({  
      ok: false,  
      error: 'empty query'  
    });  
  }  

  const response = await fetch(  
    'https://api.tavily.com/search',  
    {  
      method: 'POST',  

      headers: {  
        'Content-Type': 'application/json',  
        Authorization: `Bearer ${TAVILY_API_KEY}`  
      },  

      body: JSON.stringify({  
        query,  
        max_results: 4,  
        include_answer: true  
      }),  

      signal: AbortSignal.timeout(12000)  
    }  
  );  

  if (!response.ok) {  
    return res.json({  
      ok: false,  
      error: `search ${response.status}`  
    });  
  }  

  const result = await response.json();  

  return res.json({  
    ok: true,  
    answer: result.answer || '',  
    results: (result.results || []).map(item => ({  
      title: item.title,  
      url: item.url,  
      content: (item.content || '').slice(0, 400)  
    }))  
  });  
}  

return res.status(400).json({  
  ok: false,  
  error: 'unknown tool'  
});

} catch (e) {
console.error(
'Tool execution error:',
e?.message || e
);

return res.status(500).json({  
  ok: false,  
  error: 'tool failed'  
});

}
});

// Serve frontend
app.use(express.static(dist));

app.get('*', (_req, res) => {
res.sendFile(path.join(dist, 'index.html'));
});

// Clean rate-limit entries
setInterval(() => {
const now = Date.now();

for (const [id, times] of hits) {
const active = times.filter(
t => now - t < 60000
);

if (active.length) {  
  hits.set(id, active);  
} else {  
  hits.delete(id);  
}

}
}, 60000).unref();

// Start server
app.listen(PORT, () => {
console.log(Sambhav AI running on port ${PORT});
});