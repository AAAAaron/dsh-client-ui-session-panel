# dsh-client-ui-session-panel · 会话总览面板（看板版）

给 DSH Web GUI 加两处会话入口，都是**卡片式**：

1. **会话浮窗**（最省事）：对话头部点「浮窗」按钮，会话卡片直接浮成一个可拖动窗口——
   拖标题栏移位置、拖右下角缩放，位置记在本机。**点卡片，中间对话就切过去，浮窗不关。**
2. **右侧栏卡片**：对话头部点「会话」按钮，右侧常驻一列会话卡片（同样点卡片切会话、栏不关）。
2. **主区看板**（用来总览）：左栏「会话」入口打开的整页看板，每个工作区一条泳道、
   一行约 10 张卡，按最近活动排序，可拖动排序。

两处共用同一套分组与数据逻辑，**纯只读**（除拖动排序会写宿主的会话顺序）。

## 为什么做

官方左侧栏是按工作区分组的会话列表，但默认只展开前面的几条（水位线），要点「展开其余」
一次次往下翻；跨工作区找一个旧会话很费劲。这个面板补的是「一眼看全 + 直接跳」：

- 一屏铺开全部会话：工作区泳道 + 卡片网格，不用滚动横向、不用逐级展开
- 泳道表头显示工作区名 / 路径 / 会话数；「全部折叠 / 全部展开」一键切换
- 不想看的工作区可以 ✕ 隐藏，「管理隐藏」里随时恢复（含「全部恢复」）
- 卡片脚上是状态点：等待用户（黄）、运行中（绿）、已完成未读（绿）、空闲（灰）
- 当前会话的卡片带蓝色左侧竖条 +「当前」标签；已归档卡片灰掉且不可点
- 点任意卡片 → 直接切到该会话并回到对话
- **拖动卡片排序**（限同一工作区内），顺序写回宿主、跨设备一致；默认仍按最近活动，
  拖过之后自动切到「手动顺序」，头部按钮可随时切回
- **右侧栏卡片栏**：对话头部「会话」按钮开关，点卡片切会话、栏不关；右栏宽度可拖、可全屏

折叠与隐藏记在浏览器 localStorage，**只影响这个面板**；不动官方侧栏、不写宿主状态。

## 排序规则

| 层级 | 按什么排 |
| --- | --- |
| 工作区泳道之间 | **该工作区最近一次活动时间倒序**（取泳道内最新那条会话的 `updatedAt`）；时间相同时保持宿主的工作区顺序（`sort` 稳定） |
| 泳道内卡片（默认「最近活动」） | **最后活动时间倒序**（`SessionSummary.updatedAt`，也就是官方左栏每行显示的那个时间） |
| 泳道内卡片（「手动顺序」） | 宿主保存的顺序（官方左栏的会话顺序），也就是拖动排序后你看到的那份 |

`updatedAt` 由宿主会话列表给出，本插件不做任何时间推断。
如果想让泳道回到「宿主注册表顺序」（即官方左栏工作区顺序），把
`lib/client.js` 里 `buildModel` 末尾那行 `groups.sort(...)` 删掉即可。

## 一键筛选：最近 20 个 / 近半小时有变化

会话多了不好找时，头部（或右栏、浮窗里的紧凑版）有一组三个互斥按钮：

| 按钮 | 效果 |
|---|---|
| **全部会话** | 显示全部（默认） |
| **最近 20 个** | 只留下最后活动时间最近的 20 个会话，其余不渲染 |
| **近半小时有变化** | 只留下最后活动时间落在最近 30 分钟内的会话 |

- 筛选是**跨工作区**的：「最近 20 个」指全部会话里最近的 20 个，不是每个工作区各 20 个。
- 当前会话**始终保留**，不会因为筛选而"找不到自己在哪"。
- 筛选后不再有空的工作区泳道；页头会显示「筛选后显示 20/105 个」。
- 三处视图（工作区看板 / 右侧卡片栏 / 浮窗）共用一个状态：在一处切换，另外两处同步。
- 选择记在本机 `dsh.session-panel.filter.v1`，重启后保持；点已选中的按钮不会取消，
  要回到全量请点「全部会话」。

## 卡片上的两个小按钮：隐藏 / 归档

鼠标移到卡片上，右上角出现两个图标（键盘 Tab 聚焦也会出现）：

