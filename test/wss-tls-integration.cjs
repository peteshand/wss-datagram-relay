'use strict';

// Optional integration check. Supply a short-lived PFX only in a development
// environment; normal unit tests never require a certificate or network port.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const tls = require('node:tls');
const {RELAY_PROTOCOL, startRelay} = require('../src/wss-datagram-relay.cjs');

function argument(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? null : process.argv[index + 1] || null;
}

function clientFrame(opcode, payload) {
  const body = Buffer.from(payload);
  const mask = crypto.randomBytes(4);
  let header;
  if (body.length < 126) header = Buffer.from([0x80 | opcode, 0x80 | body.length]);
  else {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0xfe;
    header.writeUInt16BE(body.length, 2);
  }
  const masked = Buffer.allocUnsafe(body.length);
  for (let index = 0; index < body.length; ++index) masked[index] = body[index] ^ mask[index & 3];
  return Buffer.concat([header, mask, masked]);
}

function serverFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (buffer.length - offset >= 2) {
    let length = buffer[offset + 1] & 0x7f;
    let header = 2;
    if (length === 126) {
      if (buffer.length - offset < 4) break;
      length = buffer.readUInt16BE(offset + 2);
      header = 4;
    } else if (length === 127) {
      throw new Error('Unexpected long server frame');
    }
    if ((buffer[offset + 1] & 0x80) !== 0 || buffer.length - offset < header + length) break;
    frames.push({opcode: buffer[offset] & 0x0f, payload: buffer.subarray(offset + header, offset + header + length)});
    offset += header + length;
  }
  return {frames, remainder: buffer.subarray(offset)};
}

function datagram(sourceIp, sourcePort, destinationIp, destinationPort, payload) {
  const frame = Buffer.alloc(20 + payload.length);
  frame.writeUInt32BE(0x55454447, 0);
  frame[4] = 1;
  frame.writeUInt16BE(sourcePort, 6);
  frame.writeUInt32BE(sourceIp, 8);
  frame.writeUInt32BE(destinationIp, 12);
  frame.writeUInt16BE(destinationPort, 16);
  frame.writeUInt16BE(payload.length, 18);
  payload.copy(frame, 20);
  return frame;
}

function connect(port, requestedIp) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({host: '127.0.0.1', port, rejectUnauthorized: false});
    const client = {socket, received: []};
    let upgraded = false;
    let input = Buffer.alloc(0);
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback(value);
    };
    const timeout = setTimeout(() => finish(reject, new Error('WSS relay handshake timed out')), 5000);
    socket.on('error', error => finish(reject, error));
    socket.on('secureConnect', () => {
      socket.write([
        'GET / HTTP/1.1', `Host: 127.0.0.1:${port}`, 'Upgrade: websocket', 'Connection: Upgrade',
        'Sec-WebSocket-Version: 13', `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}`,
        'Sec-WebSocket-Protocol: ue-wasm-relay-v1', 'Origin: https://relay-integration.test', '', ''
      ].join('\r\n'));
    });
    socket.on('data', chunk => {
      input = Buffer.concat([input, chunk]);
      if (!upgraded) {
        const boundary = input.indexOf('\r\n\r\n');
        if (boundary < 0) return;
        assert.match(input.subarray(0, boundary).toString('utf8'), /101 Switching Protocols/);
        input = input.subarray(boundary + 4);
        upgraded = true;
        socket.write(clientFrame(1, JSON.stringify({
          type: 'hello', protocol: RELAY_PROTOCOL, requestedIp,
          scope: '/LyraStarterGame.html', build: 'relay-integration-build'
        })));
      }
      const parsed = serverFrames(input);
      input = parsed.remainder;
      for (const frame of parsed.frames) {
        if (frame.opcode === 2) client.received.push(frame.payload);
        if (frame.opcode !== 1) continue;
        const message = JSON.parse(frame.payload.toString('utf8'));
        if (message.type === 'error') finish(reject, new Error(message.reason));
        if (message.type === 'hello') finish(resolve, client);
      }
    });
  });
}

async function waitFor(label, predicate) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function main() {
  const pfx = argument('--pfx');
  const passphrase = argument('--passphrase');
  if (!pfx) {
    console.log('SKIP WSS TLS integration: pass --pfx <development.pfx> to exercise a real TLS socket.');
    return;
  }
  const relay = startRelay({pfx, pfxPassphrase: passphrase, host: '127.0.0.1', port: 0,
    expectedBuild: 'relay-integration-build', maxQueueBytes: 4096, heartbeatMs: 1000, timeoutMs: 5000});
  const address = await relay.listen();
  try {
    const firstIp = 0x0a010001;
    const secondIp = 0x0a010002;
    const first = await connect(address.port, firstIp);
    const second = await connect(address.port, secondIp);
    const direct = datagram(firstIp, 7777, secondIp, 7778, Buffer.from([9, 8, 7]));
    first.socket.write(clientFrame(2, direct));
    await waitFor('direct relay packet', () => second.received.length === 1);
    assert.deepEqual(second.received[0], direct);
    const broadcast = datagram(secondIp, 14001, 0xffffffff, 14001, Buffer.from([1]));
    second.socket.write(clientFrame(2, broadcast));
    await waitFor('broadcast relay packet', () => first.received.length === 1);
    assert.deepEqual(first.received[0], broadcast);
    first.socket.end();
    second.socket.end();
    console.log('PASS real TLS WebSocket endpoint leases, unicast, and broadcast routing');
  } finally {
    await relay.close();
  }
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
