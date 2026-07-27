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

function makeTombstone({ id, pathSegments, parentId = null, moduleId, vector }) {
  return {
    id,
    path: pathSegments.join('.'),
    pathSegments: clone(pathSegments),
    moduleId:
      moduleId !== undefined
        ? moduleId
        : pathSegments[0] === 'modules' && pathSegments[1]
          ? pathSegments[1]
          : null,
    parentId,
    _sync: {
      vector: clone(vector || {}),
      deleted: true,
      conflictOf: null
    }
  };
}

function buildMergeFixture() {
  return {
    sender: {
      modules: {
        todos: {
          items: [
            { id: 'same-1', txt: 'same text', _sync: { vector: { deviceA: 2 } } },
            { id: 'add-1', txt: 'sender only', _sync: { vector: { deviceA: 1 } } },
            { id: 'update-1', txt: 'sender newer', _sync: { vector: { deviceA: 2 } } },
            { id: 'conflict-1', txt: 'sender copy', _sync: { vector: { deviceA: 1 } } }
          ]
        }
      },
      _sync: {
        tombstones: [
          makeTombstone({
            id: 'pending-delete-1',
            pathSegments: ['modules', 'todos', 'items'],
            vector: { deviceA: 2 }
          }),
          makeTombstone({
            id: 'delete-conflict-1',
            pathSegments: ['modules', 'todos', 'items'],
            vector: { deviceA: 2 }
          })
        ]
      }
    },
    receiver: {
      modules: {
        todos: {
          items: [
            { id: 'same-1', txt: 'same text', _sync: { vector: { deviceB: 1 } } },
            { id: 'update-1', txt: 'receiver older', _sync: { vector: { deviceA: 1 } } },
            { id: 'keep-1', txt: 'receiver only', _sync: { vector: { deviceB: 1 } } },
            { id: 'conflict-1', txt: 'receiver version', _sync: { vector: { deviceB: 1 } } },
            { id: 'pending-delete-1', txt: 'remove me only if chosen', _sync: { vector: { deviceA: 1 } } },
            {
              id: 'delete-conflict-1',
              txt: 'receiver modified',
              _sync: { vector: { deviceA: 1, deviceB: 1 } }
            }
          ]
        }
      },
      _sync: { tombstones: [] }
    },
    scope: {
      modules: ['todos'],
      includeAttachments: false,
      includeSettings: false
    }
  };
}

test('exports only the Task 3 sync-core API', () => {
  assert.deepEqual(Object.keys(SyncCore).sort(), [
    'applyMergePlan',
    'buildManifest',
    'buildMergePlan',
    'compareVectors',
    'hashBlob',
    'hashRecord',
    'migrateState',
    'stampChanges',
    'validateEnvelope'
  ]);
});

test('exposes the same nine-function API in a browser UMD context', async () => {
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
    'applyMergePlan',
    'buildManifest',
    'buildMergePlan',
    'compareVectors',
    'hashBlob',
    'hashRecord',
    'migrateState',
    'stampChanges',
    'validateEnvelope'
  ]);
  assert.equal(await context.PersonalHubSyncCore.hashRecord(hashFixture), expectedHashFixture);
  assert.equal(
    await context.PersonalHubSyncCore.hashBlob(Uint8Array.from([1, 2, 3]).buffer),
    nodeCrypto.createHash('sha256').update(Buffer.from([1, 2, 3])).digest('hex')
  );
});

