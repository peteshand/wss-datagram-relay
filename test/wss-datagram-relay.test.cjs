'use strict';

const assert = require('node:assert/strict');
const {RELAY_PROTOCOL, RelayCore, decodeDatagram, relayConfig} = require('../src/wss-datagram-relay.cjs');

function client(name, queue = true) {
  return {
    name, texts: [], binaries: [], closes: [], queue,
    sendText(value) { this.texts.push(JSON.parse(value)); },
    sendBinary(value) { this.binaries.push(Buffer.from(value)); },
    canQueue() { return this.queue; },
    close(code, reason) { this.closes.push({code, reason}); }
  };
}

function hello(ip, build = 'build-a', scope = '/LyraStarterGame.html') {
  return {type: 'hello', protocol: RELAY_PROTOCOL, requestedIp: ip, build, scope};
}

function datagram(sourceIp, sourcePort, destinationIp, destinationPort, payload = Buffer.from([1, 2, 3])) {
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

assert.throws(() => relayConfig([]), /TLS is required/);
const config = relayConfig(['--cert', 'certificate.pem', '--key', 'private-key.pem', '--port', '9443', '--build-id', 'build-a']);
assert.equal(config.port, 9443);
assert.equal(config.expectedBuild, 'build-a');
assert.throws(() => relayConfig(['--cert', 'certificate.pem', '--key', 'private-key.pem', '--port', '0']), /positive integer/);
assert.equal(relayConfig(['--pfx', 'development.pfx']).pfx, 'development.pfx');
assert.throws(() => relayConfig(['--cert', 'certificate.pem', '--pfx', 'development.pfx']), /either --cert/);

const core = new RelayCore({expectedBuild: 'build-a', maxPacketsPerSecond: 10, maxBytesPerSecond: 1024});
const first = client('first');
const second = client('second');
const third = client('third');
const firstIp = 0x0a010101;
const secondIp = 0x0a010102;
const thirdIp = 0x0a010103;
core.acceptHello(first, hello(firstIp));
core.acceptHello(second, hello(secondIp));
core.acceptHello(third, hello(thirdIp, 'build-a', '/Other.html'));
assert.equal(first.texts[0].assignedIp, firstIp);
assert.match(first.texts[0].guestId, /^guest_/);
assert.equal(first.texts[0].displayName, 'Player 1');
assert.equal(second.texts[0].displayName, 'Player 2');
assert.equal(core.snapshot().rooms.length, 2);

const direct = datagram(firstIp, 7777, secondIp, 7778, Buffer.from([8, 7]));
assert.deepEqual(decodeDatagram(direct), {sourcePort: 7777, sourceIp: firstIp, destinationIp: secondIp, destinationPort: 7778, payload: Buffer.from([8, 7])});
core.forward(first, direct);
assert.equal(second.binaries.length, 1);
assert.deepEqual(second.binaries[0], direct);
assert.equal(third.binaries.length, 0);

core.forward(first, datagram(firstIp, 7777, 0xffffffff, 14001));
assert.equal(second.binaries.length, 2, 'broadcast reaches compatible room peers');
assert.equal(third.binaries.length, 0, 'broadcast does not cross build/path room');
assert.equal(first.binaries.length, 0, 'broadcast does not loop back to sender');

const blocked = client('blocked', false);
core.acceptHello(blocked, hello(0x0a010104));
core.forward(first, datagram(firstIp, 7777, 0xffffffff, 14001));
assert.equal(blocked.binaries.length, 0);
assert.equal(blocked.droppedPackets, 1, 'bounded outbound queue drops instead of growing');

const incompatible = client('incompatible');
core.acceptHello(incompatible, hello(0x0a010105, 'other-build'));
assert.equal(incompatible.closes[0].code, 1008);
assert.match(incompatible.texts[0].reason, /Incompatible build/);

const spoofed = datagram(secondIp, 7777, firstIp, 7778);
core.forward(first, spoofed);
assert.equal(first.closes.at(-1).code, 1008);
assert.match(first.texts.at(-1).reason, /Invalid datagram/);

core.remove(second);
assert.equal(core.snapshot().connections, 3);
assert.equal(core.snapshot().rooms.find(room => room.key.includes('/LyraStarterGame.html')).members, 2);
console.log('PASS WSS datagram relay endpoint leasing, room routing, bounds, and protocol guards');
