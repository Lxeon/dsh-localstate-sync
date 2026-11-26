window.__ModuleLoader__.load({
  id: '@leonhoy/dsh-localstate-sync',
  factory(require) {
    var React = require('react')
    var META_KEY = '__dsh.localstate.meta.v1'
    var ROUTE = 'api/localstate.v1'
    var FLUSH_DELAY = 400
    var MAX_RETRY_DELAY = 15000
    var GUARD = '__DSH_LOCALSTATE_CAPTURE__'

    function routeUrl() {
      return new URL(ROUTE, document.baseURI).href
    }

    function defaultAllow() {
      return { prefixes: ['dsh.'], exact: [], exclude: [] }
    }

    function allowed(state, key) {
      if (typeof key !== 'string' || key === '' || key.length > 512) return false
      var allow = state.allow
      if (allow.exclude.indexOf(key) !== -1) return false
      if (allow.exact.indexOf(key) !== -1) return true
      for (var index = 0; index < allow.prefixes.length; index += 1) {
        if (allow.prefixes[index] !== '' && key.indexOf(allow.prefixes[index]) === 0) return true
      }
      return false
    }

    function readMeta() {
      var parsed
      try {
        parsed = JSON.parse(localStorage.getItem(META_KEY) || 'null')
      } catch (error) {
        parsed = null
      }
      if (!parsed || typeof parsed !== 'object' || !parsed.at || typeof parsed.at !== 'object') return { seq: 0, at: {} }
      var at = {}
      Object.keys(parsed.at).forEach(function (key) {
        if (typeof parsed.at[key] === 'number') at[key] = parsed.at[key]
      })
      return { seq: typeof parsed.seq === 'number' ? parsed.seq : 0, at: at }
    }

    function writeMeta(meta) {
      try {
        localStorage.setItem(META_KEY, JSON.stringify(meta))
      } catch (error) {
        // The metadata write is best effort; a failure costs one redundant restore.
      }
    }

    function applySnapshot(state, data) {
      if (!data || data.v !== 1 || !Array.isArray(data.keys)) return 0
      var meta = readMeta()
      var applied = 0
      for (var index = 0; index < data.keys.length; index += 1) {
        var row = data.keys[index]
        if (!Array.isArray(row) || row.length < 3) continue
        var key = row[0]
        var value = row[1]
        var revision = row[2]
        if (typeof key !== 'string' || typeof revision !== 'number') continue
        if (!allowed(state, key)) continue
        var known = typeof meta.at[key] === 'number' ? meta.at[key] : 0
        if (revision <= known) continue
        try {
          if (value === null) localStorage.removeItem(key)
          else if (typeof value === 'string') localStorage.setItem(key, value)
          else continue
        } catch (error) {
          continue
        }
        meta.at[key] = revision
        applied += 1
      }
      if (typeof data.seq === 'number' && data.seq > meta.seq) meta.seq = data.seq
      state.known = meta.at
      writeMeta(meta)
      return applied
    }

    function applyConfig(state, config) {
      if (!config || typeof config !== 'object') return
      var next = defaultAllow()
      if (Array.isArray(config.prefixes)) next.prefixes = config.prefixes.filter(function (item) { return typeof item === 'string' })
      if (Array.isArray(config.exact)) next.exact = config.exact.filter(function (item) { return typeof item === 'string' })
      if (Array.isArray(config.exclude)) next.exclude = config.exclude.filter(function (item) { return typeof item === 'string' })
      state.allow = next
      if (typeof config.capture === 'boolean') state.capture = config.capture
    }

    var BUNDLE_NAME = '@leonhoy/dsh-localstate-sync'
    var CONFIG_EVENT = 'dsh-localstate:config-changed'
    var CONFIG_ROUTE = 'api/localstate.config.v1'
    var FORM_CSS = [
      '.lssync-form{display:flex;flex-direction:column;gap:16px;max-width:720px;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary,#1f2328)}',
      '.lssync-lead{margin:0;color:var(--dsw-alias-label-secondary,#5b636e)}',
      '.lssync-field{display:flex;flex-direction:column;gap:6px;padding-bottom:14px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.18))}',
      '.lssync-field:last-of-type{border-bottom:none}',
      '.lssync-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.lssync-name{font-weight:600}',
      '.lssync-code{font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:12px;color:var(--dsw-alias-label-secondary,#5b636e)}',
      '.lssync-badge{font-size:11px;padding:1px 6px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.3));color:var(--dsw-alias-label-secondary,#5b636e)}',
      '.lssync-badge[data-on="true"]{border-color:var(--dsw-alias-brand-primary,#1f8a70);color:var(--dsw-alias-brand-primary,#1f8a70)}',
      '.lssync-help{margin:0;color:var(--dsw-alias-label-secondary,#5b636e)}',
      '.lssync-input,.lssync-area{font:inherit;color:inherit;background:var(--dsw-alias-bg-layer-1,transparent);border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.3));border-radius:6px;padding:6px 8px;width:100%;box-sizing:border-box}',
      '.lssync-area{resize:vertical;min-height:84px;font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:12px}',
      '.lssync-toggle{display:flex;align-items:center;gap:8px}',
      '.lssync-actions{display:flex;align-items:center;gap:12px;flex-wrap:wrap}',
      '.lssync-button{font:inherit;padding:6px 16px;border-radius:6px;border:1px solid transparent;cursor:pointer;background:var(--dsw-alias-brand-primary,#1f8a70);color:#fff}',
      '.lssync-button[disabled]{opacity:.55;cursor:default}',
      '.lssync-note{color:var(--dsw-alias-label-secondary,#5b636e)}',
      '.lssync-note[data-state="error"]{color:var(--dsw-alias-state-error,#c62828)}',
      '.lssync-warn{margin:0;color:var(--dsw-alias-state-warn,#a15c00)}',
    ].join('')

    var FORM_TEXT = {
      en: {
        lead: 'Values are written into the profile patch layer (cordis.patch.yml). Saving restarts this bundle, so capture pauses for a moment.',
        save: 'Save',
        saving: 'Saving…',
        saved: 'Saved.',
        restarting: 'Saved — applying the new configuration.',
        pending: 'Nothing changed yet.',
        unavailable: 'The configuration endpoint is unreachable. Reload the page and try again.',
        set: 'override',
        inherit: 'default',
        listHint: 'One entry per line.',
        invalid: 'This field needs a number.',
        rejected: 'Rejected',
        stateFile: 'State file',
        clashOne: '1 key kept its local value; the synced copy moved on. Reload to take the newer value:',
        clashMany: '{n} keys kept their local values; the synced copy moved on. Reload to take the newer values:',
      },
      zh: {
        lead: '值写入 profile 补丁层（cordis.patch.yml）。保存会重启本插件，采集会中断片刻。',
        save: '保存',
        saving: '保存中…',
        saved: '已保存。',
        restarting: '已保存，正在应用新配置。',
        pending: '还没有改动。',
        unavailable: '配置接口不可达，请刷新页面后重试。',
        set: '已覆盖',
        inherit: '默认',
        listHint: '每行一个条目。',
        invalid: '这个字段需要数字。',
        rejected: '被拒绝',
        stateFile: '状态文件',
        clashOne: '有 1 个键保留了本地值：云端已更新，刷新页面后才会取用云端值：',
        clashMany: '有 {n} 个键保留了本地值：云端已更新，刷新页面后才会取用云端值：',
      },
    }

    var FORM_LABELS_ZH = {
      enabled: '启用整个插件',
      capture: '采集浏览器对 localStorage 的写入',
      injectSnapshot: '页面启动前注入快照',
      file: '状态文件（相对 DSH home）',
      includePrefixes: '采集的键前缀',
      includeExact: '额外采集的完整键',
      excludeExact: '永不采集的完整键',
      maxBytes: '快照总字节上限',
      maxKeys: '保留的键数量上限',
      injectMaxBytes: '注入头部的字节上限',
      language: '提示与设置界面的语言',
    }

    var NOTICE_HOST_ID = '__dsh_localstate_toasts'

    var NOTICE_TEXT = {
      en: {
        pushFailed: 'Push failed: the synced copy already moved to revision {n}. Reload to take the newer value.',
        pulled: 'Restored {n} keys from the synced copy (the local values were older).',
        reload: 'Reload',
        dismiss: 'Dismiss',
      },
      zh: {
        pushFailed: '推送失败：云端已更新到 revision {n}，请刷新后重试。',
        pulled: '已更新到云端版本（{n} 项本地值更旧）。',
        reload: '刷新',
        dismiss: '关闭',
      },
    }

    function noticeText(language) {
      return NOTICE_TEXT[String(language || 'en').indexOf('zh') === 0 ? 'zh' : 'en']
    }

    function fillSlot(text, value) {
      return String(text).split('{n}').join(String(value))
    }

    function publishNotice(entry) {
      try {
        var list = globalThis.__DSH_LOCALSTATE_NOTICES__
        if (!Array.isArray(list)) list = []
        list.push(entry)
        while (list.length > 20) list.shift()
        globalThis.__DSH_LOCALSTATE_NOTICES__ = list
      } catch (error) {
        // Diagnostics only.
      }
    }

    function toastContainer() {
      var host = document.getElementById(NOTICE_HOST_ID)
      if (host) return host
      host = document.createElement('div')
      host.id = NOTICE_HOST_ID
      host.setAttribute('data-plugin', 'localstate-sync')
      host.style.cssText =
        'position:fixed;right:16px;bottom:16px;z-index:2147483000;display:flex;flex-direction:column;gap:8px;max-width:420px;pointer-events:none;font-family:inherit'
      document.body.appendChild(host)
      return host
    }

    /**
     * A synced value moved on: the write was refused, so say so instead of
     * silently keeping the local copy. The only way back to a shared value is a
     * reload, which is exactly what the notice offers.
     */
    function notice(kind, text, options) {
      var settings = options || {}
      publishNotice({ kind: kind, text: text, at: Date.now(), key: typeof settings.key === 'string' ? settings.key : null })
      try {
        if (typeof document === 'undefined' || !document.body) return
        var host = toastContainer()
        var card = document.createElement('div')
        card.className = 'lssync-toast lssync-toast-' + kind
        card.setAttribute('role', kind === 'error' ? 'alert' : 'status')
        card.style.cssText =
          'pointer-events:auto;display:flex;align-items:flex-start;gap:10px;padding:10px 12px;border-radius:10px;font-size:13px;line-height:1.45;' +
          'background:var(--dsw-alias-bg-overlay,#ffffff);color:var(--dsw-alias-label-primary,#111111);' +
          'border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));border-left:3px solid ' +
          (kind === 'error' ? 'var(--dsw-alias-state-error,#b3261e)' : 'var(--dsw-alias-brand-primary,#1f8a70)') +
          ';box-shadow:0 6px 24px rgba(0,0,0,.16)'
        var label = document.createElement('span')
        label.style.flex = '1'
        label.textContent = text
        card.appendChild(label)
        function button(text, action) {
          var element = document.createElement('button')
          element.type = 'button'
          element.textContent = text
          element.style.cssText =
            'appearance:none;border:0;background:transparent;cursor:pointer;padding:0 2px;font:inherit;color:var(--dsw-alias-brand-primary,#1f8a70)'
          element.addEventListener('click', action)
          card.appendChild(element)
          return element
        }
        function dismiss() {
          try {
            card.remove()
          } catch (error) {
            // The card may already be gone.
          }
        }
        if (kind === 'error') {
          button(settings.actionLabel || 'Reload', function () {
            try {
              location.reload()
            } catch (error) {
              // Nothing else to do if reload is blocked.
            }
          })
        }
        button(settings.dismissLabel || '×', dismiss)
        host.appendChild(card)
        if (kind !== 'error') setTimeout(dismiss, 8000)
      } catch (error) {
        // Notices are cosmetic; capture must keep working without them.
      }
    }
    function configUrl() {
      try {
        return new URL(CONFIG_ROUTE, document.baseURI).href
      } catch (error) {
        return CONFIG_ROUTE
      }
    }

    function formText(language) {
      return FORM_TEXT[String(language || 'en').indexOf('zh') === 0 ? 'zh' : 'en']
    }

    // The configured language wins ('zh' / 'en'); 'auto' follows the browser, then the DSH
    // locale, then the document language. The DSH UI itself may be English while the person
    // reading the notices is not, so the browser is asked before the app.
    var bootLanguage = 'auto'

    function configuredLanguage() {
      try {
        var snapshot = globalThis.__DSH_LOCALSTATE__
        if (snapshot && snapshot.config && typeof snapshot.config.language === 'string') return snapshot.config.language
      } catch (error) {
        // No injected snapshot: fall back to whatever refresh() learned.
      }
      return bootLanguage
    }

    function browserLanguage() {
      try {
        var list = navigator.languages !== undefined && navigator.languages.length > 0 ? navigator.languages : [navigator.language]
        for (var index = 0; index < list.length; index += 1) {
          if (typeof list[index] === 'string' && list[index] !== '') return list[index]
        }
      } catch (error) {
        // No navigator: fall through.
      }
      return undefined
    }

    function detectLanguage(ctx, props) {
      if (props && typeof props.language === 'string' && props.language !== '') return props.language
      var chosen = configuredLanguage()
      if (chosen === 'zh' || chosen === 'en') return chosen
      var browser = browserLanguage()
      if (browser !== undefined) return browser
      try {
        var snapshot = ctx.locale && typeof ctx.locale.getSnapshot === 'function' ? ctx.locale.getSnapshot() : undefined
        if (snapshot && typeof snapshot.active === 'string') return snapshot.active
      } catch (error) {
        // Falls through to the document language.
      }
      var declared = document.documentElement.getAttribute('lang')
      return typeof declared === 'string' && declared !== '' ? declared : 'en'
    }

    function createConfigForm(React, ctx) {
      var h = React.createElement

      function valueOf(draft, values, name) {
        return Object.prototype.hasOwnProperty.call(draft, name) ? draft[name] : values[name]
      }

      function asText(value) {
        if (Array.isArray(value)) return value.join('\n')
        if (value === undefined || value === null) return ''
        return String(value)
      }

      function asList(text) {
        return String(text)
          .split(/[\n,]/)
          .map(function (item) {
            return item.trim()
          })
          .filter(function (item) {
            return item !== ''
          })
      }

      return function LocalStateConfigForm(props) {
        var language = detectLanguage(ctx, props)
        var text = formText(language)
        var labels = String(language).indexOf('zh') === 0 ? FORM_LABELS_ZH : undefined

        var infoState = React.useState({ status: 'loading' })
        var info = infoState[0]
        var setInfo = infoState[1]
        var draftState = React.useState({})
        var draft = draftState[0]
        var setDraft = draftState[1]
        var noteState = React.useState({ text: '', error: false })
        var note = noteState[0]
        var setNote = noteState[1]
        var busyState = React.useState(false)
        var busy = busyState[0]
        var setBusy = busyState[1]
        var aliveState = React.useState(function () {
          return { value: true }
        })
        var alive = aliveState[0]

        function say(message, error) {
          setNote({ text: message, error: error === true })
        }

        function applyBody(body) {
          if (!body || body.ok !== true || !Array.isArray(body.fields)) return false
          setInfo({ status: 'ready', body: body })
          return true
        }

        function load() {
          fetch(configUrl(), { method: 'GET', credentials: 'same-origin', cache: 'no-store' })
            .then(function (response) {
              return response.ok ? response.json() : Promise.reject(new Error('HTTP ' + response.status))
            })
            .then(function (body) {
              if (alive.value) applyBody(body)
            })
            .catch(function (error) {
              if (!alive.value) return
              setInfo({ status: 'unavailable', message: String((error && error.message) || error) })
            })
        }

        React.useEffect(function () {
          alive.value = true
          if (globalThis.__DSH_LOCALSTATE_CONFIG_CSS__ !== true) {
            var style = document.createElement('style')
            style.setAttribute('data-plugin-css', '@leonhoy/dsh-localstate-sync/client-form')
            style.textContent = FORM_CSS
            document.head.appendChild(style)
            globalThis.__DSH_LOCALSTATE_CONFIG_CSS__ = true
          }
          load()
          return function () {
            alive.value = false
          }
        }, [])

        function edit(name, value) {
          setDraft(function (current) {
            var next = {}
            Object.keys(current).forEach(function (key) {
              next[key] = current[key]
            })
            next[name] = value
            return next
          })
          say('', false)
        }

        function changes(values) {
          var out = {}
          Object.keys(draft).forEach(function (name) {
            if (JSON.stringify(draft[name]) !== JSON.stringify(values[name])) out[name] = draft[name]
          })
          return out
        }

        function settle(expected, attempt) {
          fetch(configUrl(), { method: 'GET', credentials: 'same-origin', cache: 'no-store' })
            .then(function (response) {
              return response.ok ? response.json() : undefined
            })
            .then(function (body) {
              if (!alive.value) return
              var values = body && body.values ? body.values : {}
              var pending = Object.keys(expected).some(function (name) {
                return JSON.stringify(values[name]) !== JSON.stringify(expected[name])
              })
              if (body !== undefined) applyBody(body)
              if (!pending) say(text.saved, false)
              else if (attempt < 8) setTimeout(function () { settle(expected, attempt + 1) }, 600)
            })
            .catch(function () {
              if (alive.value && attempt < 8) setTimeout(function () { settle(expected, attempt + 1) }, 600)
            })
        }

        function save() {
          if (info.status !== 'ready' || busy) return
          var values = info.body.values || {}
          var payload = changes(values)
          if (Object.keys(payload).length === 0) {
            say(text.pending, false)
            return
          }
          var fields = {}
          info.body.fields.forEach(function (field) {
            fields[field.name] = field
          })
          var invalid = Object.keys(payload).some(function (name) {
            var field = fields[name]
            return field !== undefined && field.kind === 'number' && (typeof payload[name] !== 'number' || isNaN(payload[name]))
          })
          if (invalid) {
            say(text.invalid, true)
            return
          }
          setBusy(true)
          say(text.saving, false)
          fetch(configUrl(), {
            method: 'POST',
            credentials: 'same-origin',
            cache: 'no-store',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ config: payload }),
          })
            .then(function (response) {
              return response
                .json()
                .catch(function () {
                  return undefined
                })
                .then(function (body) {
                  return { ok: response.ok, status: response.status, body: body }
                })
            })
            .then(function (result) {
              if (!alive.value) return
              setBusy(false)
              if (!result.ok) {
                var reason = result.body && result.body.reason ? result.body.reason : 'HTTP ' + result.status
                var detail = result.body && result.body.message ? ': ' + result.body.message : ''
                say(text.rejected + ' (' + reason + detail + ')', true)
                return
              }
              setDraft({})
              say(text.restarting, false)
              var merged = {}
              Object.keys(values).forEach(function (name) {
                merged[name] = values[name]
              })
              Object.keys(payload).forEach(function (name) {
                merged[name] = payload[name]
              })
              settle(merged, 0)
              try {
                window.dispatchEvent(new Event(CONFIG_EVENT))
              } catch (error) {
                // Capture keeps working with the previous allowlist.
              }
            })
            .catch(function (error) {
              if (!alive.value) return
              setBusy(false)
              say(String((error && error.message) || error), true)
            })
        }

        if (props && props.view === 'summary') return null

        if (info.status === 'loading') {
          return h('p', { className: 'lssync-lead' }, '…')
        }
        if (info.status === 'unavailable') {
          return h('p', { className: 'lssync-lead' }, text.unavailable + (info.message ? ' (' + info.message + ')' : ''))
        }

        var body = info.body
        var values = body.values || {}
        var explicit = Array.isArray(body.explicit) ? body.explicit : []

        var rows = body.fields.map(function (field) {
          var value = valueOf(draft, values, field.name)
          var label = labels && labels[field.name] ? labels[field.name] : field.description
          var control
          if (field.kind === 'boolean') {
            control = h(
              'label',
              { className: 'lssync-toggle' },
              h('input', {
                type: 'checkbox',
                checked: value === true,
                onChange: function (event) {
                  edit(field.name, event.target.checked)
                },
              }),
              h('span', { className: 'lssync-help' }, field.name),
            )
          } else if (field.kind === 'number') {
            control = h('input', {
              className: 'lssync-input',
              type: 'number',
              value: value === undefined || value === null ? '' : String(value),
              min: field.min,
              max: field.max,
              step: 1,
              onChange: function (event) {
                var next = event.target.value === '' ? undefined : Number(event.target.value)
                edit(field.name, next)
              },
            })
          } else if (field.kind === 'array') {
            control = h('textarea', {
              className: 'lssync-area',
              spellCheck: false,
              rows: 4,
              value: asText(value),
              onChange: function (event) {
                edit(field.name, asList(event.target.value))
              },
            })
          } else if (field.kind === 'union' && Array.isArray(field.options) && field.options.length > 0) {
            control = h(
              'select',
              {
                className: 'lssync-input',
                value: value === undefined || value === null ? '' : String(value),
                onChange: function (event) {
                  edit(field.name, event.target.value)
                },
              },
              field.options.map(function (option) {
                return h('option', { key: option, value: option }, option)
              }),
            )
          } else {
            control = h('input', {
              className: 'lssync-input',
              type: 'text',
              spellCheck: false,
              value: asText(value),
              onChange: function (event) {
                edit(field.name, event.target.value)
              },
            })
          }
          var hints = []
          if (field.kind === 'array') hints.push(text.listHint)
          if (field.default !== undefined && field.kind !== 'array') hints.push('default: ' + String(field.default))
          if (field.kind === 'number' && field.min !== undefined) hints.push('min ' + field.min + (field.max !== undefined ? ', max ' + field.max : ''))
          return h(
            'div',
            { className: 'lssync-field', key: field.name },
            h(
              'div',
              { className: 'lssync-head' },
              h('span', { className: 'lssync-name' }, label),
              h('span', { className: 'lssync-code' }, field.name),
              h('span', { className: 'lssync-badge', 'data-on': explicit.indexOf(field.name) === -1 ? 'false' : 'true' }, explicit.indexOf(field.name) === -1 ? text.inherit : text.set),
            ),
            control,
            hints.length === 0 ? null : h('p', { className: 'lssync-help' }, hints.join(' · ')),
          )
        })

        var clashKeys = []
        try {
          var reported = globalThis.__DSH_LOCALSTATE_CONFLICTS__
          if (reported !== null && typeof reported === 'object') clashKeys = Object.keys(reported)
        } catch (error) {
          clashKeys = []
        }
        var clashRow =
          clashKeys.length === 0
            ? null
            : h(
                'p',
                { className: 'lssync-warn' },
                (clashKeys.length === 1 ? text.clashOne : text.clashMany.replace('{n}', String(clashKeys.length))) + ' ' + clashKeys.join(', '),
              )

        return h(
          'div',
          { className: 'lssync-form' },
          h('p', { className: 'lssync-lead' }, text.lead),
          h('p', { className: 'lssync-help' }, text.stateFile + ': ' + String(body.filePath || '')),
          clashRow,
          rows,
          h(
            'div',
            { className: 'lssync-actions' },
            h('button', { className: 'lssync-button', type: 'button', disabled: busy || body.writable !== true, onClick: save }, busy ? text.saving : text.save),
            note.text === '' ? null : h('span', { className: 'lssync-note', 'data-state': note.error ? 'error' : 'ok' }, note.text),
          ),
        )
      }
    }

    function service(ctx, name) {
      try {
        var value = ctx.get(name)
        if (value !== undefined && value !== null) return value
      } catch (error) {
        // Not registered yet; falls through to the guarded property read.
      }
      try {
        return ctx[name]
      } catch (error) {
        return undefined
      }
    }

    function registerConfigCell(ctx, React) {
      var slots = service(ctx, 'slots')
      if (slots === undefined || slots === null || typeof slots.register !== 'function') return
      var Component = createConfigForm(React, ctx)
      slots.inject('plugins.bundle.config', function () {
        return slots.register(
          {
            name: 'plugins.bundle.config',
            key: BUNDLE_NAME,
            inject: function () {
              return {}
            },
          },
          Component,
        )
      })
    }

    return {
      apply: function (ctx) {
        if (typeof window === 'undefined') return
        // `ctx.slots` is a guarded service read: touching an undeclared service
        // throws, so ask the context for it explicitly and fall back quietly.
        registerConfigCell(ctx, React)
        if (typeof localStorage === 'undefined') return
        if (location.protocol === 'file:') return
        if (window[GUARD] === true) return

        var state = {
          allow: defaultAllow(),
          capture: true,
          known: {},
          /** Revisions the local values were built on, sent as the write guard. */
          base: {},
          /** Keys that already lost one conflict and keep their local value. */
          conflicts: {},
          /** Keys resent once with a refreshed base, to avoid a ping-pong loop. */
          retried: {},
          pending: new Map(),
          timer: undefined,
          retryTimer: undefined,
          retry: 0,
          inflight: false,
        }

        var injected = globalThis.__DSH_LOCALSTATE__
        if (injected && Array.isArray(injected.prefixes)) state.allow.prefixes = injected.prefixes
        state.known = readMeta().at
        state.base = { ...state.known }
        applySnapshot(state, injected)

        // The head seeder runs before the app boots and reports how many keys it
        // replaced with a newer synced copy. Nothing to say when it replaced none.
        var restored = 0
        try {
          if (typeof globalThis.__DSH_LOCALSTATE_APPLIED__ === 'number') restored = globalThis.__DSH_LOCALSTATE_APPLIED__
        } catch (error) {
          restored = 0
        }
        if (restored > 0) {
          var bootText = noticeText(detectLanguage(ctx, {}))
          notice('info', fillSlot(bootText.pulled, restored), { dismissLabel: bootText.dismiss })
        }

        function schedule() {
          if (state.timer !== undefined) return
          state.timer = setTimeout(function () {
            state.timer = undefined
            flush(false)
          }, FLUSH_DELAY)
        }

        function requeue(sending) {
          for (var index = 0; index < sending.length; index += 1) {
            var key = sending[index][0]
            if (!state.pending.has(key)) state.pending.set(key, sending[index][1])
          }
        }

        function scheduleRetry() {
          if (state.retryTimer !== undefined) return
          var delay = Math.min(MAX_RETRY_DELAY, 1000 * Math.pow(2, state.retry))
          state.retry = Math.min(state.retry + 1, 4)
          state.retryTimer = setTimeout(function () {
            state.retryTimer = undefined
            flush(false)
          }, delay)
        }

        function publishConflicts() {
          try {
            globalThis.__DSH_LOCALSTATE_CONFLICTS__ = state.conflicts
          } catch (error) {
            // Diagnostics only.
          }
        }

        function adopt(sending, body) {
          if (!body || body.ok !== true || !Array.isArray(body.accepted)) {
            requeue(sending)
            scheduleRetry()
            return
          }
          var meta = readMeta()
          for (var index = 0; index < body.accepted.length; index += 1) {
            var pair = body.accepted[index]
            if (!Array.isArray(pair)) continue
            if (typeof pair[0] === 'string' && typeof pair[1] === 'number') {
              meta.at[pair[0]] = pair[1]
              state.base[pair[0]] = pair[1]
            }
          }
          if (typeof body.seq === 'number') meta.seq = body.seq
          if (Array.isArray(body.conflicts)) adoptConflicts(sending, body.conflicts, meta)
          state.known = meta.at
          writeMeta(meta)
          state.retry = 0
        }

        /**
         * A key whose base revision moved on was not applied. Resend it once with
         * the fresh base; if it conflicts again the write FAILED: keep the local
         * value visible, leave the base revision untouched (so a reload really
         * does pull the newer synced copy), and tell the user to reload.
         */
        function adoptConflicts(sending, conflicts, meta) {
          var local = {}
          var changed = false
          for (var index = 0; index < sending.length; index += 1) local[sending[index][0]] = sending[index][1]
          for (var cursor = 0; cursor < conflicts.length; cursor += 1) {
            var row = conflicts[cursor]
            if (row === null || typeof row !== 'object' || typeof row.key !== 'string') continue
            if (!Object.hasOwn(local, row.key)) continue
            if (state.retried[row.key] !== true) {
              state.retried[row.key] = true
              if (typeof row.current === 'number') state.base[row.key] = row.current
              if (!state.pending.has(row.key)) state.pending.set(row.key, local[row.key])
              changed = true
              continue
            }
            state.conflicts[row.key] = { local: local[row.key], remote: row.value, at: row.current }
            var failure = noticeText(detectLanguage(ctx, {}))
            notice('error', fillSlot(failure.pushFailed, row.current), {
              key: row.key,
              actionLabel: failure.reload,
              dismissLabel: failure.dismiss,
            })
          }
          publishConflicts()
          if (changed) schedule()
        }

        function flush(useBeacon) {
          if (state.capture === false || state.inflight || state.pending.size === 0) return
          var changes = {}
          var base = {}
          var hasBase = false
          var sending = []
          state.pending.forEach(function (value, key) {
            changes[key] = value
            sending.push([key, value])
            if (typeof state.base[key] === 'number') {
              base[key] = state.base[key]
              hasBase = true
            }
          })
          var payload = JSON.stringify(hasBase ? { changes: changes, base: base } : { changes: changes })
          state.pending.clear()
          if (useBeacon && typeof navigator.sendBeacon === 'function' && payload.length < 60000) {
            try {
              navigator.sendBeacon(routeUrl(), new Blob([payload], { type: 'application/json' }))
            } catch (error) {
              requeue(sending)
            }
            return
          }
          state.inflight = true
          fetch(routeUrl(), {
            method: 'POST',
            credentials: 'same-origin',
            cache: 'no-store',
            headers: { 'content-type': 'application/json' },
            body: payload,
            keepalive: payload.length < 60000,
          })
            .then(function (response) {
              return response.ok ? response.json() : undefined
            })
            .then(function (body) {
              state.inflight = false
              adopt(sending, body)
            })
            .catch(function () {
              state.inflight = false
              requeue(sending)
              scheduleRetry()
            })
        }

        function refresh() {
          fetch(routeUrl(), { method: 'GET', credentials: 'same-origin', cache: 'no-store' })
            .then(function (response) {
              return response.ok ? response.json() : undefined
            })
            .then(function (body) {
              if (body === undefined) return
              applyConfig(state, body.config)
              if (typeof body.config === 'object' && body.config !== null && typeof body.config.language === 'string') {
                bootLanguage = body.config.language
              }
              applySnapshot(state, body)
            })
            .catch(function () {
              // The injected snapshot already covered this boot.
            })
        }

        ctx.effect(function () {
          window[GUARD] = true
          var proto = window.Storage && window.Storage.prototype
          var originals = proto === undefined ? undefined : {
            setItem: proto.setItem,
            removeItem: proto.removeItem,
            clear: proto.clear,
          }

          function observe(key, value) {
            if (!allowed(state, key)) return
            state.pending.set(key, value)
            schedule()
          }

          if (originals !== undefined) {
            proto.setItem = function (key, value) {
              var result = originals.setItem.call(this, key, value)
              try {
                if (this === window.localStorage) observe(String(key), String(value))
              } catch (error) {
                // Capture never changes the outcome of the original call.
              }
              return result
            }
            proto.removeItem = function (key) {
              var result = originals.removeItem.call(this, key)
              try {
                if (this === window.localStorage) observe(String(key), null)
              } catch (error) {
                // See above.
              }
              return result
            }
            proto.clear = function () {
              var result = originals.clear.call(this)
              try {
                if (this === window.localStorage) {
                  var known = Object.keys(readMeta().at).concat(Object.keys(state.known))
                  for (var index = 0; index < known.length; index += 1) observe(known[index], null)
                }
              } catch (error) {
                // See above.
              }
              return result
            }
          }

          var onHide = function () {
            if (document.visibilityState === 'hidden') flush(false)
          }
          var onPageHide = function () {
            flush(true)
          }
          /** The config form saved: pick the new allowlist up without a reload. */
          var onConfigChanged = function () {
            refresh()
          }
          document.addEventListener('visibilitychange', onHide)
          window.addEventListener('pagehide', onPageHide)
          window.addEventListener(CONFIG_EVENT, onConfigChanged)

          refresh()

          return function () {
            if (originals !== undefined) {
              proto.setItem = originals.setItem
              proto.removeItem = originals.removeItem
              proto.clear = originals.clear
            }
            document.removeEventListener('visibilitychange', onHide)
            window.removeEventListener('pagehide', onPageHide)
            window.removeEventListener(CONFIG_EVENT, onConfigChanged)
            if (state.timer !== undefined) clearTimeout(state.timer)
            if (state.retryTimer !== undefined) clearTimeout(state.retryTimer)
            window[GUARD] = false
            flush(false)
          }
        }, 'localstate-sync: browser capture')
      },
    }
  },
})
