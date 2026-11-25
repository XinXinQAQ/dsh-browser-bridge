#!/usr/bin/env node
/**
 * DSH Browser Bridge  (v2 — broker architecture)
 *
 * MODE=native (spawned by Chrome/Edge via Native Messaging host "com.workbuddy_ai.extension"):
 *   stdin/stdout  <-> browser extension protocol (4-byte LE length prefix + JSON)
 *   TCP CLIENT    <-> connects to broker at 127.0.0.1:PORT, registers, serves RPC.
 *   Exits when the extension disconnects (stdin end/error/close) or on a stale lease.
 *
 * MODE=mcp (default; spawned by DSH's dsh-mcp-client over stdio):
 *   stdin/stdout  <-> MCP JSON-RPC 2.0 (newline-delimited JSON)
 *   TCP SERVER    <-> broker: accepts native hosts, tracks which one is ready,
 *                     routes tool calls to the newest READY host.
 *
 * Why broker architecture: the browser may spawn several native hosts over time
 * (and on restart). If a native host owned the listening port, a stale/zombie
 * process could hold it forever and MCP would talk to a dead server. With the
 * MCP process owning the port, any freshly started native host simply connects
 * in and, once its extension handshake completes, becomes the active provider.
 *
 * No third-party dependencies: plain node:net / node:crypto.
 */
import net from 'node:net';
import crypto from 'node:crypto';
import fs from 'node:fs';

const MODE = process.argv.includes('--native') ? 'native' : 'mcp';
const PORT = Number(process.env.DSH_BROWSER_BRIDGE_PORT || 18765);
const HOST = '127.0.0.1';
const LOG = process.env.DSH_BROWSER_BRIDGE_LOG || '';
const PROTOCOL_VERSION = 1;
const COMMAND_TIMEOUT_MS = 80000;
const LEASE_TTL_MS = 30000;
const STALE_AFTER_MS = 2 * LEASE_TTL_MS; // exit if no extension traffic for 60s

function log(...args) {
  if (!LOG) return;
  try {
    const line = `[${MODE} ${process.pid} ${new Date().toISOString()}] ` +
      args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') + '\n';
    fs.appendFileSync(LOG, line);
  } catch {}
}

// =====================================================================
// NATIVE MODE
// =====================================================================
class ExtensionProtocol {
  constructor(onStateChange) {
    this.buf = Buffer.alloc(0);
    this.ready = false;
    this.helloSeen = false;
    this.providerEpoch = crypto.randomUUID();
    this.providerInstanceId = crypto.randomUUID();
    this.channelEpoch = null;
    this.nextId = 1;
    this.pending = new Map();
    this.lastTrafficAt = Date.now();
    this.onStateChange = onStateChange || (() => {});
    this.dead = false;
  }

  start() {
    process.stdin.on('data', c => this._feed(c));
    const die = reason => {
      if (this.dead) return;
      this.dead = true;
      this.ready = false;
      this.onStateChange(false);
      log('extension disconnected (' + reason + '); exiting native host');
      setTimeout(() => process.exit(0), 50);
    };
    process.stdin.on('end', () => die('stdin end'));
    process.stdin.on('close', () => die('stdin close'));
    process.stdin.on('error', e => die('stdin error: ' + String(e)));
    process.stdout.on('error', e => die('stdout error: ' + String(e)));

    // Watchdog: if the extension goes half-open (no traffic beyond the renew
    // cadence), exit so a fresh native host can take over cleanly.
    this.watchdog = setInterval(() => {
      if (!this.dead && Date.now() - this.lastTrafficAt > STALE_AFTER_MS) {
        die('stale lease (' + STALE_AFTER_MS + 'ms no traffic)');
      }
    }, 10000);
    this.watchdog.unref?.();
  }

