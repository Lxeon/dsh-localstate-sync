/**
 * Durable store for browser localStorage snapshots.
 *
 * The document lives in one JSON file under `$DSH_HOME`. Every accepted change
 * takes the next monotonic `at` value, which the browser compares against its
 * own per-key bookkeeping before writing a restored value. Writes are
 * write-behind: a short timer coalesces a burst of browser flushes into one
 * atomic rename.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'

/** Document schema version written into the JSON file. */
export const DOC_VERSION = 1

/** Resolved DSH home: an explicit `$DSH_HOME` wins over `~/.dsh`. */
export function dshHome() {
  const configured = process.env.DSH_HOME
  if (typeof configured === 'string' && configured.trim() !== '') return configured.trim()
  return join(homedir(), '.dsh')
}

/** Configuration defaults; every field is optional in the patch row. */
export const DEFAULT_CONFIG = {
  enabled: true,
  file: 'localstate-sync/state.json',
  includePrefixes: ['dsh.'],
  includeExact: [],
  excludeExact: [],
  maxBytes: 262144,
  maxKeys: 2000,
  injectMaxBytes: 131072,
  injectSnapshot: true,
  capture: true,
}

function stringList(value, fallback) {
  if (value === undefined || value === null) return [...fallback]
  const items = typeof value === 'string' ? [value] : Array.isArray(value) ? value : undefined
  if (items === undefined) return [...fallback]
  const kept = []
  for (const item of items) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (trimmed === '') continue
    kept.push(trimmed)
  }
  return kept
}

function positiveInt(value, fallback, min = 1) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  const rounded = Math.floor(value)
  return rounded >= min ? rounded : fallback
}

/**
 * Apply defaults and drop values the store cannot use.
 * @param raw - the patch row's `config` object, possibly undefined.
 * @returns a complete configuration.
 */
export function normalizeConfig(raw) {
  const input = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const config = { ...DEFAULT_CONFIG }
  if (typeof input.enabled === 'boolean') config.enabled = input.enabled
  if (typeof input.injectSnapshot === 'boolean') config.injectSnapshot = input.injectSnapshot
  if (typeof input.capture === 'boolean') config.capture = input.capture
  if (typeof input.file === 'string' && input.file.trim() !== '') config.file = input.file.trim()
  config.includePrefixes = stringList(input.includePrefixes, DEFAULT_CONFIG.includePrefixes)
  config.includeExact = stringList(input.includeExact, [])
  config.excludeExact = stringList(input.excludeExact, [])
  config.maxBytes = positiveInt(input.maxBytes, DEFAULT_CONFIG.maxBytes)
  config.maxKeys = positiveInt(input.maxKeys, DEFAULT_CONFIG.maxKeys)
  config.injectMaxBytes = positiveInt(input.injectMaxBytes, DEFAULT_CONFIG.injectMaxBytes)
  return config
}

/** Absolute path of the store file for one configuration. */
export function resolveStorePath(config) {
  return isAbsolute(config.file) ? config.file : join(dshHome(), config.file)
}

