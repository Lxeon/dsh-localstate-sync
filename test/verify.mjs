/**
 * Offline verification for @leonhoy/dsh-localstate-sync.
 *
 * Run from the package root: node test/verify.mjs
 *
 * Exercises the Host half with a fake Cordis context (route registration, index
 * injection, store merge, tombstones, allowlist) and the injected seeder against
 * a fake localStorage. No browser and no live profile required.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore, normalizeConfig, resolveStorePath } from '../store.js'

const home = mkdtempSync(join(tmpdir(), 'localstate-sync-'))
process.env.DSH_HOME = home

const checks = []
function check(label, condition, extra) {
  checks.push({ label, ok: Boolean(condition), extra })
  if (!condition) console.error(`FAIL ${label}`, extra ?? '')
  else console.log(`ok   ${label}`)
}

// ---------------------------------------------------------------- fake Cordis
function fakeContext() {
  const captured = { route: undefined, routes: [], listeners: [], effects: [], edits: [] }
  const logger = { info() {}, warn() {}, error() {}, debug() {} }
  const web = {
    effect(fn) {
      const dispose = fn()
      captured.effects.push(dispose)
      return dispose
    },
    on(event, listener) {
      captured.listeners.push([event, listener])
      return () => {}
    },
    connection: {
      fetch: {
        register(route) {
          captured.routes.push(route)
          return async () => {}
        },
      },
    },
  }
  const configEditor = {
    async edit(entry, change) {
      const next = change({ ...entry.options.config })
      captured.edits.push({ id: entry.id, config: next })
      return undefined
    },
  }
  const ctx = {
    logger,
    fiber: {
      entry: {
        id: 'localstate-sync',
        name: '@leonhoy/dsh-localstate-sync',
        options: { config: { includePrefixes: ['dsh.'], maxBytes: 262144, maxKeys: 2000, injectSnapshot: true, capture: true } },
      },
    },
    get(name) {
      return name === 'configEditor' ? configEditor : undefined
    },
    inject(_services, callback) {
      callback(web)
    },
  }
  return { ctx, captured }
}

// ---------------------------------------------------------------- store tests
const config = normalizeConfig({ includePrefixes: ['dsh.'], maxBytes: 262144, maxKeys: 2000 })
check('resolveStorePath honours DSH_HOME', resolveStorePath(config) === join(home, 'localstate-sync/state.json'), resolveStorePath(config))

const store = createStore(config)
const first = store.applyChanges({
  'dsh.keybindings.v1': '{"submit":"Enter"}',
  'CONVERSATION_STORE_KEY.abc': 'not-collected',
  'dsh.sidebar-right.v1.s1': '{"tabs":2}',
})
check('batch accepted', first.ok === true && first.accepted.length === 2, first)
check('disallowed key ignored', Array.isArray(first.ignored) && first.ignored[0] === 'CONVERSATION_STORE_KEY.abc', first.ignored)
check('revisions are monotonic per key', first.accepted[0][1] === 1 && first.accepted[1][1] === 2, first.accepted)

const del = store.applyChanges({ 'dsh.sidebar-right.v1.s1': null })
check('deletion becomes a tombstone', del.ok === true && store.snapshot().keys['dsh.sidebar-right.v1.s1'].del === true, store.snapshot().keys)

const injection = store.injection(131072)
check('injection carries triples in revision order', injection.v === 1 && injection.keys.length === 2 && injection.keys[0][0] === 'dsh.keybindings.v1' && injection.keys[1][1] === null, injection.keys)
check('injection not truncated', injection.truncated === false, injection.truncated)

const tooLarge = store.applyChanges({ 'dsh.big': 'x'.repeat(300000) })
check('oversized value rejected', tooLarge.ok === false && tooLarge.status === 413, tooLarge.reason)

const badValue = store.applyChanges({ 'dsh.bad': { nested: true } })
check('non-string value rejected', badValue.ok === false && badValue.reason === 'invalid-value', badValue.reason)

const badBatch = store.applyChanges([])
check('non-object batch rejected', badBatch.ok === false && badBatch.reason === 'invalid-changes', badBatch.reason)

store.flush()
const onDisk = JSON.parse(readFileSync(join(home, 'localstate-sync/state.json'), 'utf8'))
check('snapshot is on disk with 0600 mode', onDisk.version === 1 && onDisk.keys['dsh.keybindings.v1'].v === '{"submit":"Enter"}', Object.keys(onDisk.keys))
const mode = (await import('node:fs')).statSync(join(home, 'localstate-sync/state.json')).mode & 0o777
check('file mode is 0600', mode === 0o600, mode.toString(8))

const reloaded = createStore(config)
check('store reloads what it wrote', reloaded.snapshot().keys['dsh.keybindings.v1'].v === '{"submit":"Enter"}' && reloaded.snapshot().seq === 3, reloaded.snapshot().seq)

// ---------------------------------------------------------------- write conflicts
const clashConfig = normalizeConfig({ includePrefixes: ['dsh.'], file: 'clash/state.json' })
const clash = createStore(clashConfig)
const base = clash.applyChanges({ 'dsh.shared': 'from-a' }, {})
check('first write with an empty base applies', base.ok === true && base.accepted.length === 1 && base.conflicts.length === 0, base)
const staleAt = clash.snapshot().keys['dsh.shared'].at
const stale = clash.applyChanges({ 'dsh.shared': 'from-b' }, { 'dsh.shared': staleAt - 1 })
check('a stale base is reported as a conflict, not applied', stale.ok === true && stale.accepted.length === 0 && stale.conflicts.length === 1, stale)
check('the conflict carries the copy on the host', stale.conflicts[0].value === 'from-a' && stale.conflicts[0].current === staleAt && stale.conflicts[0].expected === staleAt - 1, stale.conflicts[0])
check('the rejected write left the value alone', clash.snapshot().keys['dsh.shared'].v === 'from-a', clash.snapshot().keys['dsh.shared'])
const retried = clash.applyChanges({ 'dsh.shared': 'from-b' }, { 'dsh.shared': staleAt })
check('resending with the fresh base applies', retried.ok === true && retried.accepted.length === 1 && retried.conflicts.length === 0 && clash.snapshot().keys['dsh.shared'].v === 'from-b', retried)
const mixedAt = clash.snapshot().keys['dsh.shared'].at
const mixed = clash.applyChanges({ 'dsh.shared': 'from-b2', 'dsh.fresh': 'new' }, { 'dsh.shared': mixedAt - 1, 'dsh.fresh': 0 })
check('a mixed batch applies the clean key and reports the clash', mixed.accepted.length === 1 && mixed.accepted[0][0] === 'dsh.fresh' && mixed.conflicts[0].key === 'dsh.shared', mixed)
check('the clean key in a mixed batch landed', clash.snapshot().keys['dsh.fresh'].v === 'new', clash.snapshot().keys['dsh.fresh'])
const clashDel = clash.applyChanges({ 'dsh.gone2': 'v' }, {})
const goneAt = clash.snapshot().keys['dsh.gone2'].at
clash.applyChanges({ 'dsh.gone2': null }, { 'dsh.gone2': goneAt })
const onTombstone = clash.applyChanges({ 'dsh.gone2': 'resurrect' }, { 'dsh.gone2': goneAt })
check('a tombstone also conflicts on a stale base', onTombstone.accepted.length === 0 && onTombstone.conflicts[0].value === null && onTombstone.conflicts[0].current > goneAt, onTombstone.conflicts[0])
const forcedAt = clash.snapshot().keys['dsh.shared'].at
const forced = clash.applyChanges({ 'dsh.shared': 'forced-local' }, { 'dsh.shared': forcedAt - 5 }, { 'dsh.shared': true })
check('a forced write ignores a stale base', forced.ok === true && forced.accepted.length === 1 && forced.conflicts.length === 0, forced)
check('the forced write landed on the host', clash.snapshot().keys['dsh.shared'].v === 'forced-local', clash.snapshot().keys['dsh.shared'])
const halfForced = clash.applyChanges(
  { 'dsh.shared': 'half' , 'dsh.other': 'clean' },
  { 'dsh.shared': clash.snapshot().keys['dsh.shared'].at - 5, 'dsh.other': 0 },
  { 'dsh.other': true },
)
check('force only covers the keys it names', halfForced.accepted.length === 1 && halfForced.accepted[0][0] === 'dsh.other' && halfForced.conflicts[0].key === 'dsh.shared', halfForced)
const legacy = clash.applyChanges({ 'dsh.legacy': 'no-base-sent' })
check('a batch without base still applies (old clients)', legacy.ok === true && legacy.accepted.length === 1 && legacy.conflicts.length === 0, legacy)
clash.flush()

// ---------------------------------------------------------------- host plugin
const { apply } = await import('../index.js')
const { ctx, captured } = fakeContext()
apply(ctx, { includePrefixes: ['dsh.'] })
captured.route = captured.routes.find((route) => route.path === '/api/localstate.v1')
check('route registered on /api prefix', captured.route?.path === '/api/localstate.v1', captured.routes.map((route) => route.path))
check('route declares GET and POST', captured.route?.methods.includes('GET') && captured.route?.methods.includes('POST'), captured.route?.methods)
check('route declares buffered bodies', captured.route?.requestBody === 'buffered', captured.route?.requestBody)
check('index-inject listener attached', captured.listeners.some(([event]) => event === 'webserver/index-inject'), captured.listeners.map(([event]) => event))

const getResponse = await captured.route.fetch(new Request('http://127.0.0.1:3080/api/localstate.v1', { method: 'GET' }))
const getBody = await getResponse.json()
check('GET returns the snapshot plus client config', getResponse.status === 200 && Array.isArray(getBody.keys) && getBody.config.prefixes[0] === 'dsh.' && getBody.config.language === 'auto', { status: getResponse.status, config: getBody.config })

const postResponse = await captured.route.fetch(new Request('http://127.0.0.1:3080/api/localstate.v1', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ changes: { 'dsh.keybindings.v1': '{"submit":"Mod+Enter"}' } }),
}))
const postBody = await postResponse.json()
check('POST merges and reports the new revision', postResponse.status === 200 && postBody.ok === true && postBody.accepted.length === 1 && postBody.accepted[0][1] === 4, postBody)

const badJson = await captured.route.fetch(new Request('http://127.0.0.1:3080/api/localstate.v1', { method: 'POST', body: '{' }))
check('malformed body answered with 400', badJson.status === 400, badJson.status)

const putResponse = await captured.route.fetch(new Request('http://127.0.0.1:3080/api/localstate.v1', { method: 'PUT' }))
check('unsupported method answered with 405', putResponse.status === 405, putResponse.status)

// ---------------------------------------------------------------- config route
const configRoute = captured.routes.find((route) => route.path === '/api/localstate.config.v1')
check('config route registered beside the data route', configRoute !== undefined && configRoute.methods.join(',') === 'GET,POST', captured.routes.map((route) => route.path))

const { fieldDescriptors } = await import('../index.js')
const fields = fieldDescriptors()
check('descriptors cover every config field', fields.length === 11 && fields[0].name === 'enabled' && fields[10].name === 'language', fields.map((field) => field.name))
check('descriptors carry kind and description', fields[0].kind === 'boolean' && fields[0].description.includes('Turn the whole bundle off') && fields[4].kind === 'array' && fields[4].item === 'string', fields.slice(0, 5))
check('numeric descriptors carry their minimum', fields[7].min === 1024 && fields[7].default === 262144, fields[7])
const languageField = fields.find((field) => field.name === 'language')
check('the language field is a union with its literals', languageField?.kind === 'union' && languageField.default === 'auto' && JSON.stringify(languageField.options) === '["auto","en","zh"]', languageField)

const configGet = await configRoute.fetch(new Request('http://127.0.0.1:3080/api/localstate.config.v1', { method: 'GET' }))
const configGetBody = await configGet.json()
check('config GET reports values, fields and writability', configGet.status === 200 && configGetBody.ok === true && configGetBody.writable === true && configGetBody.values.maxKeys === 2000 && configGetBody.fields.length === 11, { status: configGet.status, writable: configGetBody.writable })
check('config GET reports the resolved file path', configGetBody.filePath === join(home, 'localstate-sync/state.json'), configGetBody.filePath)
check('config GET marks the explicit override keys', Array.isArray(configGetBody.explicit) && configGetBody.explicit.includes('includePrefixes'), configGetBody.explicit)

const configPost = await configRoute.fetch(new Request('http://127.0.0.1:3080/api/localstate.config.v1', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ config: { maxKeys: 5 } }),
}))
const configPostBody = await configPost.json()
check('config POST accepts a partial draft', configPost.status === 200 && configPostBody.ok === true, configPostBody)
check('config POST merges into the row config', captured.edits.length === 1 && captured.edits[0].config.maxKeys === 5 && captured.edits[0].config.includePrefixes[0] === 'dsh.', captured.edits)

const unknownField = await configRoute.fetch(new Request('http://127.0.0.1:3080/api/localstate.config.v1', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ config: { nope: 1 } }),
}))
const unknownBody = await unknownField.json()
check('config POST refuses an unknown field', unknownField.status === 400 && unknownBody.reason === 'unknown-field' && unknownBody.fields[0] === 'nope', unknownBody)

const badDraft = await configRoute.fetch(new Request('http://127.0.0.1:3080/api/localstate.config.v1', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ config: [] }),
}))
check('config POST refuses a non-object draft', badDraft.status === 400, badDraft.status)

// A disabled bundle keeps the config route so the form can turn it back on.
const disabled = fakeContext()
apply(disabled.ctx, { enabled: false })
check('disabled bundle still serves the config route', disabled.captured.routes.length === 1 && disabled.captured.routes[0].path === '/api/localstate.config.v1', disabled.captured.routes.map((route) => route.path))

// ---------------------------------------------------------------- index inject
function injectFor(principalKind) {
  const table = []
  const listener = captured.listeners.find(([event]) => event === 'webserver/index-inject')[1]
  listener(table, { principal: { kind: principalKind } })
  return table
}
const ownerRows = injectFor('owner')
check('owner gets a global row and the seeder script', ownerRows.length === 2 && ownerRows[0].kind === 'global' && ownerRows[0].name === '__DSH_LOCALSTATE__' && ownerRows[1].kind === 'script' && ownerRows[1].placement === 'head', ownerRows.map((row) => row.kind))
check('injected global carries triples', Array.isArray(ownerRows[0]?.value?.keys) && ownerRows[0].value.prefixes[0] === 'dsh.', ownerRows[0]?.value?.prefixes)
check('injected global carries the configured language', ownerRows[0]?.value?.config?.language === 'auto', ownerRows[0]?.value?.config)
check('non-owner peer receives nothing', injectFor('shared').length === 0, injectFor('shared').length)
check('seeder script is the file text', ownerRows[1].text.startsWith('/* Injected into <head>'), ownerRows[1].text.slice(0, 40))

// ---------------------------------------------------------------- seeder logic
const seederText = readFileSync(join(import.meta.dirname, '..', 'seeder.js'), 'utf8')
const seederBody = seederText.replace(/^\/\*[\s\S]*?\*\/\s*/, '')
function runSeeder(globalValue, seed) {
  const map = new Map(Object.entries(seed))
  const localStorage = {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => void map.set(key, String(value)),
    removeItem: (key) => void map.delete(key),
  }
  const globalThisStub = { __DSH_LOCALSTATE__: globalValue }
  const run = new Function('globalThis', 'localStorage', seederBody)
  run(globalThisStub, localStorage)
  return { map, applied: globalThisStub.__DSH_LOCALSTATE_APPLIED__, list: globalThisStub.__DSH_LOCALSTATE_APPLIED_LIST__ }
}

