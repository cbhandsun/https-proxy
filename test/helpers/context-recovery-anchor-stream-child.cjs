'use strict';

// Synthetic subprocess lifecycle fixture only. No configuration, network,
// credential, storage directory or registry access.
const mode = process.argv[2];
if (!['reply', 'hang', 'stderr', 'partial', 'sequence', 'exit', 'idle-hang'].includes(mode))
  process.exit(2);
if (['hang', 'idle-hang'].includes(mode)) setInterval(() => {}, 1000);
const lifetime = new (require('node:net').Socket)({ fd: 3, readable: true, writable: true });
lifetime.on('end', () => process.exit(1));
lifetime.on('error', () => process.exit(1));
lifetime.on('data', () => process.exit(1));
process.stdout.write(Buffer.alloc(8));
process.stdin.on('end', () => {
  if (!['hang', 'idle-hang'].includes(mode)) lifetime.destroy();
});
let input = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  input = Buffer.concat([input, chunk]);
  if (input.length > 131080) process.exit(2);
  if (input.length < 8) return;
  const sequence = input.readUInt32LE(0),
    length = input.readUInt32LE(4);
  if (!length || length > 131072) process.exit(2);
  if (input.length !== length + 8) return;
  input = Buffer.alloc(0);
  if (mode === 'hang') return;
  if (mode === 'exit') process.exit(1);
  if (mode === 'stderr') {
    process.stderr.write('PRIVATE synthetic marker');
    return;
  }
  const body = Buffer.from('{"ok":true,"revision":0,"value":null}');
  const reply = Buffer.alloc(8 + body.length);
  reply.writeUInt32LE(mode === 'sequence' ? sequence + 1 : sequence, 0);
  reply.writeUInt32LE(body.length, 4);
  body.copy(reply, 8);
  if (mode === 'partial') {
    process.stdout.write(reply.subarray(0, 9), () => process.exit(1));
    return;
  }
  process.stdout.write(reply);
});
