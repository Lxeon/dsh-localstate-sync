# 插件市场索引

`index.json` 是 DSH 插件市场索引 **format 1** 的一份文档，用官方校验器
（`@deepseek-ai/dsh-plugin-market-index` 的 `parseMarketIndex`）验过。

它把本插件登记成一条 **git 源**条目，安装参数就是这个仓库的一个固定提交：

```
git+https://github.com/Lxeon/dsh-localstate-sync.git#<commit>
```

固定提交是格式要求（`source.commit` 必须是 40 位小写 hex），所以**每次发版都要重建索引并推送**。

## 重建

```sh
node market/build-index.mjs        # 或 npm run market
```

脚本从 `package.json` 取名字、版本、`engines.dsh`、`repository.url`，从 git 取 `HEAD`
与提交时间，从 `icon.svg` 生成内联 base64 图标（608 字节，远低于 32 KiB 上限），然后覆盖
写 `index.json`。仓库地址只认 `package.json` 的 `repository.url`（可用 `LSYNC_REPO_URL`
覆盖），**不读本机 git remote** —— 本地 checkout 可能指向别的、不该出现在索引里的地址。

顺序上有个先有鸡还是先有蛋：`index.json` 要写的提交是它自己所在的那次提交。做法是

1. 提交插件代码（记下提交号）；
2. `node market/build-index.mjs`（此时钉在上一步的提交）；
3. 单独提交 `market/index.json`。

于是索引钉的提交永远比仓库 `HEAD` 早一个提交——这没关系，那个提交里的代码是可安装的完整包。

## 托管

市场索引由 **DSH Host 进程**用 `fetch` 直接读，**不带任何凭据**，也不跟随跳转。
所以索引 URL 必须能被 Host 匿名取到，安装（pnpm 的 git 拉取）同理：

| 托管 | 索引直链 |
|---|---|
| GitHub 公开仓库 | `https://raw.githubusercontent.com/Lxeon/dsh-localstate-sync/refs/heads/main/market/index.json` |
| GitHub Pages / 任意静态站 | 指向 `market/index.json` 的 https 直链 |

> 用 `refs/heads/main` 形态而不是 `main`：后者是 `raw.githubusercontent.com` 的 CDN 缓存（`max-age=300`），刚推完几分钟内可能还是旧内容；`refs/heads/main` 每次取最新。

仓库若是 private，`raw.githubusercontent.com` 会返回 404，Discover 报
`plugin-market/fetch-failed`，安装也会失败——索引和安装两头都断。

## 挂到本地 DSH

**Plugins → Discover → Add index source**，填上面的 URL。索引源存在 profile 的
`plugin-market` 行配置里（`indexes` 字段，volatile，切换不需要重启服务），
`plugin_market` 工具随后就能列出它。

索引里给了 `engines.dsh = ^0.2.2-rc.5`，与之不匹配的 Host 会判为不兼容并拒绝安装。