const seeded = runSeeder(
  { v: 1, seq: 7, keys: [['dsh.keybindings.v1', '{"submit":"Mod+Enter"}', 4], ['dsh.gone', null, 5]] },
  { 'dsh.keybindings.v1': '{"submit":"Enter"}', 'dsh.gone': 'stale' },
)
check('seeder overwrites an older local value', seeded.map.get('dsh.keybindings.v1') === '{"submit":"Mod+Enter"}', seeded.map.get('dsh.keybindings.v1'))
check('seeder removes a tombstoned key', seeded.map.has('dsh.gone') === false, [...seeded.map.keys()])
check('seeder records applied revisions', seeded.applied === 2 && JSON.parse(seeded.map.get('__dsh.localstate.meta.v1')).at['dsh.gone'] === 5, seeded.map.get('__dsh.localstate.meta.v1'))

const skipped = runSeeder(
  { v: 1, seq: 7, keys: [['dsh.keybindings.v1', '{"submit":"stale-host"}', 2]] },
  { 'dsh.keybindings.v1': '{"submit":"newer-local"}', '__dsh.localstate.meta.v1': JSON.stringify({ seq: 9, at: { 'dsh.keybindings.v1': 6 } }) },
)
check('seeder keeps a newer local value', skipped.map.get('dsh.keybindings.v1') === '{"submit":"newer-local"}' && skipped.applied === 0, skipped.applied)
check(
  'seeder reports what it changed, with the value it replaced',
  Array.isArray(seeded.list) &&
    seeded.list.length === 2 &&
    seeded.list[0][0] === 'dsh.keybindings.v1' &&
    seeded.list[0][1] === 4 &&
    seeded.list[0][2] === '{"submit":"Enter"}' &&
    seeded.list[0][3] === '{"submit":"Mod+Enter"}' &&
    seeded.list[1][3] === null,
  seeded.list,
)

