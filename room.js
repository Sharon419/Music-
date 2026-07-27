// room.js — everything that happens once you're inside a room.

const params = new URLSearchParams(location.search);
const code = (params.get('code') || '').toUpperCase();
if (!code) location.href = '/';

const els = {
  joinGate: document.getElementById('joinGate'),
  gateName: document.getElementById('gateName'),
  gatePassword: document.getElementById('gatePassword'),
  gateError: document.getElementById('gateError'),
  gateJoinBtn: document.getElementById('gateJoinBtn'),
  roomShell: document.getElementById('roomShell'),
  roomCodeBadge: document.getElementById('roomCodeBadge'),
  copyCodeBtn: document.getElementById('copyCodeBtn'),
  copyLinkBtn: document.getElementById('copyLinkBtn'),
  qrImg: document.getElementById('qrImg'),
  hostUploadPanel: document.getElementById('hostUploadPanel'),
  fileInput: document.getElementById('fileInput'),
  noTrackMsg: document.getElementById('noTrackMsg'),
  nowPlayingHead: document.getElementById('nowPlayingHead'),
  coverArt: document.getElementById('coverArt'),
  trackTitle: document.getElementById('trackTitle'),
  trackSub: document.getElementById('trackSub'),
  bars: document.getElementById('bars'),
  timeElapsed: document.getElementById('timeElapsed'),
  timeRemaining: document.getElementById('timeRemaining'),
  progressTrack: document.getElementById('progressTrack'),
  progressFill: document.getElementById('progressFill'),
  favBtn: document.getElementById('favBtn'),
  restartBtn: document.getElementById('restartBtn'),
  playToggleBtn: document.getElementById('playToggleBtn'),
  skipBtn: document.getElementById('skipBtn'),
  countdown: document.getElementById('countdown'),
  volSlider: document.getElementById('volSlider'),
  statusLine: document.getElementById('statusLine'),
  readyBtn: document.getElementById('readyBtn'),
  playlistPanel: document.getElementById('playlistPanel'),
  playlistList: document.getElementById('playlistList'),
  memberList: document.getElementById('memberList'),
  lockRow: document.getElementById('lockRow'),
  lockToggle: document.getElementById('lockToggle'),
  chatLog: document.getElementById('chatLog'),
  chatInput: document.getElementById('chatInput'),
  chatSendBtn: document.getElementById('chatSendBtn'),
  player: document.getElementById('player'),
  toast: document.getElementById('toast'),
};

for (let i = 0; i < 28; i++) {
  const s = document.createElement('span');
  els.bars.appendChild(s);
}
const barEls = Array.from(els.bars.children);

let state = {
  name: sessionStorage.getItem('syncsound:name') || '',
  hostToken: sessionStorage.getItem(`syncsound:hostToken:${code}`) || null,
  joinPassword: sessionStorage.getItem('syncsound:joinPassword') || null,
  isHost: false,
  members: [],
  playlist: [],
  currentTrackIndex: -1,
  clockOffset: 0, // add to Date.now() to estimate the server's clock
  hasMarkedReady: false,
  isPlaying: false,
  favorites: new Set(), // track names favorited this session (not persisted)
};
sessionStorage.removeItem('syncsound:joinPassword'); // one-time use

let socket = null;
let audioCtx = null;
let analyser = null;
let dataArr = null;
let sourceConnected = false;
let currentBlobUrl = null; // object URL for the fully-downloaded track, revoked on track change
let trackLoadToken = 0;    // bumped every time a new track starts loading, so a slow
                           // download that finishes late can tell it's been superseded
let driftTimer = null;
let pendingAnchor = null; // { localTime, position } — the reference point drift correction checks against

els.roomCodeBadge.textContent = code;

// ---------------------------------------------------------------------------
// Join flow
// ---------------------------------------------------------------------------

