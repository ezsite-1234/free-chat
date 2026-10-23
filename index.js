import { DurableObject } from "cloudflare:workers";

const OPEN = 1, MAX_MSG = 500, BURST = 5, REFILL_MS = 1000, ALARM_MS = 30000, STALE_MS = 75000;
const ROOM_RE = /^[a-z0-9]{1,24}$/;
const NAME_STRIP = /[\u0000-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g;
const cleanName = (s) => [...String(s ?? "").replace(NAME_STRIP, "").trim()].slice(0, 16).join("");
const send = (ws, o) => { try { ws.send(JSON.stringify(o)); } catch {} };
const HTML = "<!doctype html>\n<html lang=\"ja\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover\">\n<meta name=\"robots\" content=\"noindex\">\n<title>FREE CHAT</title>\n<link rel=\"stylesheet\" href=\"/style.css\">\n</head>\n<body>\n<main class=\"card\">\n  <h1 data-app-name></h1>\n\n  <section id=\"s-start\">\n    <label for=\"room\">部屋ID</label>\n    <input id=\"room\" maxlength=\"24\" autocomplete=\"off\" autocapitalize=\"none\" autocorrect=\"off\" spellcheck=\"false\" placeholder=\"半角英数字・最大24文字\">\n    <p class=\"note\">相手が作成した部屋のIDを入力しましょう。IDは部屋を作成した人に表示されています。存在しないIDを入力した場合は部屋を新規作成します。</p>\n    <label for=\"name\">名前</label>\n    <input id=\"name\" maxlength=\"16\" autocomplete=\"off\" placeholder=\"未入力なら自動で決まります\">\n    <div class=\"row\">\n      <button id=\"create\" class=\"primary\" type=\"button\">作成</button>\n      <button id=\"join\" type=\"button\">入室</button>\n    </div>\n  </section>\n\n  <section id=\"s-wait\" hidden>\n    <p>この部屋IDを相手に伝えてください。</p>\n    <div id=\"wait-room\" class=\"roomid\"></div>\n    <div class=\"row\"><button id=\"copy\" class=\"primary\" type=\"button\">IDをコピー</button><button id=\"cancel\" type=\"button\">退出</button></div>\n    <p class=\"waiting\"><span class=\"spinner\"></span>相手の接続を待っています…</p>\n  </section>\n\n  <section id=\"s-chat\" hidden>\n    <header class=\"head\">\n      <div class=\"who\">あなた <b id=\"me-name\"></b>／相手 <b id=\"peer-name\"></b></div>\n      <span class=\"conn\">● 接続中</span>\n      <button id=\"leave\" type=\"button\">退出</button>\n    </header>\n    <ol id=\"log\" aria-live=\"polite\"></ol>\n    <form id=\"form\">\n      <textarea id=\"input\" rows=\"1\" maxlength=\"500\" placeholder=\"メッセージを入力\" aria-label=\"メッセージ\"></textarea>\n      <button id=\"send\" class=\"primary\" type=\"submit\">送信</button>\n    </form>\n    <p class=\"hint\">Enterで送信／Shift+Enterで改行　<span id=\"count\">0/500</span></p>\n  </section>\n\n  <p id=\"status\" class=\"status\" role=\"status\" aria-live=\"polite\"></p>\n</main>\n<script src=\"/app.js\"></script>\n</body>\n</html>\n";
const CSS = ":root{--card:#0b1226;--line:#1c2850;--fg:#e6ebff;--mute:#9aa6cf;--acc:#5b8cff;--mine:#1c3a8c;--their:#141d3b;--err:#ff8a98;--ok:#6fe3b0}\n*{box-sizing:border-box}\n[hidden]{display:none!important}\nhtml,body{height:100%;margin:0}\nbody{background:linear-gradient(160deg,#000 0%,#0a1230 100%) fixed;color:var(--fg);font:16px/1.6 system-ui,\"Hiragino Sans\",\"Noto Sans JP\",sans-serif;display:flex;align-items:center;justify-content:center;padding:16px}\n.card{width:100%;max-width:440px;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:24px}\nh1{margin:0 0 12px;font-size:1.4rem}\nlabel{display:block;margin:16px 0 6px;color:var(--mute);font-size:.9rem}\ninput,textarea{width:100%;font:inherit;color:var(--fg);background:#060b1c;border:1px solid var(--line);border-radius:10px;padding:12px;min-height:48px}\ninput:focus,textarea:focus,button:focus-visible{outline:2px solid var(--acc);outline-offset:1px}\nbutton{font:inherit;min-height:48px;padding:0 18px;border-radius:10px;border:1px solid var(--line);background:#111a38;color:var(--fg);cursor:pointer}\nbutton.primary{background:var(--acc);border-color:var(--acc);color:#04091a;font-weight:700}\nbutton:disabled{opacity:.5;cursor:default}\n.row{display:flex;gap:10px;margin-top:18px}.row button{flex:1}\n.note{margin:8px 0 0;color:var(--mute);font-size:.85rem}\n.status{min-height:1.6em;margin:16px 0 0;font-size:.95rem;color:var(--mute)}.status.err{color:var(--err)}.status.ok{color:var(--ok)}\n.roomid{margin:12px 0;padding:14px;border:1px dashed var(--acc);border-radius:10px;font:700 1.25rem ui-monospace,monospace;word-break:break-all;text-align:center;user-select:all}\n.waiting{display:flex;align-items:center;gap:10px;color:var(--mute)}\n.spinner{width:16px;height:16px;border:2px solid var(--line);border-top-color:var(--acc);border-radius:50%;animation:spin 1s linear infinite}\n@keyframes spin{to{transform:rotate(360deg)}}\n@media (prefers-reduced-motion:reduce){.spinner{animation-duration:4s}}\nbody.is-chat{padding:0}\nbody.is-chat .card{max-width:720px;height:100dvh;border-radius:0;border-width:0 1px;padding:0;display:flex;flex-direction:column}\nbody.is-chat h1,body.is-chat .status{display:none}\n#s-chat{display:flex;flex-direction:column;flex:1;min-height:0}\n.head{display:flex;align-items:center;gap:10px;padding:calc(10px + env(safe-area-inset-top)) 14px 10px;border-bottom:1px solid var(--line)}\n.who{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:.95rem}\n.head button{min-height:40px}\n.conn{color:var(--ok);font-size:.85rem;white-space:nowrap}\n#log{flex:1;min-height:0;overflow-y:auto;list-style:none;margin:0;padding:14px;display:flex;flex-direction:column;gap:10px}\n#log li{max-width:82%;padding:8px 12px;border-radius:12px;overflow-wrap:anywhere}\nli.mine{align-self:flex-end;background:var(--mine)}li.theirs{align-self:flex-start;background:var(--their)}\nli.sys{align-self:center;max-width:100%!important;color:var(--mute);font-size:.85rem;padding:0!important;background:none}\nli.err{color:var(--err)}\n.meta{font-size:.75rem;color:var(--mute);margin-bottom:2px}li.mine .meta{color:#c9d4ff}\n.msg{white-space:pre-wrap}\n#form{display:flex;gap:8px;padding:10px 14px 4px;align-items:flex-end}\n#input{resize:none;max-height:120px}\n.hint{margin:0;padding:2px 14px calc(8px + env(safe-area-inset-bottom));color:var(--mute);font-size:.78rem}\n";
const JS = "const APP_NAME = \"FREE CHAT\"; // ← アプリ名はここだけ変更すればOK\nconst MAX_NAME = 16, MAX_MSG = 500;\nconst $ = (id) => document.getElementById(id);\nconst log = $(\"log\"), input = $(\"input\");\nlet ws = null, me = null, myName = \"\", roomId = \"\", phase = \"home\", lastPong = 0, tConn = 0, tPing = 0;\n\ndocument.title = APP_NAME;\ndocument.querySelectorAll(\"[data-app-name]\").forEach((e) => (e.textContent = APP_NAME));\n\nconst STRIP = /[\\u0000-\\u001F\\u007F\\u200B-\\u200F\\u202A-\\u202E\\u2066-\\u2069]/g;\nconst cleanName = (s) => [...s.replace(STRIP, \"\").trim()].slice(0, MAX_NAME).join(\"\");\nconst rnd = (n) => crypto.getRandomValues(new Uint32Array(1))[0] % n;\nconst pick = (a) => a[rnd(a.length)];\nconst randName = () =>\n  pick([\"青い\", \"赤い\", \"白い\", \"小さな\", \"元気な\", \"静かな\", \"眠そうな\", \"優しい\"]) +\n  pick([\"ねこ\", \"いぬ\", \"うさぎ\", \"きつね\", \"たぬき\", \"くま\", \"ふくろう\", \"いるか\"]) + (10 + rnd(90));\n// 32文字のアルファベット×256通りのバイト値 → 偏りなし。16文字 ≒ 80bit\nconst randRoom = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (x) => \"abcdefghijklmnopqrstuvwxyz234567\"[x & 31]).join(\"\");\n\nfunction show(id) {\n  for (const s of [\"start\", \"wait\", \"chat\"]) $(\"s-\" + s).hidden = s !== id;\n  document.body.classList.toggle(\"is-chat\", id === \"chat\");\n}\nfunction status(text, kind = \"\") { const el = $(\"status\"); el.textContent = text; el.className = \"status \" + kind; }\n\n// 最初の画面へ戻る（退出・終了・切断・エラー共通）。古い部屋情報は一切残さない。\nfunction goHome(msg, kind = \"\") {\n  clearTimeout(tConn); clearInterval(tPing);\n  const s = ws; ws = null; me = null; phase = \"home\";\n  if (s) { s.onmessage = s.onclose = s.onopen = null; try { s.close(1000); } catch {} }\n  log.replaceChildren(); input.value = \"\"; resize();\n  $(\"create\").disabled = $(\"join\").disabled = false;\n  show(\"start\"); status(msg || \"\", kind);\n}\n\nfunction begin(mode) {\n  if (phase !== \"home\") return;\n  let id = $(\"room\").value.trim().toLowerCase();\n  if (!id) { if (mode === \"join\") return status(\"部屋IDを入力してください。\", \"err\"); id = randRoom(); }\n  if (!/^[a-z0-9]{1,24}$/.test(id)) return status(\"部屋IDは半角英数字24文字以内で入力してください。\", \"err\");\n  const name = cleanName($(\"name\").value) || randName();\n  $(\"room\").value = id; $(\"name\").value = name;\n  roomId = id; myName = name; phase = \"connecting\";\n  $(\"create\").disabled = $(\"join\").disabled = true;\n  status(\"接続しています…\");\n  const sock = (ws = new WebSocket(`${location.protocol === \"https:\" ? \"wss\" : \"ws\"}://${location.host}/ws?room=${id}&mode=${mode}&name=${encodeURIComponent(name)}`));\n  tConn = setTimeout(() => phase === \"connecting\" && goHome(\"接続がタイムアウトしました。もう一度お試しください。\", \"err\"), 10000);\n  sock.onmessage = (e) => onMessage(sock, e.data);\n  sock.onclose = () => sock === ws && goHome(phase === \"connecting\" ? \"サーバーに接続できませんでした。\" : \"接続が切断されたため、部屋を終了しました。\", \"err\");\n}\n\nfunction startPing() {\n  lastPong = Date.now(); clearInterval(tPing);\n  tPing = setInterval(() => {\n    if (Date.now() - lastPong > 60000) return goHome(\"通信がタイムアウトしました。部屋を終了しました。\", \"err\");\n    if (ws && ws.readyState === 1) ws.send(\"ping\");\n  }, 20000);\n}\n\nfunction onMessage(sock, data) {\n  if (sock !== ws) return;\n  if (data === \"pong\") { lastPong = Date.now(); return; }\n  let m; try { m = JSON.parse(data); } catch { return; }\n  if (m.t === \"waiting\") {\n    me = m.me; phase = \"wait\"; clearTimeout(tConn); startPing();\n    $(\"wait-room\").textContent = roomId; show(\"wait\");\n    status(m.created ? \"そのIDの部屋はなかったため、新しく作成しました。相手の入室を待っています。\" : \"部屋を作成しました。IDを相手に伝えてください。\", \"ok\");\n  } else if (m.t === \"start\") {\n    me = m.me; phase = \"chat\"; clearTimeout(tConn); startPing();\n    $(\"me-name\").textContent = myName; $(\"peer-name\").textContent = m.peer.name;\n    log.replaceChildren(); show(\"chat\"); sys(\"相手が入室しました。履歴はこの画面のメモリだけに残り、退出すると消えます。\");\n  } else if (m.t === \"msg\") addMsg(m);\n  else if (m.t === \"error\") m.fatal ? goHome(m.message, \"err\") : sys(m.message, \"err\");\n  else if (m.t === \"ended\") goHome(m.reason || \"部屋が終了しました。\", \"err\");\n}\n\nfunction sys(text, cls = \"\") {\n  const li = document.createElement(\"li\"); li.className = \"sys \" + cls; li.textContent = text;\n  log.append(li); log.scrollTop = log.scrollHeight;\n}\nfunction addMsg(m) {\n  const near = log.scrollHeight - log.scrollTop - log.clientHeight < 80;\n  const mine = m.from === me;\n  const li = document.createElement(\"li\"); li.className = mine ? \"mine\" : \"theirs\";\n  const meta = document.createElement(\"div\"); meta.className = \"meta\";\n  meta.textContent = `${m.name}　${new Date(m.ts).toLocaleTimeString(\"ja-JP\", { hour: \"2-digit\", minute: \"2-digit\" })}`;\n  const body = document.createElement(\"div\"); body.className = \"msg\"; body.textContent = m.text; // textContentのみ使用: HTMLは解釈されない\n  li.append(meta, body); log.append(li);\n  if (mine || near) log.scrollTop = log.scrollHeight;\n}\n\nfunction send() {\n  const t = input.value.replace(/\\r\\n?/g, \"\\n\").trim();\n  if (!t || phase !== \"chat\" || !ws || ws.readyState !== 1) return;\n  if ([...t].length > MAX_MSG) return sys(`メッセージは${MAX_MSG}文字までです。`, \"err\");\n  ws.send(JSON.stringify({ t: \"msg\", text: t }));\n  input.value = \"\"; resize();\n}\nfunction resize() {\n  input.style.height = \"auto\"; input.style.height = Math.min(input.scrollHeight, 120) + \"px\";\n  const n = [...input.value].length; $(\"count\").textContent = `${n}/${MAX_MSG}`;\n}\n\nasync function copyId() {\n  let ok = false;\n  try { await navigator.clipboard.writeText(roomId); ok = true; } catch {\n    const t = document.createElement(\"textarea\"); t.value = roomId; document.body.append(t); t.select();\n    try { ok = document.execCommand(\"copy\"); } catch {} t.remove();\n  }\n  $(\"copy\").textContent = ok ? \"コピーしました\" : \"IDを長押ししてコピー\";\n  setTimeout(() => ($(\"copy\").textContent = \"IDをコピー\"), 2000);\n}\n\n$(\"room\").addEventListener(\"input\", (e) => (e.target.value = e.target.value.replace(/[^a-zA-Z0-9]/g, \"\").toLowerCase()));\n$(\"create\").onclick = () => begin(\"create\");\n$(\"join\").onclick = () => begin(\"join\");\n$(\"copy\").onclick = copyId;\n$(\"cancel\").onclick = $(\"leave\").onclick = () => goHome(\"退出しました。\");\n$(\"form\").addEventListener(\"submit\", (e) => { e.preventDefault(); send(); });\ninput.addEventListener(\"input\", resize);\ninput.addEventListener(\"keydown\", (e) => {\n  if (e.key === \"Enter\" && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); send(); } // 日本語変換中のEnterは送信しない\n});\n// 補助的な通知（これに依存しない: サーバーはWebSocketのcloseを検知して部屋を終了する）\naddEventListener(\"pagehide\", () => { try { ws && ws.close(1000); } catch {} });\n";
const PAGES = { "/": ["text/html; charset=utf-8", HTML], "/index.html": ["text/html; charset=utf-8", HTML], "/style.css": ["text/css; charset=utf-8", CSS], "/app.js": ["text/javascript; charset=utf-8", JS] };
const SEC = { "Content-Security-Policy": "default-src 'self'; connect-src 'self' wss: ws:; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Cache-Control": "no-cache" };

// 入口: /ws だけを部屋IDごとのDurable Objectへ振り分ける（画面のHTML/CSS/JSもこのファイルから配信）
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/ws") {
      const f = PAGES[url.pathname];
      if (!f || (request.method !== "GET" && request.method !== "HEAD")) return new Response("Not found", { status: 404 });
      return new Response(request.method === "HEAD" ? null : f[1], { headers: { "Content-Type": f[0], ...SEC } });
    }
    if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected WebSocket", { status: 426 });
    const origin = request.headers.get("Origin");
    if (origin) {
      let ok = false;
      try { ok = new URL(origin).host === url.host; } catch {}
      if (!ok) return new Response("Forbidden", { status: 403 });
    }
    const room = (url.searchParams.get("room") || "").trim().toLowerCase();
    const mode = url.searchParams.get("mode");
    if (!ROOM_RE.test(room) || (mode !== "create" && mode !== "join")) return new Response("Bad request", { status: 400 });
    return env.ROOM.get(env.ROOM.idFromName(room)).fetch(request);
  },
};

