# 浏览器状态同步

这个应用里有些插件配置只存在 `localStorage`：快捷键绑定、右侧栏的 tab 布局、定时任务面板上次选中的 tab、插件市场上次选的 registry。清一次站点数据、换一个访问地址（默认端口和反向代理端口是两个不同的 origin）、或者换一个浏览器，这些设置就没了。

本 bundle 把它们存到 Host 侧的一个 JSON 文件，并在**页面启动之前**写回：

```
$DSH_HOME/localstate-sync/state.json
```

English: [docs/en.md](docs/en.md)

## 工作方式

1. **抓取**：客户端 bundle 覆盖 `Storage.prototype.setItem / removeItem / clear`，只对 `this === window.localStorage` 且键命中白名单的写入记账。原函数永远先调用，自己的记账逻辑包在 `try/catch` 里，不改变原调用的异常语义。400ms 免抖后合并成一次 `POST`。
2. **落盘**：Host 路由 `POST /api/localstate.v1` 把每个键合并进 JSON 文档，并赋予递增的 `at` 版本号。写入是原子的（`tmp` + `rename`），文件权限 `0600`，突发写入在 120ms 内合并。
3. **恢复**：`webserver/index-inject` 把快照以 `globalThis.__DSH_LOCALSTATE__` 写进 `<head>`，紧跟一段内联脚本，在应用启动前把值灌回 `localStorage`。因此**不需要刷新页面**，也不存在“别的插件在初始化时已经读到旧值”的竞态。
4. **不打架**：浏览器侧用 `__dsh.localstate.meta.v1` 记录每个键已应用的版本号，只有 Host 侧版本更新时才写回。删除写成 tombstone（`null`），所以删掉的键不会在下次启动时复活。
5. **冲突可见、可覆写**：每次写入都带上该键的基线版本 `base`。若这份副本在别的浏览器里已经前进，Host 不会用它覆盖，而是在响应里回一个 `conflicts` 项（含对方的当前值与版本号）；浏览器随即用新基线重发一次——刚编辑的一方按意图生效——若再次撞车则**保留本地值**、记进 `globalThis.__DSH_LOCALSTATE_CONFLICTS__`，并在配置表单里显示一行提示。不会无限重试；提示里的「强制推送」会给这批写入带上 `force`，明确覆盖云端。

## 提示

版本号（文件里的 `at`）对齐时**什么都不提示**。只有两种不一致会打扰你：

| 场景 | 提示 | 之后 |
| --- | --- | --- |
| 保存并推送时，本地版本比云端旧 | 右下角弹「推送失败：云端已更新到 revision N，请刷新后重试」 | 本地值仍显示，但**不再覆盖云端**；点刷新才会取用云端值 |
| 加载时，本地版本比云端旧 | 启动后提示「已更新到云端版本（N 项）」，点「查看」列出**具体哪些键**、各自的新 revision，以及 JSON 值的字段级 diff（`theme: "light" → "solar"`） | 已经是云端值，无需操作 |
| 同上，但你想保留本地值 | 同一个提示里点「强制推送」 | 该键以本地值覆盖云端（绕过 revision 校验），成功后会显示「已强制推送」 |

同一条推送失败的提示**不会刷屏**：同一个键在同一个云端 revision 上只提示一次，之后同一个键的新消息会更新原来那张卡片而不是再叠一张；点了「强制推送」后按钮也会换掉，不会一直挂着。

提示的语言由配置项 `language` 决定：`auto`（默认）先看浏览器语言，再看 DSH 自己的界面语言，都没有就用英文；设成 `zh` 或 `en` 则固定，设置表单的字段标签也一起跟着变。表单里存完立刻生效，不需要刷新。

冲突判定在写入侧：一批写入带 `base`（每个键写入时所基于的 `at`），Host 发现该键已经前进就返回
`conflicts`，客户端按新版本重发一次；再冲突就按上表报错。配置页里也会列出保留了本地值的键。

## 配置

在 **Plugins** 页打开本插件卡片，配置表单直接渲染在卡片里（值写回 profile 的 `cordis.patch.yml` 补丁层，改完插件会重启一次）。等价的 YAML：

```yaml
- insert:
    - id: localstate-sync
      name: '@leonhoy/dsh-localstate-sync'
      config:
        includePrefixes: ['dsh.']   # 采集这些前缀的键
        includeExact: []            # 额外采集的完整键名
        excludeExact: []            # 永不采集的完整键名
        maxBytes: 262144            # 单值与整份快照的上限（字节）
        maxKeys: 2000               # 键数量上限：先丢 tombstone，再丢最旧的
        injectMaxBytes: 131072      # 超过则不在 head 注入，改由页面 GET 拉取
        injectSnapshot: true        # false = 只保存，不自动恢复
        capture: true               # false = 停止采集（既有数据保留）
        file: 'localstate-sync/state.json'
        language: auto               # 提示与设置表单的语言：auto | en | zh
```

