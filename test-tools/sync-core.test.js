const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { TextEncoder } = require('node:util');
const nodeCrypto = require('node:crypto');
const SyncCore = require('../versions/v1-local-first/sync-core.js');

const syncCoreSource = fs.readFileSync(
  path.join(__dirname, '../versions/v1-local-first/sync-core.js'),
  'utf8'
);
const hashFixture = {
  id: 'rec-1',
  z: 1,
  nested: {
    b: 2,
    a: 1,
    _sync: { vector: { x: 9 } }
  },
  list: [
    { id: 'child-1', value: 1, _sync: { deleted: false } },
    { id: 'child-2', value: 2 }
  ],
  _sync: { vector: { deviceA: 1 } }
};
const hashFixtureCanonicalJson = JSON.stringify({
  id: 'rec-1',
  list: [
    { id: 'child-1', value: 1 },
    { id: 'child-2', value: 2 }
  ],
  nested: {
    a: 1,
    b: 2
  },
  z: 1
});
const expectedHashFixture = nodeCrypto
  .createHash('sha256')
  .update(hashFixtureCanonicalJson)
  .digest('hex');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function visible(value) {
  return JSON.parse(JSON.stringify(value, (key, item) => (key === '_sync' ? undefined : item)));
}

test('exports only the Task 2 sync-core API', () => {
  assert.deepEqual(Object.keys(SyncCore).sort(), [
    'compareVectors',
    'hashRecord',
    'migrateState',
    'stampChanges'
  ]);
});

test('exposes the same four-function API in a browser UMD context', async () => {
  const context = {
    crypto: nodeCrypto.webcrypto,
    TextEncoder,
    Uint8Array
  };
  context.globalThis = context;
  vm.createContext(context);
  new vm.Script(syncCoreSource, { filename: 'sync-core.js' }).runInContext(context);

  assert.ok(context.PersonalHubSyncCore);
  assert.deepEqual(Object.keys(context.PersonalHubSyncCore).sort(), [
    'compareVectors',
    'hashRecord',
    'migrateState',
    'stampChanges'
  ]);
  assert.equal(await context.PersonalHubSyncCore.hashRecord(hashFixture), expectedHashFixture);
});

test('compares dominating and concurrent vectors', () => {
  assert.equal(SyncCore.compareVectors({ a: 2 }, { a: 1 }), 'newer');
  assert.equal(SyncCore.compareVectors({ a: 1 }, { a: 2 }), 'older');
  assert.equal(SyncCore.compareVectors({ a: 1 }, { b: 1 }), 'concurrent');
  assert.equal(SyncCore.compareVectors({ a: 1 }, { a: 1 }), 'equal');
});

test('normalizes vector counters before comparing them', () => {
  assert.equal(SyncCore.compareVectors({ a: '10' }, { a: '2' }), 'newer');
  assert.equal(SyncCore.compareVectors({ a: '2' }, { a: '10' }), 'older');
  assert.equal(SyncCore.compareVectors({ a: 'nope' }, { a: 1 }), 'older');
  assert.equal(SyncCore.compareVectors({ a: -4 }, { a: 0 }), 'equal');
  assert.equal(SyncCore.compareVectors({ a: Infinity, b: '3' }, { a: 0, b: 2 }), 'newer');
});

test('hashes deterministically while omitting nested _sync metadata in Node via node:crypto', async () => {
  const left = hashFixture;
  const right = {
    list: [
      { value: 1, id: 'child-1' },
      { value: 2, id: 'child-2', _sync: { conflictOf: 'stale' } }
    ],
    nested: {
      a: 1,
      b: 2
    },
    z: 1,
    id: 'rec-1',
    _sync: { vector: { deviceB: 3 } }
  };
  const reorderedArray = {
    ...right,
    list: [...right.list].reverse()
  };
  const originalCryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');

  try {
    Object.defineProperty(globalThis, 'crypto', {
      value: {
        subtle: {
          digest() {
            throw new Error('CommonJS hash should not call crypto.subtle');
          }
        }
      },
      configurable: true
    });
    const leftHash = await SyncCore.hashRecord(left);
    const rightHash = await SyncCore.hashRecord(right);
    const arrayHash = await SyncCore.hashRecord(reorderedArray);

    assert.match(leftHash, /^[a-f0-9]{64}$/);
    assert.equal(leftHash, expectedHashFixture);
    assert.equal(leftHash, rightHash);
    assert.notEqual(leftHash, arrayHash);
  } finally {
    Object.defineProperty(globalThis, 'crypto', originalCryptoDescriptor);
  }
});

