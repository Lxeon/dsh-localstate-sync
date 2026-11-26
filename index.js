/**
 * Host half of browser-state sync.
 *
 * Serves one exact Fetch route under the shared `/api` channel and injects the
 * current snapshot into the page `<head>` before the application boots, so the
 * browser can restore values without a reload.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Schema from 'schemastery'
import { DEFAULT_CONFIG, LANGUAGES, createStore, normalizeConfig, resolveStorePath } from './store.js'

/**
 * The row's config schema. It is what the Plugins page renders as a form and
 * what the loader validates before {@link apply} runs.
 */
export const Config = Schema.object({
  enabled: Schema.boolean().default(true).description('Turn the whole bundle off without removing it.'),
  capture: Schema.boolean().default(true).description('Record browser localStorage writes. Existing data is kept when this is off.'),
  injectSnapshot: Schema.boolean().default(true).description('Restore the snapshot in the page head before the app boots. When off, values are only saved.'),
  file: Schema.string().default('localstate-sync/state.json').description('State file, relative to the DSH home.'),
  includePrefixes: Schema.array(Schema.string()).default(['dsh.']).description('Collect keys that start with one of these prefixes.'),
  includeExact: Schema.array(Schema.string()).default([]).description('Collect these exact keys in addition to the prefixes.'),
  excludeExact: Schema.array(Schema.string()).default([]).description('Never collect these exact keys.'),
  maxBytes: Schema.number().min(1024).default(262144).description('Largest accepted value and snapshot size, in bytes. A larger batch is rejected, never truncated.'),
  maxKeys: Schema.number().min(1).default(2000).description('Key cap. Tombstones are dropped first, then the oldest values.'),
  injectMaxBytes: Schema.number().min(0).default(131072).description('Above this size the snapshot is not injected; the page pulls it over the route instead.'),
  language: Schema.union(LANGUAGES.map((value) => Schema.const(value))).default('auto').description('Language of the notices and the settings form. auto follows the browser, then the DSH locale.'),
})

/** Route path; it carries the `/api` prefix the shared channel matches on. */
export const ROUTE_PATH = '/api/localstate.v1'

/** Route the Plugins page uses to read and edit this row's config. */
export const CONFIG_ROUTE_PATH = '/api/localstate.config.v1'

/** Global the injected snapshot is published as. */
export const GLOBAL_NAME = '__DSH_LOCALSTATE__'

/**
 * Flatten the config schema into the field list the browser form renders.
 * Reading `Config.dict` keeps the form in step with {@link Config}: a field is
 * added, renamed, or re-typed in exactly one place.
 * @returns one descriptor per config field, in declaration order.
 */
// schemastery encodes a union of constants as a refs blob; pull the literal values out so
// the settings form can render a select without importing the schema library client-side.
const UNION_OPTIONS = { language: LANGUAGES }

export function fieldDescriptors() {
  const dict = Config.dict !== null && typeof Config.dict === 'object' ? Config.dict : {}
  const out = []
  for (const name of Object.keys(dict)) {
    const schema = dict[name]
    const meta = schema?.meta !== null && typeof schema?.meta === 'object' ? schema.meta : {}
    const kind = typeof schema?.type === 'string' ? schema.type : 'string'
    const descriptor = {
      name,
      kind,
      description: typeof meta.description === 'string' ? meta.description : '',
    }
    if (Object.hasOwn(meta, 'default')) descriptor.default = meta.default
    if (typeof meta.min === 'number') descriptor.min = meta.min
    if (typeof meta.max === 'number') descriptor.max = meta.max
    if (kind === 'array') descriptor.item = typeof schema?.inner?.type === 'string' ? schema.inner.type : 'string'
    if (kind === 'union' && Array.isArray(UNION_OPTIONS[name])) descriptor.options = [...UNION_OPTIONS[name]]
    out.push(descriptor)
  }
  return out
}

const SEEDER_FILE = join(dirname(fileURLToPath(import.meta.url)), 'seeder.js')

let seederText
function readSeeder() {
  if (seederText === undefined) {
    try {
      seederText = readFileSync(SEEDER_FILE, 'utf8').trim()
    } catch {
      seederText = ''
    }
  }
  return seederText
}

function jsonResponse(status, value) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

/**
 * Serve the row's own config to the Plugins page and accept edits back into the
 * profile patch layer through the Host config editor.
 * @param ctx - the plugin context.
 * @param cfg - the normalized config the running instance uses.
 * @param raw - the row's raw config, used to mark explicit overrides.
 */
