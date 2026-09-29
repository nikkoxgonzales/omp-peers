/**
 * Peers acceptance test — runs against the COMPILED package (dist) with
 * OMP_PEERS_DIR pointed at a fresh temp dir.
 * Covers: presence beat → roster lists both fake peers; outbound socket frame
 * → inbound path with a FAKE pi capturing `sendUserMessage` calls — attributed
 * `[peer <name>]` text delivered with `agent` attribution (never a hardcoded
 * driving-agent name, no registry lookup); over-budget wakes queue as
 * followUps (deliverAs 'followUp' — queued, never waking); empty frames,
 * missing contexts, and sendUserMessage
 * rejections drop without touching the host; hop-cap refusal both locally
 * (before any socket I/O) and server-side; conversation-aware hop accounting
 * (a request/reply round trip stays level, a relay advances, a human prompt
 * resets); the native todo mapping (user_todo_edit vs todo toolResult,
 * newest-wins, ignored non-todo/error results, clamps) and its peer_status
 * rendering; burst coalescing is per sender —
 * concurrent senders stay separate batches and a coalesced hop takes
 * Math.max; UTF-8 frames split mid-character still decode intact;
 * session-name adoption (`peerNameFromSession`, incl. the refused `Main`)
 * + first-wins collision; defaultPeerName never truncates the pid suffix;
 * stale reap; forward-compat v>1 records skipped-not-unlinked; a live pid's
 * socket file survives record reaping (unix only).
 * Plain Node ESM — no test-runner dependency (also runs under `node --test`).
 */

import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

process.env.OMP_PEERS_DIR = await mkdtemp(join(tmpdir(), 'peers-test-'));
const STATE = process.env.OMP_PEERS_DIR;

const {
  writePeerBeat,
  listLivePeers,
  removePeerRecord,
  peerNameFromSession,
  readTitleSource,
  buildPeersNote,
  appendNoteToMessages,
  deliverInboundPeerMessage,
  formatPeerText,
  isWakeOverBudget,
  recordPeerWake,
  sendToPeer,
  outboundHop,
  MAX_HOPS,
  validatePeerName,
  resolvePeerName,
  defaultPeerName,
  peerSocketAddress,
  startPeerServer,
  requestPeer,
  formatPeerLine,
  formatPeersText,
  peerPath,
  PEER_TTL_MS,
  HOLD_TIMEOUT_MS,
  registerPeerSendTool,
  registerPeerStatusTool,
  registerPeerRequestTool,
  readNativeTodos,
  MAX_PEER_TODOS,
} = await import('../dist/index.js');

const ALIVE = () => true;

function fakeCtx(sessionId, { idle = true } = {}) {
  const sent = [];
  const noted = [];
  return {
    ctx: {
      cwd: join(STATE, 'work'),
      mode: 'tui',
      ui: {
        notify: (message, type) => noted.push({ message, type }),
      },
      sessionManager: { getSessionId: () => sessionId },
      model: { id: 'test-model' },
      isIdle: () => idle,
    },
    pi: {
      sendUserMessage: (text, opts) => sent.push({ text, opts }),
    },
    sent,
    noted,
  };
}

describe('presence beat → roster lists both peers', () => {
  it('beats two fake peers and lists both live', async () => {
    await writePeerBeat({
      stateDir: STATE, pid: 47111, name: 'alpha', cwd: join(STATE, 'a'),
      harness: 'omp', sessionId: 'sess-a', model: 'm1',
      socket: peerSocketAddress(STATE, 47111), startedAt: 1000, busy: false,
    });
    await writePeerBeat({
      stateDir: STATE, pid: 47222, name: 'beta', cwd: join(STATE, 'b'),
      harness: 'pi', sessionId: 'sess-b', model: 'm2',
      socket: peerSocketAddress(STATE, 47222), startedAt: 2000, busy: true,
    });
    const live = await listLivePeers(STATE, 47111, { isAlive: ALIVE });
    assert.equal(live.length, 2);
    assert.deepEqual(live.map((p) => p.name), ['alpha', 'beta']);
    const note = buildPeersNote('alpha', live);
    assert.match(note, /`alpha`/);
    assert.match(note, /`beta`/);
    assert.match(note, /peer_send/);
    // Never a native `hub` path: peers are not in the host's agent registry.
    assert.doesNotMatch(note, /`hub`/);
    // Live state stays out of the note, which must not change mid-turn and
    // invalidate the provider's prompt cache (beta is busy here).
    assert.doesNotMatch(note, /\((working|idle)\)/);
  });

  it('reaps dead pids and expired beats on sight', async () => {
    const live = await listLivePeers(STATE, 47111, { isAlive: ALIVE });
    assert.equal(live.length, 2);
    // Dead pid (liveness seam reports it gone) is unlinked.
    await writePeerBeat({
      stateDir: STATE, pid: 2147483647, name: 'ghost', cwd: join(STATE, 'g'),
      harness: 'pi', socket: peerSocketAddress(STATE, 2147483647), startedAt: 1,
    });
    // Expired beat with a "live" pid is unlinked by TTL.
    const stalePath = peerPath(47999, STATE);
    await writeFile(
      stalePath,
      JSON.stringify({
        v: 1, pid: 47999, name: 'stale', cwd: join(STATE, 's'), project: 's',
        harness: 'omp', sessionId: '', model: '', socket: peerSocketAddress(STATE, 47999),
        startedAt: 1, beatAt: Date.now() - PEER_TTL_MS - 1000, busy: false,
      }) + '\n'
    );
    const after = await listLivePeers(STATE, 47111, {
      isAlive: (pid) => pid !== 2147483647,
    });
    assert.deepEqual(after.map((p) => p.name), ['alpha', 'beta']);
  });

  it('compacts the roster note when no peers are live', () => {
    const solo = buildPeersNote('alpha', []);
    assert.match(solo, /`alpha`/);
    assert.match(solo, /No other peers are live/);
    assert.doesNotMatch(solo, /peer_send/);
  });

  it('formats the /peers text columns', () => {
    const now = Date.now();
    const text = formatPeersText(
      {
        ownName: 'alpha',
        peers: [
          {
            v: 1, pid: 47111, name: 'alpha', cwd: '/w/a', project: 'a', harness: 'omp',
            sessionId: 's', model: 'm1', socket: 'x', startedAt: 1, beatAt: now - 3000, busy: true,
          },
        ],
      },
      now
    );
    assert.match(text, /alpha · omp\(47111\) · \/w\/a · m1 · working · beat 3s ago · you/);
  });

  it('surfaces held batches in the /peers header', () => {
    const now = Date.now();
    const held = formatPeersText({ ownName: 'alpha', peers: [], held: 2 }, now);
    assert.match(held, /held 2/);
    const clear = formatPeersText({ ownName: 'alpha', peers: [] }, now);
    assert.doesNotMatch(clear, /held/);
  });

  it('appends the roster note to the last user message', () => {
    const messages = [
      { role: 'assistant', content: 'hi' },
      { role: 'user', content: 'do it' },
    ];
    appendNoteToMessages(messages, 'NOTE');
    assert.equal(messages[1].content, 'do it\n\nNOTE');
    const empty = appendNoteToMessages([], 'NOTE');
    assert.deepEqual(empty, [{ role: 'user', content: 'NOTE' }]);
  });

  it('skips a well-shaped v>1 record without unlinking it', async () => {
    const dir = join(STATE, 'peers');
    await mkdir(dir, { recursive: true });
    const file = peerPath(49876, STATE);
    await writeFile(
      file,
      JSON.stringify({
        v: 2, pid: 49876, name: 'future', cwd: join(STATE, 'f'),
        harness: 'omp', socket: peerSocketAddress(STATE, 49876),
        startedAt: 1, beatAt: Date.now(), busy: false,
      }) + '\n'
    );
    const live = await listLivePeers(STATE, 0, { isAlive: ALIVE });
    assert.ok(!live.some((p) => p.name === 'future'));
    // A future peer owns that file — skipping must not reap it.
    await stat(file);
  });

  if (process.platform !== 'win32') {
    it('keeps a stale-but-alive peer\'s socket file while delisting the record', async () => {
      const dir = join(STATE, 'peers');
      await mkdir(dir, { recursive: true });
      const sock = peerSocketAddress(STATE, 49877);
      await writeFile(sock, '');
      await writeFile(
        peerPath(49877, STATE),
        JSON.stringify({
          v: 1, pid: 49877, name: 'stale-alive', cwd: join(STATE, 'sa'), project: 'sa',
          harness: 'omp', sessionId: '', model: '', socket: sock,
          startedAt: 1, beatAt: Date.now() - PEER_TTL_MS - 1000, busy: false,
        }) + '\n'
      );
      const live = await listLivePeers(STATE, 0, { isAlive: ALIVE });
      assert.ok(!live.some((p) => p.name === 'stale-alive'));
      // The pid is alive: unlinking its socket would strand it forever.
      await stat(sock);
    });
  }
});

