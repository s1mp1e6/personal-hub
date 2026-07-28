const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Recovery = require('../versions/v1-local-first/recovery-core.js');
const SyncCore = require('../versions/v1-local-first/sync-core.js');

const API = [
  'applyCleanup',
  'applyReset',
  'collectReferencedFileIds',
  'createRecoveryPoint',
  'previewCleanup',
  'previewReset',
  'retain'
];

function fixture() {
  return {
    activeQuote: 1,
    settings: { theme: 'dark', compact: true },
    customQuotes: [{ text: 'keep', author: 'user' }],
    dashWidgets: [{ id: 'widget-1', attachment: { fileId: 'dashboard-file' } }],
    moduleOrder: ['dashboard', 'tasks', 'todos', 'papers'],
    modules: {
      dashboard: { name: 'Desktop', type: 'dashboard' },
      tasks: {
        name: 'Tasks',
        type: 'task',
        items: [
          { id: 'task-done', done: true, archived: false, attachment: { fileId: 'done-file' } },
          { id: 'task-archived', done: false, archived: true, attachment: { fileId: 'archived-file' } },
          { id: 'task-live', done: false, archived: false, attachment: { fileId: 'shared-file' } }
        ]
      },
      todos: {
        name: 'Todos',
        type: 'todo',
        items: [
          { id: 'todo-done', done: true, archived: true },
          { id: 'todo-live', done: false, archived: false }
        ]
      },
      papers: {
        name: 'Papers',
        type: 'paper',
        items: [{ id: 'paper-1', attachment: { fileId: 'shared-file' } }]
      }
    },
    syncDevices: { local: { name: 'Phone' }, peers: [{ id: 'tablet' }] },
    _sync: { deviceId: 'local', vector: { local: 4 } }
  };
}

function defaults() {
  const state = fixture();
  state.activeQuote = 0;
  state.settings = { theme: 'default' };
  state.customQuotes = [];
  state.dashWidgets = [];
  state.modules.tasks.items = [];
  state.modules.todos.items = [];
  state.modules.papers.items = [];
  state.syncDevices = {};
  delete state._sync;
  return state;
}

function identity(tombstone) {
  return {
    id: tombstone.id,
    path: tombstone.path,
    pathSegments: tombstone.pathSegments,
    moduleId: tombstone.moduleId,
    parentId: tombstone.parentId
  };
}

async function stampedRemovalIdentities(before, after) {
  const stamped = await SyncCore.stampChanges(after, before, 'cleanup-device');
  return stamped._sync.tombstones.map(identity);
}

test('exports the recovery API through CommonJS and browser UMD', () => {
  assert.deepEqual(Object.keys(Recovery).sort(), API);
  const source = fs.readFileSync(
    path.join(__dirname, '../versions/v1-local-first/recovery-core.js'),
    'utf8'
  );
  const context = {};
  vm.createContext(context);
  vm.runInContext(source, context);
  assert.deepEqual(Array.from(Object.keys(context.PersonalHubRecoveryCore).sort()), API);
});

test('creates a JSON-only recovery point without mutating the source', () => {
  const state = fixture();
  state.transientBlob = new Blob(['not copied']);
  const before = structuredClone(state);
  const point = Recovery.createRecoveryPoint(state, {
    id: 'recovery-1',
    createdAt: 42,
    reason: 'before-reset'
  });

  const expectedState = structuredClone(before);
  delete expectedState.transientBlob;
  assert.deepEqual(point, {
    id: 'recovery-1',
    createdAt: 42,
    reason: 'before-reset',
    state: expectedState
  });
  assert.notEqual(point.state, state);
  point.state.modules.tasks.items[0].done = false;
  assert.equal(state.modules.tasks.items[0].done, true);
  assert.deepEqual(state, before);
  assert.equal('transientBlob' in point.state, false);
  assert.equal(JSON.stringify(point).includes('blob'), false);
});

test('keeps only the three newest recovery points without mutating input', () => {
  const points = [1, 4, 2, 3].map(n => ({ id: String(n), createdAt: n }));
  const before = structuredClone(points);
  const retained = Recovery.retain(points, 3);

  assert.deepEqual(retained.map(point => point.id), ['4', '3', '2']);
  assert.deepEqual(points, before);
  assert.notEqual(retained[0], points[1]);
});