function registerConfigRoute(ctx, cfg, raw) {
  const fields = fieldDescriptors()

  const handle = async (request) => {
    let editor
    let entry
    try {
      editor = ctx.get('configEditor')
      entry = ctx.fiber?.entry
    } catch {
      editor = undefined
      entry = undefined
    }

    if (request.method === 'GET') {
      return jsonResponse(200, {
        ok: true,
        fields,
        values: cfg,
        explicit: Object.keys(raw),
        filePath: resolveStorePath(cfg),
        writable: editor !== undefined && entry !== undefined,
      })
    }
    if (request.method !== 'POST') return new Response('method not allowed', { status: 405 })
    if (editor === undefined || entry === undefined) {
      return jsonResponse(501, { ok: false, reason: 'config-editor-unavailable' })
    }

    let body
    try {
      body = await request.json()
    } catch {
      return jsonResponse(400, { ok: false, reason: 'invalid-json' })
    }
    const draft = body !== null && typeof body === 'object' ? body.config : undefined
    if (draft === null || typeof draft !== 'object' || Array.isArray(draft)) {
      return jsonResponse(400, { ok: false, reason: 'invalid-config' })
    }
    const unknown = Object.keys(draft).filter((name) => !Object.hasOwn(DEFAULT_CONFIG, name))
    if (unknown.length > 0) {
      return jsonResponse(400, { ok: false, reason: 'unknown-field', fields: unknown })
    }
    try {
      await editor.edit(entry, (current) => ({ ...current, ...draft }))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return jsonResponse(400, { ok: false, reason: 'rejected', message })
    }
    return jsonResponse(200, { ok: true })
  }

  ctx.inject(['webServer', 'connection', 'configEditor'], (web) => {
    web.effect(
      () => web.connection.fetch.register({ path: CONFIG_ROUTE_PATH, methods: ['GET', 'POST'], requestBody: 'buffered', fetch: handle }),
      'localstate-sync: config route',
    )
  })
}

/**
 * Register the route and the index injection for one profile.
 * @param ctx - the plugin context.
 * @param config - the patch row's config, already normalized by the caller.
 */
export function apply(ctx, config) {
  const resolved = config !== null && typeof config === 'object' && !Array.isArray(config) ? config : {}
  // `config` above is the resolved value (defaults filled in); the patch row
  // itself only carries the keys the operator set, which is what "explicit"
  // means in the form.
  const literal = ctx.fiber !== undefined && ctx.fiber.entry !== undefined ? ctx.fiber.entry.options.config : undefined
  const raw = literal !== null && typeof literal === 'object' && !Array.isArray(literal) ? literal : resolved
  const cfg = normalizeConfig({ ...raw, ...resolved })

  // The config route stays up even with `enabled: false`, so the form on the
  // Plugins page can always turn the bundle back on.
  registerConfigRoute(ctx, cfg, raw)

  if (!cfg.enabled) return

  const store = createStore(cfg)
  const log = (level, message) => {
    try {
      ctx.logger?.[level]?.(message)
    } catch {
      // Logging must never break request handling.
    }
  }
  if (store.recovered !== undefined) {
    log('warn', `[localstate-sync] unreadable state moved to ${store.recovered.aside}: ${store.recovered.message}`)
  }

  // The browser needs the allowlist and the chosen language both at boot (injected global)
  // and after a live config save (this route), so one shape serves both.
  const browserConfig = () => ({
    prefixes: cfg.includePrefixes,
    exact: cfg.includeExact,
    exclude: cfg.excludeExact,
    capture: cfg.capture,
    language: cfg.language,
  })

  const handle = async (request) => {
    if (request.method === 'GET') {
      return jsonResponse(200, { ...store.injection(cfg.injectMaxBytes), config: browserConfig() })
    }
    if (request.method === 'POST') {
      let body
      try {
        body = await request.json()
      } catch {
        return jsonResponse(400, { ok: false, reason: 'invalid-json' })
      }
      const changes = body !== null && typeof body === 'object' ? body.changes : undefined
      const base = body !== null && typeof body === 'object' ? body.base : undefined
      const result = store.applyChanges(changes, base)
      if (result.ok === false) {
        log('warn', `[localstate-sync] rejected a browser batch: ${result.reason}`)
        return jsonResponse(typeof result.status === 'number' ? result.status : 400, result)
      }
      return jsonResponse(200, result)
    }
    return new Response('method not allowed', { status: 405 })
  }

  ctx.inject(['webServer', 'connection'], (web) => {
    web.effect(
      () => web.connection.fetch.register({ path: ROUTE_PATH, methods: ['GET', 'POST'], requestBody: 'buffered', fetch: handle }),
      'localstate-sync: exact Fetch route',
    )

    web.on('webserver/index-inject', (table, peer) => {
      if (cfg.injectSnapshot !== true) return
      if (peer?.principal?.kind !== 'owner') return
      const injection = store.injection(cfg.injectMaxBytes)
      if (injection.truncated === true) {
        log('info', `[localstate-sync] snapshot exceeds injectMaxBytes (${cfg.injectMaxBytes}); the page will pull it over the route instead`)
        return
      }
      if (injection.keys.length === 0) return
      table.push({
        kind: 'global',
        name: GLOBAL_NAME,
        value: { ...injection, config: browserConfig(), prefixes: cfg.includePrefixes },
      })
      const text = readSeeder()
      if (text !== '') table.push({ kind: 'script', placement: 'head', text })
    })

    web.effect(() => () => store.flush(), 'localstate-sync: flush on unload')
  })

  log('info', `[localstate-sync] ${store.filePath} (${store.size} keys)`)
}
