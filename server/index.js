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

const DEFAULT_VOICE = process.env.GEMINI_VOICE || 'Aoede';
const OWNER_NAME = 'Sambhav Gupta';
const PORT = process.env.PORT || 8787;
const CACHE_TTL = 20000;
const MAX_CACHE_ENTRIES = 500;

const VOICES = {
  female: 'Aoede',
  male: 'Puck',
  Aoede: 'Aoede',
  Puck: 'Puck'
};

const dist = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'dist'
);

const app = express();

app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));

const gemini = GEMINI_API_KEY
  ? new GoogleGenAI({
      apiKey: GEMINI_API_KEY,
      httpOptions: { apiVersion: 'v1alpha' }
    })
  : null;

const contextCache = new Map();
const hits = new Map();

function dbFor(jwt) {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: {
      headers: { Authorization: `Bearer ${jwt}` }
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
  while (contextCache.size > MAX_CACHE_ENTRIES) {
    const oldest = contextCache.keys().next().value;
    if (!oldest) break;
    contextCache.delete(oldest);
  }
}

function getBearer(req) {
  const value = req.headers.authorization || '';
  return value.startsWith('Bearer ') ? value.slice(7) : '';
}

async function auth(req, res, next) {
  try {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
      return res.status(500).json({ error: 'Supabase is not configured.' });
    }

    const jwt = getBearer(req);
    if (!jwt) {
      return res.status(401).json({ error: 'Authentication required.' });
    }

    const db = dbFor(jwt);
    const { data, error } = await db.auth.getUser();

    if (error || !data?.user) {
      return res.status(401).json({ error: 'Your session has expired.' });
    }

    const userId = data.user.id;
    const now = Date.now();
    const previous = hits.get(userId) || [];
    const recent = previous.filter(time => now - time < 60000);

    if (recent.length >= 30) {
      return res.status(429).json({ error: 'Too many requests. Try again shortly.' });
    }

    recent.push(now);
    hits.set(userId, recent);

    req.jwt = jwt;
    req.user = data.user;
    req.db = db;

    next();
  } catch (error) {
    console.error('Authentication error:', error);
    res.status(500).json({ error: 'Authentication failed.' });
  }
}

const PERSONA = `
You are Sambhav AI, a personal real-time voice assistant.

IDENTITY — ALWAYS FOLLOW:
- Your name is Sambhav AI.
- You were created by and your owner is Sambhav Gupta.
- If asked "Who made you?", "Who created you?", "Who is your owner?" or similar, answer clearly: "I was created by Sambhav Gupta."
- Never claim that Google, Gemini, or another company is your owner or creator.
- Gemini is the underlying AI technology you use. It is not your owner.
- Do not invent another creator, owner, company, or backstory.

PERSONALITY:
- Sound natural, warm, confident, helpful and conversational.
- Speak like a real-time assistant, not like a formal article.
- Keep spoken answers concise unless the user asks for detail.
- Understand English, Hindi and Hinglish. Reply in the language the user uses.
- Avoid repeatedly introducing yourself.
- Do not say that you are searching or remembering unless you are actually using the relevant tool.

MEMORY:
- Use save_memory when the user explicitly asks you to remember a useful personal preference or fact.
- Use recall_memory when a remembered detail would materially help answer the user.
- Never claim to have saved something unless the tool confirms it.

WEB:
- Use web_search when the user asks for current information or when freshness matters.
- Clearly distinguish verified information from uncertainty.

VOICE:
- Your output is intended to be spoken aloud.
- Avoid markdown tables, excessive symbols, and long lists in spoken replies.
`;

const toolDeclarations = [
  {
    name: 'save_memory',
    description: 'Save a useful fact or preference the user explicitly wants remembered.',
    parameters: {
      type: 'OBJECT',
      properties: {
        content: {
          type: 'STRING',
          description: 'The memory to save.'
        }
      },
      required: ['content']
    }
  },
  {
    name: 'recall_memory',
    description: 'Retrieve saved memories relevant to the user request.',
    parameters: {
      type: 'OBJECT',
      properties: {
        query: {
          type: 'STRING',
          description: 'What memory or information to look for.'
        }
      },
      required: ['query']
    }
  },
  {
    name: 'web_search',
    description: 'Search the web for current information using Tavily.',
    parameters: {
      type: 'OBJECT',
      properties: {
        query: {
          type: 'STRING',
          description: 'The search query.'
        }
      },
      required: ['query']
    }
  }
];

