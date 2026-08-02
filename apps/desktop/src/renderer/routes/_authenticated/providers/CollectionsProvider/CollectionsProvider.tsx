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
	// A ref, not state: nothing renders differently while a switch is in
	// flight, it only stops two switches overlapping.
	const switchInFlightRef = useRef(false);
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
			try {
				await authClient.organization.setActive({ organizationId });
				await preloadCollections(organizationId);
				await refetchSession();
				setDisplayedOrganizationId(organizationId);
			} finally {
				switchInFlightRef.current = false;
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