- **隐藏（斜杠眼睛）**：只在这个面板里藏起来，**不动官方侧栏**，记录存在本机
  `dsh.session-panel.hidden-sessions.v1`。头部会出现「已隐藏 N 个」，点一下把隐藏的
  卡片显示出来（虚线框 + 恢复按钮），点恢复即回到原状。
- **归档（盒子）**：走官方 `archiveSession`，归档后官方侧栏和本面板都不再显示；
  官方侧栏的「取消归档」能把恢复回来。**要连点两下确认**（第一下按钮变成「确认」，
  3 秒内再点才真的归档，避免误触）。

## 哪些会话不显示（对齐官方侧栏）

面板不是"把会话日志全列出来"，而是照官方左栏的口径过滤：

| 不显示 | 依据 |
|---|---|
| 子代理会话（`origin === "subagent"`） | 官方 `sessionVisible` 第一条 |
| 非当前的空会话（点「新会话」留下的占位） | `session.blank && id !== current` |
| **已归档会话** | 官方默认 `archivedFilter: "default"` 就是隐藏 |
| **不在任何工作区里的会话** | 官方左栏只列工作区成员；这类会话在左栏属于「未分组」桶，面板不重复列 |

之前面板里出现过"归档还能看到""左栏看不见的会话这里却能看到"，就是后两条没对齐。

## 空会话不显示（同官方侧栏）

点「新会话」时宿主会先建一条**占位会话**（日志里只有配置、没有任何消息），用掉之前它会一直留在
会话目录里。官方侧栏的规则是**空会话只显示当前那一条，其余一律不显示**：

```js
// dsh-client-ui-workspace/lib/client.js
if (session.blank && session.id !== current) return false;
```

本面板跟随这条规则，所以「（新会话）」只在它是当前会话时出现一次；被藏掉多少条写在标题下的
元信息里（例如 `69 个会话 · 6 个工作区 · 隐藏 24 个空会话`）。这些空会话**仍然在磁盘上**，
本面板只读、不删除也不归档。

## 可拖动的会话浮窗

右栏卡片栏的头部有个「浮动」按钮：点它把卡片栏**浮成一个独立窗口**，
之后就可以拖着走了——比固定在右栏灵活，也不再挤占对话宽度。

- **拖标题栏**移动，**拖右下角**缩放，位置和大小都记在本机
- **点 ✕ 关闭**；刷新页面后会回到上次的位置和大小（如果关着就还是关着）
- 浮窗挂在官方的全框浮层 `shell.overlay` 上（这层本身点击穿透、条目自己接管指针），
  所以它浮在所有栏之上，也不会挡住底下的操作
- 卡片列表和右栏共用同一套分组/排序逻辑，点卡片的切会话行为一致
- 官方的右栏 tab 条**不支持拖动排序**（代码里没有 draggable），
  所以"调整位置"这件事是通过这个浮窗做到的，而不是去改官方 tab 条

## 右侧栏卡片（与对话并排）

- **入口**：对话头部那一排小按钮里的「会话」（`conversation.session.header.utilities` 座位），
  点一下展开、再点收起。也可以在右栏自己的"打开右侧边栏"里从指南条目「会话卡片」打开。
- **行为**：点卡片 → 中间会话切过去，右栏不关、当前卡片高亮；连续点就是连续切。
- **为什么不做成"我的面板分两半"**：官方主区同时只显示一个面板，对话没法嵌进我的面板里；
  右栏是官方唯一"和对话并排"的接缝（和文件/终端/交付物同一套 tab 系统）。
- **宽度**：默认约屏幕 1/4~1/3，一行 3~6 张卡（`auto-fill` 自适应），可拖宽或全屏。
- **卡片可以直接拖动排序**：在右栏里拖动卡片（同一工作区内），松手即写回宿主顺序，
  并自动切到「手动」顺序；未分组那条泳道不支持拖动。
- **注意**：右侧 tab 是**按会话**记录的，所以点卡片切到别的会话时，会用
  `openTabIn` + 两次延时补开把卡片栏一并带过去；切到没开过的会话时可能有一帧空白。
- 空白「新会话」是 hero 页、没有对话头部，所以按钮只在真实会话里出现。

## 拖动排序（限同一工作区内）

- **怎么拖**：按住卡片拖到目标位置。落在卡片**左半**＝插到它前面，**右半**＝插到它后面，
  落在**网格空白处**＝追加到该工作区末尾。拖动时目标卡片会出现一条蓝色标记线。