function emptyDoc() {
  return { version: DOC_VERSION, seq: 0, updatedAt: null, keys: {} }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function loadDoc(filePath) {
  if (!existsSync(filePath)) return { doc: emptyDoc(), recovered: undefined }
  let text
  try {
    text = readFileSync(filePath, 'utf8')
  } catch {
    return { doc: emptyDoc(), recovered: undefined }
  }
  try {
    const parsed = JSON.parse(text)
    if (!isRecord(parsed) || !isRecord(parsed.keys)) throw new Error('state document has no keys map')
    const keys = {}
    for (const [key, row] of Object.entries(parsed.keys)) {
      if (typeof key !== 'string' || !isRecord(row)) continue
      const at = typeof row.at === 'number' && Number.isFinite(row.at) ? row.at : 0
      const t = typeof row.t === 'number' && Number.isFinite(row.t) ? row.t : at
      if (row.del === true) keys[key] = { del: true, at, t }
      else if (typeof row.v === 'string') keys[key] = { v: row.v, at, t }
    }
    const seq = typeof parsed.seq === 'number' && Number.isFinite(parsed.seq) ? parsed.seq : 0
    const updatedAt = typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null
    return { doc: { version: DOC_VERSION, seq, updatedAt, keys }, recovered: undefined }
  } catch (error) {
    const aside = `${filePath}.corrupt-${Date.now()}`
    try {
      renameSync(filePath, aside)
    } catch {
      // Keep serving an empty document even when the bad file cannot be moved aside.
    }
    return { doc: emptyDoc(), recovered: { aside, message: String(error) } }
  }
}

/**
 * Create the store for one resolved configuration.
 * @param config - normalized configuration.
 * @returns the store handle plus load diagnostics.
 */
export function createStore(config) {
  const filePath = resolveStorePath(config)
  const { doc: initialDoc, recovered } = loadDoc(filePath)
  let doc = initialDoc
  let timer
  let dirty = false
  let lastWriteAt = null
  let lastWriteError = null

  const allows = (key) => {
    if (typeof key !== 'string' || key === '' || key.length > 512) return false
    if (config.excludeExact.includes(key)) return false
    if (config.includeExact.includes(key)) return true
    return config.includePrefixes.some((prefix) => key.startsWith(prefix))
  }

  const writeNow = () => {
    if (!dirty) return
    dirty = false
    try {
      mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 })
      const body = `${JSON.stringify(doc, null, 2)}\n`
      const tmp = `${filePath}.${process.pid}.tmp`
      writeFileSync(tmp, body, { mode: 0o600 })
      renameSync(tmp, filePath)
      try {
        chmodSync(filePath, 0o600)
      } catch {
        // A missing chmod on some filesystems is not a reason to fail the write.
      }
      lastWriteAt = new Date().toISOString()
      lastWriteError = null
    } catch (error) {
      dirty = true
      lastWriteError = String(error)
    }
  }

  const scheduleWrite = () => {
    dirty = true
    if (timer !== undefined) return
    timer = setTimeout(() => {
      timer = undefined
      writeNow()
    }, 120)
    if (typeof timer.unref === 'function') timer.unref()
  }

  /** Drop the oldest keys once the key cap is exceeded; tombstones go first. */
  const prune = (keys) => {
    const entries = Object.entries(keys)
    if (entries.length <= config.maxKeys) return keys
    const ranked = entries.sort((left, right) => {
      const leftDel = left[1].del === true ? 0 : 1
      const rightDel = right[1].del === true ? 0 : 1
      if (leftDel !== rightDel) return leftDel - rightDel
      return (left[1].t ?? 0) - (right[1].t ?? 0)
    })
    const keep = new Set(ranked.slice(entries.length - config.maxKeys).map(([key]) => key))
    const next = {}
    for (const [key, row] of entries) {
      if (keep.has(key)) next[key] = row
    }
    return next
  }

  return {
    filePath,
    recovered,
    allows,
    get seq() {
      return doc.seq
    },
    get size() {
      return Object.keys(doc.keys).length
    },
    diagnostics() {
      return {
        file: filePath,
        seq: doc.seq,
        keys: Object.keys(doc.keys).length,
        updatedAt: doc.updatedAt,
        recovered,
        lastWriteAt,
        lastWriteError,
        pendingWrite: dirty,
      }
    },
    /** Complete key map for the GET route. */
    snapshot() {
      const keys = {}
      for (const [key, row] of Object.entries(doc.keys)) {
        if (!allows(key)) continue
        keys[key] = row.del === true ? { del: true, at: row.at, t: row.t } : { v: row.v, at: row.at, t: row.t }
      }
      return { version: DOC_VERSION, seq: doc.seq, updatedAt: doc.updatedAt, keys }
    },
    /**
     * Render the boot-injection payload: `[key, valueOrNull, at]` triples in
     * ascending revision order, so a seeder applies them in one pass.
     */
    injection(limit) {
      const keys = []
      let truncated = false
      const ranked = Object.entries(doc.keys)
        .filter(([key]) => allows(key))
        .sort((left, right) => (left[1].at ?? 0) - (right[1].at ?? 0))
      for (const [key, row] of ranked) {
        const triple = [key, row.del === true ? null : row.v, row.at]
        keys.push(triple)
        if (limit !== undefined && JSON.stringify({ v: DOC_VERSION, seq: doc.seq, keys }).length > limit) {
          keys.pop()
          truncated = true
          break
        }
      }
      return { v: DOC_VERSION, seq: doc.seq, keys, truncated }
    },
    /**
     * Merge one browser batch. Keys outside the allowlist are ignored.
     * @param changes - `{ key: string | null }`; null records a deletion.
     * @param base - optional `{ key: number }` of the revisions the browser
     *   built its values on. A key whose revision moved on since then is not
     *   applied; it comes back as a conflict instead of overwriting silently.
     * @returns the wire result for the POST route.
     */
    applyChanges(changes, base) {
      if (!isRecord(changes)) return { ok: false, status: 400, reason: 'invalid-changes' }
      const guard = isRecord(base) ? base : undefined
      const accepted = []
      const ignored = []
      const conflicts = []
      const next = { ...doc, keys: { ...doc.keys } }
      let seq = doc.seq
      const now = Date.now()
      for (const [key, value] of Object.entries(changes)) {
        if (!allows(key)) {
          ignored.push(key)
          continue
        }
        if (value !== null && typeof value !== 'string') {
          return { ok: false, status: 400, reason: 'invalid-value', key }
        }
        if (typeof value === 'string' && value.length > config.maxBytes) {
          return { ok: false, status: 413, reason: 'value-too-large', key, bytes: value.length }
        }
        const existing = next.keys[key]
        const current = existing === undefined ? 0 : existing.at
        const expected = guard !== undefined && Object.hasOwn(guard, key) ? guard[key] : undefined
        if (typeof expected === 'number' && expected !== current) {
          conflicts.push({
            key,
            expected,
            current,
            at: current,
            value: existing === undefined || existing.del === true ? null : existing.v,
          })
          continue
        }
        seq += 1
        next.keys[key] = value === null ? { del: true, at: seq, t: now } : { v: value, at: seq, t: now }
        accepted.push([key, seq])
      }
      if (accepted.length === 0) {
        return { ok: true, seq: doc.seq, accepted: [], ignored, conflicts }
      }
      next.keys = prune(next.keys)
      next.seq = seq
      next.updatedAt = new Date(now).toISOString()
      const bytes = JSON.stringify(next).length
      if (bytes > config.maxBytes) {
        return { ok: false, status: 413, reason: 'snapshot-too-large', bytes, maxBytes: config.maxBytes }
      }
      doc = next
      scheduleWrite()
      return { ok: true, seq, accepted, ignored, conflicts }
    },
    /** Coalesced write, synchronous flush for shutdown. */
    flush() {
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
      writeNow()
    },
  }
}
