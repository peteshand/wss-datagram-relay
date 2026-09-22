'use strict';

// Minimal public relay for the WebAssembly virtual datagram socket backend.
// It deliberately carries no gameplay semantics: it leases virtual endpoints,
// forwards complete datagrams, and scopes discovery broadcasts to compatible
// build/path rooms. TLS termination is mandatory for normal use.

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');

const RELAY_PROTOCOL = 'UE-WASM-WSS-RELAY-1';
const SUBPROTOCOL = 'ue-wasm-relay-v1';
const FRAME_MAGIC = 0x55454447; // UEDG
const FRAME_HEADER_BYTES = 20;
const MAX_DATAGRAM_BYTES = 65507;
const VIRTUAL_SUBNET = 0x0a000000;
const VIRTUAL_MASK = 0xff000000;

function isVirtualIp(ip) {
  return ((ip >>> 0) & VIRTUAL_MASK) === VIRTUAL_SUBNET && (ip >>> 0) !== VIRTUAL_SUBNET;
}

function parseArgumentList(argv) {
  const result = {};
  for (let index = 0; index < argv.length; ++index) {
    const key = argv[index];
    if (!key.startsWith('--')) throw new Error(`Unexpected argument: ${key}`);
    const name = key.slice(2);
    if (name === 'help' || name === 'http') { result[name] = true; continue; }
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for --${name}`);
    result[name] = value;
  }
  return result;
}

function positiveInteger(value, name, fallback) {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) throw new Error(`--${name} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`--${name} must be a positive integer`);
  return parsed;
}

function relayConfig(argv) {
  const args = parseArgumentList(argv);
  if (args.help) return {help: true};
  const plainHttp = args.http === true;
  const pem = !!args.cert || !!args.key;
  const pfx = !!args.pfx;
  if ((pem && (!args.cert || !args.key)) || (pem && pfx) || (!plainHttp && !pem && !pfx) || (plainHttp && (pem || pfx))) {
    throw new Error('TLS is required: provide either --cert <pem> with --key <pem>, or --pfx <bundle>.');
  }
  const host = args.host || '0.0.0.0';
  if (plainHttp && !['127.0.0.1', '::1', 'localhost'].includes(host.toLowerCase())) {
    throw new Error('--http is only permitted with --host 127.0.0.1, ::1, or localhost; terminate public TLS at the reverse proxy.');
  }
  const port = positiveInteger(args.port, 'port', 8443);
  if (port > 65535) throw new Error('--port must be at most 65535');
  return {
    host,
    port,
    plainHttp,
    certificate: args.cert,
    key: args.key,
    pfx: args.pfx || null,
    pfxPassphrase: args['pfx-passphrase'] || null,
    expectedBuild: args['build-id'] || null,
    expectedOrigin: args.origin || null,
    maxQueueBytes: positiveInteger(args['max-queue-bytes'], 'max-queue-bytes', 8 * 1024 * 1024),
    maxPacketsPerSecond: positiveInteger(args['max-packets-per-second'], 'max-packets-per-second', 2048),
    maxBytesPerSecond: positiveInteger(args['max-bytes-per-second'], 'max-bytes-per-second', 8 * 1024 * 1024),
    heartbeatMs: positiveInteger(args['heartbeat-ms'], 'heartbeat-ms', 15000),
    timeoutMs: positiveInteger(args['timeout-ms'], 'timeout-ms', 45000)
  };
}

function encodeFrame(opcode, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  if (body.length > 0x7fffffff) throw new Error('WebSocket frame too large');
  let headerBytes = 2;
  if (body.length >= 126 && body.length <= 0xffff) headerBytes += 2;
  else if (body.length > 0xffff) headerBytes += 8;
  const frame = Buffer.allocUnsafe(headerBytes + body.length);
  frame[0] = 0x80 | opcode;
  if (body.length < 126) frame[1] = body.length;
  else if (body.length <= 0xffff) {
    frame[1] = 126;
    frame.writeUInt16BE(body.length, 2);
  } else {
    frame[1] = 127;
    frame.writeUInt32BE(0, 2);
    frame.writeUInt32BE(body.length, 6);
  }
  body.copy(frame, headerBytes);
  return frame;
}