test('buildManifest returns scoped metadata only and omits user content', async () => {
  const state = {
    modules: {
      todos: {
        items: [
          {
            id: 'todo-1',
            title: 'Buy milk',
            txt: 'very private text',
            attachment: {
              fileId: 'file-1',
              name: 'scan.pdf',
              type: 'application/pdf',
              size: 4096,
              kind: 'doc',
              bytes: 'never send this'
            }
          }
        ]
      },
      diary: {
        items: [{ id: 'day-1', title: 'Dear diary', content: 'deep secret entry' }]
      }
    },
    appearance: {
      theme: 'dark',
      signature: 'hidden setting text'
    },
    _sync: {
      tombstones: [
        makeTombstone({
          id: 'todo-deleted',
          pathSegments: ['modules', 'todos', 'items'],
          vector: { deviceA: 2 }
        }),
        makeTombstone({
          id: 'day-deleted',
          pathSegments: ['modules', 'diary', 'items'],
          vector: { deviceA: 2 }
        })
      ]
    }
  };
  const before = clone(state);

  const manifest = await SyncCore.buildManifest(state, {
    modules: ['todos'],
    includeAttachments: true,
    includeSettings: false
  });
  const withSettings = await SyncCore.buildManifest(state, {
    modules: ['todos'],
    includeAttachments: false,
    includeSettings: true
  });

  assert.deepEqual(state, before);
  assert.equal(manifest.protocol, 2);
  assert.deepEqual(manifest.scope, {
    modules: ['todos'],
    includeAttachments: true,
    includeSettings: false
  });
  assert.deepEqual(manifest.modules.map(item => item.id), ['todos']);
  assert.equal(manifest.records.length, 1);
  assert.deepEqual(manifest.records[0].pathSegments, ['modules', 'todos', 'items']);
  assert.equal(manifest.records[0].parentId, null);
  assert.equal(manifest.records[0].moduleId, 'todos');
  assert.equal(manifest.records[0].deleted, false);
  assert.equal(typeof manifest.records[0].size, 'number');
  assert.equal(manifest.records[0].size > 0, true);
  assert.equal(manifest.records[0].attachmentCount, 1);
  assert.equal(manifest.records[0].attachmentBytes, 4096);
  assert.equal('title' in manifest.records[0], false);
  assert.equal('txt' in manifest.records[0], false);
  assert.equal('content' in manifest.records[0], false);
  assert.equal(manifest.tombstones.length, 1);
  assert.equal(manifest.tombstones[0].id, 'todo-deleted');
  assert.equal(manifest.attachments.length, 1);
  assert.equal(manifest.attachments[0].fileId, 'file-1');
  assert.equal(manifest.attachments[0].moduleId, 'todos');
  assert.equal(manifest.attachments[0].size, 4096);
  assert.equal('bytes' in manifest.attachments[0], false);
  assert.equal('settings' in manifest, false);
  assert.ok(withSettings.settings);
  assert.match(withSettings.settings.contentHash, /^[a-f0-9]{64}$/);
  assert.equal(withSettings.settings.size > 0, true);

  const manifestJson = JSON.stringify(manifest);
  const settingsJson = JSON.stringify(withSettings);
  for (const leaked of [
    'Buy milk',
    'very private text',
    'Dear diary',
    'deep secret entry',
    'hidden setting text',
    'never send this'
  ]) {
    assert.equal(manifestJson.includes(leaked), false);
    assert.equal(settingsJson.includes(leaked), false);
  }
});

test('buildManifest rejects unknown requested modules', async () => {
  await assert.rejects(
    () =>
      SyncCore.buildManifest(
        { modules: { todos: { items: [] } } },
        { modules: ['missing'], includeAttachments: false, includeSettings: false }
      ),
    /Unknown module/
  );
});

test('builds a safe merge plan for every record relationship', async () => {
  const { sender, receiver, scope } = buildMergeFixture();
  const senderBefore = clone(sender);
  const receiverBefore = clone(receiver);

  const plan = await SyncCore.buildMergePlan(sender, receiver, scope);

  assert.deepEqual(sender, senderBefore);
  assert.deepEqual(receiver, receiverBefore);
  assert.deepEqual(plan.scope, scope);
  assert.deepEqual(plan.summary, {
    add: 1,
    update: 1,
    keep: 1,
    conflictCopy: 1,
    pendingDelete: 1,
    deleteConflict: 1,
    same: 1
  });
  assert.equal(plan.operations.length, 7);

  for (const [category, selected] of [
    ['add', true],
    ['update', true],
    ['keep', false],
    ['conflictCopy', true],
    ['pendingDelete', false],
    ['deleteConflict', false],
    ['same', false]
  ]) {
    const operation = plan.operations.find(item => item.category === category);
    assert.ok(operation, category);
    assert.equal(operation.selected, selected, category);
  }
});

