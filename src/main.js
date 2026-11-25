import * as THREE from 'three';
import { createClient } from '@supabase/supabase-js';
import { Live } from './live.js';

/* =========================
   CONFIG
========================= */

const $ = (id) => document.getElementById(id);

const els = {
  canvas: $('gl'),
  error: $('err'),
  status: $('status'),
  caption: $('cap'),
  mic: $('mic'),
  auth: $('auth'),
  authMail: $('am'),
  authPass: $('pw'),
  signIn: $('su'),
  end: $('end'),
  mute: $('mute'),
  transcript: $('tb'),
  ui: $('ui'),
  signOut: $('so')
};

let sb = null;
let live = null;
let convId = null;
let currentMode = 'idle';
let transcriptVisible = true;
let muted = false;
let selectedVoice = localStorage.getItem('sambhav_voice') || 'Aoede';

const VOICES = [
  { name: 'Aoede', label: 'Female · Soft' },
  { name: 'Kore', label: 'Female · Clear' },
  { name: 'Puck', label: 'Male · Natural' },
  { name: 'Charon', label: 'Male · Deep' },
  { name: 'Fenrir', label: 'Male · Bold' }
];

/* =========================
   UI HELPERS
========================= */

function showError(message) {
  if (!els.error) return;
  els.error.textContent = message;
  els.error.classList.add('show');

  setTimeout(() => {
    els.error.classList.remove('show');
  }, 5000);
}

function setStatus(mode) {
  currentMode = mode;

  const labels = {
    idle: 'Tap to talk',
    connecting: 'Connecting…',
    listening: 'Listening',
    thinking: 'Thinking',
    speaking: 'Speaking',
    error: 'Something went wrong'
  };

  if (els.status) {
    els.status.textContent = labels[mode] || mode;
  }

  document.body.dataset.state = mode;
}

function setCaption(text) {
  if (!els.caption) return;
  els.caption.textContent = text || '';
}

function setButtonState(button, active) {
  if (!button) return;
  button.classList.toggle('active', Boolean(active));
  button.setAttribute('aria-pressed', String(Boolean(active)));
}

/* =========================
   VOICE SELECTOR
========================= */

function createVoiceSelector() {
  if (document.getElementById('voiceSelect')) return;

  const header = document.querySelector('.topbar') ||
                 document.querySelector('header') ||
                 els.ui;

  if (!header) return;

  const wrapper = document.createElement('div');
  wrapper.className = 'voice-control';

  wrapper.innerHTML = `
    <label for="voiceSelect">VOICE</label>
    <select id="voiceSelect" aria-label="Choose assistant voice">
      ${VOICES.map(voice => `
        <option value="${voice.name}">
          ${voice.label}
        </option>
      `).join('')}
    </select>
  `;

  header.appendChild(wrapper);

  const select = $('voiceSelect');
  select.value = selectedVoice;

  select.addEventListener('change', () => {
    selectedVoice = select.value;
    localStorage.setItem('sambhav_voice', selectedVoice);

    if (currentMode !== 'idle') {
      showError('Voice changed. End this conversation and reconnect to apply it.');
    }
  });
}

/* =========================
   SUPABASE
========================= */

async function initializeSupabase() {
  try {
    const response = await fetch('/api/config');

    if (!response.ok) {
      throw new Error('Could not load app configuration.');
    }

    const config = await response.json();

    if (!config.supabaseUrl || !config.supabaseAnonKey) {
      throw new Error('Supabase configuration is missing.');
    }

    sb = createClient(
      config.supabaseUrl,
      config.supabaseAnonKey
    );

    const { data: { session }, error } = await sb.auth.getSession();

    if (error) throw error;

    updateAuthUI(session);

    sb.auth.onAuthStateChange((_event, session) => {
      updateAuthUI(session);
    });

  } catch (error) {
    showError(error.message || 'Authentication setup failed.');
  }
}

function updateAuthUI(session) {
  const loggedIn = Boolean(session);

  if (els.auth) {
    els.auth.style.display = loggedIn ? 'none' : 'flex';
  }

  if (els.ui) {
    els.ui.style.display = loggedIn ? 'flex' : 'none';
  }
}