  _feed(chunk) {
    this.lastTrafficAt = Date.now();
    this.buf = Buffer.concat([this.buf, chunk]);
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32LE(0);
      if (len > 16 * 1024 * 1024) { this.buf = Buffer.alloc(0); return; }
      if (this.buf.length < 4 + len) break;
      const payload = this.buf.subarray(4, 4 + len);
      this.buf = this.buf.subarray(4 + len);
      let msg;
      try { msg = JSON.parse(payload.toString('utf8')); } catch { continue; }
      this._handle(msg);
    }
  }

  post(obj) {
    if (this.dead) return;
    const data = Buffer.from(JSON.stringify(obj), 'utf8');
    const head = Buffer.alloc(4);
    head.writeUInt32LE(data.length, 0);
    process.stdout.write(Buffer.concat([head, data]));
  }

  _handle(msg) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'provider_hello': {
        if (this.helloSeen) return;
        this.helloSeen = true;
        const min = msg.protocol_min ?? 1;
        const max = msg.protocol_max ?? 1;
        if (!(min <= PROTOCOL_VERSION && PROTOCOL_VERSION <= max)) {
          log('protocol mismatch', min, max);
          return;
        }
        this.post({
          type: 'provider_hello_ack',
          protocol: PROTOCOL_VERSION,
          provider_epoch: this.providerEpoch,
          provider_instance_id: this.providerInstanceId,
          lease_ttl_ms: LEASE_TTL_MS,
        });
        this.ready = true;
        this.channelEpoch = 'dsh-' + crypto.randomUUID();
        this.post({
          type: 'channel_open',
          channel_epoch: this.channelEpoch,
          lease_ttl_ms: LEASE_TTL_MS,
          session_id: 'dsh-browser-bridge',
        });
        this.renewTimer = setInterval(() => {
          if (!this.dead && this.ready && this.channelEpoch) {
            this.post({ type: 'channel_renew', channel_epoch: this.channelEpoch, lease_deadline_ms: LEASE_TTL_MS });
          }
        }, 10000);
        this.renewTimer.unref?.();
        log('hello acked; extension', msg.extension_id, msg.browser_name);
        this.onStateChange(true);
        break;
      }
      case 'provider_result': {
        const p = this.pending.get(msg.command_id);
        if (!p) return;
        this.pending.delete(msg.command_id);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg.result ?? null);
        else p.reject(new Error((msg.error && msg.error.message) || 'browser command failed'));
        break;
      }
      case 'channel_closed':
        log('channel_closed by extension', msg.reason);
        this.ready = false;
        this.onStateChange(false);
        // channel closed means the extension dropped this channel; this host
        // can no longer serve calls, so release everything for a fresh one.
        setTimeout(() => { if (!this.dead) { this.dead = true; process.exit(0); } }, 50);
        break;
      case 'channel_close_ack':
        log('channel_close_ack');
        break;
      default:
        log('unexpected extension message', msg.type);
    }
  }

  call(method, params = {}) {
    return new Promise((resolve, reject) => {
      if (this.dead || !this.ready || !this.channelEpoch) return reject(new Error('扩展尚未完成握手'));
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`浏览器命令超时: ${method}`));
      }, COMMAND_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.post({ type: 'command', command_id: id, channel_epoch: this.channelEpoch, method, params });
    });
  }
}

function runNativeHost() {
  const ext = new ExtensionProtocol(state => {
    if (brokerSocket && !brokerSocket.destroyed) {
      brokerSocket.write(JSON.stringify({ type: 'status', ready: state }) + '\n');
    }
  });
  ext.start();

  let brokerSocket = null;
  let rpcBuf = '';
  let reconnectTimer = null;

  function connectBroker() {
    const s = net.createConnection({ host: HOST, port: PORT });
    s.setNoDelay(true);
    brokerSocket = s;
    s.on('connect', () => {
      log('connected to broker');
      if (reconnectTimer) { clearInterval(reconnectTimer); reconnectTimer = null; }
      s.write(JSON.stringify({ type: 'register', role: 'native', pid: process.pid, ready: ext.ready }) + '\n');
    });
    s.on('data', chunk => {
      rpcBuf += chunk.toString('utf8');
      let i;
      while ((i = rpcBuf.indexOf('\n')) >= 0) {
        const line = rpcBuf.slice(0, i).trim();
        rpcBuf = rpcBuf.slice(i + 1);
        if (!line) continue;
        let req;
        try { req = JSON.parse(line); } catch { continue; }
        if (req.type === 'ping') {
          s.write(JSON.stringify({ type: 'pong', ready: ext.ready, pid: process.pid }) + '\n');
        } else if (req.type === 'call') {
          ext.call(req.method, req.params || {})
            .then(result => { if (!s.destroyed) s.write(JSON.stringify({ type: 'result', id: req.id, ok: true, result }) + '\n'); })
            .catch(err => { if (!s.destroyed) s.write(JSON.stringify({ type: 'result', id: req.id, ok: false, error: String(err && err.message || err) }) + '\n'); });
        }
      }
    });
    s.on('error', () => {});
    s.on('close', () => {
      if (brokerSocket === s) brokerSocket = null;
      if (ext.dead) return;
      log('broker disconnected; retrying in 1.5s');
      if (!reconnectTimer) reconnectTimer = setInterval(() => {
        if (!brokerSocket || brokerSocket.destroyed) connectBroker();
      }, 1500);
    });
  }
  connectBroker();
}