function connectAndJoin(name, password) {
  socket = io();

  socket.on('connect', () => {
    syncClock(() => {
      socket.emit(
        'join-room',
        { code, name, password, hostToken: state.hostToken },
        (res) => {
          if (!res.ok) {
            showGateError(res.error || 'Could not join room');
            return;
          }
          state.isHost = res.isHost;
          state.members = res.members;
          state.playlist = res.playlist || [];
          onJoined(res.track);
        }
      );
    });
  });

  wireSocketEvents();
}

function showGateError(msg) {
  els.gateError.textContent = msg;
  els.gateError.style.display = 'block';
}

els.gateJoinBtn.addEventListener('click', () => {
  const name = els.gateName.value.trim();
  if (!name) return showGateError('Enter a name to join');
  state.name = name;
  connectAndJoin(name, els.gatePassword.value);
});

if (state.name) {
  connectAndJoin(state.name, state.joinPassword);
} else {
  els.joinGate.style.display = 'flex';
}

function setHostControlsVisible(visible) {
  els.hostUploadPanel.style.display = visible ? 'block' : 'none';
  els.lockRow.style.display = visible ? 'flex' : 'none';
  els.restartBtn.disabled = !visible;
  els.skipBtn.disabled = !visible;
  els.progressTrack.classList.toggle('seekable', visible);
}

function onJoined(track) {
  els.joinGate.style.display = 'none';
  els.roomShell.classList.add('ready');
  els.roomShell.style.display = 'grid';

  setHostControlsVisible(state.isHost);

  fetch(`/api/rooms/${encodeURIComponent(code)}/qr`)
    .then((r) => r.json())
    .then((d) => { if (d.dataUrl) els.qrImg.src = d.dataUrl; })
    .catch(() => {});

  renderMembers();
  applyTrack(track, state.playlist, -1);
}

// ---------------------------------------------------------------------------
// Copy code / invite link
// ---------------------------------------------------------------------------

function showToast(msg) {
  els.toast.textContent = msg;
  els.toast.classList.add('show');
  setTimeout(() => els.toast.classList.remove('show'), 1600);
}

async function copyText(text, successMsg) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (err) {
    // Clipboard API can fail in insecure contexts / some in-app browsers.
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) { /* give up quietly */ }
    document.body.removeChild(ta);
  }
  showToast(successMsg);
}

els.copyCodeBtn.addEventListener('click', () => copyText(code, 'Room code copied'));
els.copyLinkBtn.addEventListener('click', () => {
  const link = `${location.origin}/index.html?code=${encodeURIComponent(code)}`;
  copyText(link, 'Invite link copied');
});

// ---------------------------------------------------------------------------
// Clock sync — a small NTP-style handshake so a server timestamp can be
// translated into "when that is on my device's clock".
// ---------------------------------------------------------------------------

function syncClock(done) {
  let best = null;
  let rounds = 0;
  const totalRounds = 5;

  function nextRound() {
    const t0 = Date.now();
    socket.emit('time-sync', t0, (serverTime) => {
      const t1 = Date.now();
      const rtt = t1 - t0;
      const estimatedServerNow = serverTime + rtt / 2;
      const offset = estimatedServerNow - t1;
      if (!best || rtt < best.rtt) best = { rtt, offset };
      rounds++;
      if (rounds < totalRounds) {
        nextRound();
      } else {
        state.clockOffset = best.offset;
        done();
      }
    });
  }
  nextRound();
}

// ---------------------------------------------------------------------------
// Socket events
// ---------------------------------------------------------------------------

