# Personal Hub Reliable Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add reliable selective device sync, short-code signaling, camera permission guidance, gallery QR decoding, and reversible reset flows without removing or changing unrelated Personal Hub features.

**Architecture:** Keep `versions/v1-local-first/` as the editable source and mechanically mirror publishable files into `site/`. Add small UMD-style pure libraries for version/merge and recovery logic, then adapt the existing monolithic page at its storage and sync boundaries. Preserve the current compressed SDP flow as an offline fallback while adding an optional Cloudflare Worker/Durable Object signaling path.

**Tech Stack:** Static HTML/CSS/JavaScript, IndexedDB, WebRTC DataChannel, WebSocket, Cloudflare Workers and Durable Objects, Node.js built-in test runner, Playwright, existing local QR/LZ libraries.

---

## Compatibility Contract

- Keep all existing modules, fields, local IndexedDB database name, import/export behavior, themes, search, archive, attachments, handwriting, and long pairing codes.
- Continue accepting existing `v1-local-first` backups and records without sync metadata.
- New metadata must remain internal and must not alter visible record content.
- Short-code signaling is optional. Its failure must reveal the existing offline pairing flow.
- Edit source files first, then mirror only the changed publishable files to `site/` with `Copy-Item`.

## File Map

- Create `versions/v1-local-first/sync-core.js`: pure version-vector, migration, manifest, merge-plan, and merge-application functions.
- Create `versions/v1-local-first/recovery-core.js`: pure recovery-point retention, cleanup preview, reset preview, and reset application functions.
- Create `versions/v1-local-first/signaling-client.js`: browser client for Cloudflare room creation/join and signal relay.
- Modify `versions/v1-local-first/index.html`: storage integration and new UI flows only.
- Modify `versions/v1-local-first/sw.js`: cache the new local scripts and increment cache version.
- Mirror those four files into `site/`.
- Create `test-tools/sync-core.test.js`, `test-tools/recovery-core.test.js`, `test-tools/verify-sync-v2.js`, and `test-tools/verify-safety-flows.js`.
- Modify `test-tools/package.json`: expose focused test commands.
- Create `cloudflare-signaling/src/room-code.js`, `cloudflare-signaling/src/index.js`, `cloudflare-signaling/test/room-code.test.js`, `cloudflare-signaling/package.json`, and `cloudflare-signaling/wrangler.jsonc`.
- Create `cloudflare-signaling/package-lock.json` through `npm install`.
- Modify `README.md` and `OPTIMIZATION_NOTES.md` after behavior is verified.

### Task 1: Lock Existing Behavior as the Regression Baseline

**Files:**
- Modify: `test-tools/verify-sync.js`

- [ ] **Step 1: Make the existing sync test use isolated browser contexts**

Replace the shared-page setup with separate contexts so IndexedDB cannot make a failed transfer appear successful:

```js
const senderContext = await browser.newContext();
const receiverContext = await browser.newContext();
const sender = await senderContext.newPage();
const receiver = await receiverContext.newPage();
```

- [ ] **Step 2: Assert the receiver does not contain the marker before transfer**

```js
const marker = `legacy-sync-${Date.now()}`;
await sender.locator('#f_txt').fill(marker);
if (await receiver.getByText(marker).count()) {
  throw new Error('isolated receiver unexpectedly contains sender data');
}
```

- [ ] **Step 3: Run the unchanged legacy flow**

Run:

```powershell
$env:PLAYWRIGHT_BROWSERS_PATH='F:\GitHub-Trending\10-Personal-Hub\test-tools\ms-playwright'
npm run verify:sync
```

Expected: PASS with `connected: true` and `transferred: true` using `ph1.` codes.

- [ ] **Step 4: Run all current checks**

Run:

```powershell
npm run scan
npm run verify
npm run audit
```

Expected: all commands exit 0 with no console errors and no horizontal overflow.