// =====================================================================
// MCP MODE — MCP stdio server + broker (TCP server)
// =====================================================================
const TOOLS = [
  { name: 'browser_status', description: '检查浏览器桥接是否连接到扩展，并返回浏览器能力信息及受控标签页列表。操作浏览器前先调用此工具。', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'browser_open', description: '打开一个新的浏览器标签页并导航到指定 URL（仅 http/https）。返回 tabId 和 generation，后续操作必须使用它们。', inputSchema: { type: 'object', properties: { url: { type: 'string', description: '绝对 http(s) URL' } }, required: ['url'], additionalProperties: false } },
  { name: 'browser_tabs', description: '列出可认领的用户标签页（默认）或本会话已受控的标签页。认领前先调用本工具获取 tabId 与 generation。', inputSchema: { type: 'object', properties: { controlled: { type: 'boolean', description: 'true=已受控标签，false=可认领的用户标签（默认）' } }, additionalProperties: false } },
  { name: 'browser_claim', description: '认领一个用户标签页以进行控制。需要 browser_tabs 返回的 tabId 和 generation。', inputSchema: { type: 'object', properties: { tabId: { type: ['string', 'number'] }, generation: { type: 'number' } }, required: ['tabId', 'generation'], additionalProperties: false } },
  { name: 'browser_navigate', description: '将受控标签页导航到指定 URL。', inputSchema: { type: 'object', properties: { tabId: { type: ['string', 'number'] }, generation: { type: 'number' }, url: { type: 'string' } }, required: ['tabId', 'generation', 'url'], additionalProperties: false } },
  { name: 'browser_screenshot', description: '截取受控标签页的屏幕截图，返回 base64 图片数据和尺寸。', inputSchema: { type: 'object', properties: { tabId: { type: ['string', 'number'] }, generation: { type: 'number' }, format: { type: 'string', enum: ['jpeg', 'png'] }, quality: { type: 'integer', description: 'jpeg 质量 1-100' }, fullPage: { type: 'boolean' }, clip: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' } }, required: ['x', 'y', 'width', 'height'], additionalProperties: false } }, required: ['tabId', 'generation'], additionalProperties: false } },
  { name: 'browser_dom', description: '获取受控标签页的可见 DOM 快照（含 node_id）。配合 browser_dom_click 使用。', inputSchema: { type: 'object', properties: { tabId: { type: ['string', 'number'] }, generation: { type: 'number' } }, required: ['tabId', 'generation'], additionalProperties: false } },
  { name: 'browser_click', description: '在受控标签页的 CSS 视口坐标处点击。', inputSchema: { type: 'object', properties: { tabId: { type: ['string', 'number'] }, generation: { type: 'number' }, x: { type: 'number' }, y: { type: 'number' }, button: { type: ['string', 'integer'], description: 'left|middle|right 或 1|2|3' }, doubleClick: { type: 'boolean' } }, required: ['tabId', 'generation', 'x', 'y'], additionalProperties: false } },
  { name: 'browser_scroll', description: '在受控标签页指定坐标处滚动。', inputSchema: { type: 'object', properties: { tabId: { type: ['string', 'number'] }, generation: { type: 'number' }, x: { type: 'number' }, y: { type: 'number' }, scrollX: { type: 'number' }, scrollY: { type: 'number' } }, required: ['tabId', 'generation', 'x', 'y', 'scrollX', 'scrollY'], additionalProperties: false } },
  { name: 'browser_type', description: '向受控标签页当前聚焦元素输入文本。', inputSchema: { type: 'object', properties: { tabId: { type: ['string', 'number'] }, generation: { type: 'number' }, text: { type: 'string' } }, required: ['tabId', 'generation', 'text'], additionalProperties: false } },
  { name: 'browser_key', description: '向受控标签页发送按键或组合键，例如 ctrl+a、enter。', inputSchema: { type: 'object', properties: { tabId: { type: ['string', 'number'] }, generation: { type: 'number' }, keys: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] } }, required: ['tabId', 'generation', 'keys'], additionalProperties: false } },
  { name: 'browser_dom_click', description: '按 browser_dom 返回的 node_id 点击 DOM 节点。', inputSchema: { type: 'object', properties: { tabId: { type: ['string', 'number'] }, generation: { type: 'number' }, node_id: { type: 'string' }, doubleClick: { type: 'boolean' } }, required: ['tabId', 'generation', 'node_id'], additionalProperties: false } },
  { name: 'browser_close_tab', description: '关闭一个受控标签页。', inputSchema: { type: 'object', properties: { tabId: { type: ['string', 'number'] }, generation: { type: 'number' } }, required: ['tabId', 'generation'], additionalProperties: false } },
  { name: 'browser_finish', description: '结束浏览器会话，释放所有认领的标签页；agent 新建的标签页默认关闭，除非在 keep 中指定保留。', inputSchema: { type: 'object', properties: { keep: { type: 'array', items: { type: 'object', properties: { id: { type: ['string', 'number'] }, generation: { type: 'number' } }, required: ['id', 'generation'], additionalProperties: false } } }, additionalProperties: false } },
];

class Broker {
  constructor() {
    this.hosts = new Map();      // socket -> {ready, pid, id, lastSeen}
    this.pending = new Map();    // rpc id -> {resolve, reject, timer}
    this.nextId = 1;
  }

  listen() {
    this.server = net.createServer(socket => {
      socket.setNoDelay(true);
      const id = crypto.randomUUID();
      const info = { id, ready: false, pid: null, lastSeen: Date.now() };
      this.hosts.set(socket, info);
      let buf = '';
      log('native client connected', id);
      socket.on('data', chunk => {
        info.lastSeen = Date.now();
        buf += chunk.toString('utf8');
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line) continue;
          let msg;
          try { msg = JSON.parse(line); } catch { continue; }
          if (msg.type === 'register') {
            info.ready = !!msg.ready;
            info.pid = msg.pid ?? null;
            info.lastSeen = Date.now();
            log('native registered', id, 'pid', info.pid, 'ready', info.ready);
          } else if (msg.type === 'status') {
            info.ready = !!msg.ready;
            info.lastSeen = Date.now();
          } else if (msg.type === 'pong') {
            info.ready = !!msg.ready;
            info.pid = msg.pid ?? info.pid;
            info.lastSeen = Date.now();
          } else if (msg.type === 'result') {
            const p = this.pending.get(msg.id);
            if (!p) continue;
            this.pending.delete(msg.id);
            clearTimeout(p.timer);
            if (msg.ok) p.resolve(msg.result);
            else p.reject(new Error(msg.error || 'browser command failed'));
          }
        }
      });
      socket.on('error', () => {});
      socket.on('close', () => {
        this.hosts.delete(socket);
        log('native client disconnected', id);
      });
    });
    this.server.on('error', e => {
      log('broker listen error', String(e));
      if (e && e.code === 'EADDRINUSE') {
        // A stale broker process still owns the port. Retry until it frees.
        log('broker port in use; retrying in 2s', PORT);
        setTimeout(() => {
          try { this.server.close(); } catch {}
          this.server.listen(PORT, HOST);
        }, 2000);
      }
    });
    this.server.listen(PORT, HOST, () => log('broker listening on', PORT));
  }

  activeHost() {
    // Prefer the newest READY host. Fall back to none if all are stale.
    let best = null;
    for (const [socket, info] of this.hosts) {
      if (!info.ready || socket.destroyed) continue;
      if (Date.now() - info.lastSeen > STALE_AFTER_MS) continue;
      if (!best || info.lastSeen > best.info.lastSeen) best = { socket, info };
    }
    return best;
  }

  isReady() {
    return !!this.activeHost();
  }

  call(method, params = {}) {
    const active = this.activeHost();
    if (!active) {
      const anyHost = this.hosts.size > 0;
      throw new Error(anyHost
        ? '浏览器扩展尚未完成握手（连接已建立，请稍候或刷新扩展）'
        : '浏览器扩展未连接：请确认扩展已启用，且原生消息宿主 com.workbuddy_ai.extension 已注册。');
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`RPC 超时: ${method}`)); }, COMMAND_TIMEOUT_MS + 5000);
      this.pending.set(id, { resolve, reject, timer });
      active.socket.write(JSON.stringify({ type: 'call', id, method, params }) + '\n');
    });
  }
}

