// server.js
// Anon/Voice — minimal oda + chat + WebRTC signaling server (3–5 kişi)
// Run: node server.js   (PORT env varsa onu dinler)

const express = require("express");
const cors = require("cors");
const http = require("http");
const { WebSocketServer } = require("ws");

const app = express();
app.use(cors());
app.get("/", (_req, res) => res.send("OK"));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// { ROOM_CODE -> Set(ws) }
const rooms = new Map();

// helper: odaya katıl/ayrıl
function joinRoom(ws, room) {
  if (!rooms.has(room)) rooms.set(room, new Set());
  rooms.get(room).add(ws);
  ws._room = room;
  sendPresence(room);
}
function leaveRoom(ws) {
  const room = ws._room;
  if (!room) return;
  const set = rooms.get(room);
  if (set) {
    set.delete(ws);
    if (set.size === 0) rooms.delete(room);
  }
  ws._room = null;
  sendPresence(room);
}

// helper: odadakilere yayın
function broadcast(room, payload, except) {
  const set = rooms.get(room);
  if (!set) return;
  for (const peer of set) {
    if (peer.readyState === 1 && peer !== except) peer.send(payload);
  }
}
function sendPresence(room) {
  const n = rooms.get(room)?.size || 0;
  broadcast(room, JSON.stringify({ type: "presence", n }), null);
}

// --- WS bağlantıları ---
wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.on("pong", () => (ws.isAlive = true));

  ws.on("message", (buf) => {
    let msg;
    try { msg = JSON.parse(buf.toString()); } catch { return; }

    // Odaya giriş
    if (msg.type === "join") {
      const room = String(msg.room || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
      if (!room) return;
      joinRoom(ws, room);
      ws.send(JSON.stringify({ type: "joined", room }));
      return;
    }

    // Oda içi metin mesajı
    if (msg.type === "chat" && ws._room) {
      const payload = JSON.stringify({
        type: "chat",
        alias: String(msg.alias || "anon").slice(0, 24),
        text: String(msg.text || "").slice(0, 400),
        ts: Date.now(),
      });
      broadcast(ws._room, payload, null);
      return;
    }

    // WebRTC signaling relay (mesh)
    if (msg.type && msg.type.startsWith("rtc:") && ws._room) {
      const relay = JSON.stringify({ ...msg, from: String(msg.alias || "anon").slice(0, 24) });
      broadcast(ws._room, relay, ws); // gönderen hariç herkese
    }
  });

  ws.on("close", () => leaveRoom(ws));
});

// Keep-alive (Render/WebSocket)
const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on("close", () => clearInterval(interval));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("server on", PORT));