表单走的是 `GET/POST /api/localstate.config.v1`：GET 返回字段描述、当前值、哪些字段是被显式覆盖的、以及解析后的状态文件路径；POST 只提交改动过的字段，Host 先用 `configEditor` 校验再写 YAML，非法值会在落盘前被拒（`400`）。这个路由在插件被停用（`enabled: false`）时仍然可用，所以关掉了也能在界面上重新打开。

默认**不**收 `CONVERSATION_STORE_KEY.*`、宽度偏好这类会话级/纯 UI 的键，因为它们的键名不以 `dsh.` 开头；需要时显式加进 `includeExact`。

显式收集的典型例子：`dsh-purge` 的“用户须知”确认状态存在 `localStorage` 的 `dsh-purge-user-notice-v1`（值是 `"1"`，**不是 cookie**）。它的键名里是连字符而不是点，命中不了 `dsh.` 前缀，所以在新浏览器里会再弹一次。把它加进 `includeExact` 即可跨浏览器记住：

```json
{ "config": { "includeExact": ["dsh-purge-user-notice-v1"] } }
```

改完白名单后不需要刷新页面：表单保存成功会派发一个页内事件，客户端就地重新拉取配置（其他标签页里的改动仍以下次加载为准）。

## 边界与已知限制

- 只同步 `localStorage` 的**字符串值**。单个值超过 `maxBytes` 时整批被拒（`413`），不会截断。
- 快照按 profile 存一份。`localStorage` 本身仍按 origin 隔离，本插件的目的是让**不同 origin 拿到同一份值**，不是把 origin 合并。
- 持久化的是别人插件的私有格式。上游改了 schema 就会吃进旧值；DSH 侧读取是防御式的（解析失败只清自己那个键），所以最坏情况是该项被重置。
- Desktop（`file://`）下没有 `/api` 通道，客户端会跳过自己。
- 两个路由都是 `/api` 下的精确路由，由 Host 的 cookie 鉴权保护，只有 owner principal 能读写；不新增权限面。
- 配置表单注册在 `plugins.bundle.config` slot 上，键名就是包名。宿主若没有 `slots` 服务（极少见），表单不出现，采集与恢复不受影响。
- 冲突只在**写入**时判定。没有跨标签页/跨浏览器的实时推送（不监听 `storage` 事件），两边要下次加载才收敛；同一次冲突里保留的那方由重发顺序决定，不是合并算法。

## 安装

公开安装（按固定提交钉版本）：

```bash
dsh plugin --profile web add git+https://github.com/Lxeon/dsh-localstate-sync.git#<commit>
```

或者把插件市场索引
`https://raw.githubusercontent.com/Lxeon/dsh-localstate-sync/main/market/index.json`
加到 **Plugins → Discover → Add index source**。

本地开发用 **Plugins → Add plugin** 选择本目录，或调用 `plugin_manager` 的 `install_bundle`。

bundle 是**链接**进 profile 的（不是拷贝），所以改完文件刷新页面即可；反过来，移动或删除本目录会让安装失效。Host 侧代码改动不会热重载，需要在 Plugins 页把插件关掉再打开（或重启 web）才会重新 import。

`package.json` 里声明了 `schemastery` 依赖（`Config` schema 用），链接安装时依赖从本目录的 `node_modules` 解析，所以这里需要做过一次 `npm install`。

## 核对

```bash
cat "$DSH_HOME/localstate-sync/state.json"
```

每个键形如 `{"v": "...", "at": 12, "t": 1764...}`；`{"del": true}` 表示该键已删除、只留了 tombstone。

离线自检（不需要浏览器）：

```bash
node test/verify.mjs   # 73/73 checks passed
```

它用一个假的 Cordis ctx 跑真实的 Host 半边（路由注册、注入、合并、tombstone、白名单、配置路由、写冲突判定），用 `node:vm` 加载真实的客户端 bundle（slot 注册、config cell 键名、采集补丁是否装上、冲突重发一次后保留本地值且不循环），再跑注入的 seeder 脚本。

## 文件构成

| 文件 | 作用 |
| --- | --- |
| `index.js` | Host 半边：数据路由、配置路由、`Config` schema、`index-inject` |
| `store.js` | 文档读写：合并、版本号、tombstone、裁剪、原子落盘 |
| `seeder.js` | 注入 `<head>` 的内联脚本，启动前写回 `localStorage` |
| `client.js` | 浏览器半边：采集补丁、flush/重试、配置表单 |
| `cordis.patch.yml` | 插入 profile 的那一行（含默认 config） |
| `locale/*.json` | 插件标题/描述，以及详情文档指向 |