describe('outbound frame → inbound path', () => {
  const addrB = peerSocketAddress(STATE, 47333);
  let seen = [];
  let deliveries = 0;
  let server;
  before(async () => {
    server = startPeerServer({
      address: addrB,
      ownName: () => 'beta',
      onMessage: async (msg) => {
        deliveries += 1;
        seen.push(msg);
        return 'injected';
      },
    });
    // Named pipes (win32) bind asynchronously; unix sockets too — wait for it.
    await new Promise((r) => setTimeout(r, 500));
  });

  it('delivers a socket frame with a text receipt', async () => {
    const recordB = {
      v: 1, pid: 47333, name: 'beta', cwd: '/w/b', project: 'b', harness: 'pi',
      sessionId: '', model: '', socket: addrB, startedAt: 1, beatAt: Date.now(), busy: false,
    };
    const receipt = await sendToPeer('beta', 'hello from alpha', {
      ownName: 'alpha',
      hop: 0,
      listPeers: async () => [recordB],
    });
    assert.match(receipt, /^Delivered to beta \(injected\)/);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].from, 'alpha');
    assert.equal(seen[0].body, 'hello from alpha');
    assert.equal(seen[0].hop, 0);
  });

  it('refuses unknown peers, broadcasts, and self-sends without throwing', async () => {
    const deps = { ownName: 'alpha', listPeers: async () => [] };
    assert.match(await sendToPeer('nobody', 'hi', deps), /Unknown peer "nobody"/);
    assert.match(await sendToPeer('all', 'hi', deps), /Broadcasts are not supported/);
    assert.match(await sendToPeer('alpha', 'hi', deps), /yourself/);
    assert.match(await sendToPeer('', '', deps), /required/);
  });

  it('answers ping and refuses over-hop frames', async () => {
    const pong = await requestPeer(addrB, { t: 'ping', from: 'alpha' });
    assert.equal(pong?.ok, true);
    assert.equal(pong?.name, 'beta');
    const refused = await requestPeer(addrB, { t: 'msg', from: 'alpha', body: 'far', hop: 99 });
    assert.equal(refused?.ok, false);
    assert.match(refused?.error ?? '', /limit is 4/);
  });

  it('coalesces a burst from one sender into a single wake', async () => {
    deliveries = 0;
    const p1 = requestPeer(addrB, { t: 'msg', from: 'burst', body: 'one', hop: 0 });
    const p2 = requestPeer(addrB, { t: 'msg', from: 'burst', body: 'two', hop: 0 });
    const [r1, r2] = await Promise.all([p1, p2]);
    const outcomes = [r1?.outcome, r2?.outcome].sort();
    assert.deepEqual(outcomes, ['coalesced', 'injected']);
    assert.equal(deliveries, 1);
  });

  it('drops oversized frames without delivering', async () => {
    const before = deliveries;
    const res = await requestPeer(addrB, { t: 'msg', from: 'big', body: 'x'.repeat(2_000_000), hop: 0 });
    assert.equal(res?.ok, false);
    assert.match(res?.error ?? '', /too large/);
    assert.equal(deliveries, before);
  });

  // One raw line to the socket; resolves the reply line, or undefined on close.
  const rawRequest = (address, text) =>
    new Promise((resolve) => {
      const socket = createConnection(address, () => socket.write(`${text}\n`));
      socket.setEncoding('utf8');
      let buffer = '';
      socket.on('data', (chunk) => {
        buffer += chunk;
        const index = buffer.indexOf('\n');
        if (index === -1) return;
        socket.destroy();
        resolve(JSON.parse(buffer.slice(0, index)));
      });
      socket.on('close', () => resolve(undefined));
      socket.on('error', () => resolve(undefined));
    });

  it('refuses malformed frames and keeps serving', async () => {
    const before = deliveries;
    const cases = [
      ['null', 'bad frame'],
      ['42', 'bad frame'],
      ['"text"', 'bad frame'],
      ['[]', 'bad frame'],
      ['{}', 'unknown frame'],
      ['{"t":"nope","from":"x"}', 'unknown frame'],
      ['{"t":"ping"}', 'bad frame'],
      ['{"t":"msg"}', 'bad frame'],
      ['{"t":"msg","from":1,"body":"x"}', 'bad frame'],
      ['{"t":"msg","from":"","body":"x"}', 'bad frame'],
      ['{"t":"msg","from":"x","body":null}', 'bad frame'],
      ['{"t":"msg","from":"x","body":"y","hop":"2"}', 'bad frame'],
      ['{"t":"msg","from":"x","body":"y","replyTo":7}', 'bad frame'],
      ['{"t":"msg","from":"x","body":"y","ack":"yes"}', 'bad frame'],
      ['not json', 'bad frame'],
    ];
    for (const [text, error] of cases) {
      assert.deepEqual(await rawRequest(addrB, text), { ok: false, error }, text);
    }
    assert.equal(deliveries, before);
    assert.deepEqual(await rawRequest(addrB, '{"t":"ping","from":"x"}'), { ok: true, name: 'beta' });
  });

  describe('malformed replies', () => {
    const addrR = peerSocketAddress(STATE, 47555);
    let answer = '';
    let replier;
    before(async () => {
      // Answers every request with `answer`, written in two halves so the
      // client has to reassemble a reply split across chunks.
      replier = createServer((socket) => {
        socket.once('data', () => {
          const half = Math.floor(answer.length / 2);
          socket.write(answer.slice(0, half));
          setTimeout(() => socket.end(answer.slice(half)), 30);
        });
      });
      await new Promise((resolve) => replier.listen(addrR, resolve));
    });
    after(() => new Promise((resolve) => replier.close(resolve)));

    const ask = async (text) => {
      answer = text;
      return requestPeer(addrR, { t: 'ping', from: 'alpha' });
    };

    it('reassembles a reply split across chunks', async () => {
      assert.deepEqual(await ask('{"ok":true,"outcome":"injected"}\n'), { ok: true, outcome: 'injected' });
    });

    it('turns a reply of the wrong shape into a bad-response failure', async () => {
      for (const text of ['null', '[]', '{"outcome":"x"}', '{"ok":"yes"}', '{"ok":true,"error":5}']) {
        assert.deepEqual(await ask(`${text}\n`), { ok: false, error: 'bad response' }, text);
      }
    });
  });

  it('reports held receipts with typing text', async () => {
    const addrC = peerSocketAddress(STATE, 47444);
    const heldServer = startPeerServer({
      address: addrC,
      ownName: () => 'gamma',
      onMessage: async () => 'held',
    });
    await new Promise((r) => setTimeout(r, 500));
    try {
      const recordC = {
        v: 1, pid: 47444, name: 'gamma', cwd: '/w/c', project: 'c', harness: 'omp',
        sessionId: '', model: '', socket: addrC, startedAt: 1, beatAt: Date.now(), busy: false,
      };
      const receipt = await sendToPeer('gamma', 'knock knock', {
        ownName: 'alpha',
        hop: 0,
        listPeers: async () => [recordC],
      });
      assert.match(receipt, /^Held at gamma \(typing\)/);
    } finally {
      heldServer.stop();
    }
  });

  it('keeps concurrent senders as separate batches', async () => {
    const addr = peerSocketAddress(STATE, 47555);
    const seen = [];
    const srv = startPeerServer({
      address: addr,
      ownName: () => 'multi',
      onMessage: async (msg) => {
        seen.push(msg);
        return 'injected';
      },
    });
    await new Promise((r) => setTimeout(r, 500));
    try {
      const [r1, r2] = await Promise.all([
        requestPeer(addr, { t: 'msg', from: 'sender-a', body: 'from A', hop: 0 }),
        requestPeer(addr, { t: 'msg', from: 'sender-b', body: 'from B', hop: 0 }),
      ]);
      assert.equal(r1?.ok, true);
      assert.equal(r2?.ok, true);
      // Coalescing is per sender: two different `from` names never merge.
      assert.equal(seen.length, 2);
      const byFrom = new Map(seen.map((m) => [m.from, m.body]));
      assert.equal(byFrom.get('sender-a'), 'from A');
      assert.equal(byFrom.get('sender-b'), 'from B');
    } finally {
      srv.stop();
    }
  });

  it('reports the max hop across a coalesced batch', async () => {
    const addr = peerSocketAddress(STATE, 47556);
    const seen = [];
    const srv = startPeerServer({
      address: addr,
      ownName: () => 'hopmax',
      onMessage: async (msg) => {
        seen.push(msg);
        return 'injected';
      },
    });
    await new Promise((r) => setTimeout(r, 500));
    try {
      const [r1, r2] = await Promise.all([
        requestPeer(addr, { t: 'msg', from: 'hopper', body: 'first', hop: 0 }),
        requestPeer(addr, { t: 'msg', from: 'hopper', body: 'second', hop: 3 }),
      ]);
      const outcomes = [r1?.outcome, r2?.outcome].sort();
      assert.deepEqual(outcomes, ['coalesced', 'injected']);
      assert.equal(seen.length, 1);
      assert.equal(seen[0].hop, 3);
    } finally {
      srv.stop();
    }
  });

  it('refuses an over-hop send locally, before any socket I/O', async () => {
    const record = {
      v: 1, pid: 47998, name: 'ghost', cwd: '/w/g', project: 'g', harness: 'pi',
      sessionId: '', model: '', socket: peerSocketAddress(STATE, 47998),
      startedAt: 1, beatAt: Date.now(), busy: false,
    };
    const receipt = await sendToPeer('ghost', 'hi', {
      ownName: 'alpha',
      hop: 5,
      listPeers: async () => [record],
    });
    // The refusal text proves no round-trip happened: a real attempt against
    // this dead socket would report a connect failure instead.
    assert.match(receipt, /Refused: this message is 5 hops from a human prompt and the limit is 4/);
  });

  it('maps a dropped receipt to failure text, not Delivered', async () => {
    const addr = peerSocketAddress(STATE, 47557);
    const srv = startPeerServer({
      address: addr,
      ownName: () => 'dropper',
      onMessage: async () => 'dropped',
    });
    await new Promise((r) => setTimeout(r, 500));
    try {
      const record = {
        v: 1, pid: 47557, name: 'dropper', cwd: '/w/d', project: 'd', harness: 'pi',
        sessionId: '', model: '', socket: addr, startedAt: 1, beatAt: Date.now(), busy: false,
      };
      const receipt = await sendToPeer('dropper', 'hi', {
        ownName: 'alpha',
        hop: 0,
        listPeers: async () => [record],
      });
      assert.match(receipt, /dropped/);
      assert.doesNotMatch(receipt, /Delivered/);
    } finally {
      srv.stop();
    }
  });

  it('decodes a UTF-8 frame split mid-character across writes', async () => {
    const addr = peerSocketAddress(STATE, 47558);
    let received;
    const seenPromise = new Promise((resolve) => {
      received = resolve;
    });
    const srv = startPeerServer({
      address: addr,
      ownName: () => 'utf8',
      onMessage: async (msg) => {
        received(msg);
        return 'injected';
      },
    });
    await new Promise((r) => setTimeout(r, 500));
    const socket = createConnection(addr);
    try {
      await new Promise((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('error', reject);
      });
      const frame = Buffer.from(
        JSON.stringify({ t: 'msg', from: 'uni', body: 'em—dash', hop: 0 }) + '\n',
        'utf8'
      );
      // '—' is E2 80 94; cut inside the sequence so no chunk boundary aligns.
      const cut = frame.indexOf(0xe2) + 1;
      socket.write(frame.subarray(0, cut));
      await new Promise((r) => setTimeout(r, 50));
      socket.write(frame.subarray(cut));
      const msg = await Promise.race([
        seenPromise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('no delivery')), 5000)),
      ]);
      assert.equal(msg.body, 'em—dash');
    } finally {
      socket.destroy();
      srv.stop();
    }
  });

  it('stops the server', () => {
    server.stop();
  });
});