test('merge planning keeps same ids distinct across separate paths', async () => {
  const sender = {
    modules: {
      todos: {
        items: [{ id: 'repeat-1', txt: 'todo branch' }]
      },
      experiments: {
        items: [{ id: 'exp-1', name: 'Experiment', logs: [{ id: 'repeat-1', note: 'log branch' }] }]
      }
    }
  };
  const receiver = { modules: { todos: { items: [] }, experiments: { items: [] } } };

  const plan = await SyncCore.buildMergePlan(sender, receiver, {
    modules: ['todos', 'experiments'],
    includeAttachments: false,
    includeSettings: false
  });
  const identities = plan.operations
    .filter(item => item.category === 'add' && item.identity.id === 'repeat-1')
    .map(item => JSON.stringify([item.identity.pathSegments, item.identity.parentId]))
    .sort();

  assert.deepEqual(plan.summary, {
    add: 3,
    update: 0,
    keep: 0,
    conflictCopy: 0,
    pendingDelete: 0,
    deleteConflict: 0,
    same: 0
  });
  assert.deepEqual(identities, [
    JSON.stringify([['modules', 'experiments', 'items', 'logs'], 'exp-1']),
    JSON.stringify([['modules', 'todos', 'items'], null])
  ]);
});

test('applyMergePlan preserves receiver values, copies conflicts, and leaves deletions off by default', async () => {
  const { sender, receiver, scope } = buildMergeFixture();
  const plan = await SyncCore.buildMergePlan(sender, receiver, scope);
  const receiverBefore = clone(receiver);
  const planBefore = clone(plan);

  const applied = await SyncCore.applyMergePlan(plan, receiver, {
    idFactory() {
      return 'conflict-copy-1';
    }
  });

  assert.deepEqual(receiver, receiverBefore);
  assert.deepEqual(plan, planBefore);
  assert.equal(applied.modules.todos.items.some(item => item.id === 'add-1'), true);
  assert.equal(applied.modules.todos.items.find(item => item.id === 'update-1').txt, 'sender newer');
  assert.equal(applied.modules.todos.items.find(item => item.id === 'conflict-1').txt, 'receiver version');
  assert.equal(applied.modules.todos.items.find(item => item.id === 'conflict-copy-1').txt, 'sender copy');
  assert.equal(
    applied.modules.todos.items.find(item => item.id === 'conflict-copy-1')._sync.conflictOf,
    'conflict-1'
  );
  assert.equal(applied.modules.todos.items.some(item => item.id === 'pending-delete-1'), true);
  assert.equal(
    applied.modules.todos.items.find(item => item.id === 'delete-conflict-1').txt,
    'receiver modified'
  );
});

test('applyMergePlan supports explicit selection for same-vector merges and pending deletes', async () => {
  const { sender, receiver, scope } = buildMergeFixture();
  const plan = await SyncCore.buildMergePlan(sender, receiver, scope);
  const selectedOperationIds = new Set(
    plan.operations
      .filter(item => item.selected || item.category === 'same' || item.category === 'pendingDelete')
      .map(item => item.id)
  );

  const applied = await SyncCore.applyMergePlan(plan, receiver, {
    selectedOperationIds,
    idFactory() {
      return 'conflict-copy-2';
    }
  });
  const sameRecord = applied.modules.todos.items.find(item => item.id === 'same-1');
  const pendingDeleteRecord = applied.modules.todos.items.find(item => item.id === 'pending-delete-1');

  assert.deepEqual(visible(sameRecord), visible(receiver.modules.todos.items.find(item => item.id === 'same-1')));
  assert.deepEqual(sameRecord._sync.vector, { deviceA: 2, deviceB: 1 });
  assert.ok(!pendingDeleteRecord || pendingDeleteRecord._sync.deleted === true);
});

