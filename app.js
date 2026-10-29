"use strict";

const APP_NAME = "FREE CHAT";
// GitHub Pages / InfinityFree use this API endpoint. The Worker-hosted preview
// automatically talks to its own origin, so preview and production use the same UI.
const WORKER_ORIGIN = "https://free-chat.s86069123.workers.dev";
const API_ORIGIN = location.hostname.endsWith(".workers.dev") ? location.origin : WORKER_ORIGIN;
const MAX_NAME = 16;
const MAX_MSG = 500;
const CONNECT_TIMEOUT_MS = 10000;
const HEARTBEAT_INTERVAL_MS = 20000;
const HEARTBEAT_TIMEOUT_MS = 60000;

const $ = (id) => document.getElementById(id);
const log = $("log");
const input = $("input");
const roomInput = $("room");
const nameInput = $("name");

let ws = null;
let me = null;
let myName = "";
let roomId = "";
let phase = "home";
let participants = [];
let lastPong = 0;
let connectTimer = null;
let heartbeatTimer = null;
let leaveTimer = null;

const STRIP = /[\u0000-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g;
const cleanName = (value) => [...String(value || "").replace(STRIP, "").trim()].slice(0, MAX_NAME).join("");
const randomNumber = (max) => crypto.getRandomValues(new Uint32Array(1))[0] % max;
const pick = (array) => array[randomNumber(array.length)];
const randomName = () =>
  pick(["青い", "赤い", "白い", "小さな", "元気な", "静かな", "眠そうな", "優しい"]) +
  pick(["ねこ", "いぬ", "うさぎ", "きつね", "たぬき", "くま", "ふくろう", "いるか"]) +
  (10 + randomNumber(90));

// 元の仕様どおり、ランダムな16文字の部屋IDを生成する。
const randomRoom = () => {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (value) => alphabet[value & 31]).join("");
};

document.title = APP_NAME;
document.querySelectorAll("[data-app-name]").forEach((element) => {
  element.textContent = APP_NAME;
});

function show(section) {
  for (const name of ["start", "wait", "chat"]) {
    $("s-" + name).hidden = name !== section;
  }
  document.body.classList.toggle("is-chat", section === "chat");
}

function setStatus(message, kind = "") {
  const element = $("status");
  element.textContent = message;
  element.className = "status" + (kind ? " " + kind : "");
}

function clearTimers() {
  clearTimeout(connectTimer);
  clearInterval(heartbeatTimer);
  clearTimeout(leaveTimer);
  connectTimer = null;
  heartbeatTimer = null;
  leaveTimer = null;
}

function resizeInput() {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 120) + "px";
  $("count").textContent = [...input.value].length + "/" + MAX_MSG;
}

function closeLocalSocket() {
  const oldSocket = ws;
  ws = null;
  if (!oldSocket) return;

  oldSocket.onopen = null;
  oldSocket.onmessage = null;
  oldSocket.onerror = null;
  oldSocket.onclose = null;
  try {
    oldSocket.close(1000, "Leaving");
  } catch (_) {
    // すでに切断済みなら無視する。
  }
}

function goHome(message = "", kind = "") {
  clearTimers();
  phase = "home";
  me = null;
  participants = [];
  closeLocalSocket();
  log.replaceChildren();
  input.value = "";
  resizeInput();
  $("me-name").textContent = "";
  $("peer-name").textContent = "";
  $("member-count").textContent = "人数: 0/4人";
  $("wait-room").textContent = "";
  $("create").disabled = false;
  $("join").disabled = false;
  show("start");
  setStatus(message, kind);
}

function begin(mode) {
  if (phase !== "home") return;

  let id = roomInput.value.trim().toLowerCase();
  if (!id) {
    if (mode === "join") {
      setStatus("部屋IDを入力してください。", "err");
      roomInput.focus();
      return;
    }
    id = randomRoom();
  }

  if (!/^[a-z0-9]{1,24}$/.test(id)) {
    setStatus("部屋IDは半角英数字24文字以内で入力してください。", "err");
    roomInput.focus();
    return;
  }

  const name = cleanName(nameInput.value) || randomName();
  roomInput.value = id;
  nameInput.value = name;
  roomId = id;
  myName = name;
  phase = "connecting";
  $("create").disabled = true;
  $("join").disabled = true;
  setStatus("接続しています…");

  const endpoint = new URL("/ws", API_ORIGIN);
  endpoint.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  endpoint.searchParams.set("room", roomId);
  endpoint.searchParams.set("mode", mode);
  endpoint.searchParams.set("name", myName);

  let socket;
  try {
    socket = new WebSocket(endpoint.toString());
  } catch (error) {
    console.error("WebSocketの作成に失敗:", error);
    goHome("接続を開始できませんでした。", "err");
    return;
  }

  ws = socket;
  connectTimer = setTimeout(() => {
    if (socket === ws && phase === "connecting") {
      try { socket.close(); } catch (_) {}
      goHome("接続がタイムアウトしました。もう一度お試しください。", "err");
    }
  }, CONNECT_TIMEOUT_MS);

  socket.onmessage = (event) => {
    if (socket !== ws) return;
    handleMessage(socket, event.data);
  };

  socket.onclose = () => {
    if (socket !== ws) return;
    goHome(
      phase === "connecting"
        ? "サーバーに接続できませんでした。"
        : "接続が切断されたため、部屋を終了しました。",
      "err"
    );
  };
}

