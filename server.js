// server.js
// SyncSound backend: room management, audio upload, and the Socket.IO
// signaling that keeps every phone's playback scheduled to the same instant.

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const http = require('http');
const { Server } = require('socket.io');
const QRCode = require('qrcode');

const {
  createRoom,
  getRoom,
  deleteRoom,
  currentTrack,
  publicMemberList,
  allReady,
} = require('./rooms');

const PORT = process.env.PORT || 3000;
const UPLOAD_ROOT = path.join(__dirname, 'uploads');
const START_DELAY_MS = 3000; // how far in the future "play" and "seek" are scheduled

if (!fs.existsSync(UPLOAD_ROOT)) fs.mkdirSync(UPLOAD_ROOT, { recursive: true });

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json());

// This project keeps client files (html/css/js) and server files (server.js,
// rooms.js) in the same flat folder, so block the server-side source files
// from being handed out as static downloads before serving everything else.
const DO_NOT_SERVE = ['/server.js', '/rooms.js', '/package.json', '/package-lock.json', '/README.md'];
app.use((req, res, next) => {
  if (DO_NOT_SERVE.includes(req.path)) return res.status(404).end();
  next();
});
app.use(express.static(__dirname)); // serves index.html, room.html, style.css, home.js, room.js, and /uploads

// ---------- host tokens (kept server-side, not persisted) ----------
// hostTokens: roomCode -> token. Whoever presents the right token on join
// is granted host control for that room.
const hostTokens = new Map();

// ---------- multer: store uploaded audio under uploads/<roomCode>/ ----------
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const code = req.params.code;
    const dir = path.join(UPLOAD_ROOT, code);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${Date.now()}-${safe}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 40 * 1024 * 1024 }, // 40MB per track
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('audio/')) return cb(new Error('Only audio files are allowed'));
    cb(null, true);
  },
});

// ---------------------------------------------------------------------------
// REST routes
// ---------------------------------------------------------------------------

// Create a room. Returns the room code plus a one-time host token the
// creator's browser must hold on to (sessionStorage) to prove it's the host.
app.post('/api/rooms', (req, res) => {
  const { hostName, password } = req.body || {};
  if (!hostName || !hostName.trim()) return res.status(400).json({ error: 'hostName is required' });

  const room = createRoom({ hostName: hostName.trim(), password: password || null });
  const hostToken = crypto.randomBytes(16).toString('hex');
  hostTokens.set(room.code, hostToken);

  res.json({ code: room.code, hostToken });
});

// Look up a room (used by the join screen before connecting a socket).
app.get('/api/rooms/:code', (req, res) => {
  const room = getRoom(req.params.code);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  res.json({
    code: room.code,
    locked: room.locked,
    hasPassword: !!room.password,
    memberCount: room.members.size,
  });
});

// QR code image (data URL) that deep-links straight to this room's join screen.
app.get('/api/rooms/:code/qr', async (req, res) => {
  const room = getRoom(req.params.code);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  const joinUrl = `${req.protocol}://${req.get('host')}/room.html?code=${encodeURIComponent(room.code)}`;
  try {
    const dataUrl = await QRCode.toDataURL(joinUrl, { margin: 1, width: 240, color: { dark: '#1A1025', light: '#FFFFFF' } });
    res.json({ dataUrl, joinUrl });
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate QR code' });
  }
});

// Host uploads a track. Requires the host token in the x-host-token header.
app.post('/api/rooms/:code/upload', upload.single('audio'), (req, res) => {
  const room = getRoom(req.params.code);
  if (!room) return res.status(404).json({ error: 'Room not found' });

  const token = req.header('x-host-token');
  if (!token || token !== hostTokens.get(room.code)) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(403).json({ error: 'Only the host can upload a track' });
  }
  if (!req.file) return res.status(400).json({ error: 'No audio file received' });

  const track = {
    name: req.file.originalname,
    url: `/uploads/${room.code}/${req.file.filename}`,
  };
  room.playlist.push(track);
  if (room.currentTrackIndex === -1) room.currentTrackIndex = room.playlist.length - 1;

  // Let everyone in the room know a track is ready to download.
  io.to(room.code).emit('track', {
    track: currentTrack(room),
    playlist: room.playlist,
    currentTrackIndex: room.currentTrackIndex,
  });
  // A new track means everyone has to re-download and re-arm.
  for (const m of room.members.values()) m.ready = false;
  io.to(room.code).emit('member-update', { members: publicMemberList(room), allReady: false });

  res.json({ ok: true, track });
});

// ---------------------------------------------------------------------------
// Socket.IO — everything that has to happen in real time
// ---------------------------------------------------------------------------