test('validateEnvelope accepts valid manifests and rejects unsafe envelopes', async () => {
  const manifest = await SyncCore.buildManifest(
    {
      modules: {
        todos: {
          items: [
            {
              id: 'todo-1',
              txt: 'manifest source',
              attachment: {
                fileId: 'file-1',
                name: 'scan.pdf',
                type: 'application/pdf',
                size: 64,
                kind: 'doc'
              }
            }
          ]
        }
      }
    },
    { modules: ['todos'], includeAttachments: true, includeSettings: false }
  );
  const validEnvelope = {
    protocol: 2,
    type: 'manifest',
    manifest
  };
  const limits = {
    allowedModules: new Set(['todos']),
    maxManifestBytes: 10000,
    maxAttachmentCount: 4,
    maxAttachmentBytes: 1000,
    maxChunkBytes: 32,
    seenChunkIndexes: new Set()
  };
  const before = clone(validEnvelope);

  assert.equal(SyncCore.validateEnvelope(validEnvelope, limits), true);
  assert.deepEqual(validEnvelope, before);

  const duplicateEnvelope = {
    protocol: 2,
    type: 'data-chunk',
    chunk: {
      index: 1,
      total: 3,
      payload: 'abc'
    }
  };

  for (const [name, envelope, expectedPattern, nextLimits] of [
    [
      'protocol',
      { ...validEnvelope, protocol: 1 },
      /protocol 2/i,
      limits
    ],
    [
      'type',
      { ...validEnvelope, type: 'mystery' },
      /unknown type/i,
      limits
    ],
    [
      'module',
      {
        ...validEnvelope,
        manifest: { ...manifest, scope: { ...manifest.scope, modules: ['unknown'] } }
      },
      /module/i,
      limits
    ],
    [
      'size',
      {
        ...validEnvelope,
        manifest: {
          ...manifest,
          attachments: manifest.attachments.map(item => ({ ...item, size: -1 }))
        }
      },
      /size/i,
      limits
    ],
    [
      'manifest bytes',
      validEnvelope,
      /manifest bytes/i,
      { ...limits, maxManifestBytes: 10 }
    ],
    [
      'chunk index',
      {
        protocol: 2,
        type: 'data-chunk',
        chunk: { index: -1, total: 2, payload: 'abc' }
      },
      /chunk index/i,
      limits
    ],
    [
      'duplicate chunk',
      duplicateEnvelope,
      /duplicate chunk/i,
      { ...limits, seenChunkIndexes: new Set([1]) }
    ],
    [
      'prototype key',
      JSON.parse(
        '{"protocol":2,"type":"manifest","manifest":{"protocol":2,"scope":{"modules":["todos"],"includeAttachments":true,"includeSettings":false},"modules":[{"id":"todos"}],"records":[{"id":"todo-1","pathSegments":["modules","todos","items"],"parentId":null,"moduleId":"todos","vector":{},"contentHash":"abc","deleted":false,"size":1,"__proto__":{"polluted":true}}],"tombstones":[],"attachments":[]}}'
      ),
      /prototype/i,
      limits
    ]
  ]) {
    assert.throws(() => SyncCore.validateEnvelope(envelope, nextLimits), expectedPattern, name);
  }
});