test('daily cleanup independently removes completed or archived records and emits tombstones', () => {
  const state = fixture();
  const completed = Recovery.applyCleanup(state, { completed: true, archived: false });
  const archived = Recovery.applyCleanup(state, { completed: false, archived: true });

  assert.deepEqual(completed.state.modules.tasks.items.map(item => item.id), ['task-archived', 'task-live']);
  assert.deepEqual(completed.state.modules.todos.items.map(item => item.id), ['todo-live']);
  assert.deepEqual(completed.tombstones.map(item => item.id).sort(), ['task-done', 'todo-done']);
  assert.deepEqual(archived.state.modules.tasks.items.map(item => item.id), ['task-done', 'task-live']);
  assert.deepEqual(archived.state.modules.todos.items.map(item => item.id), ['todo-live']);
  assert.deepEqual(archived.tombstones.map(item => item.id).sort(), ['task-archived', 'todo-done']);
  assert.equal(state.modules.tasks.items.length, 3);
});

test('cleanup and reset tombstones use sync-compatible paths and nested parent IDs', () => {
  const state = fixture();
  state.modules.tasks.items[0].logs = [{ id: 'log-1', attachment: { fileId: 'log-file' } }];
  const initial = defaults();
  const cleanup = Recovery.applyCleanup(state, { completed: true });
  const reset = Recovery.applyReset(state, initial, { modules: ['tasks'] });

  assert.deepEqual(cleanup.tombstones.find(item => item.id === 'task-done'), {
    id: 'task-done',
    path: 'modules.tasks.items',
    pathSegments: ['modules', 'tasks', 'items'],
    moduleId: 'tasks',
    parentId: null
  });
  assert.deepEqual(reset.tombstones.find(item => item.id === 'log-1'), {
    id: 'log-1',
    path: 'modules.tasks.items.logs',
    pathSegments: ['modules', 'tasks', 'items', 'logs'],
    moduleId: 'tasks',
    parentId: 'task-done'
  });
});

test('cleanup and reset recursively match SyncCore tombstones for complete removed subtrees', async () => {
  const state = {
    modules: {
      tasks: {
        type: 'task',
        items: [{
          id: 'parent',
          done: true,
          noIdContainer: {
            children: [{
              id: 'child',
              noIdContainer: { grandchildren: [{ id: 'grandchild' }] }
            }]
          },
          left: [{ id: 'same-id' }, { id: 'duplicate' }, { id: 'duplicate' }],
          right: { noIdContainer: [{ id: 'same-id' }] }
        }]
      }
    }
  };
  const initial = { modules: { tasks: { type: 'task', items: [] } } };
  const before = structuredClone(state);
  const cleanup = Recovery.applyCleanup(state, { completed: true });
  const reset = Recovery.applyReset(state, initial, { modules: ['tasks'] });
  const expectedCleanup = await stampedRemovalIdentities(state, cleanup.state);
  const expectedReset = await stampedRemovalIdentities(state, reset.state);

  assert.deepEqual(cleanup.tombstones.map(identity), expectedCleanup);
  assert.deepEqual(reset.tombstones.map(identity), expectedReset);
  assert.equal(cleanup.tombstones.length, new Set(cleanup.tombstones.map(item =>
    JSON.stringify([item.pathSegments, item.parentId, item.id])
  )).size);
  assert.equal(reset.tombstones.length, new Set(reset.tombstones.map(item =>
    JSON.stringify([item.pathSegments, item.parentId, item.id])
  )).size);
  assert.equal(cleanup.tombstones.some(item =>
    item.id === 'grandchild' &&
    item.parentId === 'child' &&
    item.path === 'modules.tasks.items.noIdContainer.children.noIdContainer.grandchildren'
  ), true);
  assert.equal(cleanup.tombstones.filter(item => item.id === 'same-id').length, 2);
  assert.deepEqual(state, before);
});

test('reset tombstones match the final state when identities are retained or removed outside modules', async () => {
  const state = {
    dashWidgets: [{ id: 'widget-parent', children: [{ id: 'widget-child' }] }],
    modules: {
      tasks: {
        type: 'task',
        items: [{ id: 'retained-parent', children: [{ id: 'removed-child' }] }]
      }
    }
  };
  const initial = {
    dashWidgets: [],
    modules: {
      tasks: { type: 'task', items: [{ id: 'retained-parent', children: [] }] }
    }
  };
  const before = structuredClone(state);
  const result = Recovery.applyReset(state, initial, {
    modules: ['tasks'],
    dashboardLayout: true
  });

  assert.deepEqual(
    result.tombstones.map(identity),
    await stampedRemovalIdentities(state, result.state)
  );
  assert.equal(result.tombstones.some(item => item.id === 'retained-parent'), false);
  assert.deepEqual(state, before);
});

test('cleanup preview and apply report identical statistics', () => {
  const state = fixture();
  const options = { completed: true, archived: true, fileIds: ['orphan-file', 'shared-file'] };
  const recoveryPoints = [{ state: { attachment: { fileId: 'recovery-file' } } }];
  const preview = Recovery.previewCleanup(state, options, recoveryPoints);
  const applied = Recovery.applyCleanup(state, options, recoveryPoints);

  assert.deepEqual(preview, applied.stats);
  assert.deepEqual(preview, {
    completed: 2,
    archived: 1,
    records: 3,
    removedFileCandidates: 1
  });
  assert.deepEqual(applied.removedFileCandidates, ['orphan-file']);
});