io.on('connection', (socket) => {
  let joinedCode = null;

  // A lightweight NTP-style handshake: the client sends its own clock reading,
  // the server echoes back its own. Client uses several round trips to
  // estimate the offset between "its" clock and "the server's" clock, so a
  // server-issued startAt timestamp can be translated into a local one.
  socket.on('time-sync', (clientSentAt, cb) => {
    if (typeof cb === 'function') cb(Date.now());
  });

  socket.on('join-room', ({ code, name, password, hostToken }, cb) => {
    const room = getRoom(code);
    if (!room) return cb({ ok: false, error: 'Room not found' });
    if (room.locked && !(hostToken && hostToken === hostTokens.get(code))) {
      return cb({ ok: false, error: 'Room is locked' });
    }
    if (room.password && room.password !== password && !(hostToken && hostToken === hostTokens.get(code))) {
      return cb({ ok: false, error: 'Incorrect password' });
    }
    if (!name || !name.trim()) return cb({ ok: false, error: 'Name is required' });

    socket.join(code);
    joinedCode = code;
    room.members.set(socket.id, { name: name.trim().slice(0, 24), ready: false, joinedAt: Date.now() });

    // Whoever presents the correct host token always reclaims host control —
    // e.g. the original host refreshing their tab after the room temporarily
    // handed control to someone else while they were briefly disconnected.
    const isHostClaim = hostToken && hostToken === hostTokens.get(code);
    if (isHostClaim) {
      room.hostId = socket.id;
    } else if (!room.hostId) {
      // No host token presented and no host yet — first joiner becomes host
      // as a fallback so a room is never stuck without one.
      room.hostId = socket.id;
    }

    cb({
      ok: true,
      isHost: room.hostId === socket.id,
      locked: room.locked,
      members: publicMemberList(room),
      track: currentTrack(room),
      playlist: room.playlist,
    });

    socket.to(code).emit('member-update', { members: publicMemberList(room), allReady: allReady(room) });
  });

  socket.on('ready', () => {
    if (!joinedCode) return;
    const room = getRoom(joinedCode);
    if (!room || !room.members.has(socket.id)) return;
    room.members.get(socket.id).ready = true;
    io.to(joinedCode).emit('member-update', { members: publicMemberList(room), allReady: allReady(room) });
  });

  // Host-only playback + room controls.
  socket.on('host-control', ({ action, payload }) => {
    if (!joinedCode) return;
    const room = getRoom(joinedCode);
    if (!room || room.hostId !== socket.id) return; // silently ignore non-host attempts

    switch (action) {
      case 'play': {
        if (!allReady(room)) return;
        const startAt = Date.now() + START_DELAY_MS;
        io.to(joinedCode).emit('play', { startAt });
        break;
      }
      case 'pause': {
        io.to(joinedCode).emit('pause', {});
        break;
      }
      case 'seek': {
        const startAt = Date.now() + START_DELAY_MS;
        io.to(joinedCode).emit('seek', { position: payload?.position || 0, startAt });
        break;
      }
      case 'skip': {
        if (room.playlist.length === 0) return;
        room.currentTrackIndex = (room.currentTrackIndex + 1) % room.playlist.length;
        for (const m of room.members.values()) m.ready = false;
        io.to(joinedCode).emit('track', {
          track: currentTrack(room),
          playlist: room.playlist,
          currentTrackIndex: room.currentTrackIndex,
        });
        io.to(joinedCode).emit('member-update', { members: publicMemberList(room), allReady: false });
        break;
      }
      case 'lock': {
        room.locked = !!payload?.locked;
        io.to(joinedCode).emit('room-updated', { locked: room.locked });
        break;
      }
      case 'kick': {
        const targetId = payload?.socketId;
        if (targetId && room.members.has(targetId)) {
          io.to(targetId).emit('kicked');
          io.sockets.sockets.get(targetId)?.leave(joinedCode);
          room.members.delete(targetId);
          io.to(joinedCode).emit('member-update', { members: publicMemberList(room), allReady: allReady(room) });
        }
        break;
      }
      default:
        break;
    }
  });

  socket.on('chat-message', ({ text }) => {
    if (!joinedCode || !text || !text.trim()) return;
    const room = getRoom(joinedCode);
    const member = room?.members.get(socket.id);
    if (!member) return;
    io.to(joinedCode).emit('chat-message', { name: member.name, text: text.trim().slice(0, 300), ts: Date.now() });
  });

  socket.on('reaction', ({ emoji }) => {
    if (!joinedCode || !emoji) return;
    const room = getRoom(joinedCode);
    const member = room?.members.get(socket.id);
    if (!member) return;
    io.to(joinedCode).emit('reaction', { name: member.name, emoji });
  });

  socket.on('disconnect', () => {
    if (!joinedCode) return;
    const room = getRoom(joinedCode);
    if (!room) return;
    room.members.delete(socket.id);

    if (room.hostId === socket.id) {
      // Hand the room to whoever has been in it the longest.
      const next = Array.from(room.members.entries()).sort((a, b) => a[1].joinedAt - b[1].joinedAt)[0];
      room.hostId = next ? next[0] : null;
      if (next) io.to(next[0]).emit('host-changed', { youAreHost: true });
    }

    if (room.members.size === 0) {
      deleteRoom(joinedCode);
      hostTokens.delete(joinedCode);
      // Clean up this room's uploaded audio so uploads/ doesn't grow forever.
      fs.rm(path.join(UPLOAD_ROOT, joinedCode), { recursive: true, force: true }, () => {});
    } else {
      io.to(joinedCode).emit('member-update', { members: publicMemberList(room), allReady: allReady(room) });
    }
  });
});

server.listen(PORT, () => {
  console.log(`SyncSound server running at http://localhost:${PORT}`);
  console.log('Open this address on your phone too (same Wi-Fi) using your computer\'s LAN IP instead of localhost.');
});