// 1部屋 = 1 Durable Object。メッセージは中継のみで、storageには何も書かない。
export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  members() {
    return this.ctx.getWebSockets().filter((w) => w.readyState === OPEN && w.deserializeAttachment()?.joined);
  }

  async fetch(request) {
    const p = new URL(request.url).searchParams;
    const mode = p.get("mode");
    const name = cleanName(p.get("name")) || "ゲスト" + (10 + (crypto.getRandomValues(new Uint8Array(1))[0] % 90));
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ joined: false });
    // ここから serializeAttachment までawaitが無いので、同時入室でも3人目は必ず弾かれる
    const peers = this.members();
    const reject = (code, message) => { send(server, { t: "error", fatal: true, code, message }); server.close(4001, code); };
    if (mode === "create" && peers.length > 0) reject("exists", "この部屋IDはすでに使われています。別のIDにするか「入室」を使ってください。");
    else if (peers.length >= 2) reject("full", "この部屋は満員です");
    else {
      const now = Date.now(), me = crypto.randomUUID();
      server.serializeAttachment({ joined: true, me, name, tokens: BURST, last: now, at: now });
      if (peers.length === 0) send(server, { t: "waiting", me, created: mode === "join" });
      else {
        const o = peers[0].deserializeAttachment();
        send(server, { t: "start", me, peer: { name: o.name } });
        send(peers[0], { t: "start", me: o.me, peer: { name } });
      }
      await this.ctx.storage.setAlarm(now + ALARM_MS);
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, data) {
    const a = ws.deserializeAttachment();
    if (!a?.joined) return;
    const bad = (code, message) => send(ws, { t: "error", fatal: false, code, message });
    if (typeof data !== "string" || data.length > 4000) { ws.close(4002, "bad"); return; }
    let m;
    try { m = JSON.parse(data); } catch { return bad("bad", "不正なデータです"); }
    if (m?.t !== "msg" || typeof m.text !== "string") return bad("bad", "不正なデータです");
    const text = m.text.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").replace(/\n{4,}/g, "\n\n\n").trim();
    const len = [...text].length;
    if (!len) return bad("empty", "メッセージが空です");
    if (len > MAX_MSG) return bad("long", `メッセージは${MAX_MSG}文字までです`);
    const now = Date.now();
    a.tokens = Math.min(BURST, a.tokens + (now - a.last) / REFILL_MS);
    a.last = now;
    if (a.tokens < 1) { ws.serializeAttachment(a); return bad("rate", "送信が速すぎます。少し待ってください"); }
    a.tokens -= 1;
    ws.serializeAttachment(a);
    const ms = this.members();
    if (ms.length !== 2) return;
    const out = JSON.stringify({ t: "msg", from: a.me, name: a.name, text, ts: now });
    for (const w of ms) w.send(out);
  }

  async webSocketClose(ws) {
    try { ws.close(1000, "bye"); } catch {}
    await this.finish(ws, "相手が退出したため、部屋を終了しました。");
  }
  async webSocketError(ws) { await this.finish(ws, "相手との接続が切れたため、部屋を終了しました。"); }
  async finish(ws, reason) { if (ws.deserializeAttachment()?.joined) await this.endRoom(reason); }

  // 全員に通知して切断し、参加者情報(attachment)を無効化。終了済みソケットの遅れて届くcloseは無視される。
  async endRoom(reason) {
    for (const w of this.ctx.getWebSockets()) {
      const a = w.deserializeAttachment();
      if (!a?.joined) continue;
      w.serializeAttachment({ ...a, joined: false });
      if (w.readyState === OPEN) send(w, { t: "ended", reason });
      try { w.close(4000, "ended"); } catch {}
    }
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  // 心拍監視: クライアントのping(自動応答)も送信もSTALE_MS無い参加者がいれば部屋を終了
  async alarm() {
    const ms = this.members();
    if (!ms.length) return;
    const now = Date.now();
    for (const w of ms) {
      const a = w.deserializeAttachment();
      const t = this.ctx.getWebSocketAutoResponseTimestamp(w)?.getTime() ?? 0;
      if (now - Math.max(t, a.last, a.at) > STALE_MS) return this.endRoom("接続が途切れたため、部屋を終了しました。");
    }
    await this.ctx.storage.setAlarm(now + ALARM_MS);
  }
}