function wireSocketEvents() {
  socket.on('member-update', ({ members }) => {
    state.members = members;
    const me = members.find((m) => m.id === socket.id);
    if (me) {
      const wasHost = state.isHost;
      state.isHost = me.isHost;
      if (state.isHost !== wasHost) setHostControlsVisible(state.isHost);
    }
    renderMembers();
    updatePlayAvailability();
  });

  socket.on('track', ({ track, playlist, currentTrackIndex }) => {
    state.hasMarkedReady = false;
    applyTrack(track, playlist, currentTrackIndex);
  });

  socket.on('play', ({ startAt }) => scheduleAt(startAt, () =>
    attemptPlay({ localTime: startAt - state.clockOffset, position: 0 })
  ));

  socket.on('pause', () => {
    els.player.pause();
    stopDriftCorrection();
    setStatus('ready', 'paused');
  });

  socket.on('seek', ({ position, startAt }) => scheduleAt(startAt, () => {
    els.player.currentTime = position;
    attemptPlay({ localTime: startAt - state.clockOffset, position });
  }));

  socket.on('room-updated', ({ locked }) => {
    els.lockToggle.checked = locked;
  });

  socket.on('chat-message', ({ name, text }) => addChatLine(name, text));

  socket.on('reaction', ({ emoji }) => floatEmoji(emoji));

  socket.on('kicked', () => {
    alert('You were removed from this room.');
    location.href = '/';
  });

  socket.on('host-changed', () => {
    state.isHost = true;
    setHostControlsVisible(true);
    updatePlayAvailability();
  });
}

function scheduleAt(serverTimestamp, fn) {
  const localTarget = serverTimestamp - state.clockOffset;
  function tick() {
    const remaining = localTarget - Date.now();
    if (remaining <= 0) {
      els.countdown.textContent = '';
      fn();
      return;
    }
    els.countdown.textContent = `starting in ${(remaining / 1000).toFixed(2)}s`;
    requestAnimationFrame(tick);
  }
  tick();
}

// ---------------------------------------------------------------------------
// Playback — the part that actually has to make sound
// ---------------------------------------------------------------------------

// A scheduled play() call (triggered by a socket event, not a click) can be
// silently blocked by browser autoplay rules, and if the audio is routed
// through a suspended Web Audio graph it can also fail *silently* — the
// element looks like it's playing but nothing comes out. This function
// covers both: it resumes the audio graph first, and if play() still gets
// rejected, it falls back to a visible "tap to play" state that a real
// click can always satisfy.
function attemptPlay(anchor) {
  if (anchor) pendingAnchor = anchor;
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => {});
  }
  const playPromise = els.player.play();
  if (playPromise && typeof playPromise.catch === 'function') {
    playPromise
      .then(() => onPlaybackStarted())
      .catch(() => showTapToPlayFallback());
  } else {
    onPlaybackStarted();
  }
}

function onPlaybackStarted() {
  setStatus('playing', 'playing — synced');
  updatePlayToggleIcon(true);
  animateBars();
  startDriftCorrection(pendingAnchor || { localTime: Date.now(), position: els.player.currentTime });
}

// ---------------------------------------------------------------------------
// Drift correction — the initial scheduled play() gets everyone starting
// together, but phone clocks/audio pipelines aren't perfectly locked to wall
// time, so over a few minutes devices can crawl a few dozen ms apart. Every
// couple seconds we compare where this device *should* be (based on the
// original schedule) against where it actually is, and nudge playbackRate
// slightly to correct — a hard currentTime jump only for a big miss, since
// that itself produces an audible click.
// ---------------------------------------------------------------------------

function startDriftCorrection(anchor) {
  stopDriftCorrection();
  driftTimer = setInterval(() => {
    if (els.player.paused || !anchor) return;
    const expected = anchor.position + (Date.now() - anchor.localTime) / 1000;
    const diff = els.player.currentTime - expected; // positive = running ahead

    if (Math.abs(diff) > 0.75) {
      els.player.currentTime = expected;
      els.player.playbackRate = 1;
    } else if (diff > 0.05) {
      els.player.playbackRate = 0.98; // slightly ahead — ease off
    } else if (diff < -0.05) {
      els.player.playbackRate = 1.02; // slightly behind — catch up
    } else {
      els.player.playbackRate = 1;
    }
  }, 2000);
}

function stopDriftCorrection() {
  if (driftTimer) clearInterval(driftTimer);
  driftTimer = null;
  pendingAnchor = null;
  els.player.playbackRate = 1;
}