// ---------------------------------------------------------------- client bundle
const clientText = readFileSync(join(import.meta.dirname, '..', 'client.js'), 'utf8')
check('client registers under the package name', clientText.includes("id: '@leonhoy/dsh-localstate-sync'"))
check('client patches the three storage methods', ['setItem', 'removeItem', 'clear'].every((name) => clientText.includes(`${name}: proto.${name}`)))
check('client flushes on pagehide with a beacon', clientText.includes("addEventListener('pagehide'") && clientText.includes('sendBeacon'))
check('client skips file:// origins', clientText.includes("location.protocol === 'file:'"))

const loaded = {}
const styles = []
const requests = []
const replies = []
const sandbox = {
  document: {
    baseURI: 'http://127.0.0.1:3080/',
    visibilityState: 'visible',
    documentElement: { getAttribute: () => 'zh' },
    head: { appendChild: (node) => styles.push(node) },
    createElement: () => ({ setAttribute() {}, textContent: '' }),
    addEventListener() {},
    removeEventListener() {},
  },
  navigator: { language: 'zh-CN' },
  location: { protocol: 'http:' },
  fetch: async (url, init) => {
    requests.push({ url, method: init?.method ?? 'GET', body: init?.body })
    if ((init?.method ?? 'GET') !== 'POST') return { ok: false, status: 503, json: async () => ({}) }
    const next = replies.shift()
    if (next === undefined) return { ok: true, status: 200, json: async () => ({ ok: true, seq: 99, accepted: [], conflicts: [] }) }
    return { ok: true, status: 200, json: async () => next }
  },
  setTimeout,
  clearTimeout,
  URL,
  Blob,
  Map,
  __ModuleLoader__: { load(definition) { loaded.definition = definition } },
}
const sites = new Map()
sandbox.Storage = function Storage() {}
sandbox.Storage.prototype = {
  getItem(key) {
    return sites.has(key) ? sites.get(key) : null
  },
  setItem(key, value) {
    sites.set(key, String(value))
  },
  removeItem(key) {
    sites.delete(key)
  },
  clear() {
    sites.clear()
  },
}
// localStorage must reach its methods through the prototype so the capture patch sees the writes.
sandbox.localStorage = Object.create(sandbox.Storage.prototype)
// The notices follow the browser before the DSH locale, so the sandbox needs a language.
sandbox.navigator = { language: 'zh-CN', languages: ['zh-CN'] }
sandbox.window = sandbox
sandbox.addEventListener = () => {}
sandbox.removeEventListener = () => {}
runInContext(clientText, createContext(sandbox))
check('client bundle registers itself with the loader', loaded.definition?.id === '@leonhoy/dsh-localstate-sync', loaded.definition?.id)

