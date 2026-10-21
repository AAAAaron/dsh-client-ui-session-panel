/**
 * 会话总览面板 —— 浏览器半侧。
 *
 * 手写的 `__ModuleLoader__` bundle（没有构建步骤）：在左栏加一个「会话」入口，
 * 并在主区提供会话总览面板 —— 按工作区分组列出全部会话，组可折叠、可整体隐藏，
 * 点一行就通过 `ctx.uiWorkspace.openSession` 切到该会话。整个插件只读：
 * 不归档、不删除、不改名，也不碰宿主状态。
 *
 * 数据来源都是官方公开接缝：
 *   - 会话目录   `useSessions`（全局标准席位，SessionListState）
 *   - 会话状态   `useSessionStatus`（运行中 / 等待用户 / 未读完成）
 *   - 工作区目录 `useWorkspaces`（WorkspaceSnapshot：items + archivedSessionIds）
 *   - 当前会话   行的 `retainedBy.mainView > 0`（官方主视图独占引用）
 *   - 切换会话   `ctx.uiWorkspace.openSession(id)`（内部会 selectPanel(null) 回到对话）
 *
 * 折叠与隐藏写在本机 localStorage，不写宿主、不跨设备同步。
 */
window.__ModuleLoader__.load({
	id: "dsh-client-ui-session-panel",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const react = require("react");
		const h = react.createElement;

		/** 面板 id：左栏入口的 list id，也是 main keyed slot 的 key。 */
		const PANEL_ID = "session-panel";
		/** 左栏入口排序：官方 Plugins 页为 0，任务面板为 20，本面板排在它后面。 */
		const PANEL_ORDER = 30;
		/** 右栏按钮与指南条目的排序，沿用同一个序号。 */
		const RAIL_ORDER = 30;
		/** 不属于任何工作区的会话归到这一组（空串与官方 UNGROUPED_KEY 一致）。 */
		const UNGROUPED_KEY = "";
		const UNGROUPED_LABEL = "未分组";
		/** 每个工作区一行卡片；一行放几张由这个数字决定（窄屏由 CSS 断点自动降级）。 */
		const CARDS_PER_ROW = 10;
		const HIDDEN_KEY = "dsh.session-panel.hidden.v1";
		/** 面板里单独隐藏的会话（只影响本面板，不动官方归档）。 */
		const HIDDEN_SESSIONS_KEY = "dsh.session-panel.hidden-sessions.v1";
		const COLLAPSED_KEY = "dsh.session-panel.collapsed.v1";
		/** 卡片顺序模式：默认按最后活动时间倒序；拖过一次就切到宿主保存的手动顺序。 */
		const ORDER_KEY = "dsh.session-panel.order.v1";
		const ORDER_RECENT = "recent";
		const ORDER_MANUAL = "manual";
		/** 视图筛选：全部 / 最近 N 个 / 近半小时有变化。 */
		const FILTER_KEY = "dsh.session-panel.filter.v1";
		const FILTER_ALL = "all";
		const FILTER_RECENT_N = "recentN";
		const FILTER_HALF_HOUR = "halfHour";
		/** 「最近 N 个」取多少个会话。 */
		const FILTER_RECENT_LIMIT = 20;
		/** 「近半小时」的时间窗（毫秒）。 */
		const FILTER_HALF_HOUR_MS = 30 * 60 * 1000;
		const STYLE_ID = "dsh-session-panel-style";

		//#region 工具
		/** 读取本机持久化的字符串数组；任何异常都退回空数组。 */
		function readList(key) {
			try {
				const raw = window.localStorage.getItem(key);
				const parsed = raw === null || raw === "" ? [] : JSON.parse(raw);
				return Array.isArray(parsed) ? parsed.map(String) : [];
			} catch {
				return [];
			}
		}

		/** 写入本机持久化的字符串数组；配额或隐私模式异常一律忽略。 */
		function writeList(key, values) {
			try {
				window.localStorage.setItem(key, JSON.stringify(values));
			} catch {
				/* 持久化失败不影响本次会话内的显示 */
			}
		}

		/** 与 localStorage 同步的字符串数组状态。 */
		function useStoredList(key) {
			const [values, setValues] = react.useState(() => readList(key));
			const update = react.useCallback((next) => {
				setValues(next);
				writeList(key, next);
			}, []);
			return [values, update];
		}

		/** 读取一个本机持久化的字符串值。 */
		function readValue(key, fallback) {
			try {
				const raw = window.localStorage.getItem(key);
				return raw === null || raw === "" ? fallback : raw;
			} catch {
				return fallback;
			}
		}

		/** 写入一个本机持久化的字符串值。 */
		function writeValue(key, value) {
			try {
				window.localStorage.setItem(key, value);
			} catch {
				/* 持久化失败不影响本次会话内的显示 */
			}
		}

		/** 与 localStorage 同步的字符串状态。 */
		function useStoredValue(key, fallback) {
			const [value, setValue] = react.useState(() => readValue(key, fallback));
			const update = react.useCallback((next) => {
				setValue(next);
				writeValue(key, next);
			}, []);
			return [value, update];
		}

		/**
		 * 视图筛选的共享状态。
		 *
		 * 看板、右栏、浮窗是三个独立组件但都渲染同一批会话；把筛选放在模块级 store，
		 * 一处切换三处同步，不用再抄一份到 localStorage 再各自监听。
		 */
		const filterStore = {
			mode: readValue(FILTER_KEY, FILTER_ALL),
			listeners: new Set(),
			set(mode) {
				if (mode === this.mode) return;
				this.mode = mode;
				writeValue(FILTER_KEY, mode);
				this.listeners.forEach((listener) => {
					try {
						listener(mode);
					} catch {
						/* 单个订阅者出错不影响其它订阅者 */
					}
				});
			},
			subscribe(listener) {
				this.listeners.add(listener);
				return () => this.listeners.delete(listener);
			}
		};

		/** 订阅共享的筛选模式；返回 [当前模式, 切换函数]。 */
		function useFilterMode() {
			const [mode, setMode] = react.useState(() => filterStore.mode);
			react.useEffect(
				() => filterStore.subscribe(setMode),
				[]
			);
			return [mode, (next) => filterStore.set(next)];
		}

		/**
		 * 一个会走动的"现在"（毫秒时间戳）。
		 *
		 * 只有开启时间窗筛选时才需要它走；关着就不设定时器，不给页面添无谓的重绘。
		 * @param active 是否需要走动。
		 */
		function useNow(active) {
			const [now, setNow] = react.useState(() => Date.now());
			react.useEffect(() => {
				if (!active) return undefined;
				setNow(Date.now());
				const timer = setInterval(() => setNow(Date.now()), 60_000);
				return () => clearInterval(timer);
			}, [active]);
			return now;
		}

		/**
		 * 算出把一张卡片放到另一张旁边时，宿主 `insertSessionBefore` 需要的锚点。
		 *
		 * 语义与 DOM `insertBefore` 一致：返回要插到它前面的那张卡；返回 undefined
		 * 表示追加到末尾。`ids` 必须是**当前显示顺序**（手动模式下就是宿主顺序）。
		 * @param ids 该工作区当前的完整顺序。
		 * @param draggedId 被拖动的会话。
		 * @param targetId 落点所在的会话。
		 * @param side "before" 落在左半 / "after" 落在右半。
		 */
		function computeReorderAnchor(ids, draggedId, targetId, side) {
			const without = ids.filter((id) => id !== draggedId);
			const index = without.indexOf(targetId);
			if (index < 0) return undefined;
			return without[side === "after" ? index + 1 : index];
		}

		/** 路径末段，作为工作区没有标题时的兜底显示名。 */
		function baseName(path) {
			if (typeof path !== "string" || path === "") return "";
			const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
			return parts[parts.length - 1] || path;
		}

		/** 相对时间：一周以内用相对说法，更早的直接给日期。 */
		function formatRelative(timestamp) {
			if (typeof timestamp !== "number" || !Number.isFinite(timestamp) || timestamp <= 0) return "";
			const delta = Date.now() - timestamp;
			if (delta < 60_000) return "刚刚";
			if (delta < 3_600_000) return Math.floor(delta / 60_000) + " 分钟前";
			if (delta < 86_400_000) return Math.floor(delta / 3_600_000) + " 小时前";
			if (delta < 7 * 86_400_000) return Math.floor(delta / 86_400_000) + " 天前";
			const date = new Date(timestamp);
			const month = String(date.getMonth() + 1).padStart(2, "0");
			const day = String(date.getDate()).padStart(2, "0");
			return date.getFullYear() === new Date().getFullYear()
				? month + "-" + day
				: date.getFullYear() + "-" + month + "-" + day;
		}

		/** 组内按最后活动时间倒序。 */
		function sortByRecency(ids, byId) {
			return ids.slice().sort((left, right) => {
				const a = byId[left];
				const b = byId[right];
				return ((b && b.updatedAt) || 0) - ((a && a.updatedAt) || 0);
			});
		}

		/** 状态点的种类：已归档 > 等待用户 > 运行中 > 未读完成 > 空闲。 */
		function statusKindOf(row, status, archived) {
			if (archived) return "archived";
			if (status && status.pendingInteraction) return "pending";
			if ((row && row.running) || (status && status.running)) return "running";
			if (status && status.completionUnread) return "unread";
			return "idle";
		}

		/** 泳道内最近一次活动时间；没有会话时为 0。 */
		function groupRecency(group, byId) {
			let latest = 0;
			for (const id of group.sessionIds) {
				const row = byId[id];
				const updatedAt = (row && row.updatedAt) || 0;
				if (updatedAt > latest) latest = updatedAt;
			}
			return latest;
		}

		/**
		 * 把会话目录与工作区目录拼成面板模型。
		 *
		 * 分组只用官方的归属关系（WorkspaceView.sessionIds），不按路径前缀猜；
		 * 子代理会话与官方一致地隐藏；空会话只留当前那一条（同官方侧栏）；
		 * 已归档会话照常显示但灰掉且不可点。
		 * 泳道之间始终按「该工作区最近一次活动时间」倒序；泳道内卡片按 orderMode：
		 * ORDER_RECENT（默认）按时间倒序，ORDER_MANUAL 保持宿主保存的顺序。
		 * 每组另带 manualSessionIds（宿主保存的顺序，与显示模式无关），拖动排序据此算锚点。
		 * @param listState 会话目录快照（SessionListState）。
		 * @param workspaceState 工作区快照（WorkspaceSnapshot）。
		 * @param hiddenKeys 被隐藏的组 key 列表。
		 * @param orderMode 卡片顺序模式，缺省视为按最近活动。
		 */
		function buildModel(listState, workspaceState, hiddenKeys, orderMode, sessionOptions) {
			const byId = (listState && listState.byId) || {};
			const filterMode = (sessionOptions && sessionOptions.filterMode) || FILTER_ALL;
			const now = (sessionOptions && typeof sessionOptions.now === "number") ? sessionOptions.now : Date.now();
			const hiddenSessions = new Set(((sessionOptions && sessionOptions.hiddenSessionIds) || []).map(String));
			const revealHidden = Boolean(sessionOptions && sessionOptions.revealHidden);
			let hiddenSessionCount = 0;
			const archivedIds = (workspaceState && workspaceState.archivedSessionIds) || [];
			const archived = new Set(archivedIds.map(String));
			const hidden = new Set(hiddenKeys.map(String));
			const claimed = new Set();
			const groups = [];
			const blankHiddenIds = new Set();
			const ordered = (ids) => (orderMode === ORDER_MANUAL ? ids.slice() : sortByRecency(ids, byId));

			/**
			 * 官方的可见性规则：普通会话都显示；空会话（点「新会话」后留下的占位，
			 * 日志里只有配置、没有任何消息）只显示当前那一条，其余不显示。
			 * 见 dsh-client-ui-workspace: `if (session.blank && session.id !== current) return false`。
			 * 这里跟随官方，避免面板被一堆没内容的占位会话塞满。
			 */
			const accept = (id, row) => {
				if (!row || row.origin === "subagent") return false;
				// 官方默认过滤：已归档的会话不出现在列表里（见 sessionVisible 的 archivedFilter）
				if (archived.has(id)) return false;
				if (row.blank === true && id !== currentId) {
					blankHiddenIds.add(id);
					return false;
				}
				// 用户在本面板里手动隐藏的会话（可在「已隐藏」里恢复）
				if (hiddenSessions.has(id)) {
					hiddenSessionCount += 1;
					if (!revealHidden) return false;
				}
				return true;
			};

			let currentId = null;
			for (const id of Object.keys(byId)) {
				const row = byId[id];
				if (row && row.retainedBy && (row.retainedBy.mainView || 0) > 0) {
					currentId = id;
					break;
				}
			}

			const workspaces = (workspaceState && workspaceState.items) || [];
			for (const workspace of workspaces) {
				const key = String(workspace.workspaceId);
				const members = (workspace.sessionIds || []).map(String).filter((id) => accept(id, byId[id]));
				for (const id of members) claimed.add(id);
				groups.push({
					key,
					title: workspace.title || baseName(workspace.path) || key,
					path: workspace.path || "",
					sessionIds: ordered(members),
					manualSessionIds: members
				});
			}

			// 不在任何工作区里的会话（官方左栏也看不到的那些）这里同样不列，
			// 面板只覆盖"工作区里真实存在"的会话。

			// 视图筛选：只保留符合条件的会话，其余"藏起来"。
			// 筛选是全局的（跨工作区），用户说"最近的 20 个会话"指的就是全部会话里最近的 20 个。
			const filterInfo = { mode: filterMode, total: 0, shown: 0 };
			if (filterMode !== FILTER_ALL) {
				const allIds = [];
				for (const group of groups) allIds.push(...group.sessionIds);
				filterInfo.total = allIds.length;
				let keep = new Set();
				if (filterMode === FILTER_RECENT_N) {
					// 最近 N 个：按最后活动时间倒序取前 N 个；当前会话始终保留，免得点了就找不到自己
					for (const id of sortByRecency(allIds, byId).slice(0, FILTER_RECENT_LIMIT)) keep.add(id);
					if (currentId && allIds.indexOf(currentId) >= 0) keep.add(currentId);
				} else if (filterMode === FILTER_HALF_HOUR) {
					// 近半小时有变化：最后活动时间落在最近 30 分钟内
					const since = now - FILTER_HALF_HOUR_MS;
					for (const id of allIds) {
						const updatedAt = (byId[id] && byId[id].updatedAt) || 0;
						if (updatedAt >= since) keep.add(id);
					}
					if (currentId && allIds.indexOf(currentId) >= 0) keep.add(currentId);
				}
				for (const group of groups) {
					group.sessionIds = group.sessionIds.filter((id) => keep.has(id));
					group.manualSessionIds = group.manualSessionIds.filter((id) => keep.has(id));
				}
				filterInfo.shown = keep.size;
				// 筛选后不再显示空的工作区泳道
				for (let i = groups.length - 1; i >= 0; i -= 1) {
					if (groups[i].sessionIds.length === 0) groups.splice(i, 1);
				}
			} else {
				filterInfo.total = groups.reduce((count, group) => count + group.sessionIds.length, 0);
				filterInfo.shown = filterInfo.total;
			}

			groups.sort((left, right) => groupRecency(right, byId) - groupRecency(left, byId));

			return {
				byId,
				archived,
				currentId,
				hiddenSessionCount,
				revealHidden,
				filterInfo,
				groups: groups.filter((group) => !hidden.has(group.key)),
				hiddenGroups: groups.filter((group) => hidden.has(group.key)),
				blankHidden: blankHiddenIds.size,
				ready: Boolean(listState) && listState.phase !== "pending"
			};
		}
		//#endregion

		//#region 样式
		const CSS = [
			".dsp-page{box-sizing:border-box;height:100%;overflow:auto;color:var(--dsw-alias-label-primary);",
			"padding:0 clamp(12px,1.6vw,24px) 40px}",
			"[data-platform=darwin] .dsp-page{padding-top:var(--dsh-frame-top-clearance,0px)}",
			".dsp-inner{max-width:100%;margin:0 auto}",
			".dsp-head{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px 16px;padding:28px 0 16px}",
			".dsp-title{margin:0;font-size:20px;font-weight:500;line-height:28px}",
			".dsp-meta{margin:4px 0 0;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px}",
			".dsp-tools{display:flex;flex:none;align-items:center;gap:8px}",
			".dsp-filter{display:inline-flex;align-items:center;gap:2px;padding:2px;border:.5px solid var(--dsw-alias-border-l3);",
			"border-radius:15px;background:var(--dsw-alias-bg-layer-2)}",
			".dsp-filter-btn{box-sizing:border-box;height:24px;padding:0 10px;border:0;border-radius:12px;",
			"background:0 0;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12.5px;line-height:1;",
			"cursor:pointer;white-space:nowrap}",
			".dsp-filter-btn:hover{color:var(--dsw-alias-label-primary)}",
			".dsp-filter-btn.is-active{background:var(--dsw-alias-interactive-bg-hover);",
			"color:var(--dsw-alias-state-business-primary)}",
			".dsp-filter--compact .dsp-filter-btn{height:22px;padding:0 8px;font-size:11.5px}",
			".dsp-btn{box-sizing:border-box;height:28px;padding:0 12px;border:.5px solid var(--dsw-alias-border-l3);",
			"border-radius:14px;background:0 0;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12.5px;",
			"line-height:1;cursor:pointer}",
			".dsp-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
			".dsp-btn:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}",
			".dsp-hidden{border:.5px solid var(--dsw-alias-border-l3);border-radius:12px;background:var(--dsw-alias-bg-layer-3);",
			"margin:0 0 16px;padding:12px 14px}",
			".dsp-hidden-title{margin:0 0 8px;color:var(--dsw-alias-label-secondary);font-size:12.5px;line-height:18px}",
			".dsp-hidden-row{display:flex;align-items:center;gap:10px;padding:4px 0;font-size:13px}",
			".dsp-hidden-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".dsp-group{border:.5px solid var(--dsw-alias-border-l3);border-radius:12px;background:var(--dsw-alias-bg-layer-3);",
			"margin:0 0 10px;overflow:hidden}",
			".dsp-group-head{display:flex;align-items:center;gap:10px;padding:10px 12px;cursor:pointer;user-select:none}",
			".dsp-group-head:hover{background:var(--dsw-alias-interactive-bg-hover)}",
			".dsp-caret{flex:none;width:12px;color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:1}",
			".dsp-group-name{flex:none;max-width:46%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13.5px;font-weight:500}",
			".dsp-group-path{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;",
			"color:var(--dsw-alias-label-caption);font-size:11.5px}",
			".dsp-count{flex:none;color:var(--dsw-alias-label-tertiary);font-size:12px;font-variant-numeric:tabular-nums}",
			".dsp-icon-btn{flex:none;width:22px;height:22px;padding:0;border:0;border-radius:11px;background:0 0;",
			"color:var(--dsw-alias-label-caption);font:inherit;font-size:12px;line-height:1;cursor:pointer;opacity:0;transition:opacity .12s}",
			".dsp-group-head:hover .dsp-icon-btn,.dsp-icon-btn:focus-visible{opacity:1}",
			".dsp-icon-btn:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}",
			".dsp-grid{border-top:.5px solid var(--dsw-alias-border-l4);display:grid;gap:8px;padding:10px 12px 14px;",
			"grid-template-columns:repeat(" + CARDS_PER_ROW + ",minmax(0,1fr))}",
			"@media (width<=1280px){.dsp-grid{grid-template-columns:repeat(8,minmax(0,1fr))}}",
			"@media (width<=1024px){.dsp-grid{grid-template-columns:repeat(6,minmax(0,1fr))}}",
			"@media (width<=800px){.dsp-grid{grid-template-columns:repeat(4,minmax(0,1fr))}}",
			"@media (width<=560px){.dsp-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}",
			".dsp-card{display:flex;flex-direction:column;justify-content:space-between;gap:8px;min-height:62px;",
			"border:.5px solid var(--dsw-alias-border-l3);border-radius:10px;background:var(--dsw-alias-bg-base);",
			"padding:8px 10px;cursor:pointer}",
			".dsp-card{position:relative}",
			".dsp-card:hover{background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l2)}",
			// 卡片右上角的隐藏/归档按钮：平时透明，悬停或键盘聚焦时出现
			".dsp-card-acts{position:absolute;top:4px;right:4px;display:flex;gap:3px;opacity:0;transition:opacity .12s}",
			".dsp-card:hover .dsp-card-acts,.dsp-card:focus-within .dsp-card-acts{opacity:1}",
			".dsp-card-act{box-sizing:border-box;width:20px;height:20px;display:inline-flex;align-items:center;",
			"justify-content:center;padding:0;border:.5px solid var(--dsw-alias-border-l3);border-radius:6px;",
			"background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary);font:inherit;",
			"font-size:11px;line-height:1;cursor:pointer}",
			".dsp-card-act:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2)}",
			".dsp-card-act.is-danger{color:var(--dsw-alias-state-warning-primary,#e5a13a);border-color:currentColor}",
			".dsp-card.is-user-hidden{opacity:.55;border-style:dashed}",
			".dsp-card:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}",
			".dsp-card.is-current{border-color:var(--dsw-alias-state-business-primary);",
			"box-shadow:inset 3px 0 0 0 var(--dsw-alias-state-business-primary)}",
			".dsp-card.is-archived{cursor:default;opacity:.55}",
			".dsp-card.is-archived:hover{background:var(--dsw-alias-bg-base);border-color:var(--dsw-alias-border-l3)}",
			".dsp-card.is-draggable{cursor:grab}",
			".dsp-card.is-dragging{opacity:.45}",
			".dsp-card.is-drop-before{box-shadow:inset 3px 0 0 0 var(--dsw-alias-state-business-primary)}",
			".dsp-card.is-drop-after{box-shadow:inset -3px 0 0 0 var(--dsw-alias-state-business-primary)}",
			".dsp-grid.is-drop-append{box-shadow:inset 0 -2px 0 0 var(--dsw-alias-state-business-primary)}",
			".dsp-error{color:var(--dsw-alias-state-error-primary);font-size:12.5px;line-height:18px;margin:0 0 10px}",
			// 右侧栏卡片
			".dsp-rail{box-sizing:border-box;height:100%;display:flex;flex-direction:column;overflow:hidden;color:var(--dsw-alias-label-primary)}",
			".dsp-rail-head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:.5px solid var(--dsw-alias-border-l4)}",
			".dsp-rail-title{font-size:13px;font-weight:500}",
			".dsp-rail-count{color:var(--dsw-alias-label-tertiary);font-size:12px;font-variant-numeric:tabular-nums}",
			".dsp-rail-head .dsp-btn{margin-left:auto}",
			".dsp-rail-body{flex:1;min-height:0;overflow:auto;padding:8px 10px 20px}",
			".dsp-rail-group{margin:0 0 6px}",
			".dsp-rail-group-head{display:flex;align-items:center;gap:6px;padding:4px 2px;border-radius:6px;cursor:pointer;user-select:none}",
			".dsp-rail-group-head:hover{background:var(--dsw-alias-interactive-bg-hover)}",
			".dsp-rail-group-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;",
			"color:var(--dsw-alias-label-secondary);font-size:12px}",
			".dsp-rail-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(86px,1fr));gap:6px;padding:4px 0 8px}",
			".dsp-rail-grid .dsp-card{min-height:52px;padding:6px 8px;border-radius:8px}",
			".dsp-rail-grid .dsp-card-title{font-size:11.5px;line-height:15px}",
			".dsp-rail-grid .dsp-card-foot{font-size:10.5px}",
			".dsp-rail-btn{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0;",
			"border:0;border-radius:6px;background:0 0;color:var(--dsw-alias-label-secondary);cursor:pointer}",
			".dsp-rail-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
			".dsp-rail-btn.is-active{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-state-business-primary)}",
			// 可拖动浮窗
			".dsp-float{position:fixed;z-index:60;display:flex;flex-direction:column;pointer-events:auto;",
			"border:1px solid var(--dsw-alias-border-l3);border-radius:12px;background:var(--dsw-alias-bg-layer-3);",
			"box-shadow:0 12px 32px rgba(0,0,0,.28);overflow:hidden;color:var(--dsw-alias-label-primary)}",
			".dsp-float-head{display:flex;align-items:center;gap:8px;padding:8px 10px;cursor:grab;user-select:none;",
			"border-bottom:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-2)}",
			".dsp-float-head:active{cursor:grabbing}",
			".dsp-float-title{font-size:13px;font-weight:500}",
			".dsp-float-head .dsp-btn:first-of-type{margin-left:auto}",
			".dsp-float-body{flex:1;min-height:0;overflow:auto;padding:8px 10px 16px}",
			".dsp-float-resize{position:absolute;right:0;bottom:0;width:16px;height:16px;cursor:nwse-resize;",
			"background:linear-gradient(135deg,transparent 50%,var(--dsw-alias-border-l2) 50%)}",
			".dsp-icon-btn--always{opacity:1}",
			".dsp-dot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-border-l2,#9aa4b2)}",
			".dsp-dot--running{background:var(--dsw-alias-state-success-primary,#3fb950)}",
			".dsp-dot--pending{background:var(--dsw-alias-state-warn-primary,#d29922)}",
			".dsp-dot--unread{background:var(--dsw-alias-state-success-primary,#3fb950)}",
			".dsp-dot--archived{background:var(--dsw-alias-border-l1,#6b7280)}",
			".dsp-card-title{-webkit-line-clamp:2;line-clamp:2;-webkit-box-orient:vertical;display:-webkit-box;",
			"overflow:hidden;overflow-wrap:anywhere;font-size:12.5px;line-height:17px}",
			".dsp-card-foot{display:flex;flex-wrap:wrap;align-items:center;gap:2px 6px;",
			"color:var(--dsw-alias-label-caption);font-size:11px}",
			".dsp-tag{flex:none;border-radius:9px;background:var(--dsw-alias-bg-module-platform);",
			"color:var(--dsw-alias-label-secondary);padding:1px 7px;font-size:10.5px;line-height:16px}",
			".dsp-tag--muted{background:0 0;color:var(--dsw-alias-label-caption);border:.5px solid var(--dsw-alias-border-l3)}",
			".dsp-time{flex:none;color:var(--dsw-alias-label-caption);font-size:11.5px;font-variant-numeric:tabular-nums}",
			".dsp-empty{color:var(--dsw-alias-label-tertiary);padding:40px 0;text-align:center;font-size:13.5px}"
		].join("");

		/** 幂等地插入面板样式表。 */
		function installStyles() {
			if (document.getElementById(STYLE_ID) !== null) return;
			const style = document.createElement("style");
			style.id = STYLE_ID;
			style.textContent = CSS;
			document.head.appendChild(style);
		}
		//#endregion

		//#region 组件
		/** 会话状态缺席时的空表。 */
		const EMPTY_STATUSES = new Map();

		/** 左栏入口图标：一列会话行。 */
		function SessionPanelIcon({ size }) {
			const edge = typeof size === "number" && size > 0 ? size : 18;
			return h(
				"svg",
				{
					width: edge,
					height: edge,
					viewBox: "0 0 20 20",
					fill: "none",
					"aria-hidden": "true"
				},
				h("rect", {
					x: "2.5",
					y: "3.5",
					width: "15",
					height: "13",
					rx: "2.5",
					stroke: "currentColor",
					strokeWidth: "1.4"
				}),
				h("path", {
					d: "M6 7.5h8M6 10.5h8M6 13.5h5",
					stroke: "currentColor",
					strokeWidth: "1.4",
					strokeLinecap: "round"
				})
			);
		}

		/** 卡片上的「隐藏」图标（一只被划掉的眼睛）。 */
		function SessionHideIcon() {
			return h(
				"svg",
				{ width: 13, height: 13, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true" },
				h("path", { d: "M2.2 8s2.2-3.6 5.8-3.6S13.8 8 13.8 8s-2.2 3.6-5.8 3.6S2.2 8 2.2 8Z", stroke: "currentColor", strokeWidth: 1.2 }),
				h("circle", { cx: 8, cy: 8, r: 1.7, stroke: "currentColor", strokeWidth: 1.2 }),
				h("path", { d: "M3 13 13 3", stroke: "currentColor", strokeWidth: 1.2, strokeLinecap: "round" })
			);
		}

		/** 卡片上的「归档」图标（一个盒子）。 */
		function SessionArchiveIcon() {
			return h(
				"svg",
				{ width: 13, height: 13, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true" },
				h("rect", { x: 2.2, y: 3.2, width: 11.6, height: 3, rx: 1, stroke: "currentColor", strokeWidth: 1.2 }),
				h("path", { d: "M3.4 6.2v5.6a1 1 0 0 0 1 1h7.2a1 1 0 0 0 1-1V6.2", stroke: "currentColor", strokeWidth: 1.2 }),
				h("path", { d: "M6.4 9h3.2", stroke: "currentColor", strokeWidth: 1.2, strokeLinecap: "round" })
			);
		}

		/** 卡片的内容是否值得重画：标题/时间/状态/当前/归档/落点提示都没变就跳过。 */
		function sameCardContent(a, b) {
			const titleOf = (row) => row.displayTitle || row.title || "";
			return (
				a.row.id === b.row.id &&
				titleOf(a.row) === titleOf(b.row) &&
				Boolean(a.row.blank) === Boolean(b.row.blank) &&
				a.row.updatedAt === b.row.updatedAt &&
				Boolean(a.isCurrent) === Boolean(b.isCurrent) &&
				Boolean(a.isArchived) === Boolean(b.isArchived) &&
				statusKindOf(a.row, a.status, a.isArchived) === statusKindOf(b.row, b.status, b.isArchived) &&
				(a.dropHint || null) === (b.dropHint || null) &&
				Boolean(a.isDragging) === Boolean(b.isDragging) &&
				Boolean(a.drag) === Boolean(b.drag) &&
				Boolean(a.isUserHidden) === Boolean(b.isUserHidden) &&
				Boolean(a.onHide) === Boolean(b.onHide) &&
				Boolean(a.onArchive) === Boolean(b.onArchive) &&
				// 开始/结束拖动时必须刷新：卡片手里的拖拽回调闭包着"当前是否在拖"
				Boolean(a.dragActive) === Boolean(b.dragActive)
			);
		}

		/** 一张会话卡片：标题两行截断 + 状态点 + 相对时间。已归档的灰掉且不可点。 */
		function SessionCardBody(props) {
			const { row, status, isCurrent, isArchived, openSession, drag, dropHint, isDragging } = props;
			const { isUserHidden, onHide, onUnhide, onArchive } = props;
			// 归档是不可逆感很强的操作，做成"点两下确认"（3 秒内）
			const [confirmArchive, setConfirmArchive] = react.useState(false);
			const kind = statusKindOf(row, status, isArchived);
			const title = row.blank === true && !row.title
				? "（新会话）"
				: row.displayTitle || row.title || row.id;
			const className = "dsp-card"
				+ (isCurrent ? " is-current" : "")
				+ (isArchived ? " is-archived" : "")
				+ (drag ? " is-draggable" : "")
				+ (isDragging ? " is-dragging" : "")
				+ (isUserHidden ? " is-user-hidden" : "")
				+ (dropHint === "before" ? " is-drop-before" : "")
				+ (dropHint === "after" ? " is-drop-after" : "");
			const attributes = {
				className,
				"data-session-id": row.id,
				title: isArchived ? title + "（已归档，需先取消归档才能打开）" : title,
				role: isArchived ? undefined : "button",
				tabIndex: isArchived ? undefined : 0,
				onClick: isArchived ? undefined : () => openSession(row.id),
				onKeyDown: isArchived
					? undefined
					: (event) => {
						if (event.key === "Enter" || event.key === " ") {
							event.preventDefault();
							openSession(row.id);
						}
					}
			};
			if (drag) {
				attributes.draggable = true;
				attributes.onDragStart = drag.onDragStart;
				attributes.onDragEnd = drag.onDragEnd;
				attributes.onDragOver = drag.onDragOver;
				attributes.onDrop = drag.onDrop;
			}
			return h(
				"article",
				attributes,
				h("span", { className: "dsp-card-title" }, title),
				h(
					"div",
					{ className: "dsp-card-foot" },
					h("span", { className: "dsp-dot dsp-dot--" + kind }),
					h("span", { className: "dsp-time" }, formatRelative(row.updatedAt)),
					isCurrent ? h("span", { className: "dsp-tag" }, "当前") : null,
					isArchived ? h("span", { className: "dsp-tag dsp-tag--muted" }, "已归档") : null
				),
				h(
					"div",
					{ className: "dsp-card-acts" },
					isUserHidden
						? h(
							"button",
							{
								type: "button",
								className: "dsp-card-act",
								title: "恢复显示",
								"aria-label": "恢复显示",
								onClick: (event) => {
									event.preventDefault();
									event.stopPropagation();
									if (typeof onUnhide === "function") onUnhide(row.id);
								}
							},
							"↺"
						)
						: h(
							"button",
							{
								type: "button",
								className: "dsp-card-act",
								title: "在这个面板里隐藏（不影响官方侧栏）",
								"aria-label": "隐藏这个会话",
								onClick: (event) => {
									event.preventDefault();
									event.stopPropagation();
									if (typeof onHide === "function") onHide(row.id);
								}
							},
							h(SessionHideIcon, {})
						),
					h(
						"button",
						{
							type: "button",
							className: "dsp-card-act" + (confirmArchive ? " is-danger" : ""),
							title: confirmArchive ? "再点一次确认归档" : "归档这个会话（官方归档，可在左栏取消归档）",
							"aria-label": confirmArchive ? "确认归档" : "归档这个会话",
							onClick: (event) => {
								event.preventDefault();
								event.stopPropagation();
								if (typeof onArchive !== "function") return;
								if (!confirmArchive) {
									setConfirmArchive(true);
									if (typeof setTimeout === "function") {
										setTimeout(() => setConfirmArchive(false), 3000);
									}
									return;
								}
								setConfirmArchive(false);
								onArchive(row.id);
							}
						},
						confirmArchive ? "确认" : h(SessionArchiveIcon, {})
					)
				)
			);
		}

		// 流式输出时会话快照每秒会更新多次，卡片数量又多；内容没变的卡片不重画。
		const SessionCard = typeof react.memo === "function" ? react.memo(SessionCardBody, sameCardContent) : SessionCardBody;

		/**
		 * 一张卡片的拖拽属性（主区看板与右栏卡片栏共用）。
		 *
		 * 只有同一泳道内、未归档的卡片可拖；返回 undefined 表示这张卡不参与拖动。
		 * @param options 行、泳道 key、是否归档/可拖、当前拖动状态与回调。
		 */
		function cardDragAttributes(options) {
			const {
				row,
				groupKey,
				isArchived,
				canReorder,
				draggingHere,
				onDragStart,
				onDragEnd,
				onDragOverCard,
				onDropCard
			} = options;
			if (!canReorder || isArchived) return undefined;
			const sideOf = (event) => {
				const rect = event.currentTarget.getBoundingClientRect();
				return event.clientX < rect.left + rect.width / 2 ? "before" : "after";
			};
			return {
				onDragStart: (event) => {
					event.dataTransfer.effectAllowed = "move";
					try {
						event.dataTransfer.setData("text/plain", row.id);
					} catch {
						/* 某些环境不允许写 dataTransfer，拖动照常进行 */
					}
					onDragStart(row.id, groupKey);
				},
				onDragEnd: () => onDragEnd(),
				onDragOver: (event) => {
					if (!draggingHere) return;
					event.preventDefault();
					event.dataTransfer.dropEffect = "move";
					onDragOverCard(row.id, sideOf(event));
				},
				onDrop: (event) => {
					if (!draggingHere) return;
					event.preventDefault();
					event.stopPropagation();
					onDropCard(groupKey, row.id, sideOf(event));
				}
			};
		}

		/**
		 * 筛选条：全部 / 最近 N 个 / 近半小时有变化。
		 *
		 * 这是一组互斥的按钮，选中哪个就把不符合的会话藏起来（不是滚到别处，是不渲染）。
		 * 选中状态存在模块级 store，看板、右栏、浮窗三处同步。
		 * @param props compact 紧凑模式（右栏/浮窗里空间小，标签用短词）。
		 */
		function FilterBar(props) {
			const mode = filterStore.mode;
			const compact = Boolean(props.compact);
			const options = compact
				? [
						{ id: FILTER_ALL, label: "全部", title: "显示全部会话" },
						{ id: FILTER_RECENT_N, label: "20", title: "只显示最近 " + FILTER_RECENT_LIMIT + " 个会话" },
						{ id: FILTER_HALF_HOUR, label: "30m", title: "只显示最近半小时有变化的会话" }
					]
				: [
						{ id: FILTER_ALL, label: "全部会话", title: "显示全部会话" },
						{ id: FILTER_RECENT_N, label: "最近 " + FILTER_RECENT_LIMIT + " 个", title: "只显示最近 " + FILTER_RECENT_LIMIT + " 个会话" },
						{ id: FILTER_HALF_HOUR, label: "近半小时有变化", title: "只显示最后活动时间在最近 30 分钟内的会话" }
					];
			return h(
				"div",
				{ className: "dsp-filter" + (compact ? " dsp-filter--compact" : ""), role: "group", "aria-label": "会话筛选" },
				options.map((option) =>
					h(
						"button",
						{
							key: option.id,
							type: "button",
							className: "dsp-filter-btn" + (mode === option.id ? " is-active" : ""),
							title: option.title,
							"aria-pressed": mode === option.id,
							// 严格互斥：点已选中的不变；要回到全量点「全部会话」
							onClick: () => filterStore.set(option.id)
						},
						option.label
					)
				)
			);
		}

		/**
		 * 一个工作区泳道：表头显示名称/路径/数量并可折叠、可隐藏，下面是卡片网格。
		 *
		 * 卡片可拖动排序（仅同一泳道内；未分组泳道没有可保存的顺序，不参与拖动）。
		 */
		function SessionGroup(props) {
			const {
				group,
				collapsed,
				rows,
				statuses,
				archived,
				currentId,
				openSession,
				onToggle,
				onHide,
				hiddenSessionIds,
				onHideSession,
				onUnhideSession,
				onArchiveSession,
				dragState,
				dropHint,
				onDragStart,
				onDragEnd,
				onDragOverCard,
				onDragOverEnd,
				onDropCard,
				onDropEnd
			} = props;
			const canReorder = group.key !== UNGROUPED_KEY;
			const draggingHere = Boolean(dragState) && dragState.groupKey === group.key;
			const dropSideOf = (sessionId) => {
				if (!draggingHere || !dropHint || dropHint.sessionId !== sessionId) return null;
				return dropHint.side;
			};
			const makeDrag = (row, isArchived) =>
				cardDragAttributes({
					row,
					groupKey: group.key,
					isArchived,
					canReorder,
					draggingHere,
					onDragStart,
					onDragEnd,
					onDragOverCard,
					onDropCard
				});
			const gridAttributes = { className: "dsp-grid" };
			if (draggingHere) {
				gridAttributes.onDragOver = (event) => {
					if (event.target !== event.currentTarget) return;
					event.preventDefault();
					onDragOverEnd();
				};
				gridAttributes.onDrop = (event) => {
					if (event.target !== event.currentTarget) return;
					event.preventDefault();
					onDropEnd(group.key);
				};
			}
			if (draggingHere && dropHint && dropHint.append === true) {
				gridAttributes.className += " is-drop-append";
			}
			return h(
				"section",
				{ className: "dsp-group" },
				h(
					"div",
					{
						className: "dsp-group-head",
						role: "button",
						tabIndex: 0,
						"aria-expanded": !collapsed,
						onClick: () => onToggle(group.key),
						onKeyDown: (event) => {
							if (event.key === "Enter" || event.key === " ") {
								event.preventDefault();
								onToggle(group.key);
							}
						}
					},
					h("span", { className: "dsp-caret" }, collapsed ? "▶" : "▼"),
					h("span", { className: "dsp-group-name", title: group.title }, group.title),
					group.path === "" ? null : h("span", { className: "dsp-group-path", title: group.path }, group.path),
					h("span", { className: "dsp-count" }, String(group.sessionIds.length)),
					h(
						"button",
						{
							type: "button",
							className: "dsp-icon-btn",
							title: "隐藏该工作区（只影响本面板，可随时恢复）",
							"aria-label": "隐藏 " + group.title,
							onClick: (event) => {
								event.stopPropagation();
								onHide(group.key);
							}
						},
						"✕"
					)
				),
				collapsed
					? null
					: h(
						"div",
						gridAttributes,
						rows.map((row) => {
							const isArchived = archived.has(row.id);
							return h(SessionCard, {
								key: row.id,
								row,
								status: statuses.get(row.id),
								isCurrent: row.id === currentId,
								isArchived,
								openSession,
								drag: makeDrag(row, isArchived),
								dragActive: draggingHere,
								isUserHidden: Boolean(hiddenSessionIds && hiddenSessionIds.has(row.id)),
								onHide: onHideSession,
								onUnhide: onUnhideSession,
								onArchive: onArchiveSession,
								dropHint: dropSideOf(row.id),
								isDragging: draggingHere && dragState.sessionId === row.id
							});
						})
					)
			);
		}

		/** 主区总览页。 */
		/**
		 * 卡片拖拽排序的共用逻辑（主区看板与右栏卡片栏都走这一份）。
		 *
		 * 只支持同一泳道内排序；落点锚点按宿主保存的顺序（manualSessionIds）算，
		 * 落完再切到「手动」模式，保证显示顺序与宿主顺序一致。
		 */
		function useCardDrag(options) {
			const { model, orderMode, setOrderMode, insertSessionBefore, setOrderError } = options;
			const [dragState, setDragState] = react.useState(null);
			const [dropHint, setDropHint] = react.useState(null);

			/**
			 * 记下正在拖的卡片。这里刻意不改显示顺序：拖动过程中重排会让卡片从指针底下
			 * 跑掉，等落下时再切模式。
			 */
			const onDragStart = react.useCallback((sessionId, groupKey) => {
				setDragState({ sessionId, groupKey });
				setDropHint(null);
				setOrderError("");
			}, []);
			const onDragEnd = react.useCallback(() => {
				setDragState(null);
				setDropHint(null);
			}, []);
			const onDragOverCard = react.useCallback((sessionId, side) => {
				setDropHint((current) =>
					current && current.sessionId === sessionId && current.side === side ? current : { sessionId, side }
				);
			}, []);
			const onDragOverEnd = react.useCallback(() => setDropHint({ append: true }), []);

			/** 落点确定后写回宿主：只支持同一工作区内排序，跨泳道直接忽略。 */
			/** 落点确定后写回宿主：只支持同一工作区内排序，跨泳道直接忽略。 */
			const applyReorder = react.useCallback(
				(groupKey, draggedId, anchorId) => {
					if (typeof insertSessionBefore !== "function") {
						setOrderError("当前宿主没有提供排序接口，暂时改不了顺序。");
						return;
					}
					try {
						const result = insertSessionBefore(groupKey, draggedId, anchorId);
						if (result && typeof result.catch === "function") {
							result.catch((error) => {
								setOrderError("顺序没保存上：" + (error && error.message ? error.message : String(error)));
							});
						}
					} catch (error) {
						setOrderError("顺序没保存上：" + (error && error.message ? error.message : String(error)));
					}
				},
				[insertSessionBefore]
			);

			/** 写完顺序再切到「手动」：显示顺序与刚落下的宿主顺序一致。 */
			const finishReorder = react.useCallback(
				(groupKey, sessionId, anchorId) => {
					applyReorder(groupKey, sessionId, anchorId);
					if (orderMode !== ORDER_MANUAL) setOrderMode(ORDER_MANUAL);
				},
				[applyReorder, orderMode, setOrderMode]
			);

			const onDropCard = react.useCallback(
				(groupKey, targetId, side) => {
					const state = dragState;
					setDragState(null);
					setDropHint(null);
					if (!state || state.groupKey !== groupKey || state.sessionId === targetId) return;
					const group = model.groups.find((item) => item.key === groupKey);
					if (!group) return;
					// 锚点按宿主保存的顺序算：落点在「手动顺序」里的位置才是最终位置。
					const anchor = computeReorderAnchor(group.manualSessionIds, state.sessionId, targetId, side);
					finishReorder(groupKey, state.sessionId, anchor);
				},
				[dragState, finishReorder, model.groups]
			);

			const onDropEnd = react.useCallback(
				(groupKey) => {
					const state = dragState;
					setDragState(null);
					setDropHint(null);
					if (!state || state.groupKey !== groupKey) return;
					const group = model.groups.find((item) => item.key === groupKey);
					if (!group) return;
					const manual = group.manualSessionIds;
					if (manual[manual.length - 1] === state.sessionId) return;
					finishReorder(groupKey, state.sessionId, undefined);
				},
				[dragState, finishReorder, model.groups]
			);


			return { dragState, dropHint, onDragStart, onDragEnd, onDragOverCard, onDragOverEnd, onDropCard, onDropEnd };
		}

		function SessionPanel(props) {
			const openSession = props.openSession;
			const insertSessionBefore = props.insertSessionBefore;
			// 这些是框架注入的全局标准席位；缺失时降级成空数据，面板仍然可渲染。
			const useSessions = props.useSessions || (() => undefined);
			const useWorkspaces = props.useWorkspaces || (() => undefined);
			const useSessionStatus = props.useSessionStatus || (() => undefined);

			const listState = useSessions((state) => state);
			const workspaceState = useWorkspaces((state) => state);
			const statuses = useSessionStatus((state) => state) || EMPTY_STATUSES;

			const [hiddenKeys, setHiddenKeys] = useStoredList(HIDDEN_KEY);
			const [collapsedKeys, setCollapsedKeys] = useStoredList(COLLAPSED_KEY);
			const [orderMode, setOrderMode] = useStoredValue(ORDER_KEY, ORDER_RECENT);
			const [showHidden, setShowHidden] = react.useState(false);
			const [orderError, setOrderError] = react.useState("");
			const [hiddenSessionIds, setHiddenSessionIds] = useStoredList(HIDDEN_SESSIONS_KEY);
			const [revealHidden, setRevealHidden] = react.useState(false);
			const [filterMode] = useFilterMode();
			const now = useNow(filterMode === FILTER_HALF_HOUR);

			const model = react.useMemo(
				() =>
					buildModel(listState, workspaceState, hiddenKeys, orderMode, {
						hiddenSessionIds,
						revealHidden,
						filterMode,
						now
					}),
				[listState, workspaceState, hiddenKeys, orderMode, hiddenSessionIds, revealHidden, filterMode, now]
			);
			const collapsed = react.useMemo(() => new Set(collapsedKeys.map(String)), [collapsedKeys]);

			const toggleGroup = react.useCallback(
				(key) => {
					setCollapsedKeys(collapsedKeys.includes(key) ? collapsedKeys.filter((item) => item !== key) : collapsedKeys.concat(key));
				},
				[collapsedKeys, setCollapsedKeys]
			);
			const hideGroup = react.useCallback(
				(key) => {
					setHiddenKeys(hiddenKeys.includes(key) ? hiddenKeys : hiddenKeys.concat(key));
				},
				[hiddenKeys, setHiddenKeys]
			);
			const restoreGroup = react.useCallback(
				(key) => {
					const next = hiddenKeys.filter((item) => item !== key);
					setHiddenKeys(next);
					if (next.length === 0) setShowHidden(false);
				},
				[hiddenKeys, setHiddenKeys]
			);

			const { dragState, dropHint, onDragStart, onDragEnd, onDragOverCard, onDragOverEnd, onDropCard, onDropEnd } =
				useCardDrag({ model, orderMode, setOrderMode, insertSessionBefore, setOrderError });

			const toggleOrderMode = () => {
				setOrderMode(orderMode === ORDER_MANUAL ? ORDER_RECENT : ORDER_MANUAL);
				setOrderError("");
			};

			/** 在本面板隐藏/恢复一个会话（只写本机，不动官方侧栏）。 */
			const hideSession = (sessionId) => {
				setHiddenSessionIds(hiddenSessionIds.includes(sessionId) ? hiddenSessionIds : hiddenSessionIds.concat(sessionId));
			};
			const unhideSession = (sessionId) => {
				setHiddenSessionIds(hiddenSessionIds.filter((item) => item !== sessionId));
			};
			/** 归档：走官方接口，成功后归档过滤会自动把它从列表里去掉。 */
			const archiveSession = (sessionId) => {
				if (typeof props.archiveSession !== "function") {
					setOrderError("当前宿主没有提供归档接口。");
					return;
				}
				const fail = (error) => setOrderError("归档失败：" + (error && error.message ? error.message : String(error)));
				try {
					const result = props.archiveSession(sessionId);
					if (result && typeof result.catch === "function") result.catch(fail);
					setOrderError("");
				} catch (error) {
					fail(error);
				}
			};

			const groups = model.groups;
			const visibleGroupKeys = groups.map((group) => group.key);
			const allCollapsed = visibleGroupKeys.length > 0 && visibleGroupKeys.every((key) => collapsed.has(key));
			const totalSessions = groups.reduce((count, group) => count + group.sessionIds.length, 0);

			return h(
				"div",
				{ className: "dsp-page", "data-dsh-plugin": "session-panel" },
				h(
					"div",
					{ className: "dsp-inner" },
					h(
						"header",
						{ className: "dsp-head" },
						h(
							"div",
							null,
							h("h1", { className: "dsp-title" }, "会话总览"),
							h(
								"p",
								{ className: "dsp-meta" },
								totalSessions + " 个会话 · " + groups.length + " 个工作区" +
									(model.hiddenGroups.length > 0 ? " · 已隐藏 " + model.hiddenGroups.length + " 个" : "") +
									(model.blankHidden > 0 ? " · 隐藏 " + model.blankHidden + " 个空会话" : "") +
								(model.filterInfo && model.filterInfo.mode !== FILTER_ALL
									? " · 筛选后显示 " + totalSessions + "/" + model.filterInfo.total + " 个"
									: "")
							)
						),
						h(
							"div",
							{ className: "dsp-tools" },
							h(FilterBar, {}),
							h(
								"button",
								{
									type: "button",
									className: "dsp-btn",
									title:
										orderMode === ORDER_MANUAL
											? "当前按宿主保存的手动顺序显示；点一下切回按最近活动"
											: "当前按最近活动时间倒序；拖动任意卡片会自动切到手动顺序",
									onClick: toggleOrderMode
								},
								orderMode === ORDER_MANUAL ? "卡片顺序：手动" : "卡片顺序：最近活动"
							),
							h(
								"button",
								{
									type: "button",
									className: "dsp-btn",
									onClick: () => setCollapsedKeys(allCollapsed ? [] : visibleGroupKeys)
								},
								allCollapsed ? "全部展开" : "全部折叠"
							),
							model.hiddenSessionCount === 0
								? null
								: h(
									"button",
									{
										type: "button",
										className: "dsp-btn",
										title: "这些会话只在本面板隐藏，不改变官方侧栏",
										onClick: () => setRevealHidden(!revealHidden)
									},
									revealHidden ? "收起已隐藏" : "已隐藏 " + model.hiddenSessionCount + " 个"
								),
							model.hiddenGroups.length === 0
								? null
								: h(
									"button",
									{ type: "button", className: "dsp-btn", onClick: () => setShowHidden(!showHidden) },
									showHidden ? "收起隐藏项" : "管理隐藏"
								)
						)
					),

					orderError === "" ? null : h("p", { className: "dsp-error" }, orderError),

					showHidden
						? h(
							"div",
							{ className: "dsp-hidden" },
							h("p", { className: "dsp-hidden-title" }, "已隐藏的工作区（只影响本面板）"),
							model.hiddenGroups.map((group) =>
								h(
									"div",
									{ className: "dsp-hidden-row", key: group.key },
									h("span", { className: "dsp-hidden-name", title: group.path || group.title }, group.title),
									h("span", { className: "dsp-count" }, String(group.sessionIds.length)),
									h(
										"button",
										{ type: "button", className: "dsp-btn", onClick: () => restoreGroup(group.key) },
										"恢复"
									)
								)
							),
							h(
								"button",
								{ type: "button", className: "dsp-btn", onClick: () => { setHiddenKeys([]); setShowHidden(false); } },
								"全部恢复"
							)
						)
						: null,

					groups.length === 0
						? h("p", { className: "dsp-empty" }, model.ready ? "没有可显示的会话。" : "正在载入会话…")
						: groups.map((group) =>
							h(SessionGroup, {
								key: group.key === UNGROUPED_KEY ? "__ungrouped__" : group.key,
								group,
								collapsed: collapsed.has(group.key),
								rows: group.sessionIds.map((id) => model.byId[id]).filter(Boolean),
								statuses,
								archived: model.archived,
								currentId: model.currentId,
								openSession,
								onToggle: toggleGroup,
								onHide: hideGroup,
								hiddenSessionIds: new Set(hiddenSessionIds.map(String)),
								onHideSession: hideSession,
								onUnhideSession: unhideSession,
								onArchiveSession: archiveSession,
								dragState,
								dropHint,
								onDragStart,
								onDragEnd,
								onDragOverCard,
								onDragOverEnd,
								onDropCard,
								onDropEnd
							})
						)
				)
			);
		}

		//#endregion

		//#region 右侧栏卡片
		/**
		 * 右侧栏 tab 类型：`id` 是座位 key，`kind` 是 openTab 用的名字。
		 * 页类型（不认地址）所以不写 patterns；keepMounted 让卡片栏在切会话时不被拆掉。
		 */
		const RAIL_ID = "dsh-client-ui-session-panel";
		const RAIL_KIND = "session-cards";

		/** 右栏那张 tab 现在是不是开着（且右栏是展开的）。 */
		function railIsActive(rightbar) {
			try {
				const activeTab = rightbar.active();
				return Boolean(activeTab && activeTab.kind === RAIL_KIND && rightbar.isExpanded());
			} catch {
				return false;
			}
		}

		/** 对话头部的按钮：开/关右栏卡片。 */
		/**
		 * 卡片栏此刻是否真的显示在屏幕上。
		 *
		 * 不看 `sidebarRight.isExpanded()`：它记的状态和屏幕上到底显示什么会短暂不一致
		 * （实测 tab 开了、面板还收着，按钮按下去像没反应）。直接量 DOM 宽度最可靠。
		 */
		function railVisibleOnScreen() {
			try {
				const nodes = document.querySelectorAll('[data-dsh-plugin="session-panel-rail"]');
				for (const node of nodes) {
					const rect = typeof node.getBoundingClientRect === "function" ? node.getBoundingClientRect() : { width: 0 };
					if (rect.width > 0) return true;
				}
				return false;
			} catch {
				return false;
			}
		}

		function toggleRail(rightbar) {
			if (!rightbar) return;
			try {
				if (railVisibleOnScreen()) {
					const activeTab = typeof rightbar.active === "function" ? rightbar.active() : undefined;
					if (activeTab !== undefined && activeTab.kind === RAIL_KIND) rightbar.close(activeTab.id);
					return;
				}
				// 看不见就打开：先开 tab，再确保整条右栏是展开的
				rightbar.openTab(RAIL_KIND);
				if (typeof rightbar.isExpanded === "function" && !rightbar.isExpanded()) rightbar.toggleExpanded();

				// 兜底：`isExpanded()` 可能说"开着"但屏幕上还收着，这时补一次展开；
				// 万一是"其实已经展开、只是还没渲染"，再翻回来。最多翻两次，不会震荡。
				if (typeof setTimeout !== "function") return;
				setTimeout(() => {
					if (railVisibleOnScreen()) return;
					try {
						rightbar.toggleExpanded();
					} catch {
						/* 忽略 */
					}
					setTimeout(() => {
						if (railVisibleOnScreen()) return;
						try {
							rightbar.toggleExpanded();
						} catch {
							/* 忽略 */
						}
					}, 360);
				}, 260);
			} catch {
				/* 右栏不可用（旧版宿主）时安静降级 */
			}
		}

		/**
		/**
		 * 点卡片切会话后，确保新会话的右栏里也开着卡片栏。
		 *
		 * 右栏的 tab 记录按会话保存，切换后不一定继承，所以切完补开一次；
		 * `openTab` 作用在「当前屏幕上的会话」，因此要在切换之后（含两次延时重试）。
		 */
		function ensureRail(rightbar, sessionId) {
			const attempt = () => {
				try {
					if (!railIsActive(rightbar)) rightbar.openTab(RAIL_KIND);
					if (typeof rightbar.isExpanded === "function" && !rightbar.isExpanded()) rightbar.toggleExpanded();
				} catch {
					/* 忽略：右栏不可用 */
				}
			};
			try {
				rightbar.openTabIn(sessionId, RAIL_KIND);
			} catch {
				/* 目标会话的 store 还没就绪时忽略，下面的重试会补上 */
			}
			attempt();
			setTimeout(attempt, 80);
			setTimeout(attempt, 320);
		}

		/** 浮窗按钮的图标：一个小窗口。 */
		function SessionFloatIcon() {
			return h(
				"svg",
				{ width: 16, height: 16, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true" },
				h("rect", { x: 2.5, y: 3.5, width: 11, height: 9, rx: 1.5, stroke: "currentColor", strokeWidth: 1.3 }),
				h("path", { d: "M2.5 6.5h11", stroke: "currentColor", strokeWidth: 1.1 }),
				h("path", { d: "M9.5 9.5h3.5", stroke: "currentColor", strokeWidth: 1.1, strokeLinecap: "round" })
			);
		}

		/**
		 * 对话头部的「浮窗」按钮：一下把会话卡片浮成一个可拖动窗口。
		 *
		 * 走这条路完全不碰右侧栏，也就不用管 tab/展开那套状态，日常用这个最省事。
		 */
		function SessionFloatButton(props) {
			const state = useFloatState();
			const open = Boolean(state && state.open);
			return h(
				"button",
				{
					type: "button",
					className: "dsp-rail-btn" + (open ? " is-active" : ""),
					title: open ? "收起会话浮窗" : "打开会话浮窗（可拖动、可缩放）",
					"aria-label": "会话浮窗",
					"aria-pressed": open,
					onClick: () => {
						if (typeof props.toggleFloat === "function") props.toggleFloat();
					}
				},
				h(SessionFloatIcon, {})
			);
		}

		/**
		 * 对话头部的「会话」按钮：点一下把卡片栏停到右侧，再点收起。
		 * 需要右栏不可用时保持沉默，不打断对话。
		 */
		/**
		 * 跟随右栏状态：供头部按钮显示高亮。
		 *
		 * 右栏没有稳定的事件源可订阅（openTabs 是否存在、变更是否触发通知都不保证），
		 * 所以「能订阅就订阅 + 600ms 轮询兜底」：轮询只在对话头部挂载期间跑，开销可忽略。
		 */
		const useRailActive = (typeof react.useEffect === "function")
			? function useRailActiveLive(rightbar) {
				const [active, setActive] = react.useState(() => (rightbar ? railIsActive(rightbar) : false));
				react.useEffect(() => {
					// setState 传同样的值 React 会跳过重渲染，所以轮询本身很便宜；
					// 关键是别每 600ms 都塞一个新状态把整个头部拖着重画。
					const sync = () => setActive(rightbar ? railIsActive(rightbar) : false);
					sync();
					const source = rightbar && rightbar.openTabs;
					const unsubscribe = source && typeof source.subscribe === "function" ? source.subscribe(sync) : undefined;
					const timer = setInterval(sync, 900);
					return () => {
						if (typeof unsubscribe === "function") unsubscribe();
						clearInterval(timer);
					};
				}, [rightbar]);
				return active;
			}
			: function useRailActiveStatic() {
				return false;
			};

		function SessionRailButton(props) {
			const rightbar = props.rightbar;
			const toggle = props.toggleRail;
			let active = false;
			try {
				active = useRailActive(rightbar);
			} catch {
				active = false;
			}
			return h(
				"button",
				{
					type: "button",
					className: "dsp-rail-btn" + (active ? " is-active" : ""),
					title: active ? "收起会话卡片栏" : "展开会话卡片栏（点卡片就切会话，栏不关）",
					"aria-label": "会话卡片栏",
					"aria-pressed": active,
					onClick: () => {
						if (typeof toggle === "function") toggle();
					}
				},
				h(SessionPanelIcon, {})
			);
		}

		/** 浮窗几何与开关（本机持久化）：拖动、缩放的最终位置都记在这里。 */
		const FLOAT_KEY = "dsh.session-panel.float.v1";
		const FLOAT_DEFAULT = { open: false, left: null, top: null, width: 470, height: 640 };

		/** 读回浮窗状态；坏数据一律回退到默认值。 */
		function readFloatState() {
			try {
				const raw = window.localStorage.getItem(FLOAT_KEY);
				if (!raw) return { ...FLOAT_DEFAULT };
				const parsed = JSON.parse(raw);
				if (!parsed || typeof parsed !== "object") return { ...FLOAT_DEFAULT };
				const merged = { ...FLOAT_DEFAULT, ...parsed };
				return {
					open: merged.open === true,
					left: typeof merged.left === "number" ? merged.left : null,
					top: typeof merged.top === "number" ? merged.top : null,
					width: typeof merged.width === "number" ? merged.width : FLOAT_DEFAULT.width,
					height: typeof merged.height === "number" ? merged.height : FLOAT_DEFAULT.height
				};
			} catch {
				return { ...FLOAT_DEFAULT };
			}
		}

		/** 浮窗状态：右栏里的「浮动」按钮与浮窗自身共享这一份。 */
		const floatState = (() => {
			const stored = readFloatState();
			return { open: stored.open, rect: stored, listeners: new Set() };
		})();

		function persistFloat() {
			try {
				window.localStorage.setItem(FLOAT_KEY, JSON.stringify({ ...floatState.rect, open: floatState.open }));
			} catch {
				/* 持久化失败不影响显示 */
			}
			for (const listener of floatState.listeners) listener();
		}

		/** 开/关浮窗。 */
		function setFloatOpen(open) {
			floatState.open = open === true;
			persistFloat();
		}

		/** 改变浮窗几何（拖动/缩放时调用）。 */
		function setFloatRect(changes) {
			Object.assign(floatState.rect, changes);
			persistFloat();
		}

		/**
		 * 订阅浮窗状态。浮窗开关来自右栏按钮，没有框架级事件源，
		 * 所以仍然「订阅 + 800ms 轮询兜底」。
		 */
		const useFloatState = (typeof react.useEffect === "function")
			? function useFloatStateLive() {
				const [, bump] = react.useState(0);
				react.useEffect(() => {
					const snapshotOf = () => ({
						open: floatState.open,
						left: floatState.rect.left,
						top: floatState.rect.top,
						width: floatState.rect.width,
						height: floatState.rect.height
					});
					let last = snapshotOf();
					const sync = () => {
						const next = snapshotOf();
						if (
							next.open === last.open &&
							next.left === last.left &&
							next.top === last.top &&
							next.width === last.width &&
							next.height === last.height
						) return; // 没变就不重渲染
						last = next;
						bump((value) => value + 1);
					};
					floatState.listeners.add(sync);
					const timer = setInterval(sync, 1000);
					return () => {
						floatState.listeners.delete(sync);
						clearInterval(timer);
					};
				}, []);
				return floatState;
			}
			: function useFloatStateStatic() {
				return floatState;
			};

		/**
		 * 会话卡片列表：按工作区分组、组可折叠、点卡片切会话。
		 * 右栏和浮窗共用这一份，保证两处行为一致。
		 */
		function SessionCardGroups(props) {
			const {
				model,
				statuses,
				collapsed,
				onToggleGroup,
				onPick,
				dragState,
				dropHint,
				makeDrag,
				onDragOverEnd,
				onDropEnd,
				hiddenSessionIds,
				onHideSession,
				onUnhideSession,
				onArchiveSession
			} = props;
			const groups = model.groups;
			if (groups.length === 0) {
				return h("p", { className: "dsp-empty" }, model.ready ? "没有可显示的会话。" : "正在载入会话…");
			}
			return groups.map((group) => {
				const isCollapsed = collapsed.has(group.key);
				// 拖动只发生在同一泳道内：别的泳道的卡片不接受落点
				const draggingHere = Boolean(dragState) && dragState.groupKey === group.key;
				const dropSideOf = (sessionId) => {
					if (!draggingHere || !dropHint || dropHint.sessionId !== sessionId) return null;
					return dropHint.side;
				};
				// 挂到空白处的落点处理：没在拖的时候 onDropEnd 自己会安全返回
				const gridHandlers = {
					onDragOver: (event) => {
						if (!draggingHere) return;
						event.preventDefault();
						if (typeof onDragOverEnd === "function") onDragOverEnd();
					},
					onDrop: (event) => {
						if (!draggingHere) return;
						event.preventDefault();
						if (typeof onDropEnd === "function") onDropEnd(group.key);
					}
				};
				return h(
					"section",
					{ key: group.key === UNGROUPED_KEY ? "__ungrouped__" : group.key, className: "dsp-rail-group" },
					h(
						"div",
						{
							className: "dsp-rail-group-head",
							role: "button",
							tabIndex: 0,
							"aria-expanded": !isCollapsed,
							onClick: () => onToggleGroup(group.key),
							onKeyDown: (event) => {
								if (event.key === "Enter" || event.key === " ") {
									event.preventDefault();
									onToggleGroup(group.key);
								}
							}
						},
						h("span", { className: "dsp-caret" }, isCollapsed ? "▶" : "▼"),
						h("span", { className: "dsp-rail-group-name", title: group.title }, group.title),
						h("span", { className: "dsp-count" }, String(group.sessionIds.length))
					),
					isCollapsed
						? null
						: h(
							"div",
							Object.assign({ className: "dsp-rail-grid" }, gridHandlers),
							group.sessionIds.map((sessionId) => {
								const row = model.byId[sessionId];
								if (!row) return null;
								const isArchived = model.archived.has(sessionId);
								return h(SessionCard, {
									key: sessionId,
									row,
									status: statuses.get(sessionId),
									isCurrent: sessionId === model.currentId,
									isArchived,
									openSession: onPick,
									drag: typeof makeDrag === "function" ? makeDrag(row, isArchived, group.key) : undefined,
									dragActive: draggingHere,
									isUserHidden: Boolean(hiddenSessionIds && hiddenSessionIds.has(row.id)),
									onHide: onHideSession,
									onUnhide: onUnhideSession,
									onArchive: onArchiveSession,
									dropHint: dropSideOf(sessionId),
									isDragging: draggingHere && dragState.sessionId === sessionId
								});
							})
						)
				);
			});
		}

		/** 把数值夹在区间内。 */
		function clampNumber(value, min, max) {
			return Math.min(Math.max(value, min), Math.max(min, max));
		}

		/**
		 * 可拖动的会话浮窗：挂在 `shell.overlay`（全框浮层，本身点击穿透、条目自己接管指针）。
		 *
		 * 拖标题栏移动、拖右下角缩放，位置与大小都记在本机 localStorage；
		 * 卡片列表与右栏共用 `SessionCardGroups`，所以两边行为一致。
		 */
		function FloatingCards(props) {
			const state = useFloatState();
			// 关着就直接退出：不开浮窗时不做任何分组/排序计算，也不挂卡片
			if (!state.open) return null;
			return h(FloatingCardsOpen, { ...props, rect: state.rect });
		}

		/** 浮窗打开时的内容：几何、拖动、缩放、卡片列表。 */
		function FloatingCardsOpen(props) {
			const rect = props.rect;
			const useSessions = props.useSessions || (() => undefined);
			const useWorkspaces = props.useWorkspaces || (() => undefined);
			const useSessionStatus = props.useSessionStatus || (() => undefined);

			const listState = useSessions((snapshot) => snapshot);
			const workspaceState = useWorkspaces((snapshot) => snapshot);
			const statuses = useSessionStatus((snapshot) => snapshot) || EMPTY_STATUSES;
			const [hiddenKeys] = useStoredList(HIDDEN_KEY);
			const [collapsedKeys, setCollapsedKeys] = useStoredList(COLLAPSED_KEY);
			const [hiddenSessionIds, setHiddenSessionIds] = useStoredList(HIDDEN_SESSIONS_KEY);
			const [filterMode] = useFilterMode();
			const now = useNow(filterMode === FILTER_HALF_HOUR);
			const model = react.useMemo(
				() => buildModel(listState, workspaceState, hiddenKeys, ORDER_RECENT, { hiddenSessionIds, filterMode, now }),
				[listState, workspaceState, hiddenKeys, hiddenSessionIds, filterMode, now]
			);
			const hideSession = (sessionId) => {
				setHiddenSessionIds(hiddenSessionIds.includes(sessionId) ? hiddenSessionIds : hiddenSessionIds.concat(sessionId));
			};
			const unhideSession = (sessionId) => {
				setHiddenSessionIds(hiddenSessionIds.filter((item) => item !== sessionId));
			};
			const archiveSession = (sessionId) => {
				if (typeof props.archiveSession !== "function") return;
				try {
					const result = props.archiveSession(sessionId);
					if (result && typeof result.catch === "function") result.catch(() => {});
				} catch {
					/* 归档失败时保持安静：浮窗没有错误行 */
				}
			};
			const collapsed = react.useMemo(() => new Set(collapsedKeys.map(String)), [collapsedKeys]);

			const viewportWidth = typeof window.innerWidth === "number" ? window.innerWidth : 1440;
			const viewportHeight = typeof window.innerHeight === "number" ? window.innerHeight : 900;
			const width = clampNumber(rect.width, 280, Math.max(280, viewportWidth - 16));
			const height = clampNumber(rect.height, 240, Math.max(240, viewportHeight - 16));
			const left = rect.left === null ? Math.max(16, viewportWidth - width - 40) : clampNumber(rect.left, 8, Math.max(8, viewportWidth - width - 8));
			const top = rect.top === null ? 84 : clampNumber(rect.top, 8, Math.max(8, viewportHeight - 56));
			const totalSessions = model.groups.reduce((count, group) => count + group.sessionIds.length, 0);
			const allCollapsed = model.groups.length > 0 && model.groups.every((group) => collapsed.has(group.key));
			const toggleGroup = (key) => {
				setCollapsedKeys(
					collapsedKeys.includes(key) ? collapsedKeys.filter((item) => item !== key) : collapsedKeys.concat(key)
				);
			};

			/** 拖动/缩放：按下时锁定起点，移动时算增量，松开解绑（几何已经在每次移动时持久化）。 */
			const startDrag = (event, mode) => {
				if (typeof event.button === "number" && event.button !== 0) return;
				if (typeof event.preventDefault === "function") event.preventDefault();
				if (typeof event.stopPropagation === "function") event.stopPropagation();
				const startX = event.clientX;
				const startY = event.clientY;
				const startLeft = left;
				const startTop = top;
				const startWidth = width;
				const startHeight = height;
				const onMove = (moveEvent) => {
					const dx = moveEvent.clientX - startX;
					const dy = moveEvent.clientY - startY;
					if (mode === "move") {
						setFloatRect({
							left: clampNumber(startLeft + dx, 8, Math.max(8, viewportWidth - startWidth - 8)),
							top: clampNumber(startTop + dy, 8, Math.max(8, viewportHeight - 56))
						});
						return;
					}
					setFloatRect({
						width: clampNumber(startWidth + dx, 280, Math.max(280, viewportWidth - 16)),
						height: clampNumber(startHeight + dy, 240, Math.max(240, viewportHeight - 16))
					});
				};
				const onUp = () => {
					window.removeEventListener("pointermove", onMove);
					window.removeEventListener("pointerup", onUp);
				};
				window.addEventListener("pointermove", onMove);
				window.addEventListener("pointerup", onUp);
			};

			return h(
				"div",
				{
					className: "dsp-float",
					"data-dsh-plugin": "session-panel-float",
					style: { left: left + "px", top: top + "px", width: width + "px", height: height + "px" }
				},
				h(
					"div",
					{ className: "dsp-float-head", title: "按住拖动", onPointerDown: (event) => startDrag(event, "move") },
					h("span", { className: "dsp-float-title" }, "会话"),
					h("span", { className: "dsp-rail-count" }, String(totalSessions)),
					h(FilterBar, { compact: true }),
					h(
						"button",
						{
							type: "button",
							className: "dsp-btn",
							onClick: () =>
								setCollapsedKeys(allCollapsed ? [] : model.groups.map((group) => group.key))
						},
						allCollapsed ? "全部展开" : "全部折叠"
					),
					h(
						"button",
						{
							type: "button",
							className: "dsp-icon-btn dsp-icon-btn--always",
							title: "关闭浮窗",
							"aria-label": "关闭会话浮窗",
							onClick: () => setFloatOpen(false)
						},
						"✕"
					)
				),
				h(
					"div",
					{ className: "dsp-float-body" },
					h(SessionCardGroups, {
						model,
						statuses,
						collapsed,
						onToggleGroup: toggleGroup,
						onPick: (sessionId) => {
							if (typeof props.openSession === "function") props.openSession(sessionId);
						},
						hiddenSessionIds: new Set(hiddenSessionIds.map(String)),
						onHideSession: hideSession,
						onUnhideSession: unhideSession,
						onArchiveSession: archiveSession
					})
				),
				h("div", { className: "dsp-float-resize", title: "拖动缩放", onPointerDown: (event) => startDrag(event, "resize") })
			);
		}

		/**
		 * 右侧栏里的会话卡片：按工作区分组、组可折叠，点卡片切换中间会话。
		 *
		 * 与主区看板共用同一套数据与分组逻辑（buildModel），版式压缩成一列宽。
		 */
		function SessionRail(props) {
			const pickSession = props.openSession;
			const rightbar = props.rightbar;
			const useSessions = props.useSessions || (() => undefined);
			const useWorkspaces = props.useWorkspaces || (() => undefined);
			const useSessionStatus = props.useSessionStatus || (() => undefined);

			const listState = useSessions((state) => state);
			const workspaceState = useWorkspaces((state) => state);
			const statuses = useSessionStatus((state) => state) || EMPTY_STATUSES;

			const [hiddenKeys] = useStoredList(HIDDEN_KEY);
			const [collapsedKeys, setCollapsedKeys] = useStoredList(COLLAPSED_KEY);
			const [orderMode, setOrderMode] = useStoredValue(ORDER_KEY, ORDER_RECENT);
			const [orderError, setOrderError] = react.useState("");
			const [hiddenSessionIds, setHiddenSessionIds] = useStoredList(HIDDEN_SESSIONS_KEY);
			const [revealHidden, setRevealHidden] = react.useState(false);
			const [filterMode] = useFilterMode();
			const now = useNow(filterMode === FILTER_HALF_HOUR);
			const model = react.useMemo(
				() =>
					buildModel(listState, workspaceState, hiddenKeys, orderMode, {
						hiddenSessionIds,
						revealHidden,
						filterMode,
						now
					}),
				[listState, workspaceState, hiddenKeys, orderMode, hiddenSessionIds, revealHidden, filterMode, now]
			);
			const collapsed = react.useMemo(() => new Set(collapsedKeys.map(String)), [collapsedKeys]);
			const groups = model.groups;
			const totalSessions = groups.reduce((count, group) => count + group.sessionIds.length, 0);
			const allCollapsed = groups.length > 0 && groups.every((group) => collapsed.has(group.key));

			/** 在本面板隐藏/恢复一个会话（只写本机，不动官方侧栏）。 */
			const hideSession = (sessionId) => {
				setHiddenSessionIds(hiddenSessionIds.includes(sessionId) ? hiddenSessionIds : hiddenSessionIds.concat(sessionId));
			};
			const unhideSession = (sessionId) => {
				setHiddenSessionIds(hiddenSessionIds.filter((item) => item !== sessionId));
			};
			const archiveSession = (sessionId) => {
				if (typeof props.archiveSession !== "function") {
					setOrderError("当前宿主没有提供归档接口。");
					return;
				}
				const fail = (error) => setOrderError("归档失败：" + (error && error.message ? error.message : String(error)));
				try {
					const result = props.archiveSession(sessionId);
					if (result && typeof result.catch === "function") result.catch(fail);
					setOrderError("");
				} catch (error) {
					fail(error);
				}
			};

			// 右栏里的卡片也能直接拖动排序（同一工作区内），和主区看板共用同一套写入逻辑
			const drag = useCardDrag({
				model,
				orderMode,
				setOrderMode,
				insertSessionBefore: props.insertSessionBefore,
				setOrderError
			});
			const makeDrag = (row, isArchived, groupKey) =>
				cardDragAttributes({
					row,
					groupKey,
					isArchived,
					canReorder: groupKey !== UNGROUPED_KEY,
					draggingHere: Boolean(drag.dragState) && drag.dragState.groupKey === groupKey,
					onDragStart: drag.onDragStart,
					onDragEnd: drag.onDragEnd,
					onDragOverCard: drag.onDragOverCard,
					onDropCard: drag.onDropCard
				});

			const toggleGroup = (key) => {
				setCollapsedKeys(
					collapsedKeys.includes(key) ? collapsedKeys.filter((item) => item !== key) : collapsedKeys.concat(key)
				);
			};
			const pick = (sessionId) => {
				if (typeof pickSession === "function") pickSession(sessionId);
				if (rightbar) ensureRail(rightbar, sessionId);
			};

			return h(
				"div",
				{ className: "dsp-rail", "data-dsh-plugin": "session-panel-rail" },
				h(
					"div",
					{ className: "dsp-rail-head" },
					h("span", { className: "dsp-rail-title" }, "会话"),
					h("span", { className: "dsp-rail-count" }, String(totalSessions)),
					h(FilterBar, { compact: true }),
					model.hiddenSessionCount === 0
						? null
						: h(
							"button",
							{
								type: "button",
								className: "dsp-btn",
								title: "这些会话只在本面板隐藏，不改变官方侧栏",
								onClick: () => setRevealHidden(!revealHidden)
							},
							revealHidden ? "收起已隐藏" : "已隐藏 " + model.hiddenSessionCount
						),
					h(
						"button",
						{ type: "button", className: "dsp-btn", title: "浮成可拖动的窗口（可拖到任意位置）", onClick: () => setFloatOpen(true) },
						"浮动"
					),
					h(
						"button",
						{
							type: "button",
							className: "dsp-btn",
							onClick: () => setCollapsedKeys(allCollapsed ? [] : groups.map((group) => group.key))
						},
						allCollapsed ? "全部展开" : "全部折叠"
					)
				),
				orderError === "" ? null : h("p", { className: "dsp-error" }, orderError),
				h(
					"div",
					{ className: "dsp-rail-body" },
					h(SessionCardGroups, {
						model,
						statuses,
						collapsed,
						onToggleGroup: toggleGroup,
						onPick: pick,
						dragState: drag.dragState,
						dropHint: drag.dropHint,
						makeDrag,
						onDragOverEnd: drag.onDragOverEnd,
						onDropEnd: drag.onDropEnd,
						hiddenSessionIds: new Set(hiddenSessionIds.map(String)),
						onHideSession: hideSession,
						onUnhideSession: unhideSession,
						onArchiveSession: archiveSession
					})
				)
			);
		}
		//#endregion

		//#region 插件体
		/**
		 * 挂载左栏入口与主区面板。
		 *
		 * 两个座位都由别的 shell 插件声明（ui-sidebar 声明 `sidebar.panellist`、
		 * ui-layout 声明 `main`），所以各自用 `ctx.slots.inject` 包一层：座位存在时
		 * 才注册，缺失时面板安静地不出现，而不是让客户端启动失败。
		 * @param ctx 客户端根上下文。
		 */
		function apply(ctx) {
			installStyles();
			ctx.slots.inject("sidebar.panellist", () =>
				ctx.slots.register(
					{
						name: "sidebar.panellist",
						id: PANEL_ID,
						order: PANEL_ORDER,
						label: () => "会话"
					},
					SessionPanelIcon
				)
			);
			ctx.slots.inject("main", () =>
				ctx.slots.register(
					{
						name: "main",
						key: PANEL_ID,
						inject: () => ({
							openSession: (sessionId) => ctx.uiWorkspace.openSession(sessionId),
							insertSessionBefore: (workspaceId, sessionId, beforeSessionId) =>
								ctx.workspaces.insertSessionBefore(workspaceId, sessionId, beforeSessionId),
							archiveSession: (sessionId) => ctx.workspaces.archiveSession(sessionId)
						})
					},
					SessionPanel
				)
			);

			// 右侧栏：登记一个页类型（不认地址），再把卡片栏挂到它的 tab 上。
			// 右栏老宿主可能没有这套服务，缺任何一个都安静跳过，不影响左栏与主区。
			if (ctx.sidebarRightTabs && typeof ctx.sidebarRightTabs.register === "function") {
				const registerRailType = () =>
					ctx.sidebarRightTabs.register({
						id: RAIL_ID,
						kind: RAIL_KIND,
						keepMounted: true,
						title: () => "会话",
						guide: [
							{
								id: RAIL_ID,
								order: RAIL_ORDER,
								title: () => "会话卡片",
								description: () => "卡片常驻右栏，点卡片切会话"
							}
						]
					});
				if (typeof ctx.effect === "function") ctx.effect(registerRailType, "ui-session-panel: 右栏 tab 类型");
				else registerRailType();
			}

			// 可拖动浮窗：挂全框浮层（该层本身点击穿透，条目自己接管指针）
			ctx.slots.inject("shell.overlay", () =>
				ctx.slots.register(
					{
						name: "shell.overlay",
						id: RAIL_ID,
						order: RAIL_ORDER,
						inject: () => ({
							openSession: (sessionId) => ctx.uiWorkspace.openSession(sessionId),
							archiveSession: (sessionId) => ctx.workspaces.archiveSession(sessionId)
						})
					},
					FloatingCards
				)
			);

			if (ctx.sidebarRight) {
				ctx.slots.inject("sidebar.right.pane.tab", () =>
					ctx.slots.register(
						{
							name: "sidebar.right.pane.tab",
							key: RAIL_ID,
							inject: () => ({
								openSession: (sessionId) => ctx.uiWorkspace.openSession(sessionId),
								rightbar: ctx.sidebarRight,
								insertSessionBefore: (workspaceId, sessionId, beforeSessionId) =>
									ctx.workspaces.insertSessionBefore(workspaceId, sessionId, beforeSessionId),
								archiveSession: (sessionId) => ctx.workspaces.archiveSession(sessionId)
							})
						},
						SessionRail
					)
				);
				ctx.slots.inject("conversation.session.header.utilities", () =>
					ctx.slots.register(
						{
							name: "conversation.session.header.utilities",
							id: RAIL_ID,
							order: RAIL_ORDER,
							inject: () => ({
								rightbar: ctx.sidebarRight,
								toggleRail: () => toggleRail(ctx.sidebarRight)
							})
						},
						SessionRailButton
					)
				);
				// 浮窗按钮：直接丢出可拖动窗口，不经过右侧栏
				ctx.slots.inject("conversation.session.header.utilities", () =>
					ctx.slots.register(
						{
							name: "conversation.session.header.utilities",
							id: RAIL_ID + "-float",
							order: RAIL_ORDER + 1,
							inject: () => ({
								toggleFloat: () => setFloatOpen(!floatState.open)
							})
						},
						SessionFloatButton
					)
				);
			}
		}

		const inject = ["slots", "uiWorkspace", "workspaces", "sidebarRight", "sidebarRightTabs"];
		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		exports.SessionPanel = SessionPanel;
		exports.SessionPanelIcon = SessionPanelIcon;
		exports.buildModel = buildModel;
		exports.SessionRail = SessionRail;
		exports.SessionRailButton = SessionRailButton;
		exports.FloatingCards = FloatingCards;
		exports.SessionFloatButton = SessionFloatButton;
		exports.setFloatOpen = setFloatOpen;
		exports.setFloatRect = setFloatRect;
		exports.RAIL_ID = RAIL_ID;
		exports.RAIL_KIND = RAIL_KIND;
		exports.computeReorderAnchor = computeReorderAnchor;
		exports.formatRelative = formatRelative;
		exports.PANEL_ID = PANEL_ID;
		return module.exports;
	}
});
