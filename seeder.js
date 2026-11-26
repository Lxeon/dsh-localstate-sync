/* Injected into <head> before the application boots. Restores snapshot keys
   whose revision is newer than the one this browser already applied, so a
   value written in another tab or another origin is not overwritten by a stale
   page. Deliberately dependency-free and failure-tolerant. */
;(function () {
  var data = globalThis.__DSH_LOCALSTATE__
  if (!data || data.v !== 1 || !Array.isArray(data.keys)) return
  var META_KEY = '__dsh.localstate.meta.v1'
  var meta
  try {
    meta = JSON.parse(localStorage.getItem(META_KEY) || 'null')
  } catch (error) {
    meta = null
  }
  if (!meta || typeof meta !== 'object' || !meta.at || typeof meta.at !== 'object') meta = { at: {} }
  var applied = 0
  for (var index = 0; index < data.keys.length; index += 1) {
    var row = data.keys[index]
    if (!Array.isArray(row) || row.length < 3) continue
    var key = row[0]
    var value = row[1]
    var revision = row[2]
    if (typeof key !== 'string' || typeof revision !== 'number') continue
    var known = typeof meta.at[key] === 'number' ? meta.at[key] : 0
    if (revision <= known) continue
    try {
      if (value === null) localStorage.removeItem(key)
      else if (typeof value === 'string') localStorage.setItem(key, value)
      else continue
      meta.at[key] = revision
      applied += 1
    } catch (error) {
      // Quota or a storage-denied frame leaves the key for the next boot.
    }
  }
  if (typeof data.seq === 'number' && data.seq > (typeof meta.seq === 'number' ? meta.seq : 0)) meta.seq = data.seq
  if (applied > 0 || data.seq !== undefined) {
    try {
      localStorage.setItem(META_KEY, JSON.stringify(meta))
    } catch (error) {
      // Metadata is an optimisation; a failed write only costs a redundant restore.
    }
  }
  globalThis.__DSH_LOCALSTATE_APPLIED__ = applied
})()
