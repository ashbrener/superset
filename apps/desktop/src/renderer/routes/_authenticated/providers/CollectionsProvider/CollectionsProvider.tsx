import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { env } from "renderer/env.renderer";
import { authClient } from "renderer/lib/auth-client";
import { MOCK_ORG_ID } from "shared/constants";
import {
	evictInactiveOrgCollections,
	getCollections,
	preloadCollections,
} from "./collections";

type CollectionsContextType = ReturnType<typeof getCollections> & {
	switchOrganization: (organizationId: string) => Promise<void>;
};

const CollectionsContext = createContext<CollectionsContextType | null>(null);

export function CollectionsProvider({ children }: { children: ReactNode }) {
	const { data: session, refetch: refetchSession } = authClient.useSession();
	// Both a ref and state: the ref stops two switches overlapping without
	// waiting for a render, the state drives the transition veil below.
	const switchInFlightRef = useRef(false);
	const [isSwitching, setIsSwitching] = useState(false);
	const activeOrganizationId = env.SKIP_ENV_VALIDATION
		? MOCK_ORG_ID
		: session?.session?.activeOrganizationId;

	// The org actually on screen, which is NOT the same as the session's active
	// org during a switch. better-auth registers `/organization/set-active`
	// against its session signal, so `useSession` refetches on its own and
	// `activeOrganizationId` flips the moment the server commits — long before
	// the destination's collections are preloaded. Rendering straight off that
	// value would swap the whole UI onto empty, not-yet-synced collections.
	// Advancing this only once the destination is warm keeps the old
	// "never show a half-loaded org" guarantee without unmounting the tree.
	const [displayedOrganizationId, setDisplayedOrganizationId] = useState<
		string | null
	>(activeOrganizationId ?? null);

	const switchOrganization = useCallback(
		async (organizationId: string) => {
			if (organizationId === displayedOrganizationId) return;
			if (switchInFlightRef.current) return;
			switchInFlightRef.current = true;
			setIsSwitching(true);
			try {
				await authClient.organization.setActive({ organizationId });
				// `preloadCollections` settles rather than rejects on a collection
				// that fails to sync, and that is deliberate here: blocking the
				// switch on every shape succeeding would strand you on the old org
				// whenever one table is unreachable — the hang this change exists
				// to remove. Collections render cache-first, so a table that
				// hasn't arrived shows its own empty state and fills in later.
				await preloadCollections(organizationId);
				await refetchSession();
				setDisplayedOrganizationId(organizationId);
			} finally {
				switchInFlightRef.current = false;
				setIsSwitching(false);
			}
		},
		[displayedOrganizationId, refetchSession],
	);

	// The session's org can also change without going through
	// `switchOrganization` — accepting an invitation, another client, a
	// restored session. Warm the destination first, then show it, so those
	// paths land on a synced org too instead of an empty one.
	useEffect(() => {
		if (!activeOrganizationId) return;
		if (activeOrganizationId === displayedOrganizationId) return;
		if (switchInFlightRef.current) return;
		let cancelled = false;
		void preloadCollections(activeOrganizationId)
			.catch((error) => {
				console.error(
					"[collections-provider] Failed to preload active org collections:",
					error,
				);
			})
			.finally(() => {
				if (!cancelled) setDisplayedOrganizationId(activeOrganizationId);
			});
		return () => {
			cancelled = true;
		};
	}, [activeOrganizationId, displayedOrganizationId]);

	useEffect(() => {
		// Evict on the DISPLAYED org, never the session's: evicting on the
		// session value would tear down the collections still mounted on screen
		// the instant the server commits a switch.
		if (displayedOrganizationId) {
			evictInactiveOrgCollections(displayedOrganizationId);
		}
	}, [displayedOrganizationId]);

	const collections = useMemo(
		() =>
			displayedOrganizationId ? getCollections(displayedOrganizationId) : null,
		[displayedOrganizationId],
	);

	const contextValue = useMemo<CollectionsContextType | null>(
		() => (collections ? { ...collections, switchOrganization } : null),
		[collections, switchOrganization],
	);

	// Only a window with no collections at all renders nothing. Switching used
	// to return null too, which unmounted the whole authenticated tree for the
	// length of three round trips — a blank window for as long as the
	// destination org took to preload. The context still points at the previous
	// org until the switch resolves, so keeping it mounted shows the org you
	// are leaving rather than a void.
	if (!contextValue) {
		return null;
	}

	return (
		<CollectionsContext.Provider value={contextValue}>
			{children}
			{/* Mid-switch the tree still renders the org being left, while
			    consumers that read the session directly (the org menu, the host
			    service) already name the destination. Rather than let someone act
			    on that mixture, veil it: the chrome stays visible so the app
			    doesn't look dead, but it can't be clicked. Fixed and a sibling —
			    wrapping `children` would disturb the layout it sits in. */}
			{isSwitching && (
				<div
					aria-busy="true"
					className="fixed inset-0 z-50 cursor-progress bg-background/40"
				/>
			)}
		</CollectionsContext.Provider>
	);
}

export function useCollections(): CollectionsContextType {
	const context = useContext(CollectionsContext);
	if (!context) {
		throw new Error("useCollections must be used within CollectionsProvider");
	}
	return context;
}