const ReactShim = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
}
const bundle = loaded.definition.factory((name) => {
  if (name === 'react') return ReactShim
  throw new Error('unexpected require: ' + name)
})

const cells = []
const clientCtx = {
  slots: {
    inject(name, callback) { cells.push({ name, callback }) },
    register(definition, Component) { cells.push({ definition, Component }); return () => {} },
  },
  locale: { getSnapshot: () => ({ active: 'zh' }) },
  effect(fn) { fn(); return () => {} },
}
bundle.apply(clientCtx)
const injectCall = cells.find((entry) => entry.name === 'plugins.bundle.config')
check('client injects into the bundle config slot', injectCall !== undefined, cells.map((entry) => entry.name))
injectCall.callback()
const cell = cells.find((entry) => entry.definition !== undefined)
check('config cell is keyed by the package name', cell?.definition.name === 'plugins.bundle.config' && cell?.definition.key === '@leonhoy/dsh-localstate-sync', cell?.definition)
check('config cell exposes a component', typeof cell.Component === 'function')
const rendered = cell.Component({ view: 'page' })
check('config form renders its loading state', rendered.type === 'p', rendered.type)
check('config form renders nothing in summary view', cell.Component({ view: 'summary' }) === null)
check('capture patch installs on the page', sandbox.__DSH_LOCALSTATE_CAPTURE__ === true, sandbox.__DSH_LOCALSTATE_CAPTURE__)

