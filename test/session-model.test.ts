import test from 'node:test';
import assert from 'node:assert/strict';
import {
  initialSessionSnapshot,
  reduceConnection,
  roomActionsEnabled,
} from '../build/ui/session/model.js';

test('session starts without room or connection state', () => {
  const snapshot = initialSessionSnapshot();
  assert.equal(snapshot.view, 'start');
  assert.equal(snapshot.role, null);
  assert.equal(snapshot.connection, 'disconnected');
  assert.deepEqual(snapshot.items, []);
});

test('connection reducer exposes connecting, connected, reconnecting, and terminal states', () => {
  let snapshot = initialSessionSnapshot();
  snapshot = reduceConnection(snapshot, { type: 'connect' });
  assert.equal(snapshot.connection, 'connecting');
  snapshot = reduceConnection(snapshot, { type: 'ready' });
  assert.equal(snapshot.connection, 'connected');
  assert.equal(roomActionsEnabled(snapshot), true);
  snapshot = reduceConnection(snapshot, { type: 'lost' });
  assert.equal(snapshot.connection, 'reconnecting');
  assert.equal(roomActionsEnabled(snapshot), false);
  snapshot = reduceConnection(snapshot, { type: 'terminal', message: 'Room expired.' });
  assert.equal(snapshot.connection, 'terminal');
  assert.equal(snapshot.error, 'Room expired.');
  snapshot = reduceConnection(snapshot, { type: 'close' });
  assert.equal(snapshot.connection, 'disconnected');
});
