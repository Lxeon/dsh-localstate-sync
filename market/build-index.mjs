#!/usr/bin/env node
// Regenerate market/index.json from package.json, the npm registry, and icon.svg.
//
// A version is described by one exact source: the npm release when that version is on the
// registry, otherwise a pinned git commit (the market format does not accept a floating
// branch). Rebuild and push the index every time the plugin is released.
// Run: npm run market
//
// Value constraints come from @deepseek-ai/dsh-plugin-market-index: an exact SemVer
// version, an integer publishTimestamp in Unix seconds, a lowercase 40-hex commit, and
// an icon that is either an inline base64 data URL or a URL on https / the index origin.
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()

if (pkg.dsh?.bundle === undefined) throw new Error('package.json must declare dsh.bundle, or the entry is not installable')

const commit = git('rev-parse', 'HEAD')
const gitTimestamp = Number(git('log', '-1', '--format=%ct'))
// The index is read by other machines, so the URL comes from package.json (the public
// repository), never from this checkout's git remote, which may point somewhere private.
const remote = String(process.env.LSYNC_REPO_URL ?? pkg.repository?.url ?? '').replace(/\.git$/, '')
if (remote === '') throw new Error('package.json must declare repository.url, or set LSYNC_REPO_URL to the public repository')
const icon = `data:image/svg+xml;base64,${readFileSync(join(root, 'icon.svg')).toString('base64')}`

// Prefer the npm release: it is what the registry-based markets ingest, and it needs no
// commit pin. Fall back to a pinned commit when this version is not published yet.
async function npmRelease(name, version) {
  const url = `https://registry.npmjs.org/${name.replace('/', '%2f')}`
  try {
    const response = await fetch(url, { headers: { accept: 'application/json' } })
    if (!response.ok) return undefined
    const doc = await response.json()
    const published = doc.time?.[version]
    if (typeof published !== 'string') return undefined
    const seconds = Math.floor(Date.parse(published) / 1000)
    if (!Number.isInteger(seconds) || seconds <= 0) return undefined
    return { publishTimestamp: seconds, source: { type: 'npm' } }
  } catch {
    return undefined
  }
}

const release = (await npmRelease(pkg.name, pkg.version)) ?? {
  publishTimestamp: gitTimestamp,
  source: { type: 'git', url: `${remote}.git`, commit },
}

const index = {
  format: 1,
  title: { en: "Lxeon's DSH plugins", zh: 'Lxeon 的 DSH 插件' },
  description: {
    en: 'DSH plugins published from this repository, installable by pinned commit.',
    zh: '从本仓库发布的 DSH 插件，按固定提交安装。',
  },
  metadata: {
    categories: { ui: { title: { en: 'Interface', zh: '界面' } } },
    labels: {},
    sortKeys: {},
  },
  plugins: [
    {
      name: pkg.name,
      title: { en: 'Browser state sync', zh: '浏览器状态同步' },
      description: {
        en: 'Saves the localStorage values DSH plugins keep in this browser into $DSH_HOME, and restores them before the next boot.',
        zh: '把 DSH 插件留在这个浏览器里的 localStorage 值保存到 $DSH_HOME，并在下次启动前灌回去。',
      },
      icon,
      author: pkg.author ?? 'Lxeon',
      homepage: remote,
      repository: { url: remote },
      metadata: {
        category: 'ui',
        keywords: ['localstorage', 'sync', 'browser-state', 'config'],
        labels: [],
      },
      versions: [
        {
          version: pkg.version,
          publishTimestamp: release.publishTimestamp,
          source: release.source,
          engines: pkg.engines?.dsh === undefined ? {} : { dsh: pkg.engines.dsh },
        },
      ],
    },
  ],
}

const out = join(root, 'market', 'index.json')
writeFileSync(out, `${JSON.stringify(index, null, 2)}\n`)
console.log(`wrote ${out}`)
const where = release.source.type === 'npm' ? 'npm registry' : `git ${commit.slice(0, 8)}`
console.log(`  ${pkg.name}@${pkg.version} -> ${where} (${new Date(release.publishTimestamp * 1000).toISOString()})`)