- [ ] **Step 5: Commit the strengthened baseline**

```powershell
git add test-tools/verify-sync.js
git commit -m "test: isolate legacy sync devices"
```

### Task 2: Build the Version and Migration Core with TDD

**Files:**
- Create: `test-tools/sync-core.test.js`
- Create: `versions/v1-local-first/sync-core.js`
- Modify: `test-tools/package.json`

- [ ] **Step 1: Write failing vector and migration tests**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const SyncCore = require('../versions/v1-local-first/sync-core.js');

test('compares dominating and concurrent vectors', () => {
  assert.equal(SyncCore.compareVectors({ a: 2 }, { a: 1 }), 'newer');
  assert.equal(SyncCore.compareVectors({ a: 1 }, { a: 2 }), 'older');
  assert.equal(SyncCore.compareVectors({ a: 1 }, { b: 1 }), 'concurrent');
  assert.equal(SyncCore.compareVectors({ a: 1 }, { a: 1 }), 'equal');
});

test('migrates legacy records without changing visible fields', async () => {
  const state = { modules: { todos: { items: [{ id: 'x', txt: 'keep me' }] } } };
  const migrated = await SyncCore.migrateState(state);
  assert.equal(migrated.modules.todos.items[0].txt, 'keep me');
  assert.deepEqual(migrated.modules.todos.items[0]._sync.vector, {});
  assert.match(migrated.modules.todos.items[0]._sync.contentHash, /^[a-f0-9]{64}$/);
});
```

- [ ] **Step 2: Verify the test fails because the module is missing**

Run: `node --test sync-core.test.js`

Expected: FAIL with `Cannot find module '../versions/v1-local-first/sync-core.js'`.

- [ ] **Step 3: Implement the minimal UMD API**

The module must export the same API to Node and the browser:

```js
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.PersonalHubSyncCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function compareVectors(left = {}, right = {}) {
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    let greater = false;
    let less = false;
    keys.forEach(key => {
      if ((left[key] || 0) > (right[key] || 0)) greater = true;
      if ((left[key] || 0) < (right[key] || 0)) less = true;
    });
    if (greater && less) return 'concurrent';
    if (greater) return 'newer';
    if (less) return 'older';
    return 'equal';
  }

  return { compareVectors, migrateState, hashRecord, stampChanges };
});
```

`hashRecord` must omit `_sync`, recursively sort object keys, and use SHA-256 through `crypto.subtle` in browsers or `node:crypto` in Node. `migrateState` must clone input, add `_sync` only to records with IDs, and leave all user-visible values unchanged. `stampChanges(current, previous, deviceId)` must increment only changed records and create tombstones for removed IDs.

- [ ] **Step 4: Run focused tests**

Run: `node --test sync-core.test.js`

Expected: PASS for vector comparison, legacy migration, stable hashes, changed records, unchanged records, and tombstones.

- [ ] **Step 5: Add the focused npm command**

Add this entry to `test-tools/package.json` scripts:

```json
"test:sync-core": "node --test sync-core.test.js"
```

- [ ] **Step 6: Commit the core**

```powershell
git add versions/v1-local-first/sync-core.js test-tools/sync-core.test.js test-tools/package.json
git commit -m "feat: add record version tracking core"
```

### Task 3: Add Manifest, Merge Planning, and Conflict Safety

**Files:**
- Modify: `test-tools/sync-core.test.js`
- Modify: `versions/v1-local-first/sync-core.js`

- [ ] **Step 1: Write failing merge-plan tests**

Add table-driven tests for `same`, `add`, `update`, `keep`, `conflict-copy`, `pending-delete`, and `delete-conflict`:

```js
test('builds a safe merge plan for every record relationship', async () => {
  const plan = await SyncCore.buildMergePlan(senderState, receiverState, {
    modules: ['todos'], includeAttachments: true, includeSettings: false
  });
  assert.deepEqual(plan.summary, {
    add: 1, update: 1, keep: 1, conflictCopy: 1,
    pendingDelete: 1, deleteConflict: 1, same: 1
  });
  assert.equal(plan.operations.find(x => x.id === 'deleted').selected, false);
});
```

- [ ] **Step 2: Verify the tests fail on missing planning functions**

Run: `node --test sync-core.test.js`

Expected: FAIL with `SyncCore.buildMergePlan is not a function`.

- [ ] **Step 3: Implement the pure planning API**

Expose these stable functions:

```js
return {
  compareVectors,
  migrateState,
  stampChanges,
  buildManifest,
  buildMergePlan,
  applyMergePlan,
  validateEnvelope,
  hashBlob
};
```

`applyMergePlan` must clone the receiver state, never mutate its argument, assign a new ID to conflict copies, preserve the receiver version, and merge vectors for identical records. `validateEnvelope` must reject unknown protocol versions, oversized manifests, invalid module IDs, duplicate chunk indexes, and attachment count/size limits.

- [ ] **Step 4: Run tests and verify immutability**

Run: `node --test sync-core.test.js`

Expected: PASS, including a deep equality assertion that the receiver fixture is unchanged after planning and application.

- [ ] **Step 5: Commit planning behavior**

```powershell
git add versions/v1-local-first/sync-core.js test-tools/sync-core.test.js
git commit -m "feat: plan safe selective merges"
```

### Task 4: Build Recovery and Selective Reset Logic with TDD

**Files:**
- Create: `test-tools/recovery-core.test.js`
- Create: `versions/v1-local-first/recovery-core.js`
- Modify: `test-tools/package.json`

- [ ] **Step 1: Write failing recovery tests**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const Recovery = require('../versions/v1-local-first/recovery-core.js');

test('keeps only the three newest recovery points', () => {
  const points = [1, 2, 3, 4].map(n => ({ id: String(n), createdAt: n }));
  assert.deepEqual(Recovery.retain(points, 3).map(x => x.id), ['4', '3', '2']);
});

test('daily cleanup removes only selected categories', () => {
  const result = Recovery.applyCleanup(fixture, { completed: true, archived: false });
  assert.equal(result.state.modules.todos.items.some(x => x.done), false);
  assert.equal(result.state.modules.todos.items.some(x => x.archived), true);
});
```