test('validateEnvelope rejects malformed manifest collections with field-specific errors', async () => {
  const manifest = await SyncCore.buildManifest(
    {
      modules: {
        todos: {
          items: [{ id: 'todo-1', txt: 'manifest source' }]
        }
      }
    },
    { modules: ['todos'], includeAttachments: false, includeSettings: false }
  );
  const limits = {
    allowedModules: new Set(['todos']),
    maxManifestBytes: 10000,
    maxAttachmentCount: 4,
    maxAttachmentBytes: 1000,
    maxChunkBytes: 32,
    seenChunkIndexes: new Set()
  };

  for (const [name, patch, expectedPattern] of [
    [
      'scope.modules must be an array',
      { scope: { ...manifest.scope, modules: 'todos' } },
      /manifest\.scope\.modules.*array/i
    ],
    [
      'modules must be an array',
      { modules: { id: 'todos' } },
      /manifest\.modules.*array/i
    ],
    [
      'attachments must be an array',
      { attachments: { fileId: 'file-1' } },
      /manifest\.attachments.*array/i
    ],
    [
      'records must be an array',
      { records: { id: 'todo-1' } },
      /manifest\.records.*array/i
    ],
    [
      'tombstones must be an array',
      { tombstones: { id: 'gone-1' } },
      /manifest\.tombstones.*array/i
    ],
    [
      'scope.modules is required',
      { scope: { includeAttachments: false, includeSettings: false } },
      /manifest\.scope\.modules.*required/i
    ],
    [
      'modules is required',
      { modules: undefined },
      /manifest\.modules.*required/i
    ],
    [
      'attachments is required',
      { attachments: undefined },
      /manifest\.attachments.*required/i
    ],
    [
      'records is required',
      { records: undefined },
      /manifest\.records.*required/i
    ],
    [
      'tombstones is required',
      { tombstones: undefined },
      /manifest\.tombstones.*required/i
    ]
  ]) {
    const nextManifest = { ...manifest, ...patch };
    if (patch.scope) nextManifest.scope = patch.scope;
    if (name === 'modules is required') delete nextManifest.modules;
    if (name === 'attachments is required') delete nextManifest.attachments;
    if (name === 'records is required') delete nextManifest.records;
    if (name === 'tombstones is required') delete nextManifest.tombstones;

    assert.throws(
      () => SyncCore.validateEnvelope({ protocol: 2, type: 'manifest', manifest: nextManifest }, limits),
      expectedPattern,
      name
    );
  }
});