// ---------------------------------------------------------------- client write conflicts
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const posts = () => requests.filter((entry) => entry.method === 'POST')
const bodyOf = (entry) => JSON.parse(entry.body)

replies.push({ ok: true, seq: 10, accepted: [], conflicts: [{ key: 'dsh.probe', expected: 0, current: 7, at: 7, value: 'remote-a' }] })
replies.push({ ok: true, seq: 11, accepted: [], conflicts: [{ key: 'dsh.probe', expected: 7, current: 11, at: 11, value: 'remote-b' }] })
sandbox.localStorage.setItem('dsh.probe', 'local-1')
await sleep(520)
const firstPost = posts()[0]
check('the browser sends the write as a plain batch', firstPost !== undefined && bodyOf(firstPost).changes['dsh.probe'] === 'local-1', firstPost && bodyOf(firstPost))
check('no base is sent for a key the browser has no revision for', firstPost !== undefined && bodyOf(firstPost).base === undefined, firstPost && bodyOf(firstPost).base)

await sleep(620)
const secondPost = posts()[1]
check('a conflict is resent once with the fresh base', secondPost !== undefined && bodyOf(secondPost).base['dsh.probe'] === 7, secondPost && bodyOf(secondPost))
check('the resent batch keeps the local value', secondPost !== undefined && bodyOf(secondPost).changes['dsh.probe'] === 'local-1', secondPost && bodyOf(secondPost).changes)