- [ ] **Step 2: Verify the tests fail because the module is missing**

Run: `node --test recovery-core.test.js`

Expected: FAIL with `Cannot find module '../versions/v1-local-first/recovery-core.js'`.

- [ ] **Step 3: Implement recovery and reset functions**

Expose:

```js
return {
  createRecoveryPoint,
  retain,
  previewCleanup,
  applyCleanup,
  previewReset,
  applyReset,
  collectReferencedFileIds
};
```

`applyReset` must support selected module IDs, appearance, dashboard layout, sync-device metadata, and full local data. It must return `{ state, tombstones, removedFileCandidates }` and must not delete Blob records directly.

- [ ] **Step 4: Run focused tests**

Run: `node --test recovery-core.test.js`

Expected: PASS for retention, selective cleanup, module reset, appearance reset, full reset preview, and referenced-Blob preservation.

- [ ] **Step 5: Add combined core test commands**

Add these entries to `test-tools/package.json` scripts:

```json
"test:recovery-core": "node --test recovery-core.test.js",
"test:core": "node --test sync-core.test.js recovery-core.test.js"
```

- [ ] **Step 6: Commit recovery logic**

```powershell
git add versions/v1-local-first/recovery-core.js test-tools/recovery-core.test.js
git commit -m "feat: add reversible cleanup and reset core"
```

### Task 5: Integrate Metadata and Recovery Stores Without Changing Existing Features