test('validateEnvelope rejects forged manifest module identities and invalid identity field types', async () => {
  const manifest = await SyncCore.buildManifest(
    {
      modules: {
        todos: {
          items: [{ id: 'todo-1', txt: 'manifest source' }]
        }
      },
      _sync: {
        tombstones: [
          makeTombstone({
            id: 'todo-gone-1',
            pathSegments: ['modules', 'todos', 'items'],
            vector: { deviceA: 2 }
          })
        ]
      }
    },
    { modules: ['todos'], includeAttachments: false, includeSettings: false }
  );
  const limits = {
    allowedModules: new Set(['todos', 'diary']),
    maxManifestBytes: 10000,
    maxAttachmentCount: 4,
    maxAttachmentBytes: 1000,
    maxChunkBytes: 32,
    seenChunkIndexes: new Set()
  };

  for (const [name, buildEnvelope, expectedPattern, nextLimits] of [
    [
      'record pathSegments must be an array',
      () => ({
        protocol: 2,
        type: 'manifest',
        manifest: {
          ...manifest,
          records: [{ ...manifest.records[0], pathSegments: 'modules.todos.items' }]
        }
      }),
      /manifest\.records\[0\]\.pathSegments.*array/i
    ],
    [
      'record id must be a string',
      () => ({
        protocol: 2,
        type: 'manifest',
        manifest: {
          ...manifest,
          records: [{ ...manifest.records[0], id: 42 }]
        }
      }),
      /manifest\.records\[0\]\.id.*string/i
    ],
    [
      'record parentId must be a string or null',
      () => ({
        protocol: 2,
        type: 'manifest',
        manifest: {
          ...manifest,
          records: [{ ...manifest.records[0], parentId: 42 }]
        }
      }),
      /manifest\.records\[0\]\.parentId.*string or null/i
    ],
    [
      'record moduleId is required under modules path',
      () => ({
        protocol: 2,
        type: 'manifest',
        manifest: {
          ...manifest,
          records: [{ ...manifest.records[0], moduleId: null }]
        }
      }),
      /manifest\.records\[0\]\.moduleId.*required/i
    ],
    [
      'record moduleId must match pathSegments[1]',
      () => ({
        protocol: 2,
        type: 'manifest',
        manifest: {
          ...manifest,
          records: [{ ...manifest.records[0], moduleId: 'diary' }]
        }
      }),
      /manifest\.records\[0\]\.moduleId.*pathSegments\[1\]/i
    ],
    [
      'forged record path module is rejected even if moduleId looks allowed',
      () => ({
        protocol: 2,
        type: 'manifest',
        manifest: {
          ...manifest,
          records: [{
            ...manifest.records[0],
            moduleId: 'todos',
            pathSegments: ['modules', 'diary', 'items']
          }]
        }
      }),
      /manifest\.records\[0\]\.moduleId.*pathSegments\[1\]/i
    ],
    [
      'record path module must be present in scope.modules',
      () => ({
        protocol: 2,
        type: 'manifest',
        manifest: {
          ...manifest,
          scope: { ...manifest.scope, modules: ['diary'] },
          modules: [{ ...manifest.modules[0], id: 'diary' }],
          records: [{
            ...manifest.records[0],
            moduleId: 'todos',
            pathSegments: ['modules', 'todos', 'items']
          }]
        }
      }),
      /manifest\.records\[0\]\.moduleId.*scope\.modules/i
    ],
    [
      'record path module must be present in limits.allowedModules',
      () => ({
        protocol: 2,
        type: 'manifest',
        manifest: {
          ...manifest,
          scope: { ...manifest.scope, modules: ['diary'] },
          modules: [{ ...manifest.modules[0], id: 'diary' }]
        }
      }),
      /manifest\.records\[0\]\.moduleId.*allowed/i,
      { ...limits, allowedModules: new Set(['diary']) }
    ],
    [
      'tombstone pathSegments must be an array',
      () => ({
        protocol: 2,
        type: 'manifest',
        manifest: {
          ...manifest,
          tombstones: [{ ...manifest.tombstones[0], pathSegments: 'modules.todos.items' }]
        }
      }),
      /manifest\.tombstones\[0\]\.pathSegments.*array/i
    ],
    [
      'tombstone forged path module is rejected',
      () => ({
        protocol: 2,
        type: 'manifest',
        manifest: {
          ...manifest,
          tombstones: [{
            ...manifest.tombstones[0],
            moduleId: 'todos',
            pathSegments: ['modules', 'diary', 'items']
          }]
        }
      }),
      /manifest\.tombstones\[0\]\.moduleId.*pathSegments\[1\]/i
    ]
  ]) {
    assert.throws(
      () => SyncCore.validateEnvelope(buildEnvelope(), nextLimits || limits),
      expectedPattern,
      name
    );
  }
});