await sleep(700)
const kept = sandbox.__DSH_LOCALSTATE_CONFLICTS__?.['dsh.probe']
check('a second conflict keeps the local value', kept !== undefined && kept.local === 'local-1' && kept.remote === 'remote-b' && kept.at === 11, kept)
check('the retry does not loop', posts().length === 2, posts().length)
check('the local value survives the conflict', sites.get('dsh.probe') === 'local-1', sites.get('dsh.probe'))

// ---------------------------------------------------------------- conflict notices
const notices = sandbox.__DSH_LOCALSTATE_NOTICES__ ?? []
const pushFail = notices.find((entry) => entry.kind === 'error')
check('a refused write raises a push-failed notice', pushFail !== undefined && pushFail.text.includes('11'), pushFail)
check('the notice names the key that failed', pushFail?.key === 'dsh.probe', pushFail?.key)
check('nothing is announced when the revisions already agree', notices.every((entry) => entry.kind !== 'info'), notices.map((entry) => entry.kind))

sandbox.localStorage.setItem('dsh.probe', 'local-2')
await sleep(520)
const thirdPost = posts()[2]

// The synced copy keeps moving while the key is already known to be in conflict.
replies.push({ ok: true, seq: 12, accepted: [], conflicts: [{ key: 'dsh.probe', expected: 7, current: 12, at: 12, value: 'remote-c' }] })
replies.push({ ok: true, seq: 13, accepted: [], conflicts: [{ key: 'dsh.probe', expected: 7, current: 13, at: 13, value: 'remote-d' }] })
sandbox.localStorage.setItem('dsh.probe', 'local-3')
await sleep(700)
const episodes = (sandbox.__DSH_LOCALSTATE_NOTICES__ ?? []).filter((entry) => entry.kind === 'error')
check('a key already in conflict is not announced again as the copy moves on', episodes.length === 1, episodes.map((entry) => entry.text))
check('the conflict record still tracks the newest synced revision', (sandbox.__DSH_LOCALSTATE_CONFLICTS__?.['dsh.probe']?.at ?? 0) >= 12, sandbox.__DSH_LOCALSTATE_CONFLICTS__?.['dsh.probe'])
check('after a failed push the base stays stale, so only a reload can pull', thirdPost !== undefined && bodyOf(thirdPost).base['dsh.probe'] === 7, thirdPost && bodyOf(thirdPost).base)

