/**
 * Socket-lifecycle regression test.
 *
 * The DSH host died with `fatal uncaught exception: Error: read ECONNRESET at
 * TLSWrap.onStreamRead` because a client detached its 'error' listener from a
 * still-open socket and then a TLS peer reset the connection. An 'error' event
 * with no listener is an uncaught exception, so these tests assert that a
 * closed/detached client can never leave its socket unattended.
 *
 *   node test-sockets.mjs
 */
import net from 'node:net';
import { SmtpClient } from './smtp.js';
import { ImapClient } from './imap.js';

let checks = 0;
const failures = [];

function check(name, condition, detail) {
  checks += 1;
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    failures.push(name);
  }
}

/** Whether emitting 'error' on this socket throws (i.e. nobody listens). */
function emitErrorSafely(socket, message) {
  try {
    socket.emit('error', new Error(message));
    return { threw: false };
  } catch (error) {
    return { threw: true, error };
  }
}

/** A throwaway TCP server that accepts one connection and answers a banner. */
async function listen(handler) {
  const server = net.createServer((socket) => {
    // The server side needs its own sink too: resetting from the client lands
    // here as an ECONNRESET, and an unattended socket would kill the test.
    socket.on('error', () => {});
    handler(socket);
  });
  server.on('error', () => {});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port };
}

console.log('smtp client socket lifecycle');

{
  const { server, port } = await listen((socket) => {
    socket.write('220 test ready\r\n');
  });
  const client = new SmtpClient({ host: '127.0.0.1', port, secure: false, timeoutMs: 4000, allowInvalidCert: true });
  await client.connect();
  const greeting = await client.next();
  check('connects and reads the banner', greeting.code === 220, JSON.stringify(greeting));

  const socket = client.socket;
  check('socket carries an error listener while live', socket.listenerCount('error') > 0);

  client.close();
  check('detached socket still carries an error listener', socket.listenerCount('error') > 0,
    `listeners=${socket.listenerCount('error')}`);

  const reset = emitErrorSafely(socket, 'read ECONNRESET');
  check('a reset on the detached socket does not throw', reset.threw === false,
    reset.error ? String(reset.error.message) : undefined);

  // A second reset must be just as harmless (idempotent teardown).
  check('a repeated reset is still harmless', emitErrorSafely(socket, 'read ECONNRESET').threw === false);
  socket.destroy();
  server.close();
}

{
  // The realistic shape: the peer resets the connection instead of closing it
  // politely, while the client is mid-session.
  const { server, port } = await listen((socket) => {
    socket.write('220 test ready\r\n');
    setTimeout(() => socket.resetAndDestroy(), 30);
  });
  const client = new SmtpClient({ host: '127.0.0.1', port, secure: false, timeoutMs: 4000, allowInvalidCert: true });
  await client.connect();
  await client.next();
  let rejected = false;
  try {
    await client.command('EHLO test');
  } catch {
    rejected = true;
  }
  check('a mid-session RST surfaces as a rejected command', rejected);
  client.close();
  await new Promise((resolve) => setTimeout(resolve, 60));
  check('nothing throws after the RST (process still alive)', true);
  server.close();
}

console.log('\nimap client socket lifecycle');

{
  const { server, port } = await listen((socket) => {
    socket.write('* OK test IMAP ready\r\n');
  });
  const client = new ImapClient({ host: '127.0.0.1', port, secure: false, timeoutMs: 4000, allowInvalidCert: true });
  await client.connect();
  const socket = client.socket;
  check('imap socket carries an error listener while live', socket.listenerCount('error') > 0);
  client.close();
  check('detached imap socket still carries an error listener', socket.listenerCount('error') > 0,
    `listeners=${socket.listenerCount('error')}`);
  const reset = emitErrorSafely(socket, 'read ECONNRESET');
  check('a reset on the detached imap socket does not throw', reset.threw === false,
    reset.error ? String(reset.error.message) : undefined);
  socket.destroy();
  server.close();
}

console.log(`\n${checks - failures.length}/${checks} checks passed`);
if (failures.length > 0) {
  console.log(`failures:\n  - ${failures.join('\n  - ')}`);
  process.exitCode = 1;
}