function startHeartbeat(socket) {
  lastPong = Date.now();
  clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => {
    if (socket !== ws || socket.readyState !== WebSocket.OPEN) return;

    if (Date.now() - lastPong > HEARTBEAT_TIMEOUT_MS) {
      goHome("通信がタイムアウトしました。部屋を終了しました。", "err");
      return;
    }

    try {
      socket.send("ping");
    } catch (_) {
      leaveRoom("接続が切れました。部屋を終了します。");
    }
  }, HEARTBEAT_INTERVAL_MS);
}

function handleMessage(socket, raw) {
  if (socket !== ws) return;
  if (raw === "pong") {
    lastPong = Date.now();
    return;
  }

  let message;
  try {
    message = JSON.parse(raw);
  } catch (_) {
    return;
  }

  switch (message.t) {
    case "waiting": {
      me = message.me || null;
      participants = Array.isArray(message.participants) ? message.participants : [];
      updateParticipantsUI(message.count);
      phase = "wait";
      clearTimeout(connectTimer);
      connectTimer = null;
      startHeartbeat(socket);
      $("wait-room").textContent = roomId;
      show("wait");
      setStatus(
        message.created
          ? "そのIDの部屋はなかったため、新しく作成しました。相手の入室を待っています。"
          : "部屋を作成しました。IDを相手に伝えてください。",
        "ok"
      );
      break;
    }
    case "start": {
      me = message.me || null;
      participants = Array.isArray(message.participants) ? message.participants : [];
      phase = "chat";
      clearTimeout(connectTimer);
      connectTimer = null;
      startHeartbeat(socket);
      $("me-name").textContent = myName;
      updateParticipantsUI(message.count);
      log.replaceChildren();
      show("chat");
      addSystemMessage(
        Number(message.count) > 2
          ? "チャットに参加しました。履歴はこの画面のメモリだけに残り、退出すると消えます。"
          : "相手が入室しました。履歴はこの画面のメモリだけに残り、退出すると消えます。"
      );
      input.focus();
      break;
    }
    case "joined": {
      if (Array.isArray(message.participants)) participants = message.participants;
      updateParticipantsUI(message.count);
      if (phase === "chat") {
        addSystemMessage((message.participant && message.participant.name ? message.participant.name : "参加者") + "が入室しました。");
      }
      break;
    }
    case "left": {
      if (Array.isArray(message.participants)) participants = message.participants;
      updateParticipantsUI(message.count);
      if (phase === "chat") {
        addSystemMessage((message.participant && message.participant.name ? message.participant.name : "参加者") + "が退出しました。");
      }
      break;
    }
    case "msg":
      if (phase === "chat") addMessage(message);
      break;
    case "error":
      if (message.fatal) {
        goHome(message.message || "部屋に接続できませんでした。", "err");
      } else {
        addSystemMessage(message.message || "メッセージを送信できませんでした。", "err");
      }
      break;
    case "ended":
      if (phase === "leaving") goHome("退出しました。");
      else goHome(message.reason || "部屋が終了しました。", "err");
      break;
    default:
      // 未知のイベントは無視する。
      break;
  }
}

function updateParticipantsUI(count) {
  const peerNames = participants
    .filter((participant) => participant && participant.me !== me && typeof participant.name === "string")
    .map((participant) => participant.name);
  $("peer-name").textContent = peerNames.length ? peerNames.join("・") : "相手";
  const parsedCount = Number(count);
  const visibleCount = Number.isInteger(parsedCount) && parsedCount >= 0 && parsedCount <= 4
    ? parsedCount
    : participants.length;
  $("member-count").textContent = "人数: " + visibleCount + "/4人";
}

function addSystemMessage(text, extraClass = "") {
  const item = document.createElement("li");
  item.className = "sys" + (extraClass ? " " + extraClass : "");
  item.textContent = text;
  log.appendChild(item);
  log.scrollTop = log.scrollHeight;
}