- **先切模式再拖**：默认按最近活动显示，拖一次之后自动切到「手动顺序」——因为写回的是
  宿主的顺序（`insertSessionBefore`），显示模式必须跟着切，否则松手后位置会被时间序顶回去。
  头部「卡片顺序：…」按钮可在两种模式间来回切。
- **不中途重排**：模式切换发生在**松手之后**，拖动过程中卡片不会从指针底下跑掉。
- **只能同工作区内**：官方接缝 `insertSessionBefore` 只支持「在一个工作区内移动」，
  拖到别的泳道会被忽略。跨工作区搬会话需要直接改写会话日志，风险高，建议用
  `dsh-session-manager` 那类插件，不在本插件范围内。
- **不可拖的卡片**：「未分组」泳道没有可保存的顺序；已归档卡片本身不可点开。两者都不参与拖动。
- **会改官方顺序**：写的是宿主的工作区记账，所以官方左栏的会话顺序会同步变化（同一份数据）。

**每行几张卡**由 `lib/client.js` 顶部的常量决定，改一个数字即可：

```js
const CARDS_PER_ROW = 10;
```

窄屏由 CSS 断点自动降级（≤1280px 8 张、≤1024px 6 张、≤800px 4 张、≤560px 2 张）。
实测（侧栏展开、含 91 个会话 / 7 个工作区）：1600px 视口 → 10 列 × 117px；
1440px → 10 列 × 101px；1280px → 8 列 × 109px。

## 数据来源（全部是官方公开接缝）

| 用途 | 来源 |
| --- | --- |
| 会话目录 | `useSessions`（全局标准席位，`SessionListState`） |
| 会话状态点 | `useSessionStatus`（running / pendingInteraction / completionUnread） |
| 工作区与分组归属 | `useWorkspaces`（`WorkspaceSnapshot.items[].sessionIds`） |
| 已归档集合 | `WorkspaceSnapshot.archivedSessionIds` |
| 当前会话 | 行的 `retainedBy.mainView > 0`（官方主视图独占引用） |
| 切换会话 | `ctx.uiWorkspace.openSession(id)`（内部会 `selectPanel(null)` 回到对话） |
| 拖动排序写回 | `ctx.workspaces.insertSessionBefore(workspaceId, sessionId, beforeSessionId)`（宿主持久化） |
| 右栏 tab 类型登记 | `ctx.sidebarRightTabs.register({ id, kind, keepMounted, title, guide })` |
| 右栏开关 | `ctx.sidebarRight.openTab(kind)` / `openTabIn(sessionId, kind)` / `toggleExpanded()` |

分组只用官方的归属关系（`WorkspaceView.sessionIds`），不按路径前缀猜；子代理会话与官方
一致地不显示。

## 从 GitHub 安装（换机器时）

就是本仓库。

```sh
# 1) 装进某个 profile
dsh plugin --profile web add "github:AAAAaron/dsh-client-ui-session-panel"

# 2) 确认它在该 profile 的 dsh.profile.bundles 里；没有就手动加一行
#    文件：<DSH_HOME>/profiles/web/package.json → dsh.profile.bundles: ["dsh-client-ui-session-panel", ...]

# 3) 重启
dsh web
```

装完的判定：左栏多出「会话」，对话头部多出「会话」按钮。

## 安装 / 卸载

包里已登记到 `~/.dsh/profiles/web`：

- `dependencies` 里有 `"dsh-client-ui-session-panel": "link:<本目录>"`
- `package.json` 的 `dsh.profile.bundles` 末尾有 `dsh-client-ui-session-panel`
- `node_modules/dsh-client-ui-session-panel` 是指向本目录的软链

重装：

```sh
dsh plugin --profile web add "github:AAAAaron/dsh-client-ui-session-panel"
```

卸载（两步都要做）：

```sh
dsh plugin --profile web remove dsh-client-ui-session-panel
# 再从 profiles/web/package.json 的 dsh.profile.bundles 里删掉同名条目
```

改完客户端代码要重启 `dsh web` 并硬刷新浏览器（Ctrl/Cmd+Shift+R）：宿主组合只在启动时
组装一次。

## 验证

1. 离线冒烟（不启动 DSH、不联网，用假 window/document/React 评价 bundle）：

   ```sh
   node test/smoke.mjs
   ```

   覆盖：分组与排序、未分组归集、子代理过滤、归档标记、当前会话识别、相对时间文案、
   泳道与卡片结构、两个座位的注册、`openSession` 转发。