async function getUserContext(userId, db) {
  const cached = contextCache.get(userId);

  if (cached && Date.now() - cached.time < CACHE_TTL) {
    return cached.value;
  }

  const [memoryResult, messageResult] = await Promise.all([
    db
      .from('memories')
      .select('content,created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(30),

    db
      .from('messages')
      .select('role,content,created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(12)
  ]);

  if (memoryResult.error) {
    console.error('Memory context error:', memoryResult.error.message);
  }

  if (messageResult.error) {
    console.error('Chat context error:', messageResult.error.message);
  }

  const memories = (memoryResult.data || [])
    .map(item => item.content)
    .filter(Boolean);

  const messages = (messageResult.data || [])
    .reverse()
    .map(item => `${item.role}: ${item.content}`)
    .filter(Boolean);

  const value = [
    memories.length
      ? `USER MEMORIES:\n${memories.map(x => `- ${x}`).join('\n')}`
      : 'No saved memories yet.',
    messages.length
      ? `RECENT CONVERSATION:\n${messages.join('\n')}`
      : 'No recent conversation history.'
  ].join('\n\n');

  contextCache.set(userId, { time: Date.now(), value });
  trimCache();

  return value;
}

async function saveMemory(req, content) {
  const clean = String(content || '').trim().slice(0, 2000);

  if (!clean) {
    return { ok: false, message: 'Memory was empty.' };
  }

  const { error } = await req.db.from('memories').insert({
    user_id: req.user.id,
    content: clean
  });

  if (error) {
    console.error('Save memory error:', error);
    return { ok: false, message: 'I could not save that memory.' };
  }

  clearUserCache(req.user.id);

  return { ok: true, message: 'Memory saved.' };
}

async function recallMemory(req, query) {
  const clean = String(query || '').trim();

  const { data, error } = await req.db
    .from('memories')
    .select('content,created_at')
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: false })
    .limit(30);

  if (error) {
    console.error('Recall memory error:', error);
    return { ok: false, memories: [] };
  }

  const memories = data || [];

  if (!clean) {
    return { ok: true, memories };
  }

  const words = clean.toLowerCase().split(/\s+/).filter(Boolean);
  const ranked = memories
    .map(item => {
      const text = item.content.toLowerCase();
      const score = words.reduce(
        (total, word) => total + (text.includes(word) ? 1 : 0),
        0
      );
      return { ...item, score };
    })
    .sort((a, b) => b.score - a.score);

  return {
    ok: true,
    memories: ranked.slice(0, 8).map(({ content, created_at }) => ({
      content,
      created_at
    }))
  };
}

async function webSearch(query) {
  if (!TAVILY_API_KEY) {
    return { ok: false, message: 'Web search is not configured.' };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);

  try {
    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        api_key: TAVILY_API_KEY,
        query: String(query || '').slice(0, 500),
        search_depth: 'basic',
        max_results: 5,
        include_answer: true
      })
    });

    if (!response.ok) {
      throw new Error(`Tavily returned ${response.status}`);
    }

    const data = await response.json();

    return {
      ok: true,
      answer: data.answer || '',
      results: (data.results || []).map(item => ({
        title: item.title,
        url: item.url,
        content: item.content
      }))
    };
  } catch (error) {
    console.error('Web search error:', error);
    return { ok: false, message: 'Web search failed or timed out.' };
  } finally {
    clearTimeout(timeout);
  }
}

function resolveVoice(input) {
  const requested = String(input || '').trim();
  return VOICES[requested] || VOICES[DEFAULT_VOICE] || 'Aoede';
}

app.get('/api/config', (req, res) => {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return res.status(500).json({ error: 'Supabase is not configured.' });
  }

  res.json({
    supabaseUrl: SUPABASE_URL,
    supabaseAnonKey: SUPABASE_ANON_KEY,
    searchEnabled: Boolean(TAVILY_API_KEY),
    owner: OWNER_NAME
  });
});

app.post('/api/live-token', auth, async (req, res) => {
  try {
    if (!gemini) {
      return res.status(500).json({ error: 'Gemini is not configured.' });
    }

    const voice = resolveVoice(req.body?.voice);
    const userContext = await getUserContext(req.user.id, req.db);

    const config = {
      responseModalities: ['AUDIO'],

      systemInstruction: {
        parts: [
          {
            text: `${PERSONA}\n\n${userContext}\n\nRemember: your creator and owner is ${OWNER_NAME}.`
          }
        ]
      },

      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: {
            voiceName: voice
          }
        }
      },

      inputAudioTranscription: {},
      outputAudioTranscription: {},

      tools: [
        {
          functionDeclarations: toolDeclarations
        }
      ],

      realtimeInputConfig: {
        automaticActivityDetection: {
          disabled: false,
          startOfSpeechSensitivity: 'START_SENSITIVITY_LOW',
          endOfSpeechSensitivity: 'END_SENSITIVITY_LOW',
          prefixPaddingMs: 20,
          silenceDurationMs: 350
        }
      }
    };

    const token = await gemini.authTokens.create({
      config: {
        uses: 1,
        expireTime: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        newSessionExpireTime: new Date(Date.now() + 60 * 1000).toISOString(),
        liveConnectConstraints: {
          model: MODEL,
          config
        }
      }
    });

    res.json({
      token: token.name,
      model: MODEL,
      voice,
      config
    });
  } catch (error) {
    console.error('Live token error:', error);
    res.status(500).json({
      error: 'Could not start the live session.',
      detail: process.env.NODE_ENV === 'development'
        ? error.message
        : undefined
    });
  }
});

app.post('/api/tool', auth, async (req, res) => {
  try {
    const name = req.body?.name || req.body?.toolName;
    const args = req.body?.args || req.body?.arguments || {};

    let result;

    if (name === 'save_memory') {
      result = await saveMemory(req, args.content);
    } else if (name === 'recall_memory') {
      result = await recallMemory(req, args.query);
    } else if (name === 'web_search') {
      result = await webSearch(args.query);
    } else {
      return res.status(400).json({ error: 'Unknown tool.' });
    }

    res.json({ result });
  } catch (error) {
    console.error('Tool error:', error);
    res.status(500).json({ error: 'Tool execution failed.' });
  }
});

app.use(express.static(dist, {
  extensions: ['html'],
  maxAge: '1h'
}));

app.get('*', (req, res) => {
  res.sendFile(path.join(dist, 'index.html'));
});

setInterval(() => {
  const now = Date.now();

  for (const [userId, times] of hits) {
    const recent = times.filter(time => now - time < 60000);
    if (recent.length) hits.set(userId, recent);
    else hits.delete(userId);
  }

  for (const [userId, item] of contextCache) {
    if (now - item.time > CACHE_TTL * 5) {
      contextCache.delete(userId);
    }
  }
}, 60000).unref();

app.listen(PORT, () => {
  console.log(`Sambhav AI server listening on ${PORT}`);
});