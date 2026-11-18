/**
 * dsh-session-delete —— 浏览器半边。
 *
 * 两个入口，同一条确认弹窗、同一份删除逻辑：
 *   1) 会话右键菜单（ctx.contextMenus，target "session"，排在「归档会话」后面）
 *   2) 会话标题栏的垃圾桶按钮（槽 conversation.session.header.actions）
 * 确认之后：
 *   - POST /plugin/session-delete 交给主机半边删磁盘上的会话目录
 *   - 如果主机报 in-use（日志被当前会话的 agent 占着），先切到空白会话再重试
 *   - 刷新会话列表；列表里还赖着就整页 reload 兜底
 *
 * 模块外壳照 DSH 客户端插件的加载约定写（不是 JSX 编译产物）。
 */
window.__ModuleLoader__.load({
	id: "dsh-session-delete",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react_jsx_runtime = require("react/jsx-runtime");
		let react = require("react");
		// primitives 在浏览器运行时由模块加载器提供；拿不到就退化成最朴素的样子。
		let primitives = null;
		try {
			primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		} catch (error) {
			primitives = null;
		}

		const css = [
			".dsd-trigger{display:inline-flex;align-items:center;gap:4px;min-height:28px;padding:3px 4px;",
			"background:0 0;border:0;border-radius:var(--dsw-radius-sm);cursor:pointer;",
			"color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;",
			"transition:color .12s,background-color .12s}",
			"@media (hover:hover){.dsd-trigger:hover{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-fill-tint-hover,rgba(0,0,0,.04))}}",
			".dsd-trigger:focus-visible{outline:2px solid var(--dsw-alias-border-focus,rgba(64,128,255,.6));outline-offset:1px}",
			".dsd-danger{color:var(--dsw-alias-label-error,#d33)}",
			".dsd-error{margin:0;color:var(--dsw-alias-label-error,#d33);font-size:12px;line-height:18px}",
			".dsd-hint{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}"
		].join("");

		function styleTag() {
			const existing = document.querySelector('style[data-plugin="dsh-session-delete"]');
			if (existing !== null) return existing;
			const tag = document.createElement("style");
			tag.setAttribute("data-plugin", "dsh-session-delete");
			tag.textContent = css;
			document.head.appendChild(tag);
			return tag;
		}

		/** 拿不到 primitives 图标的退路。 */
		function TrashIconFallback() {
			return (0, react_jsx_runtime.jsxs)(
				"svg",
				{
					width: 14,
					height: 14,
					viewBox: "0 0 24 24",
					fill: "none",
					stroke: "currentColor",
					strokeWidth: 2,
					strokeLinecap: "round",
					strokeLinejoin: "round",
					"aria-hidden": true
				},
				[
					(0, react_jsx_runtime.jsx)("path", { key: "top", d: "M3 6h18" }, "top"),
					(0, react_jsx_runtime.jsx)("path", { key: "cap", d: "M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" }, "cap"),
					(0, react_jsx_runtime.jsx)("path", { key: "body", d: "M6 6l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13" }, "body"),
					(0, react_jsx_runtime.jsx)("path", { key: "lines", d: "M10 11v5M14 11v5" }, "lines")
				]
			);
		}

		const TrashIcon = primitives?.IconTrashOutlineRegular ?? TrashIconFallback;

		const ENDPOINT = "/plugin/session-delete";
		const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

		/** 调主机半边删磁盘目录。 */
		async function requestDelete(sessionId) {
			const response = await fetch(ENDPOINT, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ sessionId })
			});
			let payload;
			try {
				payload = await response.json();
			} catch {
				payload = undefined;
			}
			return {
				ok: response.ok && payload?.ok === true,
				code: payload?.code,
				message: payload?.message ?? `HTTP ${response.status}`
			};
		}

		/** 会话标题（弹窗里点名用）。 */
		function displayTitleOf(ctx, sessionId) {
			try {
				return ctx.sessions.list.getSnapshot()?.byId?.[sessionId]?.displayTitle ?? sessionId;
			} catch (error) {
				return sessionId;
			}
		}

		/**
		 * 真删：POST → 被占用就先离开这个会话再重试 → 刷新列表 → 必要时 reload。
		 * @param ctx 客户端根上下文。
		 * @param sessionId 目标会话。
		 */
		async function performDelete(ctx, sessionId) {
			let result = await requestDelete(sessionId);
			if (!result.ok && result.code === "in-use") {
				// 日志句柄被当前会话的 agent 攥着：切到空白会话让宿主 dispose 之后再删。
				try {
					await ctx.uiWorkspace.startSession();
				} catch (error) {
					console.warn("[session-delete] 切到空白会话失败：", error);
				}
				await sleep(600);
				for (let attempt = 0; attempt < 3; attempt += 1) {
					result = await requestDelete(sessionId);
					if (result.ok || result.code !== "in-use") break;
					await sleep(400);
				}
			}
			if (!result.ok) throw new Error(result.message);
			try {
				await ctx.sessions.refresh();
			} catch (error) {
				console.warn("[session-delete] 刷新会话列表失败：", error);
			}
			await sleep(400);
			// 列表是从磁盘枚举的（session-query.listSessions），刷新后应该就没这行了；
			// 万一还赖着（宿主缓存之类），整页 reload 兜底。
			try {
				const snapshot = ctx.sessions.list.getSnapshot();
				if (snapshot?.byId?.[sessionId] !== undefined) window.location.reload();
			} catch (error) {
				console.warn("[session-delete] 读会话列表快照失败：", error);
			}
		}

		/* ---------------------------------------------------------------- 确认请求 */

		const center = { pending: null, listeners: new Set() };

		function setPending(next) {
			center.pending = next;
			for (const listener of [...center.listeners]) listener();
		}

		/** 弹窗读的 hook：模块级一份，菜单入口和标题栏按钮共用。 */
		function usePending() {
			const [value, setValue] = react.useState(center.pending);
			react.useEffect(() => {
				let alive = true;
				const listener = () => {
					if (alive) setValue(center.pending);
				};
				center.listeners.add(listener);
				listener();
				return () => {
					alive = false;
					center.listeners.delete(listener);
				};
			}, []);
			return value;
		}

		/** 标题栏按钮与右键菜单都走这里。 */
		function requestConfirmation(sessionId, displayTitle) {
			setPending({ sessionId, displayTitle: displayTitle ?? sessionId });
		}

		/* -------------------------------------------------------------------- 组件 */

		/**
		 * 确认弹窗（挂在 shell.overlay 槽上，永远渲染但没请求时返回 null）。
		 * @param props.performDelete 真删逻辑（apply 注入）。
		 */
		function DeleteSessionDialog({ performDelete: runDelete }) {
			const request = usePending();
			const [busy, setBusy] = react.useState(false);
			const [error, setError] = react.useState(null);

			if (request === null) return null;

			const close = () => {
				if (busy) return;
				setError(null);
				setPending(null);
			};
			const confirm = async () => {
				if (busy) return;
				setBusy(true);
				setError(null);
				try {
					await runDelete(request.sessionId);
					setBusy(false);
					setPending(null);
				} catch (reason) {
					setBusy(false);
					setError(`删除失败：${String(reason?.message ?? reason)}`);
				}
			};

			const body = [
				(0, react_jsx_runtime.jsx)(
					"p",
					{ className: "dsd-hint", key: "hint" },
					"会话日志会从磁盘删掉，不可恢复；只想从列表里藏起来的话，请用「归档会话」。"
				)
			];
			if (error !== null) {
				body.push(
					(0, react_jsx_runtime.jsx)("p", { className: "dsd-error", key: "error", role: "alert" }, error)
				);
			}

			const Button = primitives?.Button;
			const footer =
				Button === undefined
					? [
							(0, react_jsx_runtime.jsx)("button", { key: "cancel", type: "button", onClick: close, disabled: busy }, "取消"),
							(0, react_jsx_runtime.jsx)("button", { key: "ok", type: "button", className: "dsd-danger", onClick: confirm, disabled: busy }, busy ? "删除中…" : "删除")
						]
					: [
							(0, react_jsx_runtime.jsx)(Button, { key: "cancel", variant: "outline", disabled: busy, onClick: close }, "取消"),
							(0, react_jsx_runtime.jsx)(Button, { key: "ok", variant: "outline", className: "dsd-danger", disabled: busy, onClick: confirm }, busy ? "删除中…" : "删除")
						];

			const Modal = primitives?.Modal;
			if (Modal === undefined) return null;
			return (0, react_jsx_runtime.jsx)(Modal, {
				open: true,
				onClose: close,
				closeLabel: "关闭",
				title: "删除对话",
				description: `「${request.displayTitle}」`,
				footer,
				children: body
			});
		}

		/**
		 * 会话标题栏里的垃圾桶按钮（点开同一个确认弹窗）。
		 * @param props.sessionId 当前会话 id（槽位注入）。
		 * @param props.requestConfirmation 打开确认弹窗（apply 注入）。
		 */
		function DeleteSessionAction({ sessionId, requestConfirmation: ask }) {
			const onClick = react.useCallback(() => {
				ask(sessionId);
			}, [ask, sessionId]);
			return (0, react_jsx_runtime.jsxs)(
				"button",
				{
					type: "button",
					className: "dsd-trigger",
					title: "把这个会话的日志从磁盘删掉（不可恢复）；只想从列表里藏起来用「归档」",
					"aria-label": "删除会话",
					onClick
				},
				[(0, react_jsx_runtime.jsx)(TrashIcon, {}, "icon"), (0, react_jsx_runtime.jsx)("span", { key: "text" }, "删除")],
				"delete"
			);
		}

		const inject = ["slots", "contextMenus", "uiWorkspace", "sessions"];

		/**
		 * @param ctx 客户端根上下文。
		 */
		function apply(ctx) {
			styleTag();

			// 1. 右键菜单：排在「归档会话」(order 600) 后面，同在底部那一组。
			ctx.effect(
				() =>
					ctx.contextMenus.register({
						id: "session.delete",
						target: "session",
						order: 700,
						resolve: (target) => [
							{
								id: "delete",
								label: "删除对话",
								icon: { key: "session.delete" },
								danger: true,
								afterContent: true,
								run: () => requestConfirmation(target.sessionId, target.displayTitle)
							}
						]
					}),
				"session-delete: 右键菜单项"
			);

			// 2. 菜单图标（keyed 槽 contextMenu.icon，跟官方那些 workspace.* 图标同一个槽）。
			ctx.slots.inject("contextMenu.icon", function* () {
				yield ctx.slots.register({ name: "contextMenu.icon", key: "session.delete" }, TrashIcon);
			});

			// 3. 确认弹窗。
			ctx.slots.inject("shell.overlay", () =>
				ctx.slots.register(
					{
						name: "shell.overlay",
						id: "session-delete-confirm",
						inject: () => ({ performDelete: (sessionId) => performDelete(ctx, sessionId) })
					},
					DeleteSessionDialog
				)
			);

			// 4. 标题栏按钮（顺手留着的次要入口）。
			ctx.slots.inject("conversation.session.header.actions", () =>
				ctx.slots.register(
					{
						name: "conversation.session.header.actions",
						id: "session-delete",
						order: 90,
						inject: () => ({
							requestConfirmation: (sessionId, displayTitle) =>
								requestConfirmation(sessionId, displayTitle ?? displayTitleOf(ctx, sessionId))
						})
					},
					DeleteSessionAction
				)
			);
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});