async function getJWT() {
  if (!sb) return null;

  const { data, error } = await sb.auth.getSession();

  if (error) throw error;

  return data.session?.access_token || null;
}

async function signIn() {
  if (!sb) {
    showError('Authentication is not ready yet.');
    return;
  }

  const email = els.authMail?.value?.trim();
  const password = els.authPass?.value;

  if (!email || !password) {
    showError('Enter your email and password.');
    return;
  }

  if (els.signIn) els.signIn.disabled = true;

  try {
    const { error } = await sb.auth.signInWithPassword({
      email,
      password
    });

    if (error) throw error;

  } catch (error) {
    showError(error.message || 'Sign in failed.');
  } finally {
    if (els.signIn) els.signIn.disabled = false;
  }
}

async function signOut() {
  if (live) await stopLive();

  if (sb) {
    const { error } = await sb.auth.signOut();
    if (error) showError(error.message);
  }

  convId = null;
}

/* =========================
   CHAT STORAGE
========================= */

async function saveMessage(role, content) {
  if (!sb || !content) return;

  try {
    const { data: { session } } = await sb.auth.getSession();

    if (!session) return;

    if (!convId) {
      const { data, error } = await sb
        .from('conversations')
        .insert({
          user_id: session.user.id,
          title: String(content).slice(0, 70)
        })
        .select('id')
        .single();

      if (error) throw error;

      convId = data.id;
    }

    const { error } = await sb
      .from('messages')
      .insert({
        conversation_id: convId,
        role,
        content
      });

    if (error) throw error;

  } catch (error) {
    console.warn('Message save failed:', error.message);
  }
}

/* =========================
   LIVE CONNECTION
========================= */

async function startLive() {
  if (currentMode !== 'idle') return;

  try {
    setStatus('connecting');
    setCaption('Connecting to Sambhav AI…');

    const token = await getJWT();

    if (!token) {
      setStatus('idle');
      showError('Please sign in first.');
      return;
    }

    live = new Live({
      jwt: getJWT,
      save: saveMessage,
      mode: setStatus,
      state: setStatus,
      transcript: handleTranscript,
      error: showError,
      voice: selectedVoice
    });

    await live.start();

    setStatus('listening');
    setCaption('I’m listening. Speak naturally.');

    setButtonState(els.mute, false);
    setButtonState(els.mic, true);

  } catch (error) {
    console.error(error);

    setStatus('idle');
    setCaption('');
    showError(error.message || 'Could not start voice conversation.');

    live = null;
  }
}

async function stopLive() {
  if (!live) {
    setStatus('idle');
    return;
  }

  try {
    await live.stop();
  } catch (error) {
    console.warn('Stop error:', error);
  }

  live = null;
  muted = false;

  setButtonState(els.mic, false);
  setButtonState(els.mute, false);

  setStatus('idle');
  setCaption('Tap to talk');
}

function handleTranscript(data) {
  if (!data) return;

  if (typeof data === 'string') {
    setCaption(data);
    return;
  }

  const text = data.text || data.transcript || data.content;

  if (text) setCaption(text);
}

/* =========================
   CONTROLS
========================= */

els.mic?.addEventListener('click', async () => {
  if (currentMode === 'idle') {
    await startLive();
    return;
  }

  if (live) {
    try {
      await live.interrupt();
      setCaption('Interrupted. I’m listening.');
    } catch (error) {
      showError(error.message);
    }
  }
});

els.end?.addEventListener('click', stopLive);

els.mute?.addEventListener('click', () => {
  if (!live) {
    showError('Start a conversation first.');
    return;
  }

  muted = !muted;

  live.setMuted(muted);

  setButtonState(els.mute, muted);
  setCaption(muted ? 'Microphone muted' : 'Microphone on');
});

els.transcript?.addEventListener('click', () => {
  transcriptVisible = !transcriptVisible;

  if (els.caption) {
    els.caption.style.display = transcriptVisible ? '' : 'none';
  }

  setButtonState(els.transcript, transcriptVisible);
});

els.signIn?.addEventListener('click', signIn);
els.signOut?.addEventListener('click', signOut);