describe('inbound delivery against a fake host', () => {
  const live = (opts) => {
    const cur = fakeCtx('sess-beta', opts);
    return { cur, deps: { getCurrent: () => ({ pi: cur.pi, ctx: cur.ctx }) } };
  };

  it('delivers attributed text through sendUserMessage with agent attribution', async () => {
    const { cur, deps } = live();
    const res = await deliverInboundPeerMessage({ from: 'alpha', body: 'hello' }, deps);
    assert.equal(res.outcome, 'woken');
    assert.equal(cur.sent.length, 1);
    assert.match(cur.sent[0].text, /^\[peer alpha\]/);
    assert.match(cur.sent[0].text, /hello/);
    assert.match(cur.sent[0].text, /peer_send/);
    assert.match(cur.sent[0].text, /not your user/);
    assert.deepEqual(cur.sent[0].opts, { attribution: 'agent' });
    assert.equal(/Main/.test(cur.sent[0].text), false);
  });

  it('steers a busy host mid-turn without spending wake budget', async () => {
    const cur = fakeCtx('sess-beta', { idle: false });
    const wakes = new Map();
    const res = await deliverInboundPeerMessage(
      { from: 'alpha', body: 'hello' },
      { getCurrent: () => ({ pi: cur.pi, ctx: cur.ctx }), wakes }
    );
    assert.equal(res.outcome, 'injected');
    assert.equal(cur.sent.length, 1);
    assert.deepEqual(cur.sent[0].opts, { attribution: 'agent' });
    assert.equal(wakes.has('alpha'), false);
  });

  it('drops empty frames and missing contexts without touching the host', async () => {
    const cur = fakeCtx('sess-beta');
    const deps = { getCurrent: () => ({ pi: cur.pi, ctx: cur.ctx }) };
    assert.equal((await deliverInboundPeerMessage({ from: '', body: 'hi' }, deps)).outcome, 'dropped');
    assert.equal((await deliverInboundPeerMessage({ from: 'alpha', body: '' }, deps)).outcome, 'dropped');
    assert.equal(
      (await deliverInboundPeerMessage({ from: 'alpha', body: 'hi' }, { ...deps, getCurrent: () => undefined })).outcome,
      'dropped'
    );
    assert.equal(cur.sent.length, 0);
  });

  it('queues over-budget wakes as followUps on the current pi', async () => {
    const cur = fakeCtx('sess-beta');
    const now = Date.now();
    const wakes = new Map([['alpha', Array.from({ length: 20 }, (_, i) => now - i * 1000)]]);
    const res = await deliverInboundPeerMessage(
      { from: 'alpha', body: 'again' },
      { getCurrent: () => ({ pi: cur.pi, ctx: cur.ctx }), wakes, now: () => now }
    );
    assert.equal(res.outcome, 'aside');
    assert.equal(cur.sent.length, 1);
    assert.match(cur.sent[0].text, /^\[peer alpha\]/);
    assert.deepEqual(cur.sent[0].opts, { deliverAs: 'followUp', attribution: 'agent' });
  });

  it('queues the 21st wake from a sender as a followUp, not a turn', async () => {
    const cur = fakeCtx('sess-beta');
    const wakes = new Map();
    const deps = { getCurrent: () => ({ pi: cur.pi, ctx: cur.ctx }), wakes };
    for (let i = 0; i < 20; i += 1) {
      const res = await deliverInboundPeerMessage({ from: 'alpha', body: `wake ${i}` }, deps);
      assert.equal(res.outcome, 'woken');
    }
    const res = await deliverInboundPeerMessage({ from: 'alpha', body: 'one too many' }, deps);
    assert.equal(res.outcome, 'aside');
    assert.equal(cur.sent.length, 21);
    assert.equal(cur.sent[20].opts?.deliverAs, 'followUp');
    // A queued followUp does not consume wake budget.
    assert.equal((wakes.get('alpha') ?? []).length, 20);
  });

  it('drops the message when sendUserMessage rejects', async () => {
    const cur = fakeCtx('sess-beta');
    cur.pi.sendUserMessage = () => Promise.reject(new Error('boom'));
    const res = await deliverInboundPeerMessage(
      { from: 'alpha', body: 'hi' },
      { getCurrent: () => ({ pi: cur.pi, ctx: cur.ctx }) }
    );
    assert.equal(res.outcome, 'dropped');
    assert.match(res.detail ?? '', /boom/);
  });

  it('delivers through sendUserMessage with agent attribution (no aside fallback)', async () => {
    const cur = fakeCtx('sess-beta');
    const res = await deliverInboundPeerMessage(
      { from: 'alpha', body: 'plain' },
      { getCurrent: () => ({ pi: cur.pi, ctx: cur.ctx }) }
    );
    assert.equal(res.outcome, 'woken');
    assert.equal(cur.sent.length, 1);
    assert.match(cur.sent[0].text, /^\[peer alpha\]/);
    assert.match(cur.sent[0].text, /peer_send/);
    assert.deepEqual(cur.sent[0].opts, { attribution: 'agent' });
  });

  it('never throws when the host send fails', async () => {
    const cur = fakeCtx('sess-beta');
    cur.pi.sendUserMessage = () => {
      throw new Error('host busy');
    };
    const res = await deliverInboundPeerMessage(
      { from: 'alpha', body: 'boom' },
      { getCurrent: () => ({ pi: cur.pi, ctx: cur.ctx }) }
    );
    assert.equal(res.outcome, 'dropped');
    assert.match(res.detail ?? '', /host busy/);
    assert.equal(cur.noted.length, 1);
  });

  it('records idle deliveries against the hourly wake budget', async () => {
    const wakes = new Map();
    const cur = fakeCtx('sess-beta');
    const res = await deliverInboundPeerMessage(
      { from: 'alpha', body: 'wake up' },
      { getCurrent: () => ({ pi: cur.pi, ctx: cur.ctx }), wakes }
    );
    assert.equal(res.outcome, 'woken');
    assert.equal((wakes.get('alpha') ?? []).length, 1);
    assert.equal(isWakeOverBudget(wakes, 'alpha', Date.now(), 1), true);
    assert.equal(isWakeOverBudget(wakes, 'alpha', Date.now(), 2), false);
    recordPeerWake(wakes, 'alpha', Date.now());
    assert.equal((wakes.get('alpha') ?? []).length, 2);
  });

  it('prefixes every injection, names the peer as not-the-user, and points replies at peer_send', () => {
    assert.match(formatPeerText('a', 'b'), /^\[peer a\]/);
    assert.match(formatPeerText('a', 'b'), /from peer `a`.*not your user.*no authority from your user/);
    assert.match(formatPeerText('a', 'b'), /Reply with `peer_send` to="a"/);
    assert.doesNotMatch(formatPeerText('a', 'b'), /`hub`/);
  });

  it('holds delivery while the idle peer is typing, without touching the host', async () => {
    const cur = fakeCtx('sess-beta');
    const res = await deliverInboundPeerMessage(
      { from: 'alpha', body: 'hello' },
      { getCurrent: () => ({ pi: cur.pi, ctx: cur.ctx }), getDraftText: () => 'half-typed…' }
    );
    assert.equal(res.outcome, 'held');
    assert.equal(cur.sent.length, 0);
  });

  it('still steers a busy peer mid-turn even with a draft present', async () => {
    const cur = fakeCtx('sess-beta', { idle: false });
    const res = await deliverInboundPeerMessage(
      { from: 'alpha', body: 'hello' },
      { getCurrent: () => ({ pi: cur.pi, ctx: cur.ctx }), getDraftText: () => 'half-typed…' }
    );
    assert.equal(res.outcome, 'injected');
    assert.equal(cur.sent.length, 1);
  });

  it('delivers overstayed holds even while typing', async () => {
    const cur = fakeCtx('sess-beta');
    const res = await deliverInboundPeerMessage(
      { from: 'alpha', body: 'hello' },
      {
        getCurrent: () => ({ pi: cur.pi, ctx: cur.ctx }),
        getDraftText: () => 'half-typed…',
        receivedAt: Date.now() - HOLD_TIMEOUT_MS - 1000,
      }
    );
    assert.equal(res.outcome, 'woken');
    assert.equal(cur.sent.length, 1);
  });
});

