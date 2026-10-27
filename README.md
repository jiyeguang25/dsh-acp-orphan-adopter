# dsh-acp-orphan-adopter

把侧栏「未分组（Ungrouped）」里的**孤儿会话按工作目录归回对应工作区**。只做归属，不移动、不改写、不删除任何会话文件。

## 它解决什么

- ACP（PyCharm 等编辑器）通过 `session.create({ cwd })` 建会话，该入口只记录工作目录、不登记工作区归属，所以这些会话在 GUI 侧栏落进「未分组」。
- DSH 自带的 `@deepseek-ai/dsh-workspace` 只在注册表**首次**初始化时按 cwd 归组一次（`bootstrap()`）；之后新产生的孤儿会话不会再被归组。
- 本插件在注册表所在进程（**desktop profile**）里定期补一次：没有归属 + 有可解析 cwd + 未归档的会话 → 挂到该 cwd 的工作区（工作区不存在则按 cwd 新建；`create()` 对同一规范路径幂等，不会重复建）。

## 安装

装进 **desktop** profile（工作区注册表只存在于 web/desktop 组合里；acp profile 没有工作区概念）：

1. `~/.dsh/profiles/desktop/package.json` 的 `dependencies` 加：
   `"dsh-acp-orphan-adopter": "file:C:/Users/yeguang/DSH/dsh-plugins/dsh-acp-orphan-adopter"`
2. 同文件 `dsh.profile.bundles` 追加 `"dsh-acp-orphan-adopter"`
3. 在 `~/.dsh/profiles/desktop` 执行 `pnpm install --config.minimumReleaseAge=0`
4. 校验 `dsh --profile desktop --dump-config`（退出码 0 且能搜到本包名）
5. **重启 DSH Desktop** 后生效

## 配置

见 `cordis.patch.yml` 的 `config`（改这里，不要在 desktop 的 `cordis.patch.yml` 里重复 insert，会 duplicate loader entry）：

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `startupDelayMs` | `8000` | 启动后首次扫描延迟 |
| `intervalMs` | `60000` | 扫描间隔；`0` = 只扫一次 |
| `dryRun` | `false` | 只报告不写入 |
| `onlyUnder` | `[]` | cwd 前缀白名单，空 = 全部 |
| `log` | `true` | 归入时打 info 日志 |

## 行为边界

- 已在任何工作区下的会话一律跳过；归档会话跳过。
- cwd 缺失、目录已不存在的会话跳过并记 `warn`，保持原样（它们会继续显示在「未分组」）。
- 不触碰 `sessionIds` 顺序之外的任何存储；不改会话文件、不动项目目录、不做删除。
- 关掉它：`enabled: false`，或从 bundles 移除本包并 `pnpm install`。