test('validateEnvelope rejects non-integer manifest module summary counts and byte totals', async () => {
  const manifest = await SyncCore.buildManifest(
    {
      modules: {
        todos: {
          items: [{
            id: 'todo-1',
            txt: 'manifest source',
            attachment: {
              fileId: 'file-1',
              name: 'scan.pdf',
              type: 'application/pdf',
              size: 64,
              kind: 'doc'
            }
          }]
        }
      },
      _sync: {
        tombstones: [
          makeTombstone({
            id: 'todo-gone-1',
            pathSegments: ['modules', 'todos', 'items'],
            vector: { deviceA: 2 }
          })
        ]
      }
    },
    { modules: ['todos'], includeAttachments: true, includeSettings: false }
  );
  const limits = {
    allowedModules: new Set(['todos']),
    maxManifestBytes: 10000,
    maxAttachmentCount: 4,
    maxAttachmentBytes: 1000,
    maxChunkBytes: 32,
    seenChunkIndexes: new Set()
  };
  const invalidValues = [-1, 1.5, Infinity, '5'];

  for (const field of ['recordCount', 'tombstoneCount', 'attachmentCount', 'attachmentBytes', 'bytes']) {
    for (const badValue of invalidValues) {
      const nextManifest = {
        ...manifest,
        modules: [{ ...manifest.modules[0], [field]: badValue }]
      };
      assert.throws(
        () => SyncCore.validateEnvelope({ protocol: 2, type: 'manifest', manifest: nextManifest }, limits),
        new RegExp('manifest\\.modules\\[0\\]\\.' + field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'),
        field + ':' + String(badValue)
      );
    }
  }
});

test('validateEnvelope rejects non-integer record, tombstone, attachment, and settings size fields', async () => {
  const manifest = await SyncCore.buildManifest(
    {
      modules: {
        todos: {
          items: [{
            id: 'todo-1',
            txt: 'manifest source',
            attachment: {
              fileId: 'file-1',
              name: 'scan.pdf',
              type: 'application/pdf',
              size: 64,
              kind: 'doc'
            }
          }]
        }
      },
      appearance: {
        theme: 'dark'
      },
      _sync: {
        tombstones: [
          makeTombstone({
            id: 'todo-gone-1',
            pathSegments: ['modules', 'todos', 'items'],
            vector: { deviceA: 2 }
          })
        ]
      }
    },
    { modules: ['todos'], includeAttachments: true, includeSettings: true }
  );
  const limits = {
    allowedModules: new Set(['todos']),
    maxManifestBytes: 10000,
    maxAttachmentCount: 4,
    maxAttachmentBytes: 1000,
    maxChunkBytes: 32,
    seenChunkIndexes: new Set()
  };
  const invalidValues = [-1, 1.5, Infinity, '5'];

  for (const [label, mutate, expectedPattern] of [
    [
      'record attachmentCount',
      badValue => ({
        ...manifest,
        records: [{ ...manifest.records[0], attachmentCount: badValue }]
      }),
      /manifest\.records\[0\]\.attachmentCount/i
    ],
    [
      'record attachmentBytes',
      badValue => ({
        ...manifest,
        records: [{ ...manifest.records[0], attachmentBytes: badValue }]
      }),
      /manifest\.records\[0\]\.attachmentBytes/i
    ],
    [
      'record size',
      badValue => ({
        ...manifest,
        records: [{ ...manifest.records[0], size: badValue }]
      }),
      /manifest\.records\[0\]\.size/i
    ],
    [
      'tombstone size',
      badValue => ({
        ...manifest,
        tombstones: [{ ...manifest.tombstones[0], size: badValue }]
      }),
      /manifest\.tombstones\[0\]\.size/i
    ],
    [
      'attachment size',
      badValue => ({
        ...manifest,
        attachments: [{ ...manifest.attachments[0], size: badValue }]
      }),
      /manifest\.attachments\[0\]\.size/i
    ],
    [
      'settings size',
      badValue => ({
        ...manifest,
        settings: { ...manifest.settings, size: badValue }
      }),
      /manifest\.settings\.size/i
    ]
  ]) {
    for (const badValue of invalidValues) {
      assert.throws(
        () => SyncCore.validateEnvelope({ protocol: 2, type: 'manifest', manifest: mutate(badValue) }, limits),
        expectedPattern,
        label + ':' + String(badValue)
      );
    }
  }
});

test('applyMergePlan merges selected same tombstone vectors without creating visible records', async () => {
  const sender = {
    modules: {
      todos: {
        items: []
      }
    },
    _sync: {
      tombstones: [
        makeTombstone({
          id: 'todo-gone-1',
          pathSegments: ['modules', 'todos', 'items'],
          vector: { deviceA: 2 }
        })
      ]
    }
  };
  const receiver = {
    modules: {
      todos: {
        items: []
      }
    },
    _sync: {
      tombstones: [
        makeTombstone({
          id: 'todo-gone-1',
          pathSegments: ['modules', 'todos', 'items'],
          vector: { deviceB: 3 }
        })
      ]
    }
  };
  const senderBefore = clone(sender);
  const receiverBefore = clone(receiver);
  const plan = await SyncCore.buildMergePlan(sender, receiver, {
    modules: ['todos'],
    includeAttachments: false,
    includeSettings: false
  });
  const sameOperation = plan.operations.find(item => item.category === 'same');

  assert.ok(sameOperation);
  assert.equal(sameOperation.selected, false);

  const applied = await SyncCore.applyMergePlan(plan, receiver, {
    selectedOperationIds: new Set([sameOperation.id])
  });

  assert.deepEqual(sender, senderBefore);
  assert.deepEqual(receiver, receiverBefore);
  assert.deepEqual(applied.modules.todos.items, []);
  assert.equal(applied._sync.tombstones.length, 1);
  assert.deepEqual(applied._sync.tombstones[0]._sync.vector, {
    deviceA: 2,
    deviceB: 3
  });
});

test('hashBlob hashes Buffer, ArrayBuffer, and Blob when available', async () => {
  const bytes = Buffer.from('hello world', 'utf8');
  const expected = nodeCrypto.createHash('sha256').update(bytes).digest('hex');

  assert.equal(await SyncCore.hashBlob(bytes), expected);
  assert.equal(await SyncCore.hashBlob(Uint8Array.from(bytes).buffer), expected);
  if (typeof Blob !== 'undefined') {
    assert.equal(await SyncCore.hashBlob(new Blob([bytes])), expected);
  }
  await assert.rejects(() => SyncCore.hashBlob('hello world'), /Unsupported/i);
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

test('identity keys stay distinct when path segments contain dots', async () => {
  const seed = {
    'a.b': {
      c: [{ id: 'same-id', note: 'remove only dotted parent branch' }]
    },
    a: {
      'b.c': [{ id: 'same-id', note: 'same joined display path but stays' }]
    }
  };
  const previous = await SyncCore.stampChanges(seed, {}, 'device-a');
  const current = clone(previous);
  current['a.b'].c = [];

  const stamped = await SyncCore.stampChanges(current, previous, 'device-a');
  const repeatedIdTombstones = stamped._sync.tombstones.filter(item => item.id === 'same-id');

  assert.equal(repeatedIdTombstones.length, 1);
  assert.deepEqual(repeatedIdTombstones[0].pathSegments, ['a.b', 'c']);
  assert.equal(repeatedIdTombstones[0].path, 'a.b.c');
  assert.equal(stamped.a['b.c'][0].note, 'same joined display path but stays');
  assert.equal(stamped.a['b.c'][0]._sync.vector['device-a'], 1);
});

test('supports non-empty device ids including __proto__ as own vector keys', async () => {
  const stamped = await SyncCore.stampChanges({
    modules: {
      todos: {
        items: [{ id: 'todo-1', txt: 'keep me' }]
      }
    }
  }, {}, '__proto__');
  const vector = stamped.modules.todos.items[0]._sync.vector;

  assert.equal(Object.hasOwn(vector, '__proto__'), true);
  assert.equal(Object.getOwnPropertyDescriptor(vector, '__proto__').value, 1);
  assert.equal(Object.getPrototypeOf(vector), Object.prototype);
});

test('throws TypeError for missing or empty device ids', async () => {
  await assert.rejects(
    () => SyncCore.stampChanges({ modules: { todos: { items: [{ id: 'todo-1' }] } } }, {}, ''),
    TypeError
  );
  await assert.rejects(
    () => SyncCore.stampChanges({ modules: { todos: { items: [{ id: 'todo-1' }] } } }, {}, null),
    TypeError
  );
});