sandbox.localStorage.setItem('dsh.probe', 'local-3')
await sleep(520)
const repeatedErrors = (sandbox.__DSH_LOCALSTATE_NOTICES__ ?? []).filter((entry) => entry.kind === 'error')
check('the same stalled revision is announced once, not on every write', repeatedErrors.length === 1, repeatedErrors.map((entry) => entry.text))

// ---------------------------------------------------------------- boot notice
const bootSites = new Map()
const bootPosts = []
let bootDefinition
const bootGlobals = {
  Storage: function Storage() {},
  location: { protocol: 'http:', reload() {} },
  document: {
    baseURI: 'http://127.0.0.1:3081/',
    visibilityState: 'visible',
    documentElement: { getAttribute: () => 'en' },
    head: { appendChild() {} },
    createElement: () => ({ setAttribute() {}, textContent: '' }),
    addEventListener() {},
    removeEventListener() {},
  },
  __DSH_LOCALSTATE__: { v: 1, seq: 5, keys: [['dsh.a', 'remote-a', 5]], prefixes: ['dsh.'], truncated: false },
  __DSH_LOCALSTATE_APPLIED__: 3,
  __ModuleLoader__: { load(definition) { bootDefinition = definition } },
  URL,
  Blob,
  Map,
  setTimeout,
  clearTimeout,
  addEventListener() {},
  removeEventListener() {},
  fetch: async (url, init) => {
    if ((init?.method ?? 'GET') === 'POST') {
      bootPosts.push(JSON.parse(init.body))
      return { ok: true, status: 200, json: async () => ({ ok: true, seq: 6, accepted: [['dsh.a', 6]], conflicts: [] }) }
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, seq: 5, keys: [], truncated: false }) }
  },
}
bootGlobals.Storage.prototype = {
  getItem: (key) => (bootSites.has(key) ? bootSites.get(key) : null),
  setItem: (key, value) => { bootSites.set(key, String(value)) },
  removeItem: (key) => { bootSites.delete(key) },
  clear: () => { bootSites.clear() },
}
bootGlobals.localStorage = Object.create(bootGlobals.Storage.prototype)
bootGlobals.window = bootGlobals
runInContext(clientText, createContext(bootGlobals))
const bootBundle = bootDefinition.factory((name) => {
  if (name === 'react') return ReactShim
  throw new Error('unexpected require: ' + name)
})
bootBundle.apply({ locale: { getSnapshot: () => ({ active: 'en' }) }, effect(fn) { fn(); return () => {} } })
const bootNotices = bootGlobals.__DSH_LOCALSTATE_NOTICES__ ?? []
check('a boot that replaced values announces the newer synced revision', bootNotices.some((entry) => entry.kind === 'info' && entry.text.includes('3')), bootNotices)

// The seeder/snapshot restores dsh.a at revision 5. A write to that key must be
// guarded by base 5 (the revision it was just built on), not a stale/absent base —
// otherwise editing a freshly-restored key trips a spurious conflict on flush.
bootGlobals.localStorage.setItem('dsh.a', 'edited-after-boot')
await sleep(520)
const bootPost = bootPosts[0]
check('a write to a freshly-restored key carries the applied revision as its base', bootPost !== undefined && bootPost.base?.['dsh.a'] === 5, bootPost)
check('the restored key is sent as a guarded change', bootPost !== undefined && bootPost.changes?.['dsh.a'] === 'edited-after-boot', bootPost?.changes)

// The toast stack + change panel now mount on the built-in shell.overlay seat
// instead of a private DOM stack appended to document.body.
check('client mounts its overlay on the built-in shell.overlay seat', clientText.includes("slots.inject('shell.overlay'") && clientText.includes("name: 'shell.overlay'"), 'overlay registration')
check('overlay no longer appends a private toast host to document.body', !clientText.includes('__dsh_localstate_toasts') && !clientText.includes('NOTICE_HOST_ID'), 'no body-appended toast host')

rmSync(home, { recursive: true, force: true })
const failed = checks.filter((entry) => entry.ok !== true)
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
if (failed.length > 0) process.exitCode = 1
