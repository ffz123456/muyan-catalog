const REMOTE = new URL("/api/sync/orders", window.location.origin).href;
const LOCAL_NAME = "fs_orders";
const state = {
  db: null,
  syncing: false,
  lastSyncAt: null,
  lastError: null,
  pending: 0,
  online: typeof navigator === "undefined" ? true : navigator.onLine,
  onChange: null
};
function onCreate(cb) {
  state.onChange = cb;
}
function emit() {
  var _a;
  (_a = state.onChange) == null ? void 0 : _a.call(state, snapshot());
}
function snapshot() {
  return {
    online: state.online,
    syncing: state.syncing,
    lastSyncAt: state.lastSyncAt,
    lastError: state.lastError,
    pending: state.pending
  };
}
function newId() {
  const t = /* @__PURE__ */ new Date();
  const p = (n) => String(n).padStart(2, "0");
  const stamp = `${t.getFullYear()}${p(t.getMonth() + 1)}${p(t.getDate())}`;
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(4))).map((b) => b.toString(16).padStart(2, "0")).join("");
  return `order:${stamp}-${rand}`;
}
async function init() {
  if (state.db) return state.db;
  state.db = new PouchDB(LOCAL_NAME);
  window.addEventListener("online", () => {
    state.online = true;
    emit();
    sync();
  });
  window.addEventListener("offline", () => {
    state.online = false;
    emit();
  });
  await recountPending();
  emit();
  await sync();
  return state.db;
}
async function refreshPending() {
  return state.pending;
}
async function resetReplicationCheckpoints() {
  try {
    const all = await state.db.allDocs({ startkey: "_local/", endkey: "_local/\uFFF0" });
    for (const row of all.rows) {
      const id = row.id;
      if (id === PENDING_DOC) continue;
      try {
        await state.db.remove(id, row.value.rev);
      } catch {
      }
    }
  } catch {
  }
}
async function purgeUnauthorizedLocals() {
  var _a, _b;
  if (!state.online) return { skipped: "offline", removed: 0 };
  let allowed;
  try {
    if (transport === "hub") {
      const r = await postJson("/api/hub/pull", { since: 0 });
      allowed = new Set(((_a = r == null ? void 0 : r.changes) != null ? _a : []).map((c) => c.id));
    } else {
      const res = await fetch(
        new URL("/api/sync/orders/_changes?since=0", window.location.origin),
        { headers: { Accept: "application/json" }, credentials: "same-origin" }
      );
      if (!res.ok) return { skipped: `http ${res.status}`, removed: 0 };
      const data = await res.json();
      allowed = new Set(((_b = data.results) != null ? _b : []).map((r) => r.id));
    }
  } catch {
    return { skipped: "request failed", removed: 0 };
  }
  const isOrder = (id) => id.startsWith("order:") || id.startsWith("orderrev:");
  const local = await state.db.allDocs();
  const removable = local.rows.map((r) => r.id).filter((id) => isOrder(id) && !allowed.has(id));
  let removed = 0;
  for (const id of removable) {
    try {
      const doc = await state.db.get(id);
      await state.db.remove(doc);
      removed++;
    } catch {
    }
  }
  if (removed) {
    const ids = await readPendingIds();
    for (const id of removable) ids.delete(id);
    await writePendingIds(ids);
    state.pending = ids.size;
    emit();
  }
  return { removed };
}
let transport = "couch";
function setTransport(mode) {
  transport = mode === "hub" ? "hub" : "couch";
}
const currentTransport = () => transport;
async function postJson(path, body) {
  var _a;
  const res = await fetch(new URL(path, window.location.origin), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(body != null ? body : {})
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  if (!res.ok) {
    const err = new Error((_a = parsed == null ? void 0 : parsed.error) != null ? _a : `\u540C\u6B65\u5931\u8D25\uFF08HTTP ${res.status}\uFF09`);
    err.status = res.status;
    throw err;
  }
  return parsed;
}
const HUB_SEQ_DOC = "_local/hub-since";
async function readHubSeq() {
  try {
    const d = await state.db.get(HUB_SEQ_DOC);
    return Number(d.seq) || 0;
  } catch {
    return 0;
  }
}
async function writeHubSeq(seq) {
  const cur = await state.db.get(HUB_SEQ_DOC).catch(() => null);
  await state.db.put({
    _id: HUB_SEQ_DOC,
    seq: Number(seq) || 0,
    ...cur ? { _rev: cur._rev } : {}
  });
}
async function rememberHubRev(id, rev) {
  try {
    const cur = await state.db.get(id);
    if (cur.hubRev === rev) return;
    await state.db.put({ ...cur, hubRev: rev });
  } catch {
  }
}
function stripLocal(doc) {
  const { hubRev, _revisions, ...rest } = doc;
  void hubRev;
  void _revisions;
  return rest;
}
async function hubPush() {
  var _a, _b;
  const pending = await readPendingIds();
  if (!pending.size) return { pushedIds: /* @__PURE__ */ new Set(), errors: 0 };
  const changes = [];
  for (const id of pending) {
    try {
      const doc = await state.db.get(id);
      changes.push({ id, rev: (_a = doc.hubRev) != null ? _a : null, doc: stripLocal(doc) });
    } catch {
    }
  }
  if (!changes.length) return { pushedIds: /* @__PURE__ */ new Set(), errors: 0 };
  const r = await postJson("/api/hub/push", { changes });
  const pushedIds = /* @__PURE__ */ new Set();
  let errors = 0;
  for (const item of (_b = r == null ? void 0 : r.results) != null ? _b : []) {
    if (item.ok) {
      pushedIds.add(item.id);
      await rememberHubRev(item.id, item.rev);
      continue;
    }
    errors++;
  }
  return { pushedIds, errors };
}
async function hubPull() {
  var _a, _b;
  const since = await readHubSeq();
  const r = await postJson("/api/hub/pull", { since });
  const changes = (_a = r == null ? void 0 : r.changes) != null ? _a : [];
  let errors = 0;
  for (const c of changes) {
    try {
      const doc = c.doc;
      if (!doc) continue;
      const cur = await state.db.get(c.id).catch(() => null);
      const next = { ...doc, _id: c.id };
      if (cur) next._rev = cur._rev;
      await state.db.put(next);
      await rememberHubRev(c.id, c.rev);
    } catch {
      errors++;
    }
  }
  if (!errors) await writeHubSeq((_b = r == null ? void 0 : r.lastSeq) != null ? _b : since);
  return { errors };
}
let inflight = null;
function sync() {
  if (inflight) return inflight;
  inflight = (async () => {
    var _a, _b, _c, _d, _e, _f, _g, _h;
    state.syncing = true;
    emit();
    try {
      let push = null;
      let pull = null;
      if (transport === "hub") {
        push = await hubPush();
        state.lastSyncAt = /* @__PURE__ */ new Date();
        if (push.errors) state.lastError = `\u4E0A\u4F20\u5931\u8D25 ${push.errors} \u6761`;
        else state.lastError = null;
        emit();
        try {
          pull = await hubPull();
          if (pull.errors) state.lastError = `\u4E0B\u8F7D\u5931\u8D25 ${pull.errors} \u6761`;
          state.lastSyncAt = /* @__PURE__ */ new Date();
        } catch (e) {
          state.lastError = `\u4E0B\u8F7D\u5931\u8D25\uFF1A${e.message}`;
        }
        emit();
      } else {
        await resetReplicationCheckpoints();
        const r = await state.db.replicate.to(REMOTE, { batch_size: 50, retry: false });
        state.lastSyncAt = /* @__PURE__ */ new Date();
        const pushErr = (_b = (_a = r == null ? void 0 : r.errors) == null ? void 0 : _a.length) != null ? _b : 0;
        if (pushErr) {
          state.lastError = `\u4E0A\u4F20\u5931\u8D25 ${pushErr} \u6761`;
        } else {
          const pushed = new Set(
            ((_c = r == null ? void 0 : r.docs) != null ? _c : []).map((d) => {
              var _a2;
              return (_a2 = d == null ? void 0 : d._id) != null ? _a2 : d == null ? void 0 : d.id;
            }).filter(Boolean)
          );
          if (pushed.size) await clearPending(pushed);
          else await recountPending();
          state.lastError = null;
        }
        push = { docs: (_d = r == null ? void 0 : r.docs) != null ? _d : [] };
        emit();
        try {
          const p = await state.db.replicate.from(REMOTE, { batch_size: 50, retry: false });
          const pullErr = (_f = (_e = p == null ? void 0 : p.errors) == null ? void 0 : _e.length) != null ? _f : 0;
          if (pullErr) state.lastError = `\u4E0B\u8F7D\u5931\u8D25 ${pullErr} \u6761`;
          state.lastSyncAt = /* @__PURE__ */ new Date();
          pull = p;
        } catch (e) {
          state.lastError = `\u4E0B\u8F7D\u5931\u8D25\uFF1A${e.message}`;
        }
        emit();
        await resetReplicationCheckpoints();
      }
      if (transport === "hub" && ((_g = push == null ? void 0 : push.pushedIds) == null ? void 0 : _g.size)) {
        await clearPending(push.pushedIds);
      }
      await purgeUnauthorizedLocals();
      await recountPending();
      return { push, pull };
    } catch (err) {
      state.lastError = (_h = err == null ? void 0 : err.message) != null ? _h : String(err);
      emit();
      throw err;
    } finally {
      state.syncing = false;
      inflight = null;
      emit();
    }
  })();
  return inflight;
}
const PENDING_DOC = "_local/unsynced";
async function readPendingIds() {
  var _a;
  try {
    const d = await state.db.get(PENDING_DOC);
    return new Set((_a = d.ids) != null ? _a : []);
  } catch {
    return /* @__PURE__ */ new Set();
  }
}
async function writePendingIds(ids) {
  const cur = await state.db.get(PENDING_DOC).catch(() => null);
  await state.db.put({
    _id: PENDING_DOC,
    ids: [...ids],
    ...cur ? { _rev: cur._rev } : {}
  });
}
async function markPending(id) {
  const ids = await readPendingIds();
  ids.add(id);
  await writePendingIds(ids);
  state.pending = ids.size;
  emit();
}
async function clearPending(ids) {
  const cur = await readPendingIds();
  for (const id of ids) cur.delete(id);
  await writePendingIds(cur);
  state.pending = cur.size;
  emit();
}
async function putOrder(doc) {
  if (state.syncing) {
    throw new Error("\u6B63\u5728\u540C\u6B65\uFF0C\u8BF7\u7A0D\u5019\u4E00\u79D2\u518D\u4FDD\u5B58");
  }
  await markPending(doc._id);
  const res = await state.db.put(doc);
  try {
    await sync();
  } catch {
  }
  return { ...doc, _rev: res.rev };
}
async function recountPending() {
  const ids = await readPendingIds();
  state.pending = ids.size;
  emit();
  return state.pending;
}
async function newOrder(input, salesId) {
  var _a, _b, _c, _d, _e, _f, _g, _h;
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const doc = {
    _id: newId(),
    type: "order",
    sales_id: salesId,
    status: "active",
    customer_name: (_a = input.customer_name) != null ? _a : "",
    customer_phone: (_b = input.customer_phone) != null ? _b : "",
    remark: (_c = input.remark) != null ? _c : "",
    items: (_d = input.items) != null ? _d : [],
    total: (_e = input.total) != null ? _e : 0,
    list_total: (_f = input.list_total) != null ? _f : 0,
    discount: (_g = input.discount) != null ? _g : 0,
    item_count: (_h = input.item_count) != null ? _h : 0,
    version: 1,
    created_at: now,
    updated_at: now
  };
  return putOrder(doc);
}
async function updateOrderDoc(id, patch) {
  var _a;
  const cur = await state.db.get(id);
  const next = {
    ...cur,
    ...patch,
    version: ((_a = cur.version) != null ? _a : 1) + 1,
    updated_at: (/* @__PURE__ */ new Date()).toISOString()
  };
  return putOrder(next);
}
async function softDeleteOrder(id) {
  return updateOrderDoc(id, {
    status: "deleted",
    deleted_at: (/* @__PURE__ */ new Date()).toISOString()
  });
}
function normalize(doc) {
  if (!doc) return doc;
  return { ...doc, id: doc._id };
}
async function listOrders({ includeDeleted = false } = {}) {
  const res = await state.db.allDocs({ include_docs: true });
  return res.rows.map((r) => normalize(r.doc)).filter((d) => d && !d._id.startsWith("_")).filter((d) => includeDeleted ? true : d.status !== "deleted").sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}
async function getOrderDoc(id) {
  try {
    return normalize(await state.db.get(id));
  } catch {
    return null;
  }
}
async function resync() {
  state.lastError = null;
  emit();
  return sync();
}
async function wipeLocal() {
  if (state.db) {
    try {
      await state.db.destroy();
    } catch {
    }
    state.db = null;
  }
  state.pending = 0;
  state.lastError = null;
  state.lastSyncAt = null;
  inflight = null;
  emit();
}
const localName = LOCAL_NAME;
const remoteUrl = REMOTE;
export {
  currentTransport,
  getOrderDoc,
  init,
  listOrders,
  localName,
  newOrder,
  onCreate,
  putOrder,
  recountPending,
  refreshPending,
  remoteUrl,
  resync,
  setTransport,
  snapshot,
  softDeleteOrder,
  sync,
  updateOrderDoc,
  wipeLocal
};