**Files:**
- Modify: `versions/v1-local-first/index.html:486-650`
- Modify: `versions/v1-local-first/sw.js`
- Create: `test-tools/verify-storage-v2.js`
- Modify: `test-tools/package.json`
- Create: `site/sync-core.js`
- Create: `site/recovery-core.js`
- Modify: `site/index.html`
- Modify: `site/sw.js`

- [ ] **Step 1: Write a failing browser storage test**

The test must load an unmodified legacy fixture, reload, and assert visible JSON equality after removing `_sync`; then assert IndexedDB contains `recovery` and `sync-meta` stores and no existing attachment was removed.

```js
const visible = value => JSON.parse(JSON.stringify(value, (key, item) => key === '_sync' ? undefined : item));
assert.deepEqual(visible(afterMigration), visible(legacyFixture));
```

- [ ] **Step 2: Run the test and verify the new stores are absent**

Add the command before running it:

```json
"verify:storage-v2": "node verify-storage-v2.js"
```

Run: `npm run verify:storage-v2`

Expected: FAIL because database version 2 has no `recovery` or `sync-meta` store.

- [ ] **Step 3: Integrate the pure libraries at storage boundaries**

Add scripts before the inline application script:

```html
<script src="sync-core.js"></script>
<script src="recovery-core.js"></script>
```

Bump `DB_VERSION` from 2 to 3 and create `recovery` and `sync-meta` stores in `onupgradeneeded`. During `hydrateState`, migrate state, load/create `deviceId`, and retain a deep-cloned persisted shadow. Before `saveNow`, export, or sync-manifest creation, call `stampChanges(state, persistedShadow, deviceId)` and persist the stamped state.

- [ ] **Step 4: Update offline caching and mirror publishable files**

Set a new cache name and include all local dependencies:

```js
const CACHE_NAME = 'personal-hub-v1-local-first-3';
const ASSETS = [
  './', './index.html', './manifest.json', './sync-core.js', './recovery-core.js',
  './vendor/qrcode.js', './vendor/jsQR.js', './vendor/lz-string.min.js'
];
```

Then run:

```powershell
Copy-Item versions/v1-local-first/index.html site/index.html
Copy-Item versions/v1-local-first/sw.js site/sw.js
Copy-Item versions/v1-local-first/sync-core.js site/sync-core.js
Copy-Item versions/v1-local-first/recovery-core.js site/recovery-core.js
```

- [ ] **Step 5: Run storage and existing regression tests**

Run:

```powershell
npm run verify:storage-v2
npm run scan
npm run verify
npm run audit
npm run verify:sync
```

Expected: all PASS; the legacy sync fallback remains functional.

- [ ] **Step 6: Commit integration**

```powershell
git add versions/v1-local-first site test-tools
git commit -m "feat: integrate sync metadata and recovery storage"
```

### Task 6: Add Selective Sync UI and Transactional Transfer

**Files:**
- Create: `test-tools/verify-sync-v2.js`
- Modify: `versions/v1-local-first/index.html:1451-1547`
- Modify: `site/index.html`
- Modify: `test-tools/package.json`

- [ ] **Step 1: Write a failing two-device selective sync test**

Use isolated contexts. Create a sender-only todo, conflicting diary edits with the same ID, and a receiver-only paper. Assert the UI supports sender selection, receiver deselection, all-select, summary counts, safe defaults, and undo.

```js
await sender.getByRole('button', { name: '选择同步内容' }).click();
await sender.getByRole('checkbox', { name: '待办事项' }).check();
await sender.getByRole('button', { name: '全部选择' }).click();
await receiver.getByRole('checkbox', { name: '文献总结' }).uncheck();
await receiver.getByRole('button', { name: '安全同步' }).click();
await receiver.getByText('已创建 1 条同步副本').waitFor();
```

- [ ] **Step 2: Verify the test fails on the missing selection controls**

Add this script entry first:

```json
"verify:sync-v2": "node verify-sync-v2.js"
```

Run: `npm run verify:sync-v2`