function decodeDatagram(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < FRAME_HEADER_BYTES) return null;
  if (buffer.readUInt32BE(0) !== FRAME_MAGIC || buffer[4] !== 1 || buffer[5] !== 0) return null;
  const payloadBytes = buffer.readUInt16BE(18);
  if (payloadBytes > MAX_DATAGRAM_BYTES || buffer.length !== FRAME_HEADER_BYTES + payloadBytes) return null;
  const packet = {
    sourcePort: buffer.readUInt16BE(6),
    sourceIp: buffer.readUInt32BE(8),
    destinationIp: buffer.readUInt32BE(12),
    destinationPort: buffer.readUInt16BE(16),
    payload: buffer.subarray(FRAME_HEADER_BYTES)
  };
  if (!isVirtualIp(packet.sourceIp) || packet.sourcePort === 0 || packet.destinationPort === 0) return null;
  if (!isVirtualIp(packet.destinationIp) && packet.destinationIp !== 0xffffffff) return null;
  return packet;
}

class RelayCore {
  constructor(config = {}) {
    this.config = {
      expectedBuild: config.expectedBuild || null,
      maxQueueBytes: config.maxQueueBytes || 8 * 1024 * 1024,
      maxPacketsPerSecond: config.maxPacketsPerSecond || 2048,
      maxBytesPerSecond: config.maxBytesPerSecond || 8 * 1024 * 1024
    };
    this.rooms = new Map();
    this.connections = new Set();
    this.guestSequence = 0;
  }

  reject(client, reason) {
    client.sendText(JSON.stringify({type: 'error', protocol: RELAY_PROTOCOL, reason}));
    client.close(1008, reason);
  }

  roomKey(scope, build) {
    return `${build}\n${scope}`;
  }

  acceptHello(client, message) {
    if (client.room) return this.reject(client, 'Duplicate hello');
    if (!message || message.type !== 'hello' || message.protocol !== RELAY_PROTOCOL) return this.reject(client, 'Invalid hello');
    if (typeof message.scope !== 'string' || message.scope.length === 0 || message.scope.length > 512 || !message.scope.startsWith('/')) {
      return this.reject(client, 'Invalid scope');
    }
    if (typeof message.build !== 'string' || message.build.length === 0 || message.build.length > 128) return this.reject(client, 'Invalid build');
    if (this.config.expectedBuild && message.build !== this.config.expectedBuild) return this.reject(client, 'Incompatible build');
    const requestedIp = Number(message.requestedIp) >>> 0;
    if (!isVirtualIp(requestedIp)) return this.reject(client, 'Invalid virtual endpoint');
    const key = this.roomKey(message.scope, message.build);
    let room = this.rooms.get(key);
    if (!room) {
      room = {key, byAddress: new Map(), members: new Set()};
      this.rooms.set(key, room);
    }
    if (room.byAddress.has(requestedIp)) return this.reject(client, 'Virtual endpoint already leased');
    client.address = requestedIp;
    client.room = room;
    client.guestId = `guest_${crypto.randomBytes(9).toString('base64url')}`;
    client.displayName = `Player ${++this.guestSequence}`;
    client.rateStartMs = Date.now();
    client.ratePackets = 0;
    client.rateBytes = 0;
    room.byAddress.set(requestedIp, client);
    room.members.add(client);
    this.connections.add(client);
    client.sendText(JSON.stringify({
      type: 'hello', protocol: RELAY_PROTOCOL, assignedIp: requestedIp,
      guestId: client.guestId, displayName: client.displayName
    }));
  }

