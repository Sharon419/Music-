// rooms.js
// In-memory room store. Fine for a single server instance / demo / small deployment.
// Swap this module for a Redis-backed version if you need multiple server instances.

const { customAlphabet } = require('nanoid');
const nanoid = customAlphabet('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 6);

/** @type {Map<string, Room>} */
const rooms = new Map();

function formatCode(raw) {
  return raw.slice(0, 3) + '-' + raw.slice(3);
}

function createRoom({ hostName, password }) {
  let code;
  do {
    code = formatCode(nanoid());
  } while (rooms.has(code));

  const room = {
    code,
    password: password || null,
    locked: false,
    hostId: null, // socket.id of current host, set on join
    members: new Map(), // socket.id -> { name, ready, joinedAt }
    playlist: [], // [{ name, url }]
    currentTrackIndex: -1,
    createdAt: Date.now(),
  };
  rooms.set(code, room);
  return room;
}

function getRoom(code) {
  return rooms.get(code);
}

function deleteRoom(code) {
  rooms.delete(code);
}

function currentTrack(room) {
  if (room.currentTrackIndex < 0 || room.currentTrackIndex >= room.playlist.length) return null;
  return room.playlist[room.currentTrackIndex];
}

function publicMemberList(room) {
  return Array.from(room.members.entries()).map(([id, m]) => ({
    id,
    name: m.name,
    ready: m.ready,
    isHost: id === room.hostId,
  }));
}

function allReady(room) {
  if (room.members.size === 0) return false;
  return Array.from(room.members.values()).every((m) => m.ready);
}

module.exports = {
  rooms,
  createRoom,
  getRoom,
  deleteRoom,
  currentTrack,
  publicMemberList,
  allReady,
};