Expected: FAIL because `选择同步内容` is absent.

- [ ] **Step 3: Replace the one-shot backup message with a versioned protocol**

Keep existing `backup-*` handlers and add these message types:

```js
const SYNC_PROTOCOL = 2;
// scope-offer -> manifest-request -> manifest -> plan-selection
// data-start -> data-chunk -> data-end -> commit-result
// abort leaves the receiver state untouched
```

Add `renderSyncScope`, `renderSyncReview`, `sendSyncManifest`, `receiveSyncManifest`, `sendSelectedRecords`, `stageIncomingSync`, `commitIncomingSync`, and `undoLastOperation`. Use a single IndexedDB transaction across `kv`, `files`, `recovery`, and `sync-meta` for commit.

- [ ] **Step 4: Build the three-step UI in the existing modal**

The modal must show `连接设备`, `比较数据`, and `确认同步` states; sender and receiver selection lists; all-select/cancel-all; record and byte totals; safe/custom mode; progress; result summary; and undo. Existing long-code controls remain inside a collapsed `离线配对` section.

- [ ] **Step 5: Mirror and run focused tests**

```powershell
Copy-Item versions/v1-local-first/index.html site/index.html
npm run verify:sync-v2
npm run verify:sync
npm run audit
```

Expected: v2 selective sync and v1 fallback both PASS with no console errors.

- [ ] **Step 6: Commit selective sync**

```powershell
git add versions/v1-local-first/index.html site/index.html test-tools
git commit -m "feat: add selective transactional device sync"
```

### Task 7: Add Camera Guidance, Gallery QR, and Mature Reset Flows

**Files:**
- Create: `test-tools/verify-safety-flows.js`
- Modify: `versions/v1-local-first/index.html:1450-1547`
- Modify: `site/index.html`
- Modify: `test-tools/package.json`

- [ ] **Step 1: Write failing permission and reset tests**

Cover first-use explanation, remembered acknowledgement, denied permission guidance, fake-camera video dimensions, gallery QR decoding, daily cleanup selection, data reset selection, all-select, recovery creation, and undo.

```js
await page.getByRole('button', { name: '扫码填入对方码' }).click();
await page.getByText('相机画面只用于本机识别二维码').waitFor();
await page.getByRole('button', { name: '继续并请求权限' }).click();
await page.waitForFunction(() => document.querySelector('#qrVideo')?.videoWidth > 0);

await page.getByRole('button', { name: '打开重置中心' }).click();
await page.getByRole('tab', { name: '日常清理' }).click();
await page.getByRole('checkbox', { name: '已完成任务' }).check();
await page.getByRole('button', { name: '创建恢复点并清理' }).click();
```

- [ ] **Step 2: Run and observe the intended missing-control failures**

Add this script entry first:

```json
"verify:safety": "node verify-safety-flows.js"
```

Run: `npm run verify:safety`

Expected: FAIL on the missing permission explanation or reset-center controls.

- [ ] **Step 3: Implement camera and gallery fallbacks**

Add `requestQrCamera`, `showCameraPermissionGuide`, `showCameraDeniedHelp`, and `decodeQrImageFile`. Store only the acknowledgement flag in IndexedDB; never store camera permission state. Use the existing `jsQR` library for uploaded images and clear the file input after decoding.

- [ ] **Step 4: Implement two reset tabs with previews**

Change the existing sidebar reset button to open `openResetCenter`. Keep `resetToday` as a compatibility wrapper that opens the daily-cleanup tab. Display selected counts and require a second confirmation only for full local-data reset. Create a recovery point before applying either tab.

- [ ] **Step 5: Mirror and verify**

```powershell
Copy-Item versions/v1-local-first/index.html site/index.html
npm run verify:safety
npm run verify
npm run audit
```

Expected: PASS at desktop and phone dimensions with no overflow or console errors.

- [ ] **Step 6: Commit safety flows**