function showTapToPlayFallback() {
  // The browser refused a programmatic play() call. Whoever is looking at
  // this screen has to tap once themselves — that click is guaranteed to
  // be allowed, unlike a socket-triggered one.
  setStatus('wait', 'tap play to start on this device');
  els.playToggleBtn.disabled = false;
  els.playToggleBtn.textContent = '▶';
  els.playToggleBtn.dataset.fallback = '1';
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// Track / playback UI
// ---------------------------------------------------------------------------

function trackDisplayName(name) {
  return name.replace(/\.[^/.]+$/, '');
}

// Deterministic-but-varied cover art colour per track name, so each track
// gets a recognisable "album art" gradient instead of one flat colour.
function coverGradientFor(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  const hueA = hash % 360;
  const hueB = (hueA + 55) % 360;
  return `linear-gradient(135deg, hsl(${hueA} 70% 55%), hsl(${hueB} 70% 45%))`;
}

function formatTime(seconds) {
  if (!isFinite(seconds) || seconds < 0) seconds = 0;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

async function applyTrack(track, playlist, currentTrackIndex) {
  state.playlist = playlist || state.playlist;
  state.currentTrackIndex = currentTrackIndex;

  if (playlist && playlist.length > 0) {
    els.playlistPanel.style.display = 'block';
    els.playlistList.innerHTML = playlist
      .map((t, i) => `<div class="playlist-item ${i === currentTrackIndex ? 'current' : ''}">${escapeHtml(trackDisplayName(t.name))}</div>`)
      .join('');
  }

  if (!track) {
    els.noTrackMsg.style.display = 'block';
    els.nowPlayingHead.style.display = 'none';
    els.playToggleBtn.disabled = true;
    els.readyBtn.disabled = true;
    setStatus('wait', 'waiting for a track');
    return;
  }

  // Bump the load token so that if this track gets replaced (host skips
  // again) before the download below finishes, the stale download knows to
  // throw its result away instead of overwriting the newer track.
  const myToken = ++trackLoadToken;
  stopDriftCorrection();
  els.player.pause();
  state.isPlaying = false;

  els.noTrackMsg.style.display = 'none';
  els.nowPlayingHead.style.display = 'flex';
  els.trackTitle.textContent = trackDisplayName(track.name);
  els.trackSub.textContent = `Shared in room ${code}`;
  els.coverArt.style.background = coverGradientFor(track.name);
  updateFavIcon(track.name);
  els.progressFill.style.width = '0%';
  els.timeElapsed.textContent = '0:00';
  els.timeRemaining.textContent = '0:00';

  // Ready stays disabled until the file is *actually* fully on this device —
  // setting <audio>.src and calling load() only guarantees "enough buffered
  // to maybe start", which is exactly the gap that used to let someone mark
  // ready before their phone had the track, breaking the sync at play time.
  els.readyBtn.disabled = true;
  els.readyBtn.classList.remove('on');
  els.readyBtn.textContent = 'Mark ready';
  delete els.playToggleBtn.dataset.fallback;
  updatePlayToggleIcon(false);
  els.playToggleBtn.disabled = true;
  setStatus('wait', 'downloading track… 0%');

  try {
    const objectUrl = await fetchFullTrack(track.url, (pct) => {
      if (myToken !== trackLoadToken) return; // superseded by a newer track
      setStatus('wait', `downloading track… ${pct}%`);
    });
    if (myToken !== trackLoadToken) {
      URL.revokeObjectURL(objectUrl); // this track isn't current anymore, discard it
      return;
    }
    if (currentBlobUrl) URL.revokeObjectURL(currentBlobUrl);
    currentBlobUrl = objectUrl;
    els.player.src = objectUrl;
    els.player.load();
    els.readyBtn.disabled = false;
    setStatus('wait', 'downloaded — tap ready when set');
  } catch (err) {
    if (myToken !== trackLoadToken) return;
    setStatus('wait', 'download failed — try refreshing');
  }
}

// Downloads the whole audio file with real progress, then hands back an
// object URL pointing at a Blob already fully in memory. This is what makes
// "ready" mean "actually on this device" instead of relying on <audio>'s own
// loading events, which only promise "enough to maybe start playing."
async function fetchFullTrack(url, onProgress) {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error('Download failed');
  const total = Number(res.headers.get('content-length')) || 0;
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (total > 0) onProgress(Math.round((received / total) * 100));
  }
  return URL.createObjectURL(new Blob(chunks));
}

function setStatus(kind, text) {
  els.statusLine.className = `status-line ${kind}`;
  els.statusLine.textContent = text;
}

els.readyBtn.addEventListener('click', async () => {
  // Browsers block autoplay without a user gesture. This click IS that
  // gesture: we "prime" the element (and the Web Audio graph) now so the
  // later scheduled play() call has the best chance of succeeding.
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') await audioCtx.resume();
    if (!sourceConnected) {
      const source = audioCtx.createMediaElementSource(els.player);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 64;
      dataArr = new Uint8Array(analyser.frequencyBinCount);
      source.connect(analyser);
      analyser.connect(audioCtx.destination);
      sourceConnected = true;
    }
    await els.player.play();
    els.player.pause();
    els.player.currentTime = 0;
  } catch (err) {
    // Even if priming fails, still report ready — the tap-to-play fallback
    // in attemptPlay() covers the case where autoplay is still blocked.
  }
  state.hasMarkedReady = true;
  els.readyBtn.disabled = true;
  els.readyBtn.classList.add('on');
  els.readyBtn.textContent = 'Ready ✓';
  setStatus('ready', 'ready — waiting on the room');
  socket.emit('ready');
});

