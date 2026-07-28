(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.PersonalHubRecoveryCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const OMIT = {};

  function isObject(value) {
    return value !== null && typeof value === 'object';
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

  function isBinary(value) {
    if (typeof Blob !== 'undefined' && value instanceof Blob) return true;
    if (typeof ArrayBuffer !== 'undefined') {
      if (value instanceof ArrayBuffer) return true;
      if (ArrayBuffer.isView && ArrayBuffer.isView(value)) return true;
    }
    return false;
  }

  function cloneJson(value, seen) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'bigint') throw new TypeError('Recovery state must be JSON-compatible');
    if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return OMIT;
    if (isBinary(value)) return OMIT;
    if (!isObject(value)) return value;

    const ancestors = seen || new Set();
    if (ancestors.has(value)) throw new TypeError('Recovery state must not contain cycles');
    ancestors.add(value);

    let clone;
    if (Array.isArray(value)) {
      clone = value.map(item => {
        const next = cloneJson(item, ancestors);
        return next === OMIT ? null : next;
      });
    } else if (value instanceof Date) {
      clone = value.toJSON();
    } else {
      clone = {};
      for (const key of Object.keys(value)) {
        const next = cloneJson(value[key], ancestors);
        if (next !== OMIT) defineOwn(clone, key, next);
      }
    }

    ancestors.delete(value);
    return clone;
  }

  function clone(value) {
    const result = cloneJson(value);
    return result === OMIT ? undefined : result;
  }

  function normalizeOptions(options) {
    return isObject(options) && !Array.isArray(options) ? options : {};
  }

  function normalizeFileIds(value) {
    if (!Array.isArray(value)) return [];
    return [...new Set(value.filter(fileId => typeof fileId === 'string' && fileId !== ''))];
  }

  function createRecoveryPoint(state, metadata) {
    const details = normalizeOptions(metadata);
    const createdAt = hasOwn(details, 'createdAt') ? details.createdAt : Date.now();
    const id = hasOwn(details, 'id') ? details.id : 'recovery-' + String(createdAt);
    const point = { id: id, createdAt: createdAt };
    for (const key of Object.keys(details)) {
      if (key === 'id' || key === 'createdAt' || key === 'state') continue;
      const value = clone(details[key]);
      if (value !== undefined) defineOwn(point, key, value);
    }
    point.state = clone(state);
    return point;
  }

  function timeValue(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function retain(points, limit) {
    const count = Number.isSafeInteger(limit) && limit >= 0 ? limit : 3;
    if (!Array.isArray(points) || count === 0) return [];
    return points
      .map((point, index) => ({ point: point, index: index }))
      .sort((left, right) =>
        timeValue(right.point && right.point.createdAt) - timeValue(left.point && left.point.createdAt) ||
        right.index - left.index
      )
      .slice(0, count)
      .map(entry => clone(entry.point));
  }

  function collectFrom(value, fileIds, seen) {
    if (!isObject(value) || seen.has(value)) return;
    seen.add(value);
    if (hasOwn(value, 'fileId') && typeof value.fileId === 'string' && value.fileId !== '') {
      fileIds.add(value.fileId);
    }
    for (const key of Object.keys(value)) collectFrom(value[key], fileIds, seen);
  }

  function collectReferencedFileIds(state, recoveryPoints) {
    const fileIds = new Set();
    collectFrom(state, fileIds, new Set());
    for (const point of retain(recoveryPoints, 3)) {
      collectFrom(point && point.state, fileIds, new Set());
    }
    return fileIds;
  }

  function tombstone(moduleId, pathSegments, parentId, record) {
    return {
      id: record && typeof record.id === 'string' ? record.id : null,
      path: pathSegments.join('.'),
      pathSegments: pathSegments.slice(),
      moduleId: moduleId,
      parentId: parentId == null ? null : parentId
    };
  }

  function cleanupResult(state, options, recoveryPoints) {
    const selection = normalizeOptions(options);
    const next = clone(state);
    const tombstones = [];
    const stats = { completed: 0, archived: 0, records: 0, removedFileCandidates: 0 };
    const modules = isObject(next) && isObject(next.modules) ? next.modules : {};

    for (const moduleId of Object.keys(modules)) {
      const module = modules[moduleId];
      if (!module || !Array.isArray(module.items)) continue;
      module.items = module.items.filter(record => {
        let category = null;
        if (selection.completed === true && record && record.done === true) category = 'completed';
        else if (selection.archived === true && record && record.archived === true) category = 'archived';
        if (!category) return true;
        stats[category] += 1;
        stats.records += 1;
        tombstones.push(tombstone(moduleId, ['modules', moduleId, 'items'], null, record));
        return false;
      });
    }

    const referenced = collectReferencedFileIds(next, recoveryPoints);
    const removedFileCandidates = normalizeFileIds(selection.fileIds).filter(fileId => !referenced.has(fileId));
    stats.removedFileCandidates = removedFileCandidates.length;
    return { state: next, tombstones: tombstones, removedFileCandidates: removedFileCandidates, stats: stats };
  }

  function previewCleanup(state, options, recoveryPoints) {
    return cleanupResult(state, options, recoveryPoints).stats;
  }

  function applyCleanup(state, options, recoveryPoints) {
    return cleanupResult(state, options, recoveryPoints);
  }

  function collectRecordTombstones(moduleId, module) {
    const result = [];
    const seen = new Set();

    function visit(value, path, parentId) {
      if (!isObject(value) || seen.has(value)) return;
      seen.add(value);
      const hasId = !Array.isArray(value) && hasOwn(value, 'id') && typeof value.id === 'string' && value.id !== '';
      const nextParentId = hasId ? value.id : parentId;
      if (hasId) {
        result.push(tombstone(moduleId, path, parentId, value));
      }
      if (Array.isArray(value)) {
        for (let index = 0; index < value.length; index += 1) {
          visit(value[index], path, parentId);
        }
      } else {
        for (const key of Object.keys(value)) {
          if (key !== '_sync') visit(value[key], path.concat(key), nextParentId);
        }
      }
    }

    if (module && Array.isArray(module.items)) visit(module.items, ['modules', moduleId, 'items'], null);
    return result;
  }

  function replaceTopLevel(target, initial, key) {
    if (isObject(initial) && hasOwn(initial, key)) defineOwn(target, key, clone(initial[key]));
    else delete target[key];
  }

  function resetResult(state, initialState, options, recoveryPoints) {
    const selection = normalizeOptions(options);
    const source = isObject(state) ? state : {};
    const initial = isObject(initialState) ? initialState : {};
    const full = selection.fullLocalData === true;
    const next = full ? clone(initial) : clone(source);
    const tombstones = [];
    const selectedModules = full
      ? Object.keys(isObject(source.modules) ? source.modules : {})
      : [...new Set(Array.isArray(selection.modules) ? selection.modules.filter(id => typeof id === 'string') : [])];
    let records = 0;

    for (const moduleId of selectedModules) {
      const oldModule = isObject(source.modules) ? source.modules[moduleId] : undefined;
      const removed = collectRecordTombstones(moduleId, oldModule);
      records += removed.length;
      tombstones.push(...removed);
      if (full) continue;
      if (!isObject(next.modules)) next.modules = {};
      if (isObject(initial.modules) && hasOwn(initial.modules, moduleId)) {
        defineOwn(next.modules, moduleId, clone(initial.modules[moduleId]));
      } else {
        delete next.modules[moduleId];
      }
    }

    if (!full && selection.appearance === true) replaceTopLevel(next, initial, 'settings');
    if (!full && selection.dashboardLayout === true) replaceTopLevel(next, initial, 'dashWidgets');
    if (!full && selection.syncDevices === true) {
      replaceTopLevel(next, initial, 'syncDevices');
      replaceTopLevel(next, initial, '_sync');
    }

    const referenced = collectReferencedFileIds(next, recoveryPoints);
    const removedFileCandidates = normalizeFileIds(selection.fileIds).filter(fileId => !referenced.has(fileId));
    const stats = {
      destructive: full,
      modules: selectedModules.length,
      records: records,
      appearance: full || selection.appearance === true ? 1 : 0,
      dashboardLayout: full || selection.dashboardLayout === true ? 1 : 0,
      syncDevices: full || selection.syncDevices === true ? 1 : 0,
      removedFileCandidates: removedFileCandidates.length
    };
    return { state: next, tombstones: tombstones, removedFileCandidates: removedFileCandidates, stats: stats };
  }

  function previewReset(state, initialState, options, recoveryPoints) {
    return resetResult(state, initialState, options, recoveryPoints).stats;
  }

  function applyReset(state, initialState, options, recoveryPoints) {
    return resetResult(state, initialState, options, recoveryPoints);
  }

  return {
    createRecoveryPoint: createRecoveryPoint,
    retain: retain,
    previewCleanup: previewCleanup,
    applyCleanup: applyCleanup,
    previewReset: previewReset,
    applyReset: applyReset,
    collectReferencedFileIds: collectReferencedFileIds
  };
});
