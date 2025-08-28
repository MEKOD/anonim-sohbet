// app.js — ANON/VOICE (3–5 kişi, oda kodu + sesli sohbet + mesaj)
// Not: SERVER_URL'i kendi Render Web Service adresinle değiştir.

(() => {
  // ====== DOM ======
  const $ = (s) => document.querySelector(s);
  const landing = $("#landing");
  const viewCreate = $("#create");
  const viewJoin = $("#join");
  const viewRoom = $("#room");
  const statusText = $("#statusText");
  const presence = $("#presence");

  const aliasIn = $("#alias");
  const btnCreate = $("#btnCreate");
  const btnJoin = $("#btnJoin");

  const roomCodeSpan = $("#roomCode");
  const btnCopy = $("#btnCopy");
  const btnEnter = $("#btnEnter");
  const btnBack1 = $("#btnBack1");

  const joinCodeIn = $("#joinCode");
  const btnEnterJoin = $("#btnEnterJoin");
  const btnBack2 = $("#btnBack2");
  const joinError = $("#joinError");

  const roomBadge = $("#roomBadge");
  const btnLeave = $("#btnLeave");

  const peersEl = $("#peers");
  const btnMic = $("#btnMic");

  const messagesEl = $("#messages");
  const msgInput = $("#msgInput");
  const btnSend = $("#btnSend");

  // ====== CONFIG ======
  const SERVER_URL =
    (window.SERVER_URL || "").trim() ||
    "https://<server-service-adresin>.onrender.com";
  const STUN = [{ urls: "stun:stun.l.google.com:19302" }];
  const MAX_PEERS = 5;

  // ====== STATE ======
  let ws;
  let alias = "";
  let room = "";
  const myId = genId(8); // bağlantı kimliği (alias'tan bağımsız)
  let micOn = false;
  let localStream = null;

  // peer haritası: remoteId -> { pc, el, audioEl }
  const peers = new Map();

  // ====== UI helpers ======
  function show(view) {
    for (const el of document.querySelectorAll(".card")) el.classList.remove("show");
    viewRoom.classList.remove("show");
    (view || landing).classList.add("show");
  }
  function showRoom() {
    viewRoom.classList.add("show");
  }
  function setPresence(n) {
    presence.textContent = `${n} ONLINE`;
  }
  function setStatus(t) {
    statusText.textContent = t;
  }
  function fmtCode(c) {
    return (c || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6).replace(/(^.{3})/, "$1-");
  }
  function genCode6() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // O/0 I/1 yok
    let s = "";
    for (let i = 0; i < 6; i++) s += chars[(Math.random() * chars.length) | 0];
    return s;
  }
  function genId(n = 8) {
    return Math.random().toString(36).slice(2, 2 + n);
  }
  function log(line) {
    const li = document.createElement("li");
    li.textContent = line;
    messagesEl.appendChild(li);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  // ====== WS ======
  function connectWS() {
    ws = new WebSocket(SERVER_URL.replace(/^http/, "ws"));
    ws.onopen = () => {
      setStatus("ONLINE");
      ws.send(JSON.stringify({ type: "join", room }));
      // oda içi tanışma — herkes herkese "hello" atar
      setTimeout(() => {
        sendRTC("rtc:hello", { id: myId, alias });
      }, 300);
    };
    ws.onclose = () => setStatus("OFFLINE");
    ws.onerror = () => setStatus("ERROR");
    ws.onmessage = async (e) => {
      const msg = JSON.parse(e.data);

      if (msg.type === "joined") {
        setPresence(1);
        return;
      }
      if (msg.type === "presence") {
        setPresence(msg.n || 0);
        return;
      }
      if (msg.type === "chat") {
        const time = new Date(msg.ts).toLocaleTimeString();
        log(`[${time}] ${msg.alias}: ${msg.text}`);
        return;
      }

      // --- WebRTC sinyalleşme ---
      if (msg.type === "rtc:hello") {
        const remoteId = msg.id;
        if (!remoteId || remoteId === myId) return;
        ensurePeerCard(remoteId, msg.from || "peer");
        // glare önleme: id'si küçük olan pasif, büyük olan offer başlatır
        if (myId > remoteId && !peers.get(remoteId)?.pc) {
          await createConnectionAndOffer(remoteId);
        }
        return;
      }

      if (msg.type === "rtc:offer") {
        const remoteId = msg.fromId;
        if (!remoteId || remoteId === myId) return;
        ensurePeerCard(remoteId, msg.from || "peer");
        const pc = await getOrCreatePC(remoteId, false);
        await pc.setRemoteDescription(new RTCSessionDescription(msg.offer));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        sendRTC("rtc:answer", { to: remoteId, answer, fromId: myId });
        return;
      }

      if (msg.type === "rtc:answer") {
        const remoteId = msg.fromId;
        const p = peers.get(remoteId);
        if (!p) return;
        await p.pc.setRemoteDescription(new RTCSessionDescription(msg.answer));
        return;
      }

      if (msg.type === "rtc:candidate") {
        const remoteId = msg.fromId;
        const p = peers.get(remoteId);
        if (!p || !msg.candidate) return;
        try {
          await p.pc.addIceCandidate(msg.candidate);
        } catch (_) {}
        return;
      }
    };
  }

  function sendRTC(type, payload = {}) {
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type, alias, ...payload }));
    }
  }

  // ====== WebRTC helpers ======
  async function getOrCreatePC(remoteId, initiator) {
    let p = peers.get(remoteId);
    if (p?.pc) return p.pc;

    const pc = new RTCPeerConnection({ iceServers: STUN });

    // UI kartı
    if (!p) {
      const el = ensurePeerCard(remoteId, "peer");
      p = { pc, el, audioEl: el.querySelector("audio") };
      peers.set(remoteId, p);
    } else {
      p.pc = pc;
    }

    // ICE
    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        sendRTC("rtc:candidate", { fromId: myId, to: remoteId, candidate: ev.candidate });
      }
    };

    // Uzak stream
    pc.ontrack = (ev) => {
      p.audioEl.srcObject = ev.streams[0];
    };

    // Yerel mic varsa track ekle
    if (localStream) {
      localStream.getAudioTracks().forEach((t) => pc.addTrack(t, localStream));
    }

    return pc;
  }

  async function createConnectionAndOffer(remoteId) {
    const pc = await getOrCreatePC(remoteId, true);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sendRTC("rtc:offer", { fromId: myId, to: remoteId, offer });
  }

  function ensurePeerCard(id, name = "peer") {
    let card = peersEl.querySelector(`.peer[data-id="${id}"]`);
    if (card) return card;
    card = document.createElement("div");
    card.className = "peer";
    card.dataset.id = id;
    card.innerHTML = `
      <div class="name">${name} (${id.slice(0,4)})</div>
      <audio autoplay playsinline></audio>
      <div class="meter"><div class="bar"></div></div>
    `;
    peersEl.appendChild(card);
    return card;
  }

  // ====== MIC ======
  async function enableMic() {
    if (micOn) return;
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micOn = true;
      btnMic.textContent = "Mikrofon: ON";
      // mevcut pc'lere ekle
      for (const { pc } of peers.values()) {
        if (!pc) continue;
        localStream.getAudioTracks().forEach((t) => pc.addTrack(t, localStream));
      }
      startLocalMeter(localStream);
    } catch (e) {
      alert("Mikrofon izni alınamadı.");
    }
  }
  function disableMic() {
    if (!micOn) return;
    micOn = false;
    btnMic.textContent = "Mikrofon";
    if (localStream) {
      localStream.getTracks().forEach((t) => t.stop());
      localStream = null;
    }
  }
  function startLocalMeter(stream) {
    const firstBar = peersEl.querySelector(".peer .bar"); // basit: ilk bar'ı kullan
    if (!firstBar) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    const src = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    src.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);
    (function tick() {
      if (!micOn) return;
      analyser.getByteFrequencyData(data);
      const v = Math.min(100, (data[0] / 255) * 100);
      firstBar.style.width = `${4 + v}%`;
      requestAnimationFrame(tick);
    })();
  }

  // ====== EVENTS ======
  btnCreate.onclick = () => {
    alias = (aliasIn.value || "anon").slice(0, 24);
    room = genCode6();
    roomCodeSpan.textContent = fmtCode(room);
    show(viewCreate);
  };
  btnCopy.onclick = async () => {
    await navigator.clipboard.writeText(fmtCode(room));
    btnCopy.textContent = "Kopyalandı";
    setTimeout(() => (btnCopy.textContent = "Kopyala"), 900);
  };
  btnEnter.onclick = () => {
    roomBadge.textContent = fmtCode(room);
    showRoom();
    connectWS();
  };
  btnBack1.onclick = () => show(landing);

  btnJoin.onclick = () => {
    joinCodeIn.value = "";
    joinError.textContent = "";
    show(viewJoin);
  };
  joinCodeIn.addEventListener("input", () => {
    joinCodeIn.value = fmtCode(joinCodeIn.value);
  });
  btnEnterJoin.onclick = () => {
    const code = joinCodeIn.value.replace(/[^A-Z0-9]/g, "");
    if (code.length !== 6) {
      joinError.textContent = "Kod hatalı";
      return;
    }
    alias = (aliasIn.value || "anon").slice(0, 24);
    room = code;
    roomBadge.textContent = fmtCode(room);
    showRoom();
    connectWS();
  };
  btnBack2.onclick = () => show(landing);

  btnLeave.onclick = () => location.reload();

  btnMic.onclick = async () => {
    micOn ? disableMic() : await enableMic();
  };

  btnSend.onclick = () => {
    const text = msgInput.value.trim();
    if (!text || !ws || ws.readyState !== 1) return;
    ws.send(JSON.stringify({ type: "chat", alias, text }));
    msgInput.value = "";
  };
  msgInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") btnSend.click();
  });
})();