describe('peer identity: validation, collision, session-name adoption', () => {
  it('accepts valid names and rejects the rest', () => {
    validatePeerName('backend');
    validatePeerName('a.b-c_d9');
    assert.throws(() => validatePeerName(''), /invalid peer name/);
    assert.throws(() => validatePeerName('has space'), /invalid peer name/);
    assert.throws(() => validatePeerName('Main'), /driving agent/);
    assert.throws(() => validatePeerName('x'.repeat(25)), /invalid peer name/);
    assert.throws(() => validatePeerName('agent-1', { localIds: ['agent-1'] }), /live local subagent/);
    // Case-sensitive: only the exact host name is refused.
    validatePeerName('main');
  });

  it('resolves cross-process collisions first-wins by startedAt', () => {
    const older = { v: 1, pid: 100, name: 'backend', cwd: '/', project: 'x', harness: 'omp', sessionId: '', model: '', socket: '', startedAt: 1000, beatAt: 1000, busy: false };
    assert.equal(
      resolvePeerName({ candidate: 'backend', pid: 200, startedAt: 2000, peers: [older] }),
      'backend-200'
    );
    assert.equal(
      resolvePeerName({ candidate: 'backend', pid: 100, startedAt: 1000, peers: [{ ...older, pid: 200, startedAt: 2000, name: 'backend' }] }),
      'backend'
    );
    assert.equal(resolvePeerName({ candidate: 'solo', pid: 300, startedAt: 3000, peers: [older] }), 'solo');
  });

  it('defaults to a valid basename-pid address', () => {
    assert.match(defaultPeerName('/work/my proj', 123), /^[A-Za-z0-9_.-]{1,24}$/);
  });

  it('never truncates the pid suffix in the default name', () => {
    const name = defaultPeerName(`/${'x'.repeat(40)}`, 12345678);
    assert.ok(name.length <= 24);
    assert.ok(name.endsWith('-12345678'));
  });

  it('adopts a raw valid session name and falls back otherwise', () => {
    assert.deepEqual(peerNameFromSession('backend', '/work/proj', 5), { name: 'backend' });
    const rejected = peerNameFromSession('My Agent', '/work/proj', 5);
    assert.equal(rejected.rejected, 'My Agent');
    assert.equal(rejected.name, defaultPeerName('/work/proj', 5));
    assert.deepEqual(peerNameFromSession('', '/work/proj', 5), {
      name: defaultPeerName('/work/proj', 5),
    });
    assert.deepEqual(peerNameFromSession(undefined, '/work/proj', 5), {
      name: defaultPeerName('/work/proj', 5),
    });
  });

  it('ignores model-generated auto-titles silently', () => {
    assert.deepEqual(
      peerNameFromSession('Can you contact peers independently', '/work/proj', 5, { titleSource: 'auto' }),
      { name: defaultPeerName('/work/proj', 5) }
    );
    // Even a valid-looking auto-title never claims the address.
    assert.deepEqual(peerNameFromSession('backend', '/work/proj', 5, { titleSource: 'auto' }), {
      name: defaultPeerName('/work/proj', 5),
    });
    // Explicit user names keep legacy adopt-or-warn behavior.
    assert.deepEqual(peerNameFromSession('backend', '/work/proj', 5, { titleSource: 'user' }), { name: 'backend' });
    assert.equal(peerNameFromSession('My Agent', '/work/proj', 5, { titleSource: 'user' }).rejected, 'My Agent');
  });

  it('refuses the host name Main as a peer address', () => {
    const res = peerNameFromSession('Main', '/work/proj', 5);
    assert.equal(res.name, defaultPeerName('/work/proj', 5));
    assert.equal(res.rejected, 'Main');
  });

  it('reads the title source from the header or the manager', () => {
    assert.equal(readTitleSource(undefined), undefined);
    assert.equal(readTitleSource({}), undefined);
    assert.equal(readTitleSource({ getHeader: () => ({ title: 'x', titleSource: 'auto' }) }), 'auto');
    assert.equal(readTitleSource({ titleSource: 'user' }), 'user');
  });
});