test('migrates legacy records without changing visible fields or mutating input', async () => {
  const state = {
    modules: {
      todos: {
        items: [{ id: 'todo-1', txt: 'keep me', done: false }]
      },
      experiments: {
        items: [{
          id: 'exp-1',
          name: 'Experiment A',
          logs: [{ id: 'log-1', note: 'started' }]
        }]
      }
    },
    dashWidgets: [{ id: 'widget-1', type: 'note', title: 'Pinned' }],
    appearance: { theme: 'dark' }
  };
  const before = clone(state);

  const migrated = await SyncCore.migrateState(state);

  assert.deepEqual(state, before);
  assert.deepEqual(visible(migrated), before);
  assert.notStrictEqual(migrated, state);
  assert.deepEqual(migrated.modules.todos.items[0]._sync.vector, {});
  assert.equal(migrated.modules.todos.items[0]._sync.deleted, false);
  assert.equal(migrated.modules.todos.items[0]._sync.conflictOf, null);
  assert.match(migrated.modules.todos.items[0]._sync.contentHash, /^[a-f0-9]{64}$/);
  assert.match(migrated.modules.experiments.items[0].logs[0]._sync.contentHash, /^[a-f0-9]{64}$/);
  assert.match(migrated.dashWidgets[0]._sync.contentHash, /^[a-f0-9]{64}$/);
});

test('preserves own __proto__ data without prototype pollution in hashes and migrated clones', async () => {
  const left = JSON.parse('{"id":"proto-1","name":"alpha","__proto__":{"marker":"left"}}');
  const right = JSON.parse('{"id":"proto-1","name":"alpha","__proto__":{"marker":"right"}}');
  const state = {
    modules: {
      todos: {
        items: [left]
      }
    }
  };

  const leftHash = await SyncCore.hashRecord(left);
  const rightHash = await SyncCore.hashRecord(right);
  const migrated = await SyncCore.migrateState(state);
  const item = migrated.modules.todos.items[0];

  assert.notEqual(leftHash, rightHash);
  assert.equal(Object.prototype.marker, undefined);
  assert.equal(({}).marker, undefined);
  assert.equal(Object.hasOwn(item, '__proto__'), true);
  assert.deepEqual(item.__proto__, { marker: 'left' });
  assert.equal(Object.getPrototypeOf(item), Object.prototype);
  assert.equal(Object.hasOwn(migrated.modules.todos.items[0]._sync, '__proto__'), false);
});

test('stamps changed, new, and unchanged records while merging top-level sync metadata', async () => {
  const seed = {
    modules: {
      todos: {
        items: [
          { id: 'todo-1', txt: 'same', done: false },
          { id: 'todo-2', txt: 'stable', done: true }
        ]
      }
    },
    dashWidgets: [{ id: 'widget-1', type: 'note', title: 'Keep' }],
    _sync: { previousMeta: 'kept-from-seed' }
  };
  const previous = await SyncCore.stampChanges(seed, {}, 'device-a');
  previous._sync.fromPrevious = 'keep-this-too';
  const previousSnapshot = clone(previous);

  const current = clone(previous);
  current.modules.todos.items[0].txt = 'changed';
  current.modules.todos.items.push({ id: 'todo-3', txt: 'new', done: false });
  current._sync.localOnly = 'keep-local';
  const currentSnapshot = clone(current);

  const stamped = await SyncCore.stampChanges(current, previous, 'device-a');

  assert.deepEqual(previous, previousSnapshot);
  assert.deepEqual(current, currentSnapshot);
  assert.equal(stamped.modules.todos.items[0]._sync.vector['device-a'], 2);
  assert.equal(stamped.modules.todos.items[1]._sync.vector['device-a'], 1);
  assert.equal(stamped.modules.todos.items[2]._sync.vector['device-a'], 1);
  assert.notEqual(
    stamped.modules.todos.items[0]._sync.contentHash,
    previous.modules.todos.items[0]._sync.contentHash
  );
  assert.equal(
    stamped.modules.todos.items[1]._sync.contentHash,
    previous.modules.todos.items[1]._sync.contentHash
  );
  assert.equal(stamped._sync.previousMeta, 'kept-from-seed');
  assert.equal(stamped._sync.fromPrevious, 'keep-this-too');
  assert.equal(stamped._sync.localOnly, 'keep-local');
  assert.deepEqual(stamped._sync.tombstones, []);
});