  isRateAllowed(client, bytes) {
    const now = Date.now();
    if (now - client.rateStartMs >= 1000) {
      client.rateStartMs = now;
      client.ratePackets = 0;
      client.rateBytes = 0;
    }
    if (++client.ratePackets > this.config.maxPacketsPerSecond || (client.rateBytes += bytes) > this.config.maxBytesPerSecond) {
      client.droppedPackets = (client.droppedPackets || 0) + 1;
      return false;
    }
    return true;
  }

  forward(client, frame) {
    if (!client.room) return this.reject(client, 'Hello required');
    const packet = decodeDatagram(frame);
    if (!packet || packet.sourceIp !== client.address) return this.reject(client, 'Invalid datagram');
    if (!this.isRateAllowed(client, frame.length)) return;
    const targets = packet.destinationIp === 0xffffffff
      ? [...client.room.members].filter(member => member !== client)
      : [client.room.byAddress.get(packet.destinationIp)].filter(Boolean);
    for (const target of targets) {
      if (!target.canQueue(frame.length)) {
        target.droppedPackets = (target.droppedPackets || 0) + 1;
        continue;
      }
      target.sendBinary(frame);
    }
  }

  remove(client) {
    if (!client.room) return;
    const room = client.room;
    room.byAddress.delete(client.address);
    room.members.delete(client);
    if (room.members.size === 0) this.rooms.delete(room.key);
    client.room = null;
    this.connections.delete(client);
  }

  snapshot() {
    return {
      protocol: RELAY_PROTOCOL,
      connections: this.connections.size,
      rooms: [...this.rooms.values()].map(room => ({members: room.members.size, key: room.key}))
    };
  }
}

function parseWebSocketFrames(client) {
  const frames = [];
  let offset = 0;
  const data = client.input;
  while (data.length - offset >= 2) {
    const first = data[offset];
    const second = data[offset + 1];
    const fin = (first & 0x80) !== 0;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let header = 2;
    if (!fin || !masked) throw new Error('Fragmented or unmasked client frame');
    if (length === 126) {
      if (data.length - offset < 4) break;
      length = data.readUInt16BE(offset + 2); header = 4;
    } else if (length === 127) {
      if (data.length - offset < 10) break;
      if (data.readUInt32BE(offset + 2) !== 0) throw new Error('Frame too large');
      length = data.readUInt32BE(offset + 6); header = 10;
    }
    if (length > MAX_DATAGRAM_BYTES + FRAME_HEADER_BYTES || data.length - offset < header + 4 + length) break;
    const maskOffset = offset + header;
    const payloadOffset = maskOffset + 4;
    const payload = Buffer.allocUnsafe(length);
    for (let index = 0; index < length; ++index) payload[index] = data[payloadOffset + index] ^ data[maskOffset + (index & 3)];
    frames.push({opcode, payload});
    offset = payloadOffset + length;
  }
  client.input = offset === data.length ? Buffer.alloc(0) : data.subarray(offset);
  return frames;
}