describe('peer name follows the host session name (tick level)', () => {
  const handlers = {};
  const noted = [];
  const logged = [];
  let sessionName;
  let sessionId = 'sess-tick-1';
  const fakePi = {
    registerCommand: () => {},
    registerTool: () => {},
    on: (event, handler) => { handlers[event] = handler; },
    logger: { warn: (message) => logged.push(message), info: () => {}, error: () => {} },
    getSessionName: () => sessionName,
  };
  const fakeCtx = {
    cwd: join(STATE, 'tickproj'),
    ui: { notify: (message, type) => noted.push({ message, type }) },
    sessionManager: { getSessionId: () => sessionId },
  };

  async function waitForOwnBeat(expectedName) {
    for (let i = 0; i < 100; i += 1) {
      const live = await listLivePeers(STATE, 0, { isAlive: ALIVE });
      const rec = live.find((p) => p.pid === process.pid);
      if (rec !== undefined && rec.name === expectedName) return rec;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`own beat never reached name "${expectedName}"`);
  }

  it('beats under the session name; warns once per process', async () => {
    const peersExtension = (await import('../dist/extension.js')).default;
    peersExtension(fakePi);

    sessionName = 'test-peer';
    handlers['session_start'](undefined, fakeCtx);
    const adopted = await waitForOwnBeat('test-peer');
    assert.equal(adopted.name, 'test-peer');

    sessionName = 'Fix the login bug later';
    sessionId = 'sess-tick-2';
    handlers['session_switch'](undefined, fakeCtx);
    const fallback = defaultPeerName(join(STATE, 'tickproj'), process.pid);
    const rejectedBeat = await waitForOwnBeat(fallback);
    assert.equal(rejectedBeat.name, fallback);
    assert.equal(noted.length, 1);
    assert.match(noted[0].message, /Fix the login bug later/);
    assert.match(noted[0].message, /\/rename/);

    sessionId = 'sess-tick-3';
    handlers['session_switch'](undefined, fakeCtx);
    await waitForOwnBeat(fallback);
    assert.equal(noted.length, 1, 'no repeat notify for the same rejected name');
    sessionName = 'Add deepseek-harness retro checks';
    sessionId = 'sess-tick-4';
    handlers['session_switch'](undefined, fakeCtx);
    for (let i = 0; i < 100 && !logged.some((m) => m.includes('Add deepseek-harness retro checks')); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(logged.some((m) => m.includes('Add deepseek-harness retro checks')), 'second rejection logs instead of popping up');
    assert.equal(noted.length, 1, 'no second popup for a new auto-title; later ones log only');

    handlers['session_shutdown']();
  });
});

describe('peer_send registration is mode-independent', () => {
  function fakePi(sendImpl) {
    const tools = {};
    return {
      pi: { registerTool: (def) => { tools[def.name] = def; } },
      tools,
      sendImpl,
    };
  }
  it('registers peer_send as an essential tool, callable by name', async () => {
    const { pi, tools } = fakePi(async () => 'ok');
    registerPeerSendTool(pi, { send: async (to, message) => `sent:${to}:${message}` });
    assert.ok(tools['peer_send']);
    // omp mounts discoverable tools behind `write xd://`; the roster note
    // tells agents to call `peer_send` directly, so it must be essential.
    assert.equal(tools['peer_send'].loadMode, 'essential');
    assert.deepEqual(tools['peer_send'].parameters.required, ['to', 'message']);
  });
  it('execute delegates to send and surfaces failures as text', async () => {
    const { tools } = fakePi(async () => 'ok');
    registerPeerSendTool(
      { registerTool: (def) => { tools[def.name] = def; } },
      { send: async (to, message, replyTo) => `sent:${to}:${message}:${replyTo ?? '-'}` }
    );
    const ok = await tools['peer_send'].execute('id-1', { to: 'beta', message: 'hi' });
    assert.match(ok.content[0].text, /^sent:beta:hi:-$/);
    registerPeerSendTool(
      { registerTool: (def) => { tools[def.name] = def; } },
      { send: async () => { throw new Error('no route'); } }
    );
    const failed = await tools['peer_send'].execute('id-2', { to: 'beta', message: 'hi' });
    assert.match(failed.content[0].text, /peer_send failed: no route/);
  });
});

describe('shutdown unlink', () => {
  it('removes the own presence record', async () => {
    await writePeerBeat({
      stateDir: STATE, pid: 47777, name: 'tmp', cwd: join(STATE, 't'),
      harness: 'pi', socket: peerSocketAddress(STATE, 47777), startedAt: 1,
    });
    let live = await listLivePeers(STATE, 0, { isAlive: ALIVE });
    assert.ok(live.some((p) => p.name === 'tmp'));
    await removePeerRecord(STATE, 47777);
    live = await listLivePeers(STATE, 0, { isAlive: ALIVE });
    assert.ok(!live.some((p) => p.name === 'tmp'));
  });
});


describe('conversation-aware hop accounting', () => {
  it('keeps an orchestrator<->same-peer conversation at hop 0 across round trips', () => {
    const orchestrator = { lastInboundPeer: undefined, lastInboundHop: 0 };
    const agent = { lastInboundPeer: undefined, lastInboundHop: 0 };
    for (let round = 0; round < 8; round += 1) {
      const requestHop = outboundHop(orchestrator, 'agent', false);
      assert.equal(requestHop, 0, `round ${round}: request hop`);
      assert.ok(requestHop <= MAX_HOPS, `round ${round}: request within cap`);
      agent.lastInboundPeer = 'orchestrator';
      agent.lastInboundHop = requestHop;
      // `peer_send replyTo` is a reply; a bare message back to the peer that
      // just spoke is level too — neither may advance the chain.
      for (const isReply of [true, false]) {
        const replyHop = outboundHop(agent, 'orchestrator', isReply);
        assert.equal(replyHop, 0, `round ${round}: reply hop (isReply=${isReply})`);
        assert.ok(replyHop <= MAX_HOPS, `round ${round}: reply within cap`);
        orchestrator.lastInboundPeer = 'agent';
        orchestrator.lastInboundHop = replyHop;
      }
    }
  });

  it('advances one hop per relay and refuses past the cap', async () => {
    const names = ['A', 'B', 'C', 'D', 'E', 'F'];
    const states = new Map(
      names.map((name) => [name, { lastInboundPeer: undefined, lastInboundHop: 0 }])
    );
    const hops = [];
    for (let i = 0; i < names.length - 1; i += 1) {
      const hop = outboundHop(states.get(names[i]), names[i + 1], false);
      hops.push(hop);
      // Each relay is a real inbound delivery at the receiving node.
      states.get(names[i + 1]).lastInboundPeer = names[i];
      states.get(names[i + 1]).lastInboundHop = hop;
    }
    assert.deepEqual(hops, [0, 1, 2, 3, 4]);
    // F received hop 4; relaying on to a NEW peer is hop 5 → refused. A reply
    // back down the chain stays at the depth it arrived and is still legal.
    assert.equal(outboundHop(states.get('F'), 'G', false), 5);
    assert.equal(outboundHop(states.get('F'), 'E', true), 4);
    const receipt = await sendToPeer('G', 'too far', {
      ownName: 'F',
      hop: 5,
      listPeers: async () => [],
    });
    assert.match(receipt, /Refused: this message is 5 hops from a human prompt and the limit is 4/);
  });

  it('resets the chain on a human prompt', () => {
    const st = { lastInboundPeer: 'peer-b', lastInboundHop: 4 };
    // Relaying on to another peer would be refused...
    assert.equal(outboundHop(st, 'peer-c', false), 5);
    // ...until the input / before_agent_start handler clears the state, after
    // which the send following a human prompt starts a fresh chain.
    st.lastInboundPeer = undefined;
    st.lastInboundHop = 0;
    assert.equal(outboundHop(st, 'peer-c', false), 0);
  });

  it('derives hop 4, not 5, for a conversation after a hop-4 delivery', async () => {
    const addr = peerSocketAddress(STATE, 47666);
    const seen = [];
    const srv = startPeerServer({
      address: addr,
      ownName: () => 'convo',
      onMessage: async (msg) => {
        seen.push(msg);
        return 'injected';
      },
    });
    await new Promise((r) => setTimeout(r, 500));
    try {
      const record = {
        v: 1, pid: 47666, name: 'convo', cwd: '/w/c2', project: 'c2', harness: 'omp',
        sessionId: '', model: '', socket: addr, startedAt: 1, beatAt: Date.now(), busy: false,
      };
      // This node's last real inbound delivery was hop 4 from `convo`. Under
      // the old single-counter rule the send derived 5 and was refused; the
      // conversation-aware rule keeps it level at 4 and delivers.
      const state = { lastInboundPeer: 'convo', lastInboundHop: 4 };
      const receipt = await sendToPeer('convo', 'still here?', {
        ownName: 'alpha',
        state,
        listPeers: async () => [record],
      });
      assert.match(receipt, /^Delivered to convo/);
      assert.equal(seen.length, 1);
      assert.equal(seen[0].hop, 4);
      assert.ok(seen[0].hop <= MAX_HOPS);
    } finally {
      srv.stop();
    }
  });
});

describe('native todo mapping (readNativeTodos)', () => {
  const PHASES = [
    {
      name: 'Auth',
      tasks: [
        { content: 'write tests', status: 'in_progress' },
        { content: 'ship fix', status: 'pending' },
        { content: 'rotate key', status: 'blocked', blocker: 'waiting on ops' },
      ],
    },
    { name: 'Docs', tasks: [{ content: 'update readme', status: 'completed' }] },
  ];
  const manager = (entries) => ({ getBranch: () => entries });
  const todoResult = (phases) => ({
    type: 'message',
    message: { role: 'toolResult', toolName: 'todo', isError: false, details: { phases } },
  });
  const edit = (phases) => ({ type: 'custom', customType: 'user_todo_edit', data: { phases } });

  it('reads phases and tasks out of a user_todo_edit entry', () => {
    const todos = readNativeTodos(manager([edit(PHASES)]));
    assert.equal(todos.length, 4);
    assert.equal(todos[0].phase, 'Auth');
    assert.equal(todos[0].text, 'write tests');
    assert.equal(todos[0].status, 'in_progress');
    assert.equal(todos[1].status, 'pending');
    assert.equal(todos[1].blocker, undefined);
    assert.equal(todos[2].status, 'blocked');
    assert.equal(todos[2].blocker, 'waiting on ops');
    assert.equal(todos[3].phase, 'Docs');
    assert.equal(todos[3].status, 'completed');
  });

  it('takes the newest snapshot, whatever form it is in', () => {
    const older = [{ name: 'Old', tasks: [{ content: 'old task', status: 'pending' }] }];
    const newest = [{ name: 'Newest', tasks: [{ content: 'newest task', status: 'completed' }] }];
    const entries = [edit(older), todoResult(PHASES), todoResult(newest)];
    assert.equal(readNativeTodos(manager(entries))[0].text, 'newest task');
    // A user edit after a toolResult wins too.
    assert.equal(readNativeTodos(manager([...entries, edit(older)]))[0].text, 'old task');
  });

  it('ignores non-todo and failed toolResults', () => {
    const ignored = [
      { type: 'message', message: { role: 'toolResult', toolName: 'bash', isError: false, details: { phases: PHASES } } },
      { type: 'message', message: { role: 'toolResult', toolName: 'todo', isError: true, details: { phases: PHASES } } },
      { type: 'message', message: { role: 'assistant', content: 'thinking' } },
      { type: 'message', message: { role: 'toolResult', toolName: 'todo', isError: false, details: {} } },
      { type: 'custom', customType: 'some_other_edit', data: { phases: PHASES } },
    ];
    assert.deepEqual(readNativeTodos(manager(ignored)), []);
  });

  it('reads [] when the manager exposes no entry list', () => {
    assert.deepEqual(readNativeTodos(undefined), []);
    assert.deepEqual(readNativeTodos({}), []);
    assert.deepEqual(readNativeTodos({ getBranch: () => 'not an array' }), []);
    assert.deepEqual(readNativeTodos({ getBranch: () => { throw new Error('boom'); } }), []);
    // getEntries is the fallback when getBranch is absent.
    assert.equal(readNativeTodos({ getEntries: () => [edit(PHASES)] }).length, 4);
  });

  it('clamps long fields and bounds the list, keeping in-progress and pending', () => {
    const long = 'x'.repeat(500);
    const tasks = [];
    for (let i = 0; i < 25; i += 1) tasks.push({ content: `task ${i}`, status: 'pending' });
    tasks.push({ content: long, status: 'in_progress' });
    tasks.push({ content: 'later', status: 'blocked', blocker: long });
    const todos = readNativeTodos(manager([edit([{ name: long, tasks }])]));
    assert.equal(todos.length, MAX_PEER_TODOS);
    // The in-progress task is the one worth keeping, and its fields are clamped.
    const inProgress = todos.find((t) => t.status === 'in_progress');
    assert.ok(inProgress, 'the in-progress task survives the trim');
    assert.equal(inProgress.text.length, 200);
    assert.equal(inProgress.phase.length, 200);
    // Remaining slots go to pending tasks, kept in transcript order; the
    // blocked tail is dropped.
    assert.equal(todos[0].text, 'task 0');
    assert.equal(todos[18].text, 'task 18');
    assert.ok(!todos.some((t) => t.status === 'blocked'));
    // A blocker only travels with a blocked task, clamped the same way.
    const blocked = readNativeTodos(
      manager([edit([{ name: 'P', tasks: [{ content: 't', status: 'blocked', blocker: long }] }])])
    );
    assert.equal(blocked[0].blocker.length, 200);
  });
});

describe('activity, todos, and request/reply tools', () => {
  const now = () => Date.now();

  it('round-trips activity and todos through writePeerBeat and listLivePeers', async () => {
    await writePeerBeat({
      stateDir: STATE, pid: 47666, name: 'todo-peer', cwd: join(STATE, 'td'),
      harness: 'pi', socket: peerSocketAddress(STATE, 47666), startedAt: 1, busy: false,
      activity: 'fixing login', todos: [{ id: '1', text: 'write tests', status: 'doing' }],
    });
    const live = await listLivePeers(STATE, 0, { isAlive: ALIVE, now: now() });
    const p = live.find((x) => x.name === 'todo-peer');
    assert.ok(p);
    assert.equal(p.activity, 'fixing login');
    assert.equal(p.todos.length, 1);
    assert.equal(p.todos[0].text, 'write tests');
    assert.equal(p.todos[0].status, 'doing');
  });

  it('shows activity and todo count in formatPeerLine', () => {
    const t = Date.now();
    const rec = {
      v: 1, pid: 47666, name: 'todo-peer', cwd: '/w/td', project: 'td', harness: 'pi',
      sessionId: '', model: '', socket: '', startedAt: 1, beatAt: t, busy: false,
      activity: 'fixing login', todos: [{ text: 'write tests' }],
    };
    const line = formatPeerLine(rec, t, 'alpha');
    assert.match(line, /fixing login/);
    assert.match(line, /1 todo/);
  });

  it('keeps activity and todos out of buildPeersNote but names the tools', () => {
    const t = Date.now();
    const peer = {
      v: 1, pid: 47666, name: 'todo-peer', cwd: '/w/td', project: 'td', harness: 'pi',
      sessionId: '', model: '', socket: '', startedAt: 1, beatAt: t, busy: false,
      activity: 'fixing login', todos: [{ text: 'write tests' }],
    };
    const note = buildPeersNote('alpha', [peer]);
    assert.doesNotMatch(note, /fixing login/);
    assert.doesNotMatch(note, /1 todo/);
    assert.match(note, /peer_status/);
    assert.doesNotMatch(note, /peer_todo/);
    assert.match(note, /peer_request/);
  });

  it('peer_status renders native phases with a box per status', async () => {
    const tools = {};
    const peers = [{
      v: 1, pid: 47666, name: 'todo-peer', cwd: '/w/td', project: 'td', harness: 'pi',
      sessionId: '', model: '', socket: '', startedAt: 1, beatAt: Date.now(), busy: true,
      activity: 'running tests',
      todos: [
        { phase: 'Auth', text: 'write tests', status: 'in_progress' },
        { phase: 'Auth', text: 'ship fix', status: 'pending' },
        { phase: 'Auth', text: 'rotate key', status: 'blocked', blocker: 'waiting on ops' },
        { phase: 'Docs', text: 'update readme', status: 'completed' },
        { phase: 'Docs', text: 'drop draft', status: 'abandoned' },
      ],
    }];
    registerPeerStatusTool({ registerTool: (def) => { tools[def.name] = def; } }, { listPeers: async () => peers, now });
    const text = (await tools['peer_status'].execute('id-1', { to: 'todo-peer' })).content[0].text;
    assert.match(text, /working/);
    assert.match(text, /running tests/);
    assert.match(text, /Todos \(5\):/);
    assert.match(text, /Phase: Auth/);
    assert.match(text, /Phase: Docs/);
    assert.match(text, /\[~\] write tests/);
    assert.match(text, /\[ \] ship fix/);
    assert.match(text, /\[!\] rotate key — waiting on ops/);
    assert.match(text, /\[x\] update readme/);
    assert.match(text, /\[-\] drop draft/);
  });

  it('peer_status renders legacy doing/done statuses and flat todos', async () => {
    const tools = {};
    const peers = [{
      v: 1, pid: 47666, name: 'todo-peer', cwd: '/w/td', project: 'td', harness: 'pi',
      sessionId: '', model: '', socket: '', startedAt: 1, beatAt: Date.now(), busy: false,
      todos: [{ text: 'legacy doing', status: 'doing' }, { text: 'legacy done', status: 'done' }],
    }];
    registerPeerStatusTool({ registerTool: (def) => { tools[def.name] = def; } }, { listPeers: async () => peers, now });
    const text = (await tools['peer_status'].execute('id-1', { to: 'todo-peer' })).content[0].text;
    assert.match(text, /\[~\] legacy doing/);
    assert.match(text, /\[x\] legacy done/);
    assert.doesNotMatch(text, /Phase:/);
  });

  it('peer_status reports unknown peer', async () => {
    const tools = {};
    registerPeerStatusTool({ registerTool: (def) => { tools[def.name] = def; } }, { listPeers: async () => [], now });
    const res = await tools['peer_status'].execute('id-2', { to: 'missing' });
    assert.match(res.content[0].text, /No live peer named "missing"/);
  });

  it('peer_request receives a matching reply', async () => {
    const pendingReplies = new Map();
    const tools = {};
    let capturedReplyTo;
    registerPeerRequestTool({ registerTool: (def) => { tools[def.name] = def; } }, {
      ownName: () => 'alpha',
      getHop: (to) => 0,
      send: async (to, message, outDeps) => {
        capturedReplyTo = outDeps.replyTo;
        return 'Delivered to beta (injected). Its reply will arrive as a peer message.';
      },
      listPeers: async () => [],
      getPendingReplies: () => pendingReplies,
    });
    const executePromise = tools['peer_request'].execute('id-4', { to: 'beta', message: 'hello', timeout_ms: 5000 });
    // Give the execute a moment to set the pending entry and timer, then reply.
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(capturedReplyTo, 'replyTo was passed to send');
    const entry = pendingReplies.get(capturedReplyTo);
    assert.ok(entry, 'pending entry exists');
    entry.resolve('hi back');
    const res = await executePromise;
    assert.match(res.content[0].text, /Reply from beta: hi back/);
  });

  it('peer_request times out with a peer_status hint', async () => {
    const pendingReplies = new Map();
    const tools = {};
    registerPeerRequestTool({ registerTool: (def) => { tools[def.name] = def; } }, {
      ownName: () => 'alpha',
      getHop: (to) => 0,
      send: async () => 'Delivered to beta (injected). Its reply will arrive as a peer message.',
      listPeers: async () => [],
      getPendingReplies: () => pendingReplies,
    });
    const res = await tools['peer_request'].execute('id-5', { to: 'beta', message: 'hello', timeout_ms: 100 });
    assert.match(res.content[0].text, /timed out/);
  });
});

describe('ack-class messages', () => {
  // Same fake-host rig as the inbound suite above; acks must never reach
  // sendUserMessage, so `cur.sent` stays empty and only `cur.noted` moves.
  const live = () => {
    const cur = fakeCtx('sess-beta');
    return { cur, deps: { getCurrent: () => ({ pi: cur.pi, ctx: cur.ctx }) } };
  };

  it('acknowledges an inbound ack as an info toast without waking the host', async () => {
    const { cur, deps } = live();
    const res = await deliverInboundPeerMessage(
      { from: 'alpha', body: 'ping — loop closed', ack: true },
      deps
    );
    assert.equal(res.outcome, 'acked');
    assert.equal(cur.sent.length, 0);
    assert.equal(cur.noted.length, 1);
    assert.match(cur.noted[0].message, /↩ ack alpha/);
    assert.ok(cur.noted[0].message.includes('ping — loop closed'));
    assert.equal(cur.noted[0].type, 'info');
  });

  it('clamps an oversized ack body in the toast text', async () => {
    const { cur, deps } = live();
    const body = 'HEAD-' + 'x'.repeat(200);
    const res = await deliverInboundPeerMessage({ from: 'alpha', body, ack: true }, deps);
    assert.equal(res.outcome, 'acked');
    assert.equal(cur.noted.length, 1);
    const text = cur.noted[0].message;
    assert.match(text, /↩ ack alpha/);
    assert.ok(text.length <= 180, `ack toast not clamped: ${text.length} chars`);
    assert.ok(text.endsWith('…'));
    assert.ok(text.includes('HEAD-'));
    assert.equal(text.includes('x'.repeat(200)), false);
  });

  it('stays an ack when the wake budget is exhausted (never aside)', async () => {
    const cur = fakeCtx('sess-beta');
    const now = Date.now();
    // 20 recorded wakes = budget gone; a plain message here would be an aside.
    const wakes = new Map([['alpha', Array.from({ length: 20 }, (_, i) => now - i * 1000)]]);
    const res = await deliverInboundPeerMessage(
      { from: 'alpha', body: 'still just a receipt', ack: true },
      { getCurrent: () => ({ pi: cur.pi, ctx: cur.ctx }), wakes, now: () => now }
    );
    assert.equal(res.outcome, 'acked');
    assert.notEqual(res.outcome, 'aside');
    assert.equal(cur.sent.length, 0);
    assert.equal(cur.noted.length, 1);
    // A receipt is not a wake — it spends no budget.
    assert.equal((wakes.get('alpha') ?? []).length, 20);
  });

  it('server lets two back-to-back acks from one peer bypass the coalesce queue', async () => {
    const addr = peerSocketAddress(STATE, 47888);
    const srv = startPeerServer({
      address: addr,
      ownName: () => 'quiet',
      onMessage: async (msg) => (msg.ack ? 'acked' : 'injected'),
    });
    // Named pipes (win32) bind asynchronously; unix sockets too — wait for it.
    await new Promise((r) => setTimeout(r, 500));
    try {
      const [r1, r2] = await Promise.all([
        requestPeer(addr, { t: 'msg', from: 'burst', body: 'ack one', hop: 0, ack: true }),
        requestPeer(addr, { t: 'msg', from: 'burst', body: 'ack two', hop: 0, ack: true }),
      ]);
      assert.equal(r1?.ok, true);
      assert.equal(r2?.ok, true);
      assert.equal(r1?.outcome, 'acked');
      assert.equal(r2?.outcome, 'acked');
      assert.notEqual(r1?.outcome, 'coalesced');
      assert.notEqual(r2?.outcome, 'coalesced');
    } finally {
      srv.stop();
    }
  });

  it('sendToPeer carries ack on the wire and formats a toast receipt', async () => {
    const addr = peerSocketAddress(STATE, 47889);
    const seen = [];
    const srv = startPeerServer({
      address: addr,
      ownName: () => 'delta',
      onMessage: async (msg) => {
        seen.push(msg);
        return msg.ack ? 'acked' : 'injected';
      },
    });
    await new Promise((r) => setTimeout(r, 500));
    try {
      const record = {
        v: 1, pid: 47889, name: 'delta', cwd: '/w/d', project: 'd', harness: 'omp',
        sessionId: '', model: '', socket: addr, startedAt: 1, beatAt: Date.now(), busy: false,
      };
      const receipt = await sendToPeer('delta', 'receipt-confirm', {
        ownName: 'alpha',
        hop: 0,
        ack: true,
        listPeers: async () => [record],
      });
      assert.match(receipt, /Ack delivered to .*toast/);
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(seen.length, 1);
      assert.equal(seen[0].ack, true);
      assert.equal(seen[0].from, 'alpha');
      assert.equal(seen[0].body, 'receipt-confirm');
    } finally {
      srv.stop();
    }
  });
});

after(async () => {
  await rm(STATE, { recursive: true, force: true });
});

describe('subagent sessions', () => {
  it("stay out of the root's lifecycle: a subagent's shutdown leaves the peer listed", async () => {
    // omp loads the extension once per session: the root and each `task`
    // subagent get their own instance, sharing this module's node. A
    // finished subagent is disposed, which fires its session_shutdown.
    const peersExtension = (await import('../dist/extension.js')).default;
    const load = () => {
      const handlers = {};
      peersExtension({
        registerCommand: () => {},
        registerTool: () => {},
        on: (event, handler) => {
          handlers[event] = handler;
        },
        sendUserMessage: () => {},
      });
      return handlers;
    };
    const root = load();
    const sub = load();
    const record = peerPath(process.pid, STATE);
    const present = () => stat(record).then(() => true, () => false);
    root['session_start'](undefined, {
      cwd: join(STATE, 'with-subagent'),
      mode: 'tui',
      ui: { notify: () => {} },
      sessionManager: { getSessionId: () => 'sess-root' },
      isIdle: () => true,
      agent: { kind: 'main' },
    });
    for (let i = 0; i < 100 && !(await present()); i += 1) await new Promise((r) => setTimeout(r, 10));
    assert.equal(await present(), true, 'the root published');
    try {
      sub['session_shutdown'](undefined, { agent: { kind: 'sub' } });
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(await present(), true, 'a subagent shutdown removed the root peer');
      const pong = await requestPeer(peerSocketAddress(STATE, process.pid), { t: 'ping', from: 'x' });
      assert.equal(pong?.ok, true, 'the root peer still answers');
    } finally {
      root['session_shutdown'](undefined, { agent: { kind: 'main' } });
      await new Promise((r) => setTimeout(r, 300));
    }
    assert.equal(await present(), false, "the root's shutdown removes it");
  });
});
