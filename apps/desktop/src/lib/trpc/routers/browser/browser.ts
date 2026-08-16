import { observable } from "@trpc/server/observable";
import { session } from "electron";
import {
	browserManager,
	type ForwardedKey,
} from "main/lib/browser/browser-manager";
import { getKey } from "main/lib/window-registry/window-registry";
import { z } from "zod";
import { publicProcedure, router } from "../..";

/**
 * Pane ids are unique within a window, not across windows: two windows
 * restoring the same layout hold the same ids, and BrowserManager keys its
 * WebContents map by pane id alone — so the second window's registration
 * silently replaced the first window's. Namespacing by the calling window's
 * persisted key keeps them apart.
 *
 * Falls back to the bare pane id when the sender is not a resolvable window
 * (a `<webview>` guest), which is the single-window behaviour.
 */
function scopedPaneId(
	ctx: { senderWindow: Electron.BrowserWindow | null },
	paneId: string,
): string {
	const key = ctx.senderWindow ? getKey(ctx.senderWindow.id) : null;
	return key ? `${key}::${paneId}` : paneId;
}

export const createBrowserRouter = () => {
	return router({
		register: publicProcedure
			.input(z.object({ paneId: z.string(), webContentsId: z.number() }))
			.mutation(({ ctx, input }) => {
				browserManager.register(
					scopedPaneId(ctx, input.paneId),
					input.webContentsId,
				);
				return { success: true };
			}),

		unregister: publicProcedure
			.input(z.object({ paneId: z.string() }))
			.mutation(({ ctx, input }) => {
				browserManager.unregister(scopedPaneId(ctx, input.paneId));
				return { success: true };
			}),

		navigate: publicProcedure
			.input(z.object({ paneId: z.string(), url: z.string() }))
			.mutation(({ ctx, input }) => {
				browserManager.navigate(scopedPaneId(ctx, input.paneId), input.url);
				return { success: true };
			}),

		goBack: publicProcedure
			.input(z.object({ paneId: z.string() }))
			.mutation(({ ctx, input }) => {
				const wc = browserManager.getWebContents(
					scopedPaneId(ctx, input.paneId),
				);
				if (wc?.canGoBack()) wc.goBack();
				return { success: true };
			}),

		goForward: publicProcedure
			.input(z.object({ paneId: z.string() }))
			.mutation(({ ctx, input }) => {
				const wc = browserManager.getWebContents(
					scopedPaneId(ctx, input.paneId),
				);
				if (wc?.canGoForward()) wc.goForward();
				return { success: true };
			}),

		reload: publicProcedure
			.input(z.object({ paneId: z.string(), hard: z.boolean().optional() }))
			.mutation(({ ctx, input }) => {
				const wc = browserManager.getWebContents(
					scopedPaneId(ctx, input.paneId),
				);
				if (!wc) return { success: false };
				if (input.hard) {
					wc.reloadIgnoringCache();
				} else {
					wc.reload();
				}
				return { success: true };
			}),

		screenshot: publicProcedure
			.input(z.object({ paneId: z.string() }))
			.mutation(async ({ ctx, input }) => {
				const base64 = await browserManager.screenshot(
					scopedPaneId(ctx, input.paneId),
				);
				return { base64 };
			}),

		evaluateJS: publicProcedure
			.input(z.object({ paneId: z.string(), code: z.string() }))
			.mutation(async ({ ctx, input }) => {
				const result = await browserManager.evaluateJS(
					scopedPaneId(ctx, input.paneId),
					input.code,
				);
				return { result };
			}),

		getConsoleLogs: publicProcedure
			.input(z.object({ paneId: z.string() }))
			.query(({ ctx, input }) => {
				return browserManager.getConsoleLogs(scopedPaneId(ctx, input.paneId));
			}),

		consoleStream: publicProcedure
			.input(z.object({ paneId: z.string() }))
			.subscription(({ ctx, input }) => {
				return observable<{
					level: string;
					message: string;
					timestamp: number;
				}>((emit) => {
					const handler = (entry: {
						level: string;
						message: string;
						timestamp: number;
					}) => {
						emit.next(entry);
					};
					browserManager.on(
						`console:${scopedPaneId(ctx, input.paneId)}`,
						handler,
					);
					return () => {
						browserManager.off(
							`console:${scopedPaneId(ctx, input.paneId)}`,
							handler,
						);
					};
				});
			}),

		onNewWindow: publicProcedure
			.input(z.object({ paneId: z.string() }))
			.subscription(({ ctx, input }) => {
				return observable<{ url: string }>((emit) => {
					const handler = (url: string) => {
						emit.next({ url });
					};
					browserManager.on(
						`new-window:${scopedPaneId(ctx, input.paneId)}`,
						handler,
					);
					return () => {
						browserManager.off(
							`new-window:${scopedPaneId(ctx, input.paneId)}`,
							handler,
						);
					};
				});
			}),

		onContextMenuAction: publicProcedure
			.input(z.object({ paneId: z.string() }))
			.subscription(({ ctx, input }) => {
				return observable<{ action: string; url: string }>((emit) => {
					const handler = (data: { action: string; url: string }) => {
						emit.next(data);
					};
					browserManager.on(
						`context-menu-action:${scopedPaneId(ctx, input.paneId)}`,
						handler,
					);
					return () => {
						browserManager.off(
							`context-menu-action:${scopedPaneId(ctx, input.paneId)}`,
							handler,
						);
					};
				});
			}),

		onClosePane: publicProcedure
			.input(z.object({ paneId: z.string() }))
			.subscription(({ ctx, input }) => {
				return observable<void>((emit) => {
					const handler = () => {
						emit.next();
					};
					browserManager.on(
						`close-pane:${scopedPaneId(ctx, input.paneId)}`,
						handler,
					);
					return () => {
						browserManager.off(
							`close-pane:${scopedPaneId(ctx, input.paneId)}`,
							handler,
						);
					};
				});
			}),

		onReloadPane: publicProcedure
			.input(z.object({ paneId: z.string() }))
			.subscription(({ ctx, input }) => {
				return observable<void>((emit) => {
					const handler = () => {
						emit.next();
					};
					browserManager.on(
						`reload-pane:${scopedPaneId(ctx, input.paneId)}`,
						handler,
					);
					return () => {
						browserManager.off(
							`reload-pane:${scopedPaneId(ctx, input.paneId)}`,
							handler,
						);
					};
				});
			}),

		// Renderer-registered canonical chords the main process should suppress in
		// the focused guest and forward for replay (override/layout-aware).
		setForwardableChords: publicProcedure
			.input(z.object({ chords: z.array(z.string()) }))
			.mutation(({ input }) => {
				browserManager.setForwardableChords(input.chords);
				return { success: true };
			}),

		// Keystrokes intercepted from the focused guest webview, replayed by the
		// renderer into its hotkey system (guest focus hides them from the host).
		onKeyForward: publicProcedure
			.input(z.object({ paneId: z.string() }))
			.subscription(({ ctx, input }) => {
				return observable<ForwardedKey>((emit) => {
					const handler = (key: ForwardedKey) => {
						emit.next(key);
					};
					browserManager.on(
						`key-forward:${scopedPaneId(ctx, input.paneId)}`,
						handler,
					);
					return () => {
						browserManager.off(
							`key-forward:${scopedPaneId(ctx, input.paneId)}`,
							handler,
						);
					};
				});
			}),

		openDevTools: publicProcedure
			.input(z.object({ paneId: z.string() }))
			.mutation(({ ctx, input }) => {
				browserManager.openDevTools(scopedPaneId(ctx, input.paneId));
				return { success: true };
			}),

		getPageInfo: publicProcedure
			.input(z.object({ paneId: z.string() }))
			.query(({ ctx, input }) => {
				const wc = browserManager.getWebContents(
					scopedPaneId(ctx, input.paneId),
				);
				if (!wc) return null;
				return {
					url: wc.getURL(),
					title: wc.getTitle(),
					canGoBack: wc.canGoBack(),
					canGoForward: wc.canGoForward(),
					isLoading: wc.isLoading(),
				};
			}),

		clearBrowsingData: publicProcedure
			.input(
				z.object({
					type: z.enum(["cookies", "cache", "storage", "all"]),
				}),
			)
			.mutation(async ({ input }) => {
				const ses = session.fromPartition("persist:superset");
				switch (input.type) {
					case "cookies":
						await ses.clearStorageData({ storages: ["cookies"] });
						break;
					case "cache":
						await ses.clearCache();
						break;
					case "storage":
						await ses.clearStorageData({
							storages: ["localstorage", "indexdb"],
						});
						break;
					case "all":
						await ses.clearStorageData();
						await ses.clearCache();
						break;
				}
				return { success: true };
			}),
	});
};