2. 浮窗专项（headless Chrome + CDP，7 项断言）：`test/float-probe.mjs`
   覆盖「浮动」出窗、拖标题栏移动、拖右下角缩放、几何写进本机存储、
   刷新后位置保留、✕ 关闭。用真实鼠标事件驱动，和用户实际拖动一致。

3. 真实浏览器端到端（headless Chrome + CDP，34 项断言）：

   ```sh
   # 1) 用真实 web profile 另起一个临时实例（不碰正在跑的那个）
   #    注意：profile 里 remote-web-ui 的托管块把 webserver 端口钉在 3080，
   #    所以必须用后置 --patch 覆盖端口；同时关掉 remote-web-ui，
   #    免得它把 profile 里的托管端口改写成临时端口。
   cat > /tmp/dsh-temp.yml <<'YML'
   - id: web-ui-remote-web-ui
     disabled: true
   - id: webserver
     config:
       host: '127.0.0.1'
       port: 3099
   YML
   dsh --profile web --patch /tmp/dsh-temp.yml --no-open

   # 2) 另开一个 headless Chrome
   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu \
     --user-data-dir=/tmp/dsh-chrome --remote-debugging-port=9223 --window-size=1600,1000 about:blank

   # 3) 用打印出来的 token 跑检查
   DSH_VERIFY_BASE=http://127.0.0.1:3099 node test/browser-check.mjs <token> /tmp/shot.png
   ```

   实测结果：左栏出现「会话」入口；看板渲染 92 个会话 / 7 个工作区；泳道排序、隐藏、
   折叠、展开、恢复、点卡片切会话、空会话隐藏、顺序模式切换、**拖拽排序**与**右侧栏卡片**
   （出现/展开/点卡片切会话/栏不关/收起/重新展开）、浮窗出现与关闭、页面无 JS 异常
   共 34 项断言。

   ⚠️ 拖拽那一组会**真的写一次宿主顺序**（这是它验证的东西），所以脚本只挑卡最少的
   可用泳道，跑完按原顺序还原，并断言「已还原」。运行前它还会清掉本面板的
   localStorage 设置，保证每次都是干净的初始状态。

## 已知限制

- 同一份 profile 不能同时起两个实例：remote-web-ui 的托管块把端口钉死在 3080，
  `--port` 会被它覆盖；要并存只能用后置 `--patch` 覆盖端口（如上）。
- 卡片约 100–120px 宽，标题最多两行（悬停 tooltip 看全文）。想更宽松就把
  `CARDS_PER_ROW` 调小。
- 时间文案在面板打开期间不自动刷新（随会话列表变化重渲染）。
- 「隐藏工作区」只藏本面板的泳道，不影响官方侧栏。想连官方侧栏一起隐藏得用别的插件
  （如 `dsh-session-manager`）。
- 依赖 `dsh-client-ui-sidebar` 的 `sidebar.panellist` 与 `dsh-client-ui-layout` 的 `main`
  座位名；DSH 改这两个座位名时需要跟着改。
- 已归档会话不可点（点开需要先取消归档，官方语义如此），也不参与拖动排序。
- 浮窗位置/大小存在**本机** `localStorage`，换机器不会带过去。
- 头部「会话」按钮的高亮依赖右栏控制器的状态，偶尔会比实际晚一拍（外观问题，不影响开关）。
- 会话多的时候（100+）每张卡片有状态点/时间，重渲染已做浅比较优化；
  如果仍觉得卡，优先用「浮窗」那条：浮窗不在右栏的容器的里，负载更小。
- 右栏 `isExpanded()` 的内部状态和"屏幕上到底看不看得见"偶尔不一致（官方侧栏自己
  也有这个竞态），所以「收起后再点按钮展开」这条路偶尔要多点一次。
- 跨工作区搬移会话不在范围内（官方接缝不支持；建议用 `dsh-session-manager`）。
- 「手动顺序」模式下卡片顺序就是官方左栏的顺序；如果官方左栏那边调过顺序，这里会跟着变。

## 文件

```
package.json          插件清单：dsh.client 声明 + bundle patch 指向
cordis.patch.yml      宿主组合里的占位条目（纯 UI 插件，空 apply）
lib/index.js          宿主半侧：空 apply
lib/client.js         浏览器半侧：手写 __ModuleLoader__ bundle（无构建步骤）
test/smoke.mjs        离线冒烟
test/browser-check.mjs 真实浏览器交互检查
docs/*.png            验证截图
backup-profile-*/     改动线上 profile 前的备份（package.json / pnpm-lock / cordis.patch.yml）
```