```powershell
git add versions/v1-local-first/index.html site/index.html test-tools
git commit -m "feat: add guided scanning and reversible reset flows"
```

### Task 8: Build the Ephemeral Cloudflare Signaling Service with TDD

**Files:**
- Create: `cloudflare-signaling/src/room-code.js`
- Create: `cloudflare-signaling/src/index.js`
- Create: `cloudflare-signaling/test/room-code.test.js`
- Create: `cloudflare-signaling/package.json`
- Create: `cloudflare-signaling/wrangler.jsonc`

- [ ] **Step 1: Write failing room-code tests**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRoomCode, createToken, validateRoomCode } from '../src/room-code.js';

test('room codes avoid ambiguous characters', () => {
  const code = createRoomCode();
  assert.match(code, /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/);
  assert.equal(validateRoomCode(code), true);
});

test('join tokens contain at least 128 bits of entropy', () => {
  assert.ok(Buffer.from(createToken(), 'base64url').byteLength >= 16);
});
```

- [ ] **Step 2: Verify the tests fail because the module is absent**

Run: `npm test` from `cloudflare-signaling/`.

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement room primitives and Worker routing**

Implement `POST /rooms`, `POST /rooms/:code/join`, and WebSocket `GET /rooms/:code/socket?role=&token=`. The Durable Object accepts one host and one guest, relays only validated signaling JSON, caps message size at 64 KB, closes on invalid role/token, and rejects joins after lock or five-minute expiry.

Use this binding configuration:

```jsonc
{
  "name": "personal-hub-signaling",
  "main": "src/index.js",
  "compatibility_date": "2026-07-28",
  "durable_objects": { "bindings": [{ "name": "ROOMS", "class_name": "SignalRoom" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["SignalRoom"] }]
}
```

Use this package configuration before installation:

```json
{
  "name": "personal-hub-signaling",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test test/*.test.js",
    "deploy": "wrangler deploy",
    "deploy:dry": "wrangler deploy --dry-run"
  },
  "devDependencies": { "wrangler": "^4.28.1" }
}
```

- [ ] **Step 4: Add response hardening and CORS**

Allow only the GitHub Pages origin and localhost test origins, return `Cache-Control: no-store`, validate JSON shapes, and include no user data in logs. A room must reject more than five failed join attempts within one minute. Return stable errors: `ROOM_NOT_FOUND`, `ROOM_LOCKED`, `ROOM_EXPIRED`, `INVALID_TOKEN`, and `RATE_LIMITED`.

- [ ] **Step 5: Run unit and dry-run checks**

```powershell
npm install
npm test
npx wrangler deploy --dry-run
```

Expected: room-code tests PASS and Wrangler reports a valid Worker bundle and Durable Object migration.

- [ ] **Step 6: Commit the Worker**

```powershell
git add cloudflare-signaling
git commit -m "feat: add ephemeral signaling worker"
```

### Task 9: Add Short-Code Pairing Without Removing Offline Pairing

**Files:**
- Create: `versions/v1-local-first/signaling-client.js`
- Create: `site/signaling-client.js`
- Modify: `versions/v1-local-first/index.html`
- Modify: `versions/v1-local-first/sw.js`
- Modify: `site/index.html`
- Modify: `site/sw.js`
- Modify: `test-tools/verify-sync-v2.js`

- [ ] **Step 1: Extend the v2 test to expect short-code controls**

```js
await sender.getByRole('button', { name: '创建同步' }).click();
await sender.getByText(/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/).waitFor();
await receiver.getByLabel('输入房间码').fill(roomCode);
await receiver.getByRole('button', { name: '加入设备' }).click();
await sender.getByText('确认安全短语').waitFor();
```

- [ ] **Step 2: Verify failure before the signaling client exists**

Run: `npm run verify:sync-v2`

Expected: FAIL because short-code controls are absent.

- [ ] **Step 3: Implement the signaling client**

Expose `createRoom`, `joinRoom`, `connectHost`, and `connectGuest`. Relay only WebRTC offer, answer, and ICE candidate messages. Generate the displayed safety phrase from a SHA-256 hash of both peer fingerprints. On timeout, WebSocket error, or room error, show the offline pairing section without closing the modal.

- [ ] **Step 4: Integrate and cache the client**

Add `<script src="signaling-client.js"></script>`, add it to `ASSETS`, and preserve every existing `syncCreateOffer`, `syncCreateAnswer`, and `syncAcceptAnswer` function as offline fallback entry points.

- [ ] **Step 5: Deploy the Worker and set its actual endpoint**

Run from `cloudflare-signaling/`:

```powershell
npx wrangler login
npx wrangler deploy
```

Capture the exact HTTPS endpoint printed by Wrangler, insert that concrete value as `DEFAULT_SIGNALING_URL` in `signaling-client.js` using `apply_patch`, then mirror source files to `site/`. The committed file must not contain angle-bracket variables, example domains, credentials, or Wrangler state.

- [ ] **Step 6: Run local and deployed signaling tests**

Run `npm run verify:sync-v2` locally, then run the same isolated-context flow against the deployed GitHub Pages URL. Expected: short-code connection succeeds, selective transfer succeeds, and forcing a Worker failure exposes functional `ph1.` pairing.

- [ ] **Step 7: Commit short-code integration**

```powershell
git add versions/v1-local-first site test-tools
git commit -m "feat: add short-code device pairing"
```

### Task 10: Full Regression, Documentation, Deployment, and Live Audit

**Files:**
- Modify: `README.md`
- Modify: `OPTIMIZATION_NOTES.md`

- [ ] **Step 1: Run every automated check**

```powershell
$env:PLAYWRIGHT_BROWSERS_PATH='F:\GitHub-Trending\10-Personal-Hub\test-tools\ms-playwright'
npm run scan
npm run verify
npm run audit
npm run verify:sync
npm run test:core
npm run verify:storage-v2
npm run verify:sync-v2
npm run verify:safety
```

Expected: all commands exit 0, no console errors, no failed network requests, and no horizontal overflow.

- [ ] **Step 2: Verify source and publish trees are synchronized**

```powershell
$files='index.html','sw.js','manifest.json','sync-core.js','recovery-core.js','signaling-client.js'
$files | ForEach-Object {
  if((Get-FileHash "versions/v1-local-first/$_").Hash -ne (Get-FileHash "site/$_").Hash){throw "site drift: $_"}
}
```

Expected: no output and exit 0.

- [ ] **Step 3: Update user-facing documentation**

Document local-first storage, safe sync defaults, short-code signaling privacy, offline fallback, recovery points, reset categories, camera/gallery options, Cloudflare deployment, and exact test commands. Do not describe Gist as implemented.

- [ ] **Step 4: Commit documentation and push**

```powershell
git add README.md OPTIMIZATION_NOTES.md
git commit -m "docs: explain reliable device sync"
git push origin main
```

- [ ] **Step 5: Wait for GitHub Pages deployment**

```powershell
gh run list --repo s1mp1e6/personal-hub --workflow deploy-pages.yml --limit 1
gh run watch --repo s1mp1e6/personal-hub --exit-status
```

Expected: workflow and deploy job conclude `success`.

- [ ] **Step 6: Run live HTTPS acceptance tests**

Against `https://s1mp1e6.github.io/personal-hub/`, verify two isolated contexts, short-code pairing, fallback pairing, selective merge, conflict copy, pending deletion, attachment hash, undo, camera fake stream, gallery QR, reset preview, Service Worker controller, four viewport widths, and zero console errors.

- [ ] **Step 7: Record final repository state**

```powershell
git status --short
git log -8 --oneline
```

Expected: clean worktree and `main` tracking `origin/main`.
