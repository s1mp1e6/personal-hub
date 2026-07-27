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
  const OMIT = {};
  const KNOWN_ENVELOPE_TYPES = new Set([
    'scope-offer',
    'manifest-request',
    'manifest',
    'plan-selection',
    'data-start',
    'data-chunk',
    'data-end',
    'commit-result',
    'abort'
  ]);

  function isObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  }

  function hasOwn(value, key) {
    return Object.prototype.hasOwnProperty.call(value, key);
  }

  function defineOwn(target, key, value) {
    if (key === '__proto__') {
      Object.defineProperty(target, key, {
        value: value,
        enumerable: true,
        writable: true,
        configurable: true
      });
      return;
    }
    target[key] = value;
  }

  function normalizeCounter(value) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : 0;
  }

  function normalizeSize(value) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : 0;
  }

  function assertDeviceId(deviceId) {
    if (typeof deviceId !== 'string' || deviceId === '') {
      throw new TypeError('deviceId must be a non-empty string');
    }
  }

  function deepClone(value) {
    if (Array.isArray(value)) return value.map(deepClone);
    if (!isObject(value)) return value;
    const clone = {};
    for (const key of Object.keys(value)) defineOwn(clone, key, deepClone(value[key]));
    return clone;
  }

  function stableValue(value, omitSync) {
    if (Array.isArray(value)) return value.map(item => stableValue(item, omitSync));
    if (!isObject(value)) return value;
    const sorted = {};
    for (const key of Object.keys(value).sort()) {
      if (omitSync && key === '_sync') continue;
      defineOwn(sorted, key, stableValue(value[key], omitSync));
    }
    return sorted;
  }

  function mergeVectors() {
    const merged = {};
    for (const vector of arguments) {
      if (!isObject(vector)) continue;
      for (const key of Object.keys(vector)) {
        const next = normalizeCounter(vector[key]);
        if (next > normalizeCounter(merged[key])) defineOwn(merged, key, next);
      }
    }
    return merged;
  }

  function bumpVector(vector, deviceId) {
    assertDeviceId(deviceId);
    const next = mergeVectors(vector);
    defineOwn(next, deviceId, normalizeCounter(hasOwn(next, deviceId) ? next[deviceId] : 0) + 1);
    return next;
  }

  function compareVectors(left, right) {
    left = isObject(left) ? left : {};
    right = isObject(right) ? right : {};
    const keys = new Set(Object.keys(left).concat(Object.keys(right)));
    let greater = false;
    let less = false;
    for (const key of keys) {
      const leftValue = normalizeCounter(left[key]);
      const rightValue = normalizeCounter(right[key]);
      if (leftValue > rightValue) greater = true;
      if (leftValue < rightValue) less = true;
    }
    if (greater && less) return 'concurrent';
    if (greater) return 'newer';
    if (less) return 'older';
    return 'equal';
  }

  function vectorWeight(vector) {
    return Object.values(isObject(vector) ? vector : {}).reduce((sum, value) => sum + normalizeCounter(value), 0);
  }

  function extractModuleId(path) {
    return path[0] === 'modules' && path[1] ? path[1] : null;
  }

  function entityKey(path, parentId, id) {
    return JSON.stringify([path, parentId == null ? null : String(parentId), String(id)]);
  }

  function toPathString(path) {
    return path.join('.');
  }

  function normalizePathSegments(record) {
    if (Array.isArray(record && record.pathSegments)) return deepClone(record.pathSegments);
    if (Array.isArray(record && record.path)) return deepClone(record.path);
    if (record && typeof record.path === 'string') return record.path.split('.');
    return [];
  }

  function tombstoneKey(record) {
    return JSON.stringify([
      normalizePathSegments(record),
      record.parentId == null ? null : String(record.parentId),
      String(record.id)
    ]);
  }

  function normalizeTombstone(record) {
    const sync = isObject(record && record._sync) ? record._sync : {};
    const pathSegments = normalizePathSegments(record);
    return {
      id: record ? record.id : undefined,
      path: record && typeof record.path === 'string' ? record.path : toPathString(pathSegments),
      pathSegments: pathSegments,
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
    const hasId = hasOwn(node, 'id') && node.id != null;
    const nextParentId = hasId ? node.id : parentId;
    if (hasId) {
      list.push({
        id: node.id,
        path: toPathString(path),
        pathSegments: deepClone(path),
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

  function byteLengthOfText(text) {
    const string = String(text);
    if (encoder) return encoder.encode(string).length;
    if (typeof Buffer !== 'undefined' && Buffer.byteLength) return Buffer.byteLength(string);
    return string.length;
  }

  function serializedSize(value) {
    const json = JSON.stringify(value);
    return json == null ? 0 : byteLengthOfText(json);
  }

  function toNodeBuffer(bytes) {
    if (typeof Buffer === 'undefined') throw new Error('Buffer unavailable');
    if (Buffer.isBuffer(bytes)) return bytes;
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  function isArrayBufferLike(value) {
    return Object.prototype.toString.call(value) === '[object ArrayBuffer]';
  }

  function isArrayBufferViewLike(value) {
    return !!value &&
      typeof value === 'object' &&
      typeof value.byteLength === 'number' &&
      !!value.buffer &&
      isArrayBufferLike(value.buffer);
  }

  async function digestBytes(bytes) {
    if (nodeCrypto && nodeCrypto.createHash) {
      return nodeCrypto.createHash('sha256').update(toNodeBuffer(bytes)).digest('hex');
    }
    if (root.crypto && root.crypto.subtle) {
      const digest = await root.crypto.subtle.digest('SHA-256', bytes);
      return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
    }
    throw new Error('SHA-256 unavailable');
  }

  async function sha256Hex(text) {
    if (!encoder) throw new Error('TextEncoder unavailable');
    return digestBytes(encoder.encode(text));
  }

  function isFileReference(value) {
    return isObject(value) && typeof value.fileId === 'string';
  }

  function summarizeFileReference(value) {
    return {
      fileId: value.fileId,
      name: value.name == null ? null : String(value.name),
      type: value.type == null ? null : String(value.type),
      size: normalizeSize(value.size),
      kind: value.kind == null ? null : String(value.kind)
    };
  }

  function buildComparableValue(value, includeAttachments) {
    if (Array.isArray(value)) {
      const items = [];
      for (const item of value) {
        const next = buildComparableValue(item, includeAttachments);
        if (next !== OMIT) items.push(next);
      }
      return items;
    }
    if (!isObject(value)) return value;
    if (isFileReference(value)) return includeAttachments ? summarizeFileReference(value) : OMIT;
    const clone = {};
    for (const key of Object.keys(value)) {
      if (key === '_sync') continue;
      if (!includeAttachments && key === 'attType' && isFileReference(value.attachment)) continue;
      const next = buildComparableValue(value[key], includeAttachments);
      if (next === OMIT) continue;
      defineOwn(clone, key, next);
    }
    return clone;
  }

  function attachmentSubtree(value) {
    if (Array.isArray(value)) {
      const items = [];
      for (const item of value) {
        const next = attachmentSubtree(item);
        if (next !== OMIT) items.push(next);
      }
      return items.length ? items : OMIT;
    }
    if (!isObject(value)) return OMIT;
    if (isFileReference(value)) return deepClone(value);

    const subtree = {};
    let found = false;
    for (const key of Object.keys(value)) {
      if (key === '_sync' || key === 'id' || key === 'attType') continue;
      const next = attachmentSubtree(value[key]);
      if (next === OMIT) continue;
      defineOwn(subtree, key, next);
      found = true;
    }
    if (!found) return OMIT;
    if (value.id != null) defineOwn(subtree, 'id', deepClone(value.id));
    if (isFileReference(value.attachment) && hasOwn(value, 'attType')) {
      defineOwn(subtree, 'attType', deepClone(value.attType));
    }
    return subtree;
  }

  function attachmentFreeBusinessKey(value) {
    const comparable = buildComparableValue(value, false);
    if (comparable === OMIT) return null;
    if (Array.isArray(comparable) && comparable.length === 0) return null;
    if (isObject(comparable) && Object.keys(comparable).length === 0) return null;
    return JSON.stringify(stableValue(comparable, false));
  }

  function matchingArrayIndex(senderItems, receiverItems, index) {
    if (!Array.isArray(receiverItems)) return -1;
    const value = senderItems[index];
    if (isObject(value) && value.id != null) {
      const matches = receiverItems
        .map((item, itemIndex) => ({ item: item, index: itemIndex }))
        .filter(entry => isObject(entry.item) && entry.item.id != null && String(entry.item.id) === String(value.id));
      return matches.length === 1 ? matches[0].index : -1;
    }
    const businessKey = attachmentFreeBusinessKey(value);
    if (businessKey == null) return -1;
    const senderMatches = senderItems.filter(item =>
      (!isObject(item) || item.id == null) && attachmentFreeBusinessKey(item) === businessKey
    );
    if (senderMatches.length !== 1) return -1;
    const receiverMatches = receiverItems
      .map((item, itemIndex) => ({ item: item, index: itemIndex }))
      .filter(entry =>
        (!isObject(entry.item) || entry.item.id == null) && attachmentFreeBusinessKey(entry.item) === businessKey
      );
    return receiverMatches.length === 1 ? receiverMatches[0].index : -1;
  }

  function canMergeAttachmentContainers(senderValue, receiverValue) {
    if (isFileReference(senderValue) || isFileReference(receiverValue)) {
      return isFileReference(senderValue) && isFileReference(receiverValue);
    }
    if (Array.isArray(senderValue) || Array.isArray(receiverValue)) {
      return Array.isArray(senderValue) && Array.isArray(receiverValue);
    }
    return isObject(senderValue) && isObject(receiverValue);
  }

  function mergeWithoutAttachmentReferences(senderValue, receiverValue) {
    if (!canMergeAttachmentContainers(senderValue, receiverValue)) {
      const preserved = attachmentSubtree(receiverValue);
      if (preserved !== OMIT) return preserved;
    }
    if (isFileReference(senderValue)) {
      return isFileReference(receiverValue) ? deepClone(receiverValue) : OMIT;
    }
    if (Array.isArray(senderValue)) {
      const merged = [];
      const handledReceiverIndexes = new Set();
      for (let index = 0; index < senderValue.length; index += 1) {
        const receiverIndex = matchingArrayIndex(senderValue, receiverValue, index);
        const receiverItem = receiverIndex >= 0 ? receiverValue[receiverIndex] : undefined;
        const canMerge = canMergeAttachmentContainers(senderValue[index], receiverItem);
        const next = mergeWithoutAttachmentReferences(
          senderValue[index],
          canMerge ? receiverItem : undefined
        );
        if (next !== OMIT) merged.push(next);
        if (canMerge) handledReceiverIndexes.add(receiverIndex);
      }
      if (Array.isArray(receiverValue)) {
        for (let index = 0; index < receiverValue.length; index += 1) {
          if (handledReceiverIndexes.has(index)) continue;
          const preserved = attachmentSubtree(receiverValue[index]);
          if (preserved !== OMIT) merged.push(preserved);
        }
      }
      return merged;
    }
    if (!isObject(senderValue)) return senderValue;

    const receiverObject = isObject(receiverValue) ? receiverValue : null;
    const merged = {};
    for (const key of Object.keys(senderValue)) {
      if (key === 'attType' && isFileReference(senderValue.attachment)) continue;
      const next = mergeWithoutAttachmentReferences(
        senderValue[key],
        receiverObject ? receiverObject[key] : undefined
      );
      if (next !== OMIT) defineOwn(merged, key, next);
    }
    if (receiverObject) {
      for (const key of Object.keys(receiverObject)) {
        if (hasOwn(senderValue, key)) continue;
        const preserved = attachmentSubtree(receiverObject[key]);
        if (preserved !== OMIT) defineOwn(merged, key, preserved);
      }
      if (isFileReference(receiverObject.attachment) && hasOwn(receiverObject, 'attType')) {
        defineOwn(merged, 'attType', deepClone(receiverObject.attType));
      }
    }
    return merged;
  }

  function collectAttachmentMetadata(value, info, list) {
    if (Array.isArray(value)) {
      for (const item of value) collectAttachmentMetadata(item, info, list);
      return list;
    }
    if (!isObject(value)) return list;
    if (isFileReference(value)) {
      list.push({
        fileId: value.fileId,
        name: value.name == null ? null : String(value.name),
        type: value.type == null ? null : String(value.type),
        size: normalizeSize(value.size),
        kind: value.kind == null ? null : String(value.kind),
        recordId: info.id,
        parentId: info.parentId,
        moduleId: info.moduleId,
        pathSegments: deepClone(info.pathSegments)
      });
      return list;
    }
    for (const key of Object.keys(value)) {
      if (key === '_sync') continue;
      collectAttachmentMetadata(value[key], info, list);
    }
    return list;
  }

  async function hashComparableValue(value) {
    return sha256Hex(JSON.stringify(stableValue(value, false)));
  }

  function knownModulesFromState(state, set) {
    const modules = isObject(state && state.modules) ? state.modules : {};
    for (const moduleId of Object.keys(modules)) set.add(moduleId);
  }

  function normalizeScope(scope, knownModules) {
    if (!isObject(scope)) throw new TypeError('scope must be a plain object');
    const modules = [];
    const seen = new Set();
    const requested = Array.isArray(scope.modules) ? scope.modules : [];
    for (const moduleId of requested) {
      if (typeof moduleId !== 'string' || moduleId === '') {
        throw new TypeError('scope.modules must contain non-empty strings');
      }
      if (seen.has(moduleId)) continue;
      if (!knownModules.has(moduleId)) throw new Error('Unknown module: ' + moduleId);
      seen.add(moduleId);
      modules.push(moduleId);
    }
    return {
      modules: modules,
      includeAttachments: scope.includeAttachments === true,
      includeSettings: scope.includeSettings === true
    };
  }

  function buildIdentity(recordLike) {
    return {
      id: recordLike.id,
      parentId: recordLike.parentId == null ? null : recordLike.parentId,
      moduleId: recordLike.moduleId == null ? null : recordLike.moduleId,
      pathSegments: deepClone(recordLike.pathSegments)
    };
  }

  function emptySummary() {
    return {
      add: 0,
      update: 0,
      keep: 0,
      conflictCopy: 0,
      pendingDelete: 0,
      deleteConflict: 0,
      same: 0
    };
  }

  async function buildRecordEntry(entity, includeAttachments) {
    const comparable = buildComparableValue(entity.node, includeAttachments);
    const attachments = includeAttachments ? collectAttachmentMetadata(entity.node, entity, []) : [];
    return {
      kind: 'record',
      identity: buildIdentity(entity),
      meta: {
        id: entity.id,
        parentId: entity.parentId == null ? null : entity.parentId,
        moduleId: entity.moduleId == null ? null : entity.moduleId,
        pathSegments: deepClone(entity.pathSegments),
        vector: mergeVectors(entity.node._sync && entity.node._sync.vector),
        contentHash: await hashComparableValue(comparable),
        deleted: entity.node._sync && entity.node._sync.deleted === true,
        size: serializedSize(comparable),
        attachmentCount: attachments.length,
        attachmentBytes: attachments.reduce((sum, item) => sum + normalizeSize(item.size), 0)
      },
      value: includeAttachments
        ? deepClone(entity.node)
        : mergeWithoutAttachmentReferences(entity.node, null),
      attachments: attachments
    };
  }

  function buildTombstoneEntry(record) {
    const normalized = normalizeTombstone(record);
    return {
      kind: 'tombstone',
      identity: buildIdentity(normalized),
      meta: {
        id: normalized.id,
        parentId: normalized.parentId == null ? null : normalized.parentId,
        moduleId: normalized.moduleId == null ? null : normalized.moduleId,
        pathSegments: deepClone(normalized.pathSegments),
        vector: mergeVectors(normalized._sync && normalized._sync.vector),
        deleted: true,
        size: 0
      },
      value: deepClone(normalized)
    };
  }

  async function buildScopedView(state, scope) {
    const migrated = await migrateState(state || {});
    const selectedModules = new Set(scope.modules);
    const records = new Map();
    const tombstones = new Map();
    const attachments = [];
    const moduleSummaries = new Map();
    for (const moduleId of scope.modules) {
      moduleSummaries.set(moduleId, {
        id: moduleId,
        recordCount: 0,
        tombstoneCount: 0,
        attachmentCount: 0,
        attachmentBytes: 0,
        bytes: 0
      });
    }

    const entities = collectEntities(migrated, [], null, []);
    for (const entity of entities) {
      if (!selectedModules.has(entity.moduleId)) continue;
      const entry = await buildRecordEntry(entity, scope.includeAttachments);
      records.set(entity.key, entry);
      const moduleSummary = moduleSummaries.get(entity.moduleId);
      moduleSummary.recordCount += 1;
      moduleSummary.bytes += entry.meta.size;
      moduleSummary.attachmentCount += entry.meta.attachmentCount;
      moduleSummary.attachmentBytes += entry.meta.attachmentBytes;
      for (const attachment of entry.attachments) attachments.push(deepClone(attachment));
    }

    const rootTombstones = Array.isArray(migrated._sync && migrated._sync.tombstones) ? migrated._sync.tombstones : [];
    for (const tombstone of rootTombstones) {
      const entry = buildTombstoneEntry(tombstone);
      if (!selectedModules.has(entry.meta.moduleId)) continue;
      tombstones.set(tombstoneKey(entry.value), entry);
      moduleSummaries.get(entry.meta.moduleId).tombstoneCount += 1;
    }

    let settings = null;
    if (scope.includeSettings) {
      const settingsValue = {};
      for (const key of Object.keys(migrated)) {
        if (key === 'modules' || key === '_sync') continue;
        defineOwn(settingsValue, key, deepClone(migrated[key]));
      }
      const comparableSettings = buildComparableValue(settingsValue, scope.includeAttachments);
      settings = {
        contentHash: await hashComparableValue(comparableSettings),
        size: serializedSize(comparableSettings)
      };
    }

    return {
      migrated: migrated,
      records: records,
      tombstones: tombstones,
      attachments: scope.includeAttachments ? attachments : [],
      modules: scope.modules.map(moduleId => deepClone(moduleSummaries.get(moduleId))),
      settings: settings
    };
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
    assertDeviceId(deviceId);
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
        pathSegments: entity.pathSegments,
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

  async function buildManifest(state, scope) {
    const knownModules = new Set();
    knownModulesFromState(state || {}, knownModules);
    const normalizedScope = normalizeScope(scope, knownModules);
    const view = await buildScopedView(state || {}, normalizedScope);
    const records = Array.from(view.records.values(), entry => deepClone(entry.meta));
    const tombstones = Array.from(view.tombstones.values(), entry => deepClone(entry.meta));
    const manifest = {
      protocol: 2,
      scope: deepClone(normalizedScope),
      modules: deepClone(view.modules),
      records: records,
      tombstones: tombstones,
      attachments: normalizedScope.includeAttachments ? deepClone(view.attachments) : []
    };
    if (normalizedScope.includeSettings) manifest.settings = deepClone(view.settings);
    return manifest;
  }

  function createMergeOperation(category, identityKeyValue, identity, senderEntry, receiverEntry) {
    return {
      id: identityKeyValue,
      category: category,
      selected: category === 'add' || category === 'update' || category === 'conflictCopy',
      identity: deepClone(identity),
      sender: senderEntry
        ? {
            kind: senderEntry.kind,
            meta: deepClone(senderEntry.meta),
            value: deepClone(senderEntry.value)
          }
        : null,
      receiver: receiverEntry
        ? {
            kind: receiverEntry.kind,
            meta: deepClone(receiverEntry.meta),
            value: deepClone(receiverEntry.value)
          }
        : null
    };
  }

  async function buildMergePlan(senderState, receiverState, scope) {
    const knownModules = new Set();
    knownModulesFromState(senderState || {}, knownModules);
    knownModulesFromState(receiverState || {}, knownModules);
    const normalizedScope = normalizeScope(scope, knownModules);
    const senderView = await buildScopedView(senderState || {}, normalizedScope);
    const receiverView = await buildScopedView(receiverState || {}, normalizedScope);
    const operations = [];
    const summary = emptySummary();
    const allKeys = new Set();
    for (const key of senderView.records.keys()) allKeys.add(key);
    for (const key of receiverView.records.keys()) allKeys.add(key);
    for (const key of senderView.tombstones.keys()) allKeys.add(key);
    for (const key of receiverView.tombstones.keys()) allKeys.add(key);

    for (const key of Array.from(allKeys).sort()) {
      const senderRecord = senderView.records.get(key) || null;
      const receiverRecord = receiverView.records.get(key) || null;
      const senderTombstone = senderView.tombstones.get(key) || null;
      const receiverTombstone = receiverView.tombstones.get(key) || null;
      const identity = buildIdentity(
        senderRecord ? senderRecord.identity : receiverRecord ? receiverRecord.identity : senderTombstone ? senderTombstone.identity : receiverTombstone.identity
      );
      let category = null;
      let senderEntry = senderRecord || senderTombstone;
      let receiverEntry = receiverRecord || receiverTombstone;

      if (senderRecord && receiverRecord) {
        if (senderRecord.meta.contentHash === receiverRecord.meta.contentHash) {
          category = 'same';
        } else {
          const relation = compareVectors(senderRecord.meta.vector, receiverRecord.meta.vector);
          if (relation === 'newer') category = 'update';
          else if (relation === 'older') category = 'keep';
          else category = 'conflictCopy';
        }
      } else if (senderRecord && !receiverRecord && !receiverTombstone) {
        category = 'add';
      } else if (!senderRecord && !senderTombstone && receiverRecord) {
        category = 'keep';
      } else if (senderTombstone && receiverRecord) {
        const relation = compareVectors(senderTombstone.meta.vector, receiverRecord.meta.vector);
        if (relation === 'newer') category = 'pendingDelete';
        else if (relation === 'older') category = 'keep';
        else category = 'deleteConflict';
      } else if (senderRecord && receiverTombstone) {
        const relation = compareVectors(senderRecord.meta.vector, receiverTombstone.meta.vector);
        if (relation === 'newer') category = 'add';
        else if (relation === 'concurrent') category = 'deleteConflict';
        else category = 'same';
      } else if (senderTombstone && receiverTombstone) {
        category = 'same';
      } else if (senderTombstone && !receiverRecord) {
        category = 'same';
        receiverEntry = receiverTombstone;
      } else if (receiverTombstone && !senderRecord) {
        category = 'same';
        senderEntry = senderTombstone;
      }

      if (!category) continue;
      summary[category] += 1;
      operations.push(createMergeOperation(category, key, identity, senderEntry, receiverEntry));
    }

    return {
      operations: operations,
      summary: summary,
      scope: deepClone(normalizedScope)
    };
  }

  function ensureRootSync(state) {
    if (!isObject(state._sync)) state._sync = {};
    if (!Array.isArray(state._sync.tombstones)) state._sync.tombstones = [];
    return state._sync.tombstones;
  }

  function resolveCollection(rootState, pathSegments, parentId, createIfMissing) {
    let current = rootState;
    for (let index = 0; index < pathSegments.length; index += 1) {
      if (Array.isArray(current)) {
        const parent = current.find(item => isObject(item) && item.id != null && String(item.id) === String(parentId));
        if (!parent) return null;
        current = parent;
      }
      if (!isObject(current)) return null;
      const segment = pathSegments[index];
      if (!hasOwn(current, segment) || current[segment] == null) {
        if (!createIfMissing) return null;
        defineOwn(current, segment, index === pathSegments.length - 1 ? [] : {});
      }
      current = current[segment];
    }
    return Array.isArray(current) ? current : null;
  }

  function removeRecordAtIdentity(state, identity) {
    const collection = resolveCollection(state, identity.pathSegments, identity.parentId, false);
    if (!collection) return false;
    const index = collection.findIndex(item => isObject(item) && item.id != null && String(item.id) === String(identity.id));
    if (index < 0) return false;
    collection.splice(index, 1);
    return true;
  }

  function normalizeSelectedOperationIds(selectedOperationIds) {
    if (selectedOperationIds == null) return null;
    if (selectedOperationIds instanceof Set) return new Set(Array.from(selectedOperationIds, value => String(value)));
    if (Array.isArray(selectedOperationIds)) return new Set(selectedOperationIds.map(value => String(value)));
    throw new TypeError('selectedOperationIds must be a Set or an array');
  }

  function defaultIdFactory(originalId) {
    if (root.crypto && typeof root.crypto.randomUUID === 'function') {
      return root.crypto.randomUUID();
    }
    if (nodeCrypto && nodeCrypto.randomBytes) {
      return String(originalId) + '-copy-' + nodeCrypto.randomBytes(6).toString('hex');
    }
    return String(originalId) + '-copy-' + Math.random().toString(16).slice(2);
  }

  function createCollisionFreeId(collection, originalId, idFactory) {
    const existingIds = new Set(
      collection
        .filter(item => isObject(item) && item.id != null)
        .map(item => String(item.id))
    );
    const factory = typeof idFactory === 'function' ? idFactory : defaultIdFactory;
    for (let attempt = 0; attempt < 1024; attempt += 1) {
      const raw = factory(originalId, attempt);
      const candidate = raw == null || raw === '' ? defaultIdFactory(originalId, attempt) : String(raw);
      if (!existingIds.has(candidate)) return candidate;
    }
    throw new Error('Unable to generate collision-free id');
  }

  async function applyMergePlan(plan, receiverState, options) {
    if (!isObject(plan) || !Array.isArray(plan.operations)) {
      throw new TypeError('plan must contain an operations array');
    }
    const nextState = deepClone(receiverState || {});
    const tombstones = ensureRootSync(nextState);
    const tombstoneMap = new Map(
      tombstones.map(item => [tombstoneKey(normalizeTombstone(item)), normalizeTombstone(item)])
    );
    let tombstonesDirty = false;
    const selectedIds = normalizeSelectedOperationIds(options && options.selectedOperationIds);
    const idFactory = options && options.idFactory;
    const includeAttachments = !plan.scope || plan.scope.includeAttachments !== false;

    for (const operation of plan.operations) {
      const applyOperation = selectedIds ? selectedIds.has(String(operation.id)) : operation.selected === true;
      if (!applyOperation) continue;
      const key = entityKey(operation.identity.pathSegments, operation.identity.parentId, operation.identity.id);

      if (operation.category === 'add' || operation.category === 'update') {
        const collection = resolveCollection(nextState, operation.identity.pathSegments, operation.identity.parentId, true);
        if (!collection) throw new Error('Unable to resolve collection path');
        const index = collection.findIndex(
          item => isObject(item) && item.id != null && String(item.id) === String(operation.identity.id)
        );
        const receiverRecord = index >= 0 ? collection[index] : null;
        const nextRecord = includeAttachments
          ? deepClone(operation.sender.value)
          : mergeWithoutAttachmentReferences(operation.sender.value, receiverRecord);
        if (isObject(nextRecord._sync)) nextRecord._sync.contentHash = await hashRecord(nextRecord);
        if (index >= 0) collection[index] = nextRecord;
        else collection.push(nextRecord);
        if (tombstoneMap.delete(key)) tombstonesDirty = true;
        continue;
      }

      if (
        operation.category === 'conflictCopy' ||
        (
          operation.category === 'deleteConflict' &&
          operation.sender &&
          operation.sender.kind === 'record' &&
          operation.receiver &&
          operation.receiver.kind === 'tombstone'
        )
      ) {
        const collection = resolveCollection(nextState, operation.identity.pathSegments, operation.identity.parentId, true);
        if (!collection) throw new Error('Unable to resolve collection path');
        const conflictCopy = includeAttachments
          ? deepClone(operation.sender.value)
          : mergeWithoutAttachmentReferences(operation.sender.value, null);
        conflictCopy.id = createCollisionFreeId(collection, operation.identity.id, idFactory);
        if (!isObject(conflictCopy._sync)) conflictCopy._sync = {};
        conflictCopy._sync.vector = mergeVectors(conflictCopy._sync.vector);
        conflictCopy._sync.deleted = false;
        conflictCopy._sync.conflictOf = operation.identity.id;
        conflictCopy._sync.contentHash = await hashRecord(conflictCopy);
        collection.push(conflictCopy);
        if (operation.category === 'conflictCopy' && tombstoneMap.delete(key)) tombstonesDirty = true;
        continue;
      }

      if (operation.category === 'pendingDelete') {
        removeRecordAtIdentity(nextState, operation.identity);
        upsertTombstone(tombstoneMap, operation.sender.value);
        tombstonesDirty = true;
        continue;
      }

      if (operation.category === 'same') {
        if (
          (operation.sender && operation.sender.kind === 'tombstone') ||
          (operation.receiver && operation.receiver.kind === 'tombstone')
        ) {
          const senderTombstone =
            operation.sender && operation.sender.kind === 'tombstone'
              ? normalizeTombstone(operation.sender.value)
              : null;
          const receiverTombstone =
            operation.receiver && operation.receiver.kind === 'tombstone'
              ? normalizeTombstone(operation.receiver.value)
              : null;
          const mergedTombstone = normalizeTombstone(receiverTombstone || senderTombstone);
          mergedTombstone._sync.vector = mergeVectors(
            receiverTombstone && receiverTombstone._sync ? receiverTombstone._sync.vector : null,
            senderTombstone && senderTombstone._sync ? senderTombstone._sync.vector : null
          );
          tombstoneMap.set(tombstoneKey(mergedTombstone), mergedTombstone);
          tombstonesDirty = true;
          continue;
        }
        const collection = resolveCollection(nextState, operation.identity.pathSegments, operation.identity.parentId, false);
        if (!collection) continue;
        const record = collection.find(item => isObject(item) && item.id != null && String(item.id) === String(operation.identity.id));
        if (!record) continue;
        if (!isObject(record._sync)) record._sync = {};
        record._sync.vector = mergeVectors(
          record._sync.vector,
          operation.receiver && operation.receiver.meta ? operation.receiver.meta.vector : null,
          operation.sender && operation.sender.meta ? operation.sender.meta.vector : null
        );
        record._sync.deleted = false;
        if (!hasOwn(record._sync, 'conflictOf')) record._sync.conflictOf = null;
        if (record._sync.contentHash == null) record._sync.contentHash = await hashRecord(record);
      }
    }

    if (tombstonesDirty) {
      tombstones.splice(
        0,
        tombstones.length,
        ...Array.from(tombstoneMap.values()).sort((left, right) => tombstoneKey(left).localeCompare(tombstoneKey(right)))
      );
    }

    return nextState;
  }

  function assertSafeEnvelopeGraph(value, label) {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        assertSafeEnvelopeGraph(value[index], label + '[' + index + ']');
      }
      return;
    }
    if (value == null || typeof value !== 'object') return;
    if (!isPlainObject(value)) throw new Error(label + ' must contain only plain objects');
    for (const key of Object.keys(value)) {
      if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
        throw new Error('Prototype key not allowed: ' + key);
      }
      assertSafeEnvelopeGraph(value[key], label + '.' + key);
    }
  }

  function assertModuleIdsAllowed(moduleIds, allowedModules, label) {
    for (const moduleId of moduleIds) {
      if (typeof moduleId !== 'string' || moduleId === '') throw new Error(label + ' contains an invalid module id');
      if (!allowedModules.has(moduleId)) throw new Error(label + ' contains an unknown module id');
    }
  }

  function requireFiniteNonNegativeNumber(value, label) {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) throw new Error(label + ' must be a finite non-negative number');
    return number;
  }

  function requireSafeNonNegativeInteger(value, label) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || !Number.isSafeInteger(value)) {
      throw new Error(label + ' must be a safe non-negative integer');
    }
    return value;
  }

  function requireArrayField(container, key, label) {
    if (!isPlainObject(container) || !hasOwn(container, key)) throw new Error(label + ' is required');
    if (!Array.isArray(container[key])) throw new Error(label + ' must be an array');
    return container[key];
  }

  function requireNonEmptyString(value, label) {
    if (typeof value !== 'string' || value === '') throw new Error(label + ' must be a non-empty string');
    return value;
  }

  function requireStringOrNull(value, label) {
    if (value !== null && typeof value !== 'string') throw new Error(label + ' must be a string or null');
    return value;
  }

  function requireStringArray(value, label) {
    if (!Array.isArray(value)) throw new Error(label + ' must be an array');
    for (let index = 0; index < value.length; index += 1) {
      requireNonEmptyString(value[index], label + '[' + index + ']');
    }
    return value;
  }

  function requireBoolean(value, label) {
    if (typeof value !== 'boolean') throw new Error(label + ' must be a boolean');
    return value;
  }

  function requireExactFields(value, allowedFields, requiredFields, label) {
    if (!isPlainObject(value)) throw new Error(label + ' must be a plain object');
    const allowed = new Set(allowedFields);
    for (const field of requiredFields) {
      if (!hasOwn(value, field)) throw new Error(label + '.' + field + ' is required');
    }
    for (const field of Object.keys(value)) {
      if (!allowed.has(field)) throw new Error(label + ' contains unknown field: ' + field);
    }
  }

  function optionalIntegerLimit(limits, key, fallback) {
    if (!hasOwn(limits, key)) return fallback;
    return requireSafeNonNegativeInteger(limits[key], 'limits.' + key);
  }

  function validateEnvelopeModules(value, allowedModules, label) {
    if (!Array.isArray(value)) throw new Error(label + ' must be an array');
    assertModuleIdsAllowed(value, allowedModules, label);
    return value;
  }

  function validateScopePayload(scope, allowedModules, label) {
    label = label || 'scope';
    requireExactFields(
      scope,
      ['modules', 'includeAttachments', 'includeSettings'],
      ['modules', 'includeAttachments', 'includeSettings'],
      label
    );
    validateEnvelopeModules(scope.modules, allowedModules, label + '.modules');
    requireBoolean(scope.includeAttachments, label + '.includeAttachments');
    requireBoolean(scope.includeSettings, label + '.includeSettings');
  }

  function requireScopeModuleId(moduleId, scopeModules, allowedModules, label) {
    requireNonEmptyString(moduleId, label);
    if (!allowedModules.has(moduleId)) throw new Error(label + ' must be present in limits.allowedModules');
    if (!scopeModules.has(moduleId)) throw new Error(label + ' must be present in manifest.scope.modules');
    return moduleId;
  }

  function validateManifestModuleSummary(summary, index, scopeModules, allowedModules) {
    const label = 'manifest.modules[' + index + ']';
    requireExactFields(
      summary,
      ['id', 'recordCount', 'tombstoneCount', 'attachmentCount', 'attachmentBytes', 'bytes'],
      ['id', 'recordCount', 'tombstoneCount', 'attachmentCount', 'attachmentBytes', 'bytes'],
      label
    );
    requireScopeModuleId(summary.id, scopeModules, allowedModules, label + '.id');
    requireSafeNonNegativeInteger(summary.recordCount, label + '.recordCount');
    requireSafeNonNegativeInteger(summary.tombstoneCount, label + '.tombstoneCount');
    requireSafeNonNegativeInteger(summary.attachmentCount, label + '.attachmentCount');
    requireSafeNonNegativeInteger(summary.attachmentBytes, label + '.attachmentBytes');
    requireSafeNonNegativeInteger(summary.bytes, label + '.bytes');
  }

  function validateManifestVector(vector, label) {
    if (!isPlainObject(vector)) throw new Error(label + ' must be a plain object');
    for (const deviceId of Object.keys(vector)) {
      requireNonEmptyString(deviceId, label + ' device id');
      requireSafeNonNegativeInteger(vector[deviceId], label + '.' + deviceId);
    }
  }

  function requireSha256Hash(value, label) {
    if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
      throw new Error(label + ' must be a lowercase SHA-256 hash');
    }
  }

  function validateManifestIdentityEntry(entry, label, scopeModules, allowedModules, isRecord) {
    const identityFields = ['id', 'parentId', 'moduleId', 'pathSegments', 'vector', 'deleted', 'size'];
    const fields = isRecord
      ? identityFields.concat(['contentHash', 'attachmentCount', 'attachmentBytes'])
      : identityFields;
    requireExactFields(entry, fields, fields, label);
    requireNonEmptyString(entry.id, label + '.id');
    requireStringOrNull(entry.parentId, label + '.parentId');
    const pathSegments = requireStringArray(entry.pathSegments, label + '.pathSegments');
    if (pathSegments[0] !== 'modules') throw new Error(label + '.pathSegments must begin with modules');
    if (pathSegments.length < 3) throw new Error(label + '.pathSegments must include a module collection path');
    const pathModuleId = requireNonEmptyString(pathSegments[1], label + '.pathSegments[1]');
    if (entry.moduleId == null) throw new Error(label + '.moduleId is required');
    const moduleId = requireNonEmptyString(entry.moduleId, label + '.moduleId');
    if (moduleId !== pathModuleId) throw new Error(label + '.moduleId must match pathSegments[1]');
    requireScopeModuleId(moduleId, scopeModules, allowedModules, label + '.moduleId');
    validateManifestVector(entry.vector, label + '.vector');
    requireBoolean(entry.deleted, label + '.deleted');
    requireSafeNonNegativeInteger(entry.size, label + '.size');
    if (isRecord) {
      if (entry.deleted !== false) throw new Error(label + '.deleted must be false');
      requireSha256Hash(entry.contentHash, label + '.contentHash');
      requireSafeNonNegativeInteger(entry.attachmentCount, label + '.attachmentCount');
      requireSafeNonNegativeInteger(entry.attachmentBytes, label + '.attachmentBytes');
    } else if (entry.deleted !== true) {
      throw new Error(label + '.deleted must be true');
    }
  }

  function validateManifestAttachmentEntry(attachment, index, scopeModules, allowedModules) {
    const label = 'manifest.attachments[' + index + ']';
    const fields = ['fileId', 'name', 'type', 'size', 'kind', 'recordId', 'parentId', 'moduleId', 'pathSegments'];
    requireExactFields(attachment, fields, fields, label);
    requireNonEmptyString(attachment.fileId, label + '.fileId');
    requireStringOrNull(attachment.name, label + '.name');
    requireStringOrNull(attachment.type, label + '.type');
    requireStringOrNull(attachment.kind, label + '.kind');
    requireNonEmptyString(attachment.recordId, label + '.recordId');
    requireSafeNonNegativeInteger(attachment.size, label + '.size');
    const pathSegments = requireStringArray(attachment.pathSegments, label + '.pathSegments');
    if (pathSegments[0] !== 'modules') throw new Error(label + '.pathSegments must begin with modules');
    if (pathSegments.length < 3) throw new Error(label + '.pathSegments must include a module collection path');
    const pathModuleId = requireNonEmptyString(pathSegments[1], label + '.pathSegments[1]');
    if (attachment.moduleId == null) throw new Error(label + '.moduleId is required');
    const moduleId = requireNonEmptyString(attachment.moduleId, label + '.moduleId');
    if (moduleId !== pathModuleId) throw new Error(label + '.moduleId must match pathSegments[1]');
    requireScopeModuleId(moduleId, scopeModules, allowedModules, label + '.moduleId');
    requireStringOrNull(attachment.parentId, label + '.parentId');
  }

  function validateManifestPayload(manifest, limits) {
    requireExactFields(
      manifest,
      ['protocol', 'scope', 'modules', 'records', 'tombstones', 'attachments', 'settings'],
      ['protocol', 'scope', 'modules', 'records', 'tombstones', 'attachments'],
      'manifest'
    );
    if (manifest.protocol !== 2) throw new Error('manifest must use protocol 2');
    const allowedModules = limits && limits.allowedModules instanceof Set
      ? limits.allowedModules
      : new Set(Array.isArray(limits && limits.allowedModules) ? limits.allowedModules : []);
    validateScopePayload(manifest.scope, allowedModules, 'manifest.scope');
    const scopeModules = manifest.scope.modules;
    const scopeModuleSet = new Set();
    for (const moduleId of scopeModules) {
      if (scopeModuleSet.has(moduleId)) throw new Error('manifest.scope.modules contains duplicate module id: ' + moduleId);
      scopeModuleSet.add(moduleId);
    }
    const moduleSummaries = requireArrayField(manifest, 'modules', 'manifest.modules');
    const moduleSummaryMap = new Map();
    for (let index = 0; index < moduleSummaries.length; index += 1) {
      const summary = moduleSummaries[index];
      if (isPlainObject(summary) && typeof summary.id === 'string' && !scopeModuleSet.has(summary.id)) {
        throw new Error('manifest.modules contains extra module id: ' + summary.id);
      }
      validateManifestModuleSummary(summary, index, scopeModuleSet, allowedModules);
      if (moduleSummaryMap.has(summary.id)) {
        throw new Error('manifest.modules contains duplicate module id: ' + summary.id);
      }
      moduleSummaryMap.set(summary.id, summary);
    }
    for (const moduleId of scopeModules) {
      if (!moduleSummaryMap.has(moduleId)) throw new Error('manifest.modules is missing module id: ' + moduleId);
    }
    const manifestBytes = serializedSize(manifest);
    if (manifestBytes > requireFiniteNonNegativeNumber(limits.maxManifestBytes, 'max manifest bytes')) {
      throw new Error('manifest bytes exceed limit');
    }
    const attachments = requireArrayField(manifest, 'attachments', 'manifest.attachments');
    if (!manifest.scope.includeAttachments && attachments.length !== 0) {
      throw new Error('manifest.scope.includeAttachments false requires attachments to be empty');
    }
    if (attachments.length > requireFiniteNonNegativeNumber(limits.maxAttachmentCount, 'max attachment count')) {
      throw new Error('attachment count exceeds limit');
    }
    let attachmentBytes = 0;
    for (let index = 0; index < attachments.length; index += 1) {
      const attachment = attachments[index];
      validateManifestAttachmentEntry(attachment, index, scopeModuleSet, allowedModules);
      attachmentBytes += attachment.size;
    }
    if (attachmentBytes > requireFiniteNonNegativeNumber(limits.maxAttachmentBytes, 'max attachment bytes')) {
      throw new Error('attachment bytes exceed limit');
    }
    const records = requireArrayField(manifest, 'records', 'manifest.records');
    const tombstones = requireArrayField(manifest, 'tombstones', 'manifest.tombstones');
    for (let index = 0; index < records.length; index += 1) {
      validateManifestIdentityEntry(records[index], 'manifest.records[' + index + ']', scopeModuleSet, allowedModules, true);
    }
    for (let index = 0; index < tombstones.length; index += 1) {
      validateManifestIdentityEntry(tombstones[index], 'manifest.tombstones[' + index + ']', scopeModuleSet, allowedModules, false);
    }
    const recordIdentityMap = new Map();
    for (const record of records) {
      const key = entityKey(record.pathSegments, record.parentId, record.id);
      if (recordIdentityMap.has(key)) throw new Error('duplicate record identity: ' + record.id);
      recordIdentityMap.set(key, record);
    }
    const tombstoneIdentityMap = new Map();
    for (const tombstone of tombstones) {
      const key = entityKey(tombstone.pathSegments, tombstone.parentId, tombstone.id);
      if (tombstoneIdentityMap.has(key)) throw new Error('duplicate tombstone identity: ' + tombstone.id);
      tombstoneIdentityMap.set(key, tombstone);
    }
    for (const [key, tombstone] of tombstoneIdentityMap) {
      if (recordIdentityMap.has(key)) {
        throw new Error('record and tombstone identity conflict: ' + tombstone.id);
      }
    }
    if (!manifest.scope.includeAttachments) {
      for (const summary of moduleSummaries) {
        if (summary.attachmentCount !== 0 || summary.attachmentBytes !== 0) {
          throw new Error('manifest.scope.includeAttachments false requires module attachmentCount and attachmentBytes to be zero');
        }
      }
      for (const record of records) {
        if (record.attachmentCount !== 0 || record.attachmentBytes !== 0) {
          throw new Error('manifest.scope.includeAttachments false requires record attachmentCount and attachmentBytes to be zero');
        }
      }
    }
    const recordAttachmentSummaries = new Map(
      Array.from(recordIdentityMap.keys(), key => [key, { attachmentCount: 0, attachmentBytes: 0 }])
    );
    const attachmentIdentities = new Set();
    for (const attachment of attachments) {
      const recordKey = entityKey(attachment.pathSegments, attachment.parentId, attachment.recordId);
      if (tombstoneIdentityMap.has(recordKey)) {
        throw new Error('attachment references tombstone: ' + attachment.recordId);
      }
      if (!recordIdentityMap.has(recordKey)) {
        throw new Error('attachment must reference live record: ' + attachment.recordId);
      }
      const attachmentKey = JSON.stringify([recordKey, attachment.fileId]);
      if (attachmentIdentities.has(attachmentKey)) {
        throw new Error('duplicate attachment identity: ' + attachment.fileId);
      }
      attachmentIdentities.add(attachmentKey);
      const summary = recordAttachmentSummaries.get(recordKey);
      summary.attachmentCount += 1;
      summary.attachmentBytes += attachment.size;
    }
    for (const [key, record] of recordIdentityMap) {
      const actual = recordAttachmentSummaries.get(key);
      if (record.attachmentCount !== actual.attachmentCount) {
        throw new Error('record ' + record.id + ' attachmentCount does not match manifest.attachments');
      }
      if (record.attachmentBytes !== actual.attachmentBytes) {
        throw new Error('record ' + record.id + ' attachmentBytes does not match manifest.attachments');
      }
    }
    const actualSummaries = new Map(
      scopeModules.map(moduleId => [moduleId, {
        recordCount: 0,
        tombstoneCount: 0,
        attachmentCount: 0,
        attachmentBytes: 0,
        bytes: 0
      }])
    );
    for (const record of records) {
      const actual = actualSummaries.get(record.moduleId);
      actual.recordCount += 1;
      actual.bytes += record.size;
    }
    for (const tombstone of tombstones) {
      actualSummaries.get(tombstone.moduleId).tombstoneCount += 1;
    }
    for (const attachment of attachments) {
      const actual = actualSummaries.get(attachment.moduleId);
      actual.attachmentCount += 1;
      actual.attachmentBytes += attachment.size;
    }
    const summaryFields = ['recordCount', 'tombstoneCount', 'attachmentCount', 'attachmentBytes', 'bytes'];
    for (const moduleId of scopeModules) {
      const summary = moduleSummaryMap.get(moduleId);
      const actual = actualSummaries.get(moduleId);
      for (const field of summaryFields) {
        if (summary[field] !== actual[field]) {
          throw new Error('manifest.modules summary for ' + moduleId + '.' + field + ' does not match manifest collections');
        }
      }
    }
    const totalAttachmentCount = moduleSummaries.reduce((sum, summary) => sum + summary.attachmentCount, 0);
    const totalAttachmentBytes = moduleSummaries.reduce((sum, summary) => sum + summary.attachmentBytes, 0);
    if (totalAttachmentCount !== attachments.length) {
      throw new Error('manifest.modules total attachmentCount does not match manifest.attachments');
    }
    if (totalAttachmentBytes !== attachmentBytes) {
      throw new Error('manifest.modules total attachmentBytes does not match manifest.attachments');
    }
    if (manifest.scope.includeSettings) {
      if (!hasOwn(manifest, 'settings')) throw new Error('manifest.settings is required when includeSettings is true');
      requireExactFields(
        manifest.settings,
        ['contentHash', 'size'],
        ['contentHash', 'size'],
        'manifest.settings'
      );
      requireSha256Hash(manifest.settings.contentHash, 'manifest.settings.contentHash');
      requireSafeNonNegativeInteger(manifest.settings.size, 'manifest.settings.size');
    } else if (hasOwn(manifest, 'settings')) {
      throw new Error('manifest.scope.includeSettings false requires settings to be absent');
    }
  }

  function validateChunkPayload(envelope, limits) {
    requireExactFields(
      envelope,
      ['protocol', 'type', 'chunk'],
      ['protocol', 'type', 'chunk'],
      'data-chunk'
    );
    const chunk = envelope.chunk;
    requireExactFields(chunk, ['index', 'total', 'payload'], ['index', 'total', 'payload'], 'chunk');
    const index = requireSafeNonNegativeInteger(chunk.index, 'chunk index');
    const total = requireSafeNonNegativeInteger(chunk.total, 'chunk total');
    if (total <= 0) throw new Error('chunk total must be a positive integer');
    if (total > optionalIntegerLimit(limits, 'maxChunkCount', Number.MAX_SAFE_INTEGER)) {
      throw new Error('chunk total exceeds limit');
    }
    if (index >= total) throw new Error('chunk index must be smaller than chunk total');
    const payload = chunk.payload;
    if (typeof payload !== 'string') throw new Error('chunk payload must be a string');
    if (byteLengthOfText(payload) > requireFiniteNonNegativeNumber(limits.maxChunkBytes, 'max chunk bytes')) {
      throw new Error('chunk payload exceeds limit');
    }
    const seenChunkIndexes = limits && limits.seenChunkIndexes instanceof Set ? limits.seenChunkIndexes : new Set();
    if (seenChunkIndexes.has(index)) throw new Error('duplicate chunk index');
    seenChunkIndexes.add(index);
  }

  function validateTransferCounts(envelope, limits, includeAttachments) {
    const maxChunkCount = optionalIntegerLimit(limits, 'maxChunkCount', Number.MAX_SAFE_INTEGER);
    const maxTransferBytes = optionalIntegerLimit(limits, 'maxTransferBytes', Number.MAX_SAFE_INTEGER);
    const totalChunks = requireSafeNonNegativeInteger(envelope.totalChunks, envelope.type + '.totalChunks');
    const totalBytes = requireSafeNonNegativeInteger(envelope.totalBytes, envelope.type + '.totalBytes');
    if (totalChunks === 0 || totalChunks > maxChunkCount) {
      throw new Error(envelope.type + '.totalChunks exceeds limit');
    }
    if (totalBytes > maxTransferBytes) throw new Error(envelope.type + '.totalBytes exceeds limit');
    if (!includeAttachments) return;

    const attachmentCount = requireSafeNonNegativeInteger(
      envelope.attachmentCount,
      envelope.type + '.attachmentCount'
    );
    const attachmentBytes = requireSafeNonNegativeInteger(
      envelope.attachmentBytes,
      envelope.type + '.attachmentBytes'
    );
    if (attachmentCount > requireSafeNonNegativeInteger(limits.maxAttachmentCount, 'max attachment count')) {
      throw new Error(envelope.type + '.attachmentCount exceeds limit');
    }
    if (attachmentBytes > requireSafeNonNegativeInteger(limits.maxAttachmentBytes, 'max attachment bytes')) {
      throw new Error(envelope.type + '.attachmentBytes exceeds limit');
    }
  }

  function validateControlEnvelope(envelope, limits) {
    const allowedModules = limits.allowedModules instanceof Set
      ? limits.allowedModules
      : new Set(Array.isArray(limits.allowedModules) ? limits.allowedModules : []);

    if (envelope.type === 'scope-offer' || envelope.type === 'manifest-request') {
      requireExactFields(envelope, ['protocol', 'type', 'scope'], ['protocol', 'type', 'scope'], envelope.type);
      validateScopePayload(envelope.scope, allowedModules);
    } else if (envelope.type === 'plan-selection') {
      requireExactFields(
        envelope,
        ['protocol', 'type', 'operationIds'],
        ['protocol', 'type', 'operationIds'],
        envelope.type
      );
      const operationIds = requireArrayField(envelope, 'operationIds', 'operationIds');
      if (operationIds.length > optionalIntegerLimit(limits, 'maxOperationCount', Number.MAX_SAFE_INTEGER)) {
        throw new Error('plan-selection.operationIds exceeds limit');
      }
      const seen = new Set();
      for (let index = 0; index < operationIds.length; index += 1) {
        const operationId = requireNonEmptyString(operationIds[index], 'operationIds[' + index + ']');
        if (seen.has(operationId)) throw new Error('operationIds contains duplicate values');
        seen.add(operationId);
      }
    } else if (envelope.type === 'data-start') {
      requireExactFields(
        envelope,
        ['protocol', 'type', 'transferId', 'modules', 'totalChunks', 'totalBytes', 'attachmentCount', 'attachmentBytes'],
        ['protocol', 'type', 'transferId', 'modules', 'totalChunks', 'totalBytes', 'attachmentCount', 'attachmentBytes'],
        envelope.type
      );
      requireNonEmptyString(envelope.transferId, 'data-start.transferId');
      validateEnvelopeModules(envelope.modules, allowedModules, 'data-start.modules');
      validateTransferCounts(envelope, limits, true);
    } else if (envelope.type === 'data-end') {
      requireExactFields(
        envelope,
        ['protocol', 'type', 'transferId', 'totalChunks', 'totalBytes'],
        ['protocol', 'type', 'transferId', 'totalChunks', 'totalBytes'],
        envelope.type
      );
      requireNonEmptyString(envelope.transferId, 'data-end.transferId');
      validateTransferCounts(envelope, limits, false);
    } else if (envelope.type === 'commit-result') {
      requireExactFields(
        envelope,
        ['protocol', 'type', 'transferId', 'ok'],
        ['protocol', 'type', 'transferId', 'ok'],
        envelope.type
      );
      requireNonEmptyString(envelope.transferId, 'commit-result.transferId');
      requireBoolean(envelope.ok, 'commit-result.ok');
    } else if (envelope.type === 'abort') {
      requireExactFields(envelope, ['protocol', 'type', 'reason'], ['protocol', 'type', 'reason'], envelope.type);
      requireNonEmptyString(envelope.reason, 'abort.reason');
    }

    const maxEnvelopeBytes = optionalIntegerLimit(
      limits,
      'maxEnvelopeBytes',
      requireSafeNonNegativeInteger(limits.maxManifestBytes, 'max manifest bytes')
    );
    if (serializedSize(envelope) > maxEnvelopeBytes) throw new Error('envelope bytes exceed limit');
  }

  function validateEnvelope(envelope, limits) {
    if (!isPlainObject(envelope)) throw new Error('envelope must be a plain object');
    assertSafeEnvelopeGraph(envelope, 'envelope');
    if (envelope.protocol !== 2) throw new Error('envelope must use protocol 2');
    if (!KNOWN_ENVELOPE_TYPES.has(envelope.type)) throw new Error('unknown type: ' + envelope.type);
    if (!isObject(limits)) throw new TypeError('limits must be a plain object');

    if (envelope.type === 'manifest') {
      requireExactFields(envelope, ['protocol', 'type', 'manifest'], ['protocol', 'type', 'manifest'], 'manifest');
      validateManifestPayload(envelope.manifest, limits);
    }
    else if (envelope.type === 'data-chunk') validateChunkPayload(envelope, limits);
    else validateControlEnvelope(envelope, limits);
    return true;
  }

  async function hashBlob(value) {
    let bytes = null;
    if (typeof Buffer !== 'undefined' && Buffer.isBuffer && Buffer.isBuffer(value)) {
      bytes = value;
    } else if (typeof Blob !== 'undefined' && value instanceof Blob) {
      bytes = new Uint8Array(await value.arrayBuffer());
    } else if (isArrayBufferLike(value)) {
      bytes = new Uint8Array(value);
    } else if (
      (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView && ArrayBuffer.isView(value)) ||
      isArrayBufferViewLike(value)
    ) {
      bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }
    if (!bytes) throw new TypeError('Unsupported blob value');
    return digestBytes(bytes);
  }

  return {
    compareVectors: compareVectors,
    migrateState: migrateState,
    hashRecord: hashRecord,
    stampChanges: stampChanges,
    buildManifest: buildManifest,
    buildMergePlan: buildMergePlan,
    applyMergePlan: applyMergePlan,
    validateEnvelope: validateEnvelope,
    hashBlob: hashBlob
  };
});