test('selective reset supports multiple modules and independent settings groups', () => {
  const state = fixture();
  const initial = defaults();
  const options = {
    modules: ['tasks', 'papers'],
    appearance: true,
    dashboardLayout: true,
    syncDevices: true,
    fileIds: ['done-file', 'dashboard-file', 'shared-file']
  };
  const recoveryPoints = [{ createdAt: 1, state: { attachment: { fileId: 'done-file' } } }];
  const preview = Recovery.previewReset(state, initial, options, recoveryPoints);
  const applied = Recovery.applyReset(state, initial, options, recoveryPoints);

  assert.deepEqual(applied.state.modules.tasks, initial.modules.tasks);
  assert.deepEqual(applied.state.modules.papers, initial.modules.papers);
  assert.deepEqual(applied.state.modules.todos, state.modules.todos);
  assert.deepEqual(applied.state.settings, initial.settings);
  assert.deepEqual(applied.state.dashWidgets, initial.dashWidgets);
  assert.deepEqual(applied.state.syncDevices, initial.syncDevices);
  assert.deepEqual(applied.stats, preview);
  assert.deepEqual(preview, {
    destructive: false,
    modules: 2,
    records: 6,
    appearance: 1,
    dashboardLayout: 1,
    syncDevices: 1,
    removedFileCandidates: 2
  });
  assert.deepEqual(applied.tombstones.map(item => item.id).sort(),
    ['paper-1', 'tablet', 'task-archived', 'task-done', 'task-live', 'widget-1']);
  assert.deepEqual(applied.removedFileCandidates.sort(), ['dashboard-file', 'shared-file']);
  assert.equal(state.settings.theme, 'dark');
});

test('full local reset is marked destructive and resets all local state', () => {
  const state = fixture();
  const initial = defaults();
  const options = { fullLocalData: true, fileIds: ['done-file', 'shared-file', 'orphan-file'] };
  const preview = Recovery.previewReset(state, initial, options);
  const applied = Recovery.applyReset(state, initial, options);

  assert.equal(preview.destructive, true);
  assert.deepEqual(applied.state, initial);
  assert.deepEqual(applied.stats, preview);
  assert.equal(applied.tombstones.length, 8);
  assert.deepEqual(applied.removedFileCandidates.sort(), ['done-file', 'orphan-file', 'shared-file']);
});

test('current state and retained recovery points protect referenced file IDs', () => {
  const state = fixture();
  const recoveryPoints = [
    { createdAt: 3, state: { nested: [{ fileId: 'recovery-file' }, { fileId: 'shared-file' }] } },
    { createdAt: 2, state: { duplicate: { fileId: 'recovery-file' } } },
    { createdAt: 1, state: { old: { fileId: 'old-file' } } },
    { createdAt: 0, state: { expired: { fileId: 'expired-file' } } }
  ];
  const refs = Recovery.collectReferencedFileIds(state, recoveryPoints);

  assert.deepEqual([...refs].sort(),
    ['archived-file', 'dashboard-file', 'done-file', 'old-file', 'recovery-file', 'shared-file']);
  const applied = Recovery.applyCleanup(
    state,
    { fileIds: ['shared-file', 'recovery-file', 'old-file', 'expired-file', 'orphan-file'] },
    recoveryPoints
  );
  assert.deepEqual(applied.removedFileCandidates.sort(), ['expired-file', 'orphan-file']);
});

test('file collection is prototype-safe and handles duplicate nested IDs', () => {
  const state = Object.create(null);
  Object.defineProperty(state, '__proto__', {
    value: { fileId: 'proto-file' },
    enumerable: true
  });
  state.items = [{ fileId: 'same' }, { nested: { fileId: 'same' } }, { fileId: '' }];

  assert.deepEqual([...Recovery.collectReferencedFileIds(state)].sort(), ['proto-file', 'same']);
  assert.equal({}.polluted, undefined);
});

test('empty cleanup and reset selections are immutable no-ops', () => {
  const state = fixture();
  const initial = defaults();
  const cleanup = Recovery.applyCleanup(state, {});
  const reset = Recovery.applyReset(state, initial, {});

  assert.deepEqual(cleanup.state, state);
  assert.notEqual(cleanup.state, state);
  assert.deepEqual(cleanup.tombstones, []);
  assert.deepEqual(cleanup.removedFileCandidates, []);
  assert.deepEqual(reset.state, state);
  assert.notEqual(reset.state, state);
  assert.deepEqual(reset.tombstones, []);
  assert.deepEqual(reset.removedFileCandidates, []);
});