class McpServer {
  constructor(broker) { this.broker = broker; this.buf = ''; }
  start() {
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', c => {
      this.buf += c;
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        if (line) this._handle(line);
      }
    });
    process.stdin.on('end', () => process.exit(0));
    log('MCP stdio server started');
  }
  send(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }
  text(text, isError = false) { return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) }; }
  json(obj, isError = false) { return this.text(JSON.stringify(obj, null, 2), isError); }

  async _handle(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.id === undefined) return;
    const id = msg.id;
    try {
      let result;
      switch (msg.method) {
        case 'initialize':
          result = { protocolVersion: msg.params?.protocolVersion || '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'dsh-browser-bridge', version: '2.0.0' } };
          break;
        case 'ping': result = {}; break;
        case 'resources/list': result = { resources: [] }; break;
        case 'prompts/list': result = { prompts: [] }; break;
        case 'tools/list': result = { tools: TOOLS }; break;
        case 'tools/call': result = await this._call(msg.params); break;
        default:
          this.send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
          return;
      }
      this.send({ jsonrpc: '2.0', id, result });
    } catch (e) {
      this.send({ jsonrpc: '2.0', id, error: { code: -32000, message: String(e && e.message || e) } });
    }
  }

  async _call(params) {
    const name = params?.name;
    const a = params?.arguments || {};
    const b = this.broker;
    try {
      switch (name) {
        case 'browser_status': {
          if (!b.isReady()) {
            return this.json({ connected: false, nativeHosts: b.hosts.size, hint: '扩展尚未连接。若刚重启浏览器/扩展，请等几秒再试；或刷新扩展页面。' });
          }
          const info = await b.call('capability.negotiate');
          const tabs = await b.call('tabs.list');
          return this.json({ connected: true, info, controlledTabs: tabs });
        }
        case 'browser_open': return this.json(await b.call('tabs.new', { url: a.url }));
        case 'browser_tabs': return this.json(await b.call(a.controlled ? 'tabs.list' : 'user.openTabs'));
        case 'browser_claim': {
          const t = await b.call('tabs.claim', { tabId: a.tabId, generation: a.generation });
          return t ? this.json({ claimed: t, hint: '后续操作需携带 tabId 与 generation' }) : this.text('认领失败：标签可能已被占用或已过期，请重新调用 browser_tabs。', true);
        }
        case 'browser_navigate': return this.json(await b.call('tab.goto', { tabId: a.tabId, generation: a.generation, url: a.url }));
        case 'browser_screenshot': {
          const p = { tabId: a.tabId, generation: a.generation };
          if (a.format) p.format = a.format;
          if (a.quality !== undefined) p.quality = a.quality;
          if (a.fullPage !== undefined) p.fullPage = a.fullPage;
          if (a.clip) p.clip = a.clip;
          const shot = await b.call('tab.screenshot', p);
          return { content: [{ type: 'image', data: shot.data, mimeType: shot.mimeType || 'image/jpeg' }, { type: 'text', text: `截图尺寸 ${shot.width}x${shot.height}` }] };
        }
        case 'browser_dom': {
          const dom = await b.call('dom_cua.get_visible_dom', { tabId: a.tabId, generation: a.generation });
          return this.text(typeof dom === 'string' ? dom : JSON.stringify(dom));
        }
        case 'browser_click': {
          const p = { tabId: a.tabId, generation: a.generation, x: a.x, y: a.y };
          if (a.button !== undefined) p.button = a.button;
          await b.call(a.doubleClick ? 'cua.double_click' : 'cua.click', p);
          return this.text('点击完成');
        }
        case 'browser_scroll':
          await b.call('cua.scroll', { tabId: a.tabId, generation: a.generation, x: a.x, y: a.y, scrollX: a.scrollX, scrollY: a.scrollY });
          return this.text('滚动完成');
        case 'browser_type':
          await b.call('cua.type', { tabId: a.tabId, generation: a.generation, text: a.text });
          return this.text('输入完成');
        case 'browser_key':
          await b.call('cua.keypress', { tabId: a.tabId, generation: a.generation, keys: a.keys });
          return this.text('按键完成');
        case 'browser_dom_click':
          await b.call(a.doubleClick ? 'dom_cua.double_click' : 'dom_cua.click', { tabId: a.tabId, generation: a.generation, node_id: a.node_id });
          return this.text('DOM 点击完成');
        case 'browser_close_tab':
          await b.call('tabs.close', { tabId: a.tabId, generation: a.generation });
          return this.text('标签页已关闭');
        case 'browser_finish': return this.json(await b.call('tabs.finalize', { keep: a.keep || [] }));
        default: return this.text('未知工具: ' + name, true);
      }
    } catch (e) {
      return this.text('浏览器操作失败: ' + String(e && e.message || e), true);
    }
  }
}

function runMcpServer() {
  const broker = new Broker();
  broker.listen();
  const mcp = new McpServer(broker);
  mcp.start();
}

if (MODE === 'native') runNativeHost();
else runMcpServer();