test('stamps nested removals into lightweight replacement tombstones', async () => {
  const seed = {
    modules: {
      experiments: {
        items: [{
          id: 'exp-1',
          name: 'Experiment A',
          logs: [{ id: 'log-1', note: 'baseline' }]
        }]
      }
    },
    dashWidgets: [{ id: 'widget-1', type: 'note', title: 'Delete me' }],
    _sync: {
      preserved: 'yes',
      tombstones: [{
        id: 'keep-me',
        path: 'modules.todos.items',
        moduleId: 'todos',
        parentId: null,
        _sync: { vector: { 'device-z': 4 }, deleted: true, conflictOf: null }
      }]
    }
  };
  const previous = await SyncCore.stampChanges(seed, {}, 'device-a');
  const current = clone(previous);
  current.modules.experiments.items[0].logs = [];
  current.dashWidgets = [];
  current._sync.localMeta = 'current';
  current._sync.tombstones = [
    {
      id: 'log-1',
      path: 'modules.experiments.items.logs',
      moduleId: 'experiments',
      parentId: 'exp-1',
      title: 'stale user content',
      _sync: { vector: { 'device-a': 1 }, deleted: true, conflictOf: null }
    },
    {
      id: 'widget-1',
      path: 'dashWidgets',
      moduleId: null,
      parentId: null,
      title: 'stale widget title',
      _sync: { vector: { 'device-a': 1 }, deleted: true, conflictOf: null }
    }
  ];

  const stamped = await SyncCore.stampChanges(current, previous, 'device-a');
  const logTombstone = stamped._sync.tombstones.find(item =>
    item.id === 'log-1' && item.path === 'modules.experiments.items.logs'
  );
  const widgetTombstone = stamped._sync.tombstones.find(item =>
    item.id === 'widget-1' && item.path === 'dashWidgets'
  );

  assert.equal(stamped.modules.experiments.items[0]._sync.vector['device-a'], 2);
  assert.equal(logTombstone.moduleId, 'experiments');
  assert.equal(logTombstone.parentId, 'exp-1');
  assert.equal(logTombstone._sync.deleted, true);
  assert.equal(logTombstone._sync.vector['device-a'], 2);
  assert.equal(widgetTombstone._sync.vector['device-a'], 2);
  assert.ok(!('title' in logTombstone));
  assert.ok(!('title' in widgetTombstone));
  assert.equal(
    stamped._sync.tombstones.filter(item =>
      item.id === 'log-1' && item.path === 'modules.experiments.items.logs'
    ).length,
    1
  );
  assert.equal(
    stamped._sync.tombstones.filter(item =>
      item.id === 'widget-1' && item.path === 'dashWidgets'
    ).length,
    1
  );
  assert.ok(stamped._sync.tombstones.some(item => item.id === 'keep-me'));
  assert.equal(stamped._sync.preserved, 'yes');
  assert.equal(stamped._sync.localMeta, 'current');
});

test('tombstones are unique to the exact entity path and parent when ids repeat elsewhere', async () => {
  const seed = {
    modules: {
      todos: {
        items: [{ id: 'shared-id', txt: 'todo stays' }]
      },
      experiments: {
        items: [
          {
            id: 'exp-1',
            name: 'Experiment One',
            logs: [
              { id: 'shared-id', note: 'remove only this one' },
              { id: 'log-keep', note: 'still here' }
            ]
          },
          {
            id: 'exp-2',
            name: 'Experiment Two',
            logs: [{ id: 'shared-id', note: 'same id, different parent' }]
          }
        ]
      },
      books: {
        items: [{
          id: 'book-1',
          name: 'Book One',
          logs: [{ id: 'shared-id', note: 'same id, different module' }]
        }]
      }
    }
  };
  const previous = await SyncCore.stampChanges(seed, {}, 'device-a');
  const current = clone(previous);
  current.modules.experiments.items[0].logs = current.modules.experiments.items[0].logs.filter(
    item => item.note !== 'remove only this one'
  );

  const stamped = await SyncCore.stampChanges(current, previous, 'device-a');
  const repeatedIdTombstones = stamped._sync.tombstones.filter(item => item.id === 'shared-id');
  const experimentLogTombstone = repeatedIdTombstones.find(item =>
    item.path === 'modules.experiments.items.logs' && item.parentId === 'exp-1'
  );

  assert.equal(repeatedIdTombstones.length, 1);
  assert.ok(experimentLogTombstone);
  assert.equal(experimentLogTombstone.moduleId, 'experiments');
  assert.equal(experimentLogTombstone._sync.deleted, true);
  assert.equal(experimentLogTombstone._sync.vector['device-a'], 2);
  assert.equal(stamped.modules.todos.items[0]._sync.vector['device-a'], 1);
  assert.equal(stamped.modules.experiments.items[1].logs[0]._sync.vector['device-a'], 1);
  assert.equal(stamped.modules.books.items[0].logs[0]._sync.vector['device-a'], 1);
});

test('identity keys stay distinct when ids contain separator-like content', async () => {
  const seed = {
    modules: {
      experiments: {
        items: [
          {
            id: 'p::q',
            name: 'Parent One',
            logs: [{ id: 'r', note: 'remove only this log' }]
          },
          {
            id: 'p',
            name: 'Parent Two',
            logs: [{ id: 'q::r', note: 'same legacy separator shape but stays' }]
          }
        ]
      }
    }
  };
  const previous = await SyncCore.stampChanges(seed, {}, 'device-a');
  const current = clone(previous);
  current.modules.experiments.items[0].logs = [];

  const stamped = await SyncCore.stampChanges(current, previous, 'device-a');
  const matching = stamped._sync.tombstones.filter(item => item.path === 'modules.experiments.items.logs');

  assert.deepEqual(
    matching.map(item => [item.parentId, item.id]).sort(),
    [['p::q', 'r']]
  );
  assert.equal(stamped.modules.experiments.items[1].logs[0]._sync.vector['device-a'], 1);
  assert.equal(stamped.modules.experiments.items[1].logs[0].note, 'same legacy separator shape but stays');
});
