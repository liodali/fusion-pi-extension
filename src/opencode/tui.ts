import { createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import { createElement, insert, spread, type JSX } from "@opentui/solid";
import type { Plugin } from "@opencode/plugin/tui";
import { actionLabel, elapsedLabel, latestDelegateActivity } from "./activity-view.ts";

/** Explicit host render primitives avoid runtime JSX imports that fail when
 * a plugin is installed under node_modules without its own UI dependencies. */
export default {
	id: "fusion",
	setup(ctx: Plugin.Context) {
		const version = /^v?(\d+)\.(\d+)\.(\d+)/.exec(ctx.app.version);
		if (version && Number(version[1]) === 2 && (Number(version[2]) < 2 || Number(version[2]) === 2 && Number(version[3]) < 5)) return;
		if (typeof ctx.ui?.slot !== "function") return;
		return ctx.ui.slot({
			append: "session.composer.top",
			render(input) {
				const activity = createMemo(() => latestDelegateActivity(ctx.data.session.message.list(input.sessionID)));
				const [now, setNow] = createSignal(Date.now());
				const [stopPending, setStopPending] = createSignal(false);
				const running = () => activity()?.phase === "starting" || activity()?.phase === "working" || activity()?.phase === "stopping";
				createEffect(() => {
					if (!running()) return;
					const timer = setInterval(() => setNow(Date.now()), 1000);
					onCleanup(() => clearInterval(timer));
				});
				const box = createElement("box");
				spread(box, { paddingLeft: 2, paddingBottom: 1, get visible() { return !!activity(); } });
				const openChild = () => {
					const child = activity()?.childSessionID;
					if (child && !ctx.renderer.getSelection()?.getSelectedText()) ctx.ui.router.navigate({ type: "session", sessionID: child });
				};
				const title = createElement("text");
				spread(title, { fg: ctx.theme.text.base, onMouseUp: openChild });
				insert(title, () => { const current = activity(); return current ? `Fusion · ${actionLabel(current.action)} · ${current.title}` : ""; });
				const status = createElement("text");
				spread(status, { fg: ctx.theme.text.muted, onMouseUp: openChild });
				insert(status, () => {
					const current = activity();
					return current ? `${running() ? "◌" : current.phase === "completed" ? "✓" : "·"} ${current.activity} · ${current.tools} tools · ${elapsedLabel(current.startedAt, running() ? now() : current.updatedAt)}${current.childSessionID ? " · click to open executor" : ""}` : "";
				});
				insert(box, title);
				insert(box, status);
				const stopButton = createElement("text");
				spread(stopButton, { fg: ctx.theme.text.feedback.warning.base, get visible() { const phase = activity()?.phase; return !!phase && !["completed", "stopped", "failed"].includes(phase); }, onMouseUp() {
					if (stopPending() || ctx.renderer.getSelection()?.getSelectedText()) return;
					setStopPending(true);
					void ctx.client.session.command({ sessionID: input.sessionID, name: "fusion-stop", text: "Stop button" }).catch(() => { ctx.ui.toast.show({ title: "Executor stop could not be requested", message: "Use /fusion-stop or inspect /fusion-status.", variant: "error" }); }).finally(() => setStopPending(false));
				} });
				insert(stopButton, () => stopPending() ? "[Requesting stop…]" : "[Stop executor]");
				insert(box, stopButton);
				// OpenTUI's primitive factory declares BaseRenderable; the host
				// mounts this concrete box as its native element.
				return box as unknown as JSX.Element;
			},
		});
	},
} satisfies Plugin.Definition;
