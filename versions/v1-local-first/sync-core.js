(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.PersonalHubSyncCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  const isCommonJsNode =
    typeof module === 'object' &&
    !!module &&
    !!module.exports &&
    typeof require === 'function';
  const nodeCrypto = isCommonJsNode ? require('node:crypto') : null;
  const TextEncoderCtor =
    typeof TextEncoder !== 'undefined'
      ? TextEncoder
      : isCommonJsNode
        ? require('node:util').TextEncoder
        : null;
  const encoder = TextEncoderCtor ? new TextEncoderCtor() : null;

  function isObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  function deepClone(value) {
    if (Array.isArray(value)) return value.map(deepClone);
    if (!isObject(value)) return value;
    const clone = {};
    for (const key of Object.keys(value)) clone[key] = deepClone(value[key]);
    return clone;
  }

  function stableValue(value, omitSync) {
    if (Array.isArray(value)) return value.map(item => stableValue(item, omitSync));
    if (!isObject(value)) return value;
    const sorted = {};
    for (const key of Object.keys(value).sort()) {
      if (omitSync && key === '_sync') continue;
      sorted[key] = stableValue(value[key], omitSync);
    }
    return sorted;
  }

  function mergeVectors() {
    const merged = {};
    for (const vector of arguments) {
      if (!isObject(vector)) continue;
      for (const key of Object.keys(vector)) {
        const next = Number(vector[key]) || 0;
        if (next > (merged[key] || 0)) merged[key] = next;
      }
    }
    return merged;
  }

  function bumpVector(vector, deviceId) {
    const next = mergeVectors(vector);
    next[deviceId] = (next[deviceId] || 0) + 1;
    return next;
  }

  function compareVectors(left, right) {
    left = isObject(left) ? left : {};
    right = isObject(right) ? right : {};
    const keys = new Set(Object.keys(left).concat(Object.keys(right)));
    let greater = false;
    let less = false;
    for (const key of keys) {
      const leftValue = left[key] || 0;
      const rightValue = right[key] || 0;
      if (leftValue > rightValue) greater = true;
      if (leftValue < rightValue) less = true;
    }
    if (greater && less) return 'concurrent';
    if (greater) return 'newer';
    if (less) return 'older';
    return 'equal';
  }

  function vectorWeight(vector) {
    return Object.values(isObject(vector) ? vector : {}).reduce((sum, value) => sum + (Number(value) || 0), 0);
  }

  function extractModuleId(path) {
    return path[0] === 'modules' && path[1] ? path[1] : null;
  }

  function entityKey(path, parentId, id) {
    return [path.join('.'), parentId || '', String(id)].join('::');
  }

  function tombstoneKey(record) {
    return [(record.path || ''), record.parentId || '', String(record.id)].join('::');
  }

  function normalizeTombstone(record) {
    const sync = isObject(record && record._sync) ? record._sync : {};
    return {
      id: record ? record.id : undefined,
      path: record && record.path ? record.path : '',
      moduleId: record && record.moduleId != null ? record.moduleId : null,
      parentId: record && record.parentId != null ? record.parentId : null,
      _sync: {
        vector: mergeVectors(sync.vector),
        deleted: true,
        conflictOf: sync.conflictOf == null ? null : sync.conflictOf
      }
    };
  }

  function upsertTombstone(map, record) {
    if (!record || record.id == null) return;
    const normalized = normalizeTombstone(record);
    const key = tombstoneKey(normalized);
    const existing = map.get(key);
    if (!existing) {
      map.set(key, normalized);
      return;
    }
    const relation = compareVectors(normalized._sync.vector, existing._sync.vector);
    if (relation === 'older') return;
    if (relation === 'concurrent' && vectorWeight(normalized._sync.vector) < vectorWeight(existing._sync.vector)) {
      return;
    }
    map.set(key, normalized);
  }

  function collectEntities(node, path, parentId, list) {
    if (Array.isArray(node)) {
      for (const item of node) collectEntities(item, path, parentId, list);
      return list;
    }
    if (!isObject(node)) return list;
    const hasId = Object.prototype.hasOwnProperty.call(node, 'id') && node.id != null;
    const nextParentId = hasId ? node.id : parentId;
    if (hasId) {
      list.push({
        id: node.id,
        path: path.join('.'),
        moduleId: extractModuleId(path),
        parentId: parentId == null ? null : parentId,
        key: entityKey(path, parentId, node.id),
        node
      });
    }
    for (const key of Object.keys(node)) {
      if (key === '_sync') continue;
      collectEntities(node[key], path.concat(key), nextParentId, list);
    }
    return list;
  }

  async function sha256Hex(text) {
    if (!encoder) throw new Error('TextEncoder unavailable');
    const bytes = encoder.encode(text);
    if (nodeCrypto && nodeCrypto.createHash) {
      return nodeCrypto.createHash('sha256').update(Buffer.from(bytes)).digest('hex');
    }
    if (root.crypto && root.crypto.subtle) {
      const digest = await root.crypto.subtle.digest('SHA-256', bytes);
      return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
    }
    throw new Error('SHA-256 unavailable');
  }

  async function hashRecord(record) {
    return sha256Hex(JSON.stringify(stableValue(record, true)));
  }

  async function migrateState(state) {
    const migrated = deepClone(state || {});
    const rootSync = isObject(migrated._sync) ? deepClone(migrated._sync) : {};
    migrated._sync = rootSync;
    const tombstones = Array.isArray(rootSync.tombstones) ? rootSync.tombstones.map(deepClone) : [];
    const entities = collectEntities(migrated, [], null, []);
    for (const entity of entities) {
      const previousSync = isObject(entity.node._sync) ? entity.node._sync : {};
      entity.node._sync = {
        vector: mergeVectors(previousSync.vector),
        deleted: previousSync.deleted === true,
        conflictOf: previousSync.conflictOf == null ? null : previousSync.conflictOf,
        contentHash: await hashRecord(entity.node)
      };
    }
    migrated._sync.tombstones = tombstones;
    return migrated;
  }

  async function stampChanges(current, previous, deviceId) {
    const nextState = await migrateState(current || {});
    const previousState = await migrateState(previous || {});
    const nextEntities = collectEntities(nextState, [], null, []);
    const previousEntities = collectEntities(previousState, [], null, []);
    const previousMap = new Map(previousEntities.map(entity => [entity.key, entity]));
    const currentKeys = new Set();

    for (const entity of nextEntities) {
      currentKeys.add(entity.key);
      const prior = previousMap.get(entity.key);
      const currentHash = await hashRecord(entity.node);
      const currentSync = isObject(entity.node._sync) ? entity.node._sync : {};
      const priorSync = prior && isObject(prior.node._sync) ? prior.node._sync : {};
      const stableVector = mergeVectors(priorSync.vector, currentSync.vector);
      const priorHash = priorSync.contentHash || null;
      const changed = !prior || priorHash !== currentHash || priorSync.deleted === true;
      entity.node._sync = {
        vector: changed ? bumpVector(stableVector, deviceId) : stableVector,
        deleted: false,
        conflictOf: currentSync.conflictOf != null ? currentSync.conflictOf : priorSync.conflictOf == null ? null : priorSync.conflictOf,
        contentHash: currentHash
      };
    }

    const mergedRootSync = {};
    for (const source of [previousState._sync, nextState._sync]) {
      if (!isObject(source)) continue;
      for (const key of Object.keys(source)) {
        if (key === 'tombstones') continue;
        mergedRootSync[key] = deepClone(source[key]);
      }
    }

    const tombstoneMap = new Map();
    const existingTombstones = []
      .concat(Array.isArray(previousState._sync && previousState._sync.tombstones) ? previousState._sync.tombstones : [])
      .concat(Array.isArray(nextState._sync && nextState._sync.tombstones) ? nextState._sync.tombstones : []);

    for (const tombstone of existingTombstones) upsertTombstone(tombstoneMap, tombstone);
    for (const key of currentKeys) tombstoneMap.delete(key);

    for (const entity of previousEntities) {
      if (currentKeys.has(entity.key)) continue;
      upsertTombstone(tombstoneMap, {
        id: entity.id,
        path: entity.path,
        moduleId: entity.moduleId,
        parentId: entity.parentId,
        _sync: {
          vector: bumpVector(entity.node._sync && entity.node._sync.vector, deviceId),
          deleted: true,
          conflictOf:
            entity.node._sync && entity.node._sync.conflictOf != null ? entity.node._sync.conflictOf : null
        }
      });
    }

    mergedRootSync.tombstones = Array.from(tombstoneMap.values()).sort((left, right) =>
      tombstoneKey(left).localeCompare(tombstoneKey(right))
    );
    nextState._sync = mergedRootSync;
    return nextState;
  }

  return {
    compareVectors: compareVectors,
    migrateState: migrateState,
    hashRecord: hashRecord,
    stampChanges: stampChanges
  };
});
