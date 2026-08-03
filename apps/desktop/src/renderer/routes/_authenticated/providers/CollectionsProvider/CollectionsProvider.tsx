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

export function preloadActiveOrganizationCollections(
	activeOrganizationId: string | null | undefined,
): void {
	if (!activeOrganizationId) return;
	void preloadCollections(activeOrganizationId).catch((error) => {
		console.error(
			"[collections-provider] Failed to preload active org collections:",
			error,
		);
	});
}

export function CollectionsProvider({ children }: { children: ReactNode }) {
	const { data: session, refetch: refetchSession } = authClient.useSession();
	// The ref stops two switches overlapping without waiting for a render; the
	// state drives the transition veil at the bottom of this file.
	const switchInFlightRef = useRef(false);
	const [isSwitching, setIsSwitching] = useState(false);
	const activeOrganizationId = env.SKIP_ENV_VALIDATION
		? MOCK_ORG_ID
		: session?.session?.activeOrganizationId;

	const switchOrganization = useCallback(
		async (organizationId: string) => {
			if (organizationId === activeOrganizationId) return;
			if (switchInFlightRef.current) return;
			switchInFlightRef.current = true;
			setIsSwitching(true);
			try {
				await authClient.organization.setActive({ organizationId });
				await preloadCollections(organizationId);
				await refetchSession();
			} finally {
				switchInFlightRef.current = false;
				setIsSwitching(false);
			}
		},
		[activeOrganizationId, refetchSession],
	);

	useEffect(() => {
		preloadActiveOrganizationCollections(activeOrganizationId);
		// Once the active org is current (its collections are already cached by the
		// `collections` memo above, which runs during render), evict every prior
		// org's set to free the synced tables they hold. This effect is the single
		// trigger for all switch paths, including callers that set the active org
		// directly without going through `switchOrganization`.
		if (activeOrganizationId) {
			evictInactiveOrgCollections(activeOrganizationId);
		}
	}, [activeOrganizationId]);

	const collections = useMemo(
		() => (activeOrganizationId ? getCollections(activeOrganizationId) : null),
		[activeOrganizationId],
	);

	const contextValue = useMemo<CollectionsContextType | null>(
		() => (collections ? { ...collections, switchOrganization } : null),
		[collections, switchOrganization],
	);

	// Only a window with no collections at all renders nothing. Switching used
	// to return null too, which unmounted the whole authenticated tree — every
	// pane, terminal and the window-drag regions with it — for the length of
	// the switch. #6135 made that short rather than unbounded; this stops it
	// being a blank window at all.
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