els.volSlider.addEventListener('input', () => {
  els.player.volume = Number(els.volSlider.value) / 100;
});
els.player.volume = Number(els.volSlider.value) / 100;

els.player.addEventListener('timeupdate', () => {
  if (!els.player.duration) return;
  const pct = (els.player.currentTime / els.player.duration) * 100;
  els.progressFill.style.width = `${pct}%`;
  els.timeElapsed.textContent = formatTime(els.player.currentTime);
  els.timeRemaining.textContent = formatTime(els.player.duration - els.player.currentTime);
});
els.player.addEventListener('pause', () => { updatePlayToggleIcon(false); stopDriftCorrection(); });
els.player.addEventListener('play', () => updatePlayToggleIcon(true));
els.player.addEventListener('ended', () => {
  updatePlayToggleIcon(false);
  stopDriftCorrection();
  setStatus('ready', 'finished');
});

function updatePlayToggleIcon(playing) {
  state.isPlaying = playing;
  els.playToggleBtn.textContent = playing ? '❚❚' : '▶';
}

// ---------------------------------------------------------------------------
// Favorite heart (session-only, per track — not synced or persisted)
// ---------------------------------------------------------------------------

function updateFavIcon(trackName) {
  const isFav = state.favorites.has(trackName);
  els.favBtn.textContent = isFav ? '♥' : '♡';
  els.favBtn.classList.toggle('active', isFav);
}

els.favBtn.addEventListener('click', () => {
  const track = state.playlist[state.currentTrackIndex];
  if (!track) return;
  if (state.favorites.has(track.name)) state.favorites.delete(track.name);
  else state.favorites.add(track.name);
  updateFavIcon(track.name);
});

// ---------------------------------------------------------------------------
// Drag-to-seek progress bar (host only — everyone else just watches it move)
// ---------------------------------------------------------------------------

let seeking = false;

function fractionFromEvent(e) {
  const rect = els.progressTrack.getBoundingClientRect();
  return Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
}

els.progressTrack.addEventListener('pointerdown', (e) => {
  if (!state.isHost || !els.player.duration) return;
  seeking = true;
  els.progressTrack.setPointerCapture(e.pointerId);
  previewSeek(e);
});
els.progressTrack.addEventListener('pointermove', (e) => {
  if (!seeking) return;
  previewSeek(e);
});
els.progressTrack.addEventListener('pointerup', (e) => {
  if (!seeking) return;
  seeking = false;
  const position = fractionFromEvent(e) * els.player.duration;
  socket.emit('host-control', { action: 'seek', payload: { position } });
});