function addMessage(message) {
  if (typeof message.text !== "string") return;
  const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
  const item = document.createElement("li");
  const mine = message.from === me;
  item.className = mine ? "mine" : "theirs";

  const meta = document.createElement("div");
  meta.className = "meta";
  const date = new Date(Number(message.ts) || Date.now());
  const time = Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
  meta.textContent = (String(message.name || "ゲスト").slice(0, MAX_NAME) + "　" + time).trim();

  const body = document.createElement("div");
  body.className = "msg";
  appendLinkedText(body, message.text.slice(0, MAX_MSG));

  item.append(meta, body);
  log.appendChild(item);
  if (mine || nearBottom) log.scrollTop = log.scrollHeight;
}

function appendLinkedText(container, text) {
  // URLは http(s):// または www. から自動検知し、HTMLとして解釈せず安全にリンク化する。
  const pattern = /https?:\/\/[^\s<>"'、。！？]+|www\.[^\s<>"'、。！？]+/giu;
  const trailingPunctuation = /[.,!?;:、。！？）】」』〉》]+$/u;
  let cursor = 0;

  for (const match of text.matchAll(pattern)) {
    const start = match.index;
    const raw = match[0];
    let linkText = raw;
    while (linkText && trailingPunctuation.test(linkText)) linkText = linkText.slice(0, -1);
    while (linkText.endsWith(")") && (linkText.match(/\(/g) || []).length < (linkText.match(/\)/g) || []).length) {
      linkText = linkText.slice(0, -1);
    }

    container.appendChild(document.createTextNode(text.slice(cursor, start)));
    if (linkText) {
      const href = linkText.startsWith("www.") ? "https://" + linkText : linkText;
      try {
        const parsed = new URL(href);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("Unsupported URL protocol");
        const anchor = document.createElement("a");
        anchor.href = parsed.href;
        anchor.target = "_blank";
        anchor.rel = "noopener noreferrer nofollow";
        anchor.textContent = linkText;
        container.appendChild(anchor);
      } catch (_) {
        container.appendChild(document.createTextNode(linkText));
      }
    }
    container.appendChild(document.createTextNode(raw.slice(linkText.length)));
    cursor = start + raw.length;
  }
  container.appendChild(document.createTextNode(text.slice(cursor)));
}

function sendMessage() {
  const text = input.value.replace(/\r\n?/g, "\n").trim();
  if (!text || phase !== "chat" || !ws || ws.readyState !== WebSocket.OPEN) return;

  if ([...text].length > MAX_MSG) {
    addSystemMessage("メッセージは" + MAX_MSG + "文字までです。", "err");
    return;
  }

  try {
    ws.send(JSON.stringify({ t: "msg", text }));
    input.value = "";
    resizeInput();
    input.focus();
  } catch (_) {
    setStatus("送信に失敗しました。", "err");
  }
}

function leaveRoom(message = "退出しました。") {
  if (phase === "home" || phase === "leaving") return;
  clearTimeout(connectTimer);
  connectTimer = null;

  const socket = ws;
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    goHome(message);
    return;
  }

  phase = "leaving";
  setStatus("部屋を終了しています…");
  try {
    socket.send(JSON.stringify({ t: "leave" }));
  } catch (_) {
    goHome(message);
    return;
  }

  leaveTimer = setTimeout(() => {
    if (socket === ws) goHome(message);
  }, 1500);
}

async function copyRoomId() {
  let copied = false;
  try {
    await navigator.clipboard.writeText(roomId);
    copied = true;
  } catch (_) {
    const temporary = document.createElement("textarea");
    temporary.value = roomId;
    temporary.style.position = "fixed";
    temporary.style.opacity = "0";
    document.body.appendChild(temporary);
    temporary.select();
    try { copied = document.execCommand("copy"); } catch (_) {}
    temporary.remove();
  }

  $("copy").textContent = copied ? "コピーしました" : "IDを長押ししてコピー";
  setTimeout(() => { $("copy").textContent = "IDをコピー"; }, 1800);
}

roomInput.addEventListener("input", () => {
  roomInput.value = roomInput.value.replace(/[^a-zA-Z0-9]/g, "").slice(0, 24).toLowerCase();
});

$("create").addEventListener("click", () => begin("create"));
$("join").addEventListener("click", () => begin("join"));
$("copy").addEventListener("click", copyRoomId);
$("cancel").addEventListener("click", () => leaveRoom());
$("leave").addEventListener("click", () => leaveRoom());
$("form").addEventListener("submit", (event) => {
  event.preventDefault();
  sendMessage();
});
input.addEventListener("input", resizeInput);
input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
    event.preventDefault();
    sendMessage();
  }
});

// 再読み込み・タブ終了時は、サーバー側の部屋終了処理を要求する。
// pagehide時に通信できない場合は、サーバー側のWebSocket切断検知と心拍タイムアウトが後始末する。
window.addEventListener("pagehide", () => {
  try {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ t: "leave" }));
      ws.close(1000, "Page closed");
    }
  } catch (_) {}
});

show("start");
resizeInput();