function startRelay(config) {
  const core = new RelayCore(config);
  const requestHandler = (_request, response) => {
    response.writeHead(404, {'Cache-Control': 'no-store'});
    response.end();
  };
  const server = config.plainHttp ? http.createServer(requestHandler) : https.createServer(
    config.pfx
      ? {pfx: fs.readFileSync(config.pfx), ...(config.pfxPassphrase ? {passphrase: config.pfxPassphrase} : {})}
      : {cert: fs.readFileSync(config.certificate), key: fs.readFileSync(config.key)},
    requestHandler
  );
  const clients = new Set();
  const originAllowed = origin => !config.expectedOrigin || origin === config.expectedOrigin;

  server.on('upgrade', (request, socket) => {
    const upgrade = String(request.headers.upgrade || '').toLowerCase();
    const key = request.headers['sec-websocket-key'];
    const protocols = String(request.headers['sec-websocket-protocol'] || '').split(',').map(value => value.trim());
    if (upgrade !== 'websocket' || typeof key !== 'string' || !protocols.includes(SUBPROTOCOL) || !originAllowed(request.headers.origin)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); return;
    }
    const accept = crypto.createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: ${SUBPROTOCOL}\r\n\r\n`);
    socket.setNoDelay(true);
    const client = {
      input: Buffer.alloc(0), socket, lastPongMs: Date.now(), droppedPackets: 0,
      sendText: value => socket.write(encodeFrame(1, Buffer.from(value, 'utf8'))),
      sendBinary: value => socket.write(encodeFrame(2, value)),
      canQueue: bytes => !socket.destroyed && socket.writableLength + bytes <= config.maxQueueBytes,
      close: (code, reason) => {
        if (!socket.destroyed) socket.end(encodeFrame(8, Buffer.from([code >> 8, code & 255, ...Buffer.from(String(reason || '').slice(0, 120))])));
      }
    };
    clients.add(client);
    socket.on('data', chunk => {
      client.input = Buffer.concat([client.input, chunk]);
      try {
        for (const frame of parseWebSocketFrames(client)) {
          if (frame.opcode === 1) core.acceptHello(client, JSON.parse(frame.payload.toString('utf8')));
          else if (frame.opcode === 2) core.forward(client, frame.payload);
          else if (frame.opcode === 8) client.close(1000, 'Client closed');
          else if (frame.opcode === 9) socket.write(encodeFrame(10, frame.payload));
          else if (frame.opcode === 10) client.lastPongMs = Date.now();
          else throw new Error('Unsupported WebSocket opcode');
        }
      } catch (error) { client.close(1002, error.message); }
    });
    const remove = () => { core.remove(client); clients.delete(client); };
    socket.on('close', remove);
    socket.on('error', remove);
  });
  const heartbeat = setInterval(() => {
    const now = Date.now();
    for (const client of clients) {
      if (now - client.lastPongMs > config.timeoutMs) client.close(1001, 'Heartbeat timeout');
      else if (!client.socket.destroyed) client.socket.write(encodeFrame(9, Buffer.alloc(0)));
    }
  }, config.heartbeatMs).unref();
  return {
    core, server,
    listen: () => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.port, config.host, () => { server.off('error', reject); resolve(server.address()); });
    }),
    close: () => new Promise(resolve => {
      clearInterval(heartbeat);
      for (const client of clients) client.close(1001, 'Relay shutdown');
      server.close(() => resolve());
    })
  };
}

function usage() {
  return [
    'Usage: node wss-datagram-relay.cjs (--cert <certificate.pem> --key <private-key.pem> | --pfx <bundle> | --http --host <loopback>) [options]',
    'Options: --host <address> --port <port> --build-id <build-id> --origin <https://game.example>',
    '         --max-queue-bytes <bytes> --max-packets-per-second <count> --max-bytes-per-second <bytes>',
    '         --heartbeat-ms <milliseconds> --timeout-ms <milliseconds> --pfx-passphrase <passphrase>',
    '         --http only permits a loopback listener for TLS termination by a reverse proxy.'
  ].join('\n');
}

if (require.main === module) {
  try {
    const config = relayConfig(process.argv.slice(2));
    if (config.help) { console.log(usage()); process.exit(0); }
    const relay = startRelay(config);
    relay.listen().then(address => {
      console.log(`${config.plainHttp ? 'WS' : 'WSS'} datagram relay listening at ${config.plainHttp ? 'ws' : 'wss'}://${address.address}:${address.port}/`);
      console.log(`protocol=${RELAY_PROTOCOL}; build=${config.expectedBuild || 'any'}; origin=${config.expectedOrigin || 'any'}`);
    }).catch(error => { console.error(error.stack || error); process.exitCode = 1; });
    process.on('SIGINT', () => relay.close().then(() => process.exit(0)));
  } catch (error) {
    console.error(`${error.message}\n${usage()}`);
    process.exitCode = 2;
  }
}

module.exports = {RELAY_PROTOCOL, SUBPROTOCOL, RelayCore, decodeDatagram, encodeFrame, relayConfig, startRelay};
