import type { RouterHistoryState } from "main/lib/app-state/schemas";
import {
	MAX_ROUTER_HISTORY_ARGV_BYTES,
	ROUTER_HISTORY_ARG,
} from "shared/window-identity";

/**
 * Builds the `--superset-router-history=` argument for a new window, or null
 * when there is nothing to restore.
 *
 * The renderer needs its history at module-evaluation time — the router is
 * built from it before React mounts — and every path through electronTrpc is
 * async, so it arrives on the command line alongside the window key rather
 * than being fetched. Oldest entries are dropped until the payload fits
 * `MAX_ROUTER_HISTORY_ARGV_BYTES`; losing the far end of the back stack is a
 * better failure than a command line the OS refuses.
 */
export function buildRouterHistoryArg(
	history: RouterHistoryState | undefined,
): string | null {
	if (!history || history.entries.length === 0) return null;

	let entries = history.entries;
	let index = Math.min(Math.max(history.index, 0), entries.length - 1);

	while (entries.length > 0) {
		const encoded = JSON.stringify({ entries, index });
		if (Buffer.byteLength(encoded, "utf8") <= MAX_ROUTER_HISTORY_ARGV_BYTES) {
			return `${ROUTER_HISTORY_ARG}${encodeURIComponent(encoded)}`;
		}
		// Drop from the front so the current entry is the last thing lost.
		entries = entries.slice(1);
		index = Math.max(index - 1, 0);
	}

	return null;
}
