import { DurableObject } from "cloudflare:workers";

const OPEN = 1;
const MAX_MSG = 500;
const BURST = 5;
const REFILL_MS = 1000;
const ALARM_MS = 30000;
const STALE_MS = 75000;
const ROOM_RE = /^[a-z0-9]{1,24}$/;
const NAME_STRIP = /[\u0000-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g;
const STATIC_ALLOWED_ORIGINS = new Set([
  "https://freec.kesug.com",
  "https://www.freec.kesug.com",
  "https://ezsite-1234.github.io",
]);
const CSP = "default-src 'self'; connect-src 'self' wss:; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function cleanName(value) {
  return [...String(value ?? "").replace(NAME_STRIP, "").trim()].slice(0, 16).join("");
}

function send(ws, payload) {
  try {
    if (ws.readyState === OPEN) ws.send(JSON.stringify(payload));
  } catch (_) {
    // The socket may already be closing.
  }
}

function textResponse(text, status = 404) {
  return new Response(text, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}

function isAllowedOrigin(origin, workerOrigin, env) {
  if (origin === workerOrigin || STATIC_ALLOWED_ORIGINS.has(origin)) return true;
  const extras = String(env.EXTRA_ALLOWED_ORIGINS || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return extras.includes(origin);
}

function secureAssetResponse(response) {
  const headers = new Headers(response.headers);
  headers.set("Content-Security-Policy", CSP);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("Cache-Control", "no-cache");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      if (request.method !== "GET") return textResponse("Method Not Allowed", 405);
      return jsonResponse({ ok: true, service: "free-chat-test", websocket: "/ws" });
    }

    if (url.pathname !== "/ws") {
      return secureAssetResponse(await env.ASSETS.fetch(request));
    }

    if (request.method !== "GET") return textResponse("Method Not Allowed", 405);
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return textResponse("Expected WebSocket", 426);
    }

    const originHeader = request.headers.get("Origin");
    if (!originHeader) return textResponse("Forbidden", 403);
    let origin;
    try {
      origin = new URL(originHeader).origin;
    } catch (_) {
      return textResponse("Forbidden", 403);
    }
    if (!isAllowedOrigin(origin, url.origin, env)) return textResponse("Forbidden", 403);

    const room = (url.searchParams.get("room") || "").trim().toLowerCase();
    const mode = url.searchParams.get("mode");
    if (!ROOM_RE.test(room) || (mode !== "create" && mode !== "join")) {
      return textResponse("Bad Request", 400);
    }

    const id = env.ROOM.idFromName(room);
    return env.ROOM.get(id).fetch(request);
  },
};

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
  }

  members() {
    return this.ctx.getWebSockets().filter((ws) => {
      if (ws.readyState !== OPEN) return false;
      return ws.deserializeAttachment()?.joined === true;
    });
  }

  async fetch(request) {
    const params = new URL(request.url).searchParams;
    const mode = params.get("mode");
    const name = cleanName(params.get("name")) || this.randomGuestName();
    const peers = this.members();

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ joined: false });

    const reject = (code, message) => {
      send(server, { t: "error", fatal: true, code, message });
      try { server.close(4001, code); } catch (_) {}
    };

    // No await between checking membership and marking this connection joined.
    if (mode === "create" && peers.length > 0) {
      reject("exists", "この部屋IDはすでに使われています。別のIDを使用してください。");
      return new Response(null, { status: 101, webSocket: client });
    }
    if (peers.length >= 4) {
      reject("full", "この部屋は満員です（最大4人）。");
      return new Response(null, { status: 101, webSocket: client });
    }

    const now = Date.now();
    const me = crypto.randomUUID();
    server.serializeAttachment({
      joined: true,
      me,
      name,
      tokens: BURST,
      last: now,
      at: now,
    });

    const participants = peers.map((member) => {
      const memberInfo = member.deserializeAttachment();
      return { me: memberInfo.me, name: memberInfo.name };
    });
    participants.push({ me, name });

    if (peers.length === 0) {
      send(server, {
        t: "waiting",
        me,
        created: mode === "join",
        count: 1,
        participants,
      });
    } else {
      const peerList = participants.filter((participant) => participant.me !== me);
      const peer = peerList.length === 1 ? { name: peerList[0].name } : undefined;
      send(server, { t: "start", me, peer, count: participants.length, participants });

      if (peers.length === 1) {
        // The second participant starts the existing two-person chat as before.
        send(peers[0], {
          t: "start",
          me: peers[0].deserializeAttachment().me,
          peer: { name },
          count: participants.length,
          participants,
        });
      } else {
        // Third/fourth participants join the current chat without restarting it.
        const participant = { me, name };
        for (const existing of peers) {
          send(existing, {
            t: "joined",
            participant,
            count: participants.length,
            participants,
          });
        }
      }
    }

    await this.ctx.storage.setAlarm(now + ALARM_MS);
    return new Response(null, { status: 101, webSocket: client });
  }

  randomGuestName() {
    const colors = ["青い", "白い", "黒い", "赤い", "緑の", "黄色い", "静かな", "元気な"];
    const animals = ["ねこ", "いぬ", "きつね", "うさぎ", "くま", "ペンギン", "たぬき", "ふくろう"];
    const a = crypto.getRandomValues(new Uint32Array(1))[0] % colors.length;
    const b = crypto.getRandomValues(new Uint32Array(1))[0] % animals.length;
    const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1000;
    return colors[a] + animals[b] + n;
  }

  async webSocketMessage(ws, data) {
    const attachment = ws.deserializeAttachment();
    if (!attachment?.joined) return;

    if (data === "ping") {
      attachment.last = Date.now();
      ws.serializeAttachment(attachment);
      try { if (ws.readyState === OPEN) ws.send("pong"); } catch (_) {}
      return;
    }

    if (typeof data !== "string" || data.length > 4000) {
      try { ws.close(4002, "Invalid message"); } catch (_) {}
      return;
    }

    let message;
    try {
      message = JSON.parse(data);
    } catch (_) {
      send(ws, { t: "error", fatal: false, code: "bad", message: "不正なデータです。" });
      return;
    }

    if (message?.t === "leave") {
      await this.depart(ws, true, "相手が退出したため、部屋を終了しました。");
      return;
    }

    if (message?.t !== "msg" || typeof message.text !== "string") {
      send(ws, { t: "error", fatal: false, code: "bad", message: "不正なデータです。" });
      return;
    }

    const text = message.text
      .replace(/\r\n?/g, "\n")
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
      .replace(/\n{4,}/g, "\n\n\n")
      .trim();
    const length = [...text].length;

    if (!length) {
      send(ws, { t: "error", fatal: false, code: "empty", message: "メッセージが空です。" });
      return;
    }
    if (length > MAX_MSG) {
      send(ws, { t: "error", fatal: false, code: "long", message: "メッセージは500文字までです。" });
      return;
    }

    const now = Date.now();
    attachment.tokens = Math.min(BURST, attachment.tokens + (now - attachment.last) / REFILL_MS);
    attachment.last = now;
    if (attachment.tokens < 1) {
      ws.serializeAttachment(attachment);
      send(ws, { t: "error", fatal: false, code: "rate", message: "送信が速すぎます。少し待ってください。" });
      return;
    }
    attachment.tokens -= 1;
    ws.serializeAttachment(attachment);

    const participants = this.members();
    if (participants.length < 2) return;

    const payload = {
      t: "msg",
      from: attachment.me,
      name: attachment.name,
      text,
      ts: now,
    };
    for (const participant of participants) send(participant, payload);
  }

  async webSocketClose(ws) {
    await this.finish(ws, "相手が退出したため、部屋を終了しました。");
  }

  async webSocketError(ws) {
    await this.finish(ws, "相手との接続が切れたため、部屋を終了しました。");
  }

  async finish(ws, reason) {
    await this.depart(ws, false, reason);
  }

  async depart(ws, explicit, fallbackReason) {
    const attachment = ws.deserializeAttachment();
    if (attachment?.joined !== true) return;

    // When the departure leaves at least two people behind, keep the group alive.
    // With only one or zero people remaining, retain the original room-ending behavior.
    const remaining = this.members().filter((member) => member !== ws);
    if (remaining.length >= 2) {
      ws.serializeAttachment({ ...attachment, joined: false });
      const participants = remaining.map((member) => {
        const info = member.deserializeAttachment();
        return { me: info.me, name: info.name };
      });
      const participant = { me: attachment.me, name: attachment.name };

      for (const member of remaining) {
        send(member, {
          t: "left",
          participant,
          count: participants.length,
          participants,
        });
      }

      if (explicit) send(ws, { t: "ended", reason: "退出しました。" });
      try { ws.close(1000, "left"); } catch (_) {}
      await this.ctx.storage.setAlarm(Date.now() + ALARM_MS);
      return;
    }

    // A two-person chat still ends for everyone when one of them leaves.
    await this.endRoom(fallbackReason);
  }

  async endRoom(reason) {
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment();
      if (attachment?.joined !== true) continue;
      ws.serializeAttachment({ ...attachment, joined: false });
      send(ws, { t: "ended", reason });
      try { ws.close(4000, "ended"); } catch (_) {}
    }
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  async alarm() {
    const participants = this.members();
    if (participants.length === 0) {
      await this.ctx.storage.deleteAll();
      return;
    }

    const now = Date.now();
    for (const ws of participants) {
      const attachment = ws.deserializeAttachment();
      if (now - (attachment.last || attachment.at || 0) > STALE_MS) {
        await this.depart(ws, false, "接続が途切れたため、部屋を終了しました。");
        // Re-evaluate current membership; a group may continue after one stale member leaves.
        return this.alarm();
      }
    }
    await this.ctx.storage.setAlarm(now + ALARM_MS);
  }
}