els.authPass?.addEventListener('keydown', event => {
  if (event.key === 'Enter') signIn();
});

/* =========================
   THREE.JS ORB
========================= */

let renderer;
let scene;
let camera;
let orb;
let orbMaterial;
let clock;

let audioLevel = 0;
let targetLevel = 0;

function initializeOrb() {
  if (!els.canvas) return;

  try {
    renderer = new THREE.WebGLRenderer({
      canvas: els.canvas,
      alpha: true,
      antialias: true,
      powerPreference: 'high-performance'
    });

    renderer.setPixelRatio(
      Math.min(window.devicePixelRatio || 1, 1.75)
    );

    renderer.setSize(
      window.innerWidth,
      window.innerHeight
    );

    scene = new THREE.Scene();

    camera = new THREE.PerspectiveCamera(
      45,
      window.innerWidth / window.innerHeight,
      0.1,
      100
    );

    camera.position.z = 4.5;

    clock = new THREE.Clock();

    const geometry = new THREE.IcosahedronGeometry(1, 64);

    orbMaterial = new THREE.MeshPhysicalMaterial({
      color: 0xaaa6ff,
      metalness: 0.35,
      roughness: 0.16,
      transmission: 0.65,
      thickness: 1.5,
      clearcoat: 1,
      clearcoatRoughness: 0.12,
      iridescence: 0.8,
      iridescenceIOR: 1.3,
      emissive: 0x21165e,
      emissiveIntensity: 0.45
    });

    orb = new THREE.Mesh(geometry, orbMaterial);
    scene.add(orb);

    const light1 = new THREE.PointLight(0x8d7aff, 30, 10);
    light1.position.set(2, 2, 3);
    scene.add(light1);

    const light2 = new THREE.PointLight(0x4c9fff, 18, 10);
    light2.position.set(-2, -1, 2);
    scene.add(light2);

    const ambient = new THREE.AmbientLight(0xffffff, 0.8);
    scene.add(ambient);

    window.addEventListener('resize', resizeOrb);

    animateOrb();

  } catch (error) {
    console.error('Orb initialization failed:', error);
    showError('Graphics could not be initialized.');
  }
}

function resizeOrb() {
  if (!renderer || !camera) return;

  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();

  renderer.setSize(
    window.innerWidth,
    window.innerHeight
  );
}

function animateOrb() {
  requestAnimationFrame(animateOrb);

  if (!renderer || !scene || !camera || !orb) return;

  const time = clock.getElapsedTime();

  if (live) {
    const mic = live.mic?.() || 0;
    const output = live.out?.() || 0;

    targetLevel = Math.max(mic, output);
  } else {
    targetLevel = 0;
  }

  audioLevel += (targetLevel - audioLevel) * 0.14;

  const pulse = 1 + audioLevel * 0.28;

  orb.scale.setScalar(pulse);

  orb.rotation.y = time * 0.12;
  orb.rotation.x = Math.sin(time * 0.22) * 0.08;

  if (orbMaterial) {
    const speaking = currentMode === 'speaking';
    const thinking = currentMode === 'thinking';

    orbMaterial.emissiveIntensity =
      speaking ? 0.8 + audioLevel * 0.8 :
      thinking ? 0.75 :
      0.4 + audioLevel * 0.3;

    if (speaking) {
      orbMaterial.color.setHex(0xb7a7ff);
    } else if (thinking) {
      orbMaterial.color.setHex(0x8c9dff);
    } else {
      orbMaterial.color.setHex(0xaaa6ff);
    }
  }

  renderer.render(scene, camera);
}

/* =========================
   START APP
========================= */

createVoiceSelector();
initializeOrb();
initializeSupabase();

/* =========================
   KEYBOARD SHORTCUTS
========================= */

document.addEventListener('keydown', event => {
  if (event.target.matches('input, textarea, select')) return;

  if (event.code === 'Escape' && live) {
    stopLive();
  }
});

/* =========================
   CLEANUP
========================= */

window.addEventListener('beforeunload', () => {
  if (live) {
    live.stop();
  }

  if (renderer) {
    renderer.dispose();
  }
});