function previewSeek(e) {
  const frac = fractionFromEvent(e);
  els.progressFill.style.width = `${frac * 100}%`;
  els.timeElapsed.textContent = formatTime(frac * els.player.duration);
  els.timeRemaining.textContent = formatTime(els.player.duration * (1 - frac));
}

els.playToggleBtn.addEventListener('click', () => {
  // Tap-to-play fallback: this click IS the user gesture, so just play
  // directly instead of routing back through the host-control/schedule path.
  if (els.playToggleBtn.dataset.fallback) {
    delete els.playToggleBtn.dataset.fallback;
    attemptPlay();
    return;
  }
  if (!state.isHost) return;
  socket.emit('host-control', { action: state.isPlaying ? 'pause' : 'play' });
});

els.restartBtn.addEventListener('click', () => {
  if (!state.isHost) return;
  socket.emit('host-control', { action: 'seek', payload: { position: 0 } });
});
els.skipBtn.addEventListener('click', () => {
  if (!state.isHost) return;
  socket.emit('host-control', { action: 'skip' });
});
els.lockToggle.addEventListener('change', () => {
  socket.emit('host-control', { action: 'lock', payload: { locked: els.lockToggle.checked } });
});

function updatePlayAvailability() {
  const allReady = state.members.length > 0 && state.members.every((m) => m.ready);
  els.playToggleBtn.disabled = !(state.isHost && allReady && state.playlist.length > 0);
}

function animateBars() {
  if (!analyser || els.player.paused) return;
  analyser.getByteFrequencyData(dataArr);
  barEls.forEach((bar, i) => {
    const v = dataArr[i % dataArr.length] || 0;
    bar.style.height = Math.max(6, (v / 255) * 48) + 'px';
    bar.style.opacity = 0.3 + (v / 255) * 0.7;
  });
  requestAnimationFrame(animateBars);
}

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

function renderMembers() {
  els.memberList.innerHTML = state.members
    .map((m) => `
      <div class="member-row">
        <div class="member-avatar">${escapeHtml(m.name[0] || '?')}</div>
        <div class="member-name">${escapeHtml(m.name)}</div>
        ${m.isHost ? '<span class="badge-host">HOST</span>' : ''}
        <span class="check ${m.ready ? 'on' : 'off'}">${m.ready ? '✓' : '·'}</span>
      </div>
    `)
    .join('');
  updatePlayAvailability();
}

// ---------------------------------------------------------------------------
// Upload (host only)
// ---------------------------------------------------------------------------

els.fileInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file || !state.hostToken) return;
  const formData = new FormData();
  formData.append('audio', file);
  try {
    const res = await fetch(`/api/rooms/${encodeURIComponent(code)}/upload`, {
      method: 'POST',
      headers: { 'x-host-token': state.hostToken },
      body: formData,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Upload failed');
  } catch (err) {
    alert(err.message);
  }
});

// ---------------------------------------------------------------------------
// Chat + reactions
// ---------------------------------------------------------------------------

function addChatLine(name, text) {
  const line = document.createElement('div');
  line.className = 'chat-msg';
  line.innerHTML = `<span class="who">${escapeHtml(name)}</span>${escapeHtml(text)}`;
  els.chatLog.appendChild(line);
  els.chatLog.scrollTop = els.chatLog.scrollHeight;
}

function sendChat() {
  const text = els.chatInput.value.trim();
  if (!text) return;
  socket.emit('chat-message', { text });
  els.chatInput.value = '';
}
els.chatSendBtn.addEventListener('click', sendChat);
els.chatInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });

document.querySelectorAll('.reactions-row button').forEach((btn) => {
  btn.addEventListener('click', () => socket.emit('reaction', { emoji: btn.dataset.emoji }));
});

function floatEmoji(emoji) {
  const el = document.createElement('div');
  el.className = 'floating-emoji';
  el.textContent = emoji;
  el.style.left = `${20 + Math.random() * 60}%`;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2500);
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
