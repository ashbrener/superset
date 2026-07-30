import { useCallback, useState } from "react";
import { apiTrpcClient } from "renderer/lib/api-trpc-client";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { setHostServiceSecret } from "renderer/lib/host-service-auth";
import { getHostServiceClientByUrl } from "renderer/lib/host-service-client";
import { useNavigateAwayFromWorkspace } from "renderer/routes/_authenticated/_dashboard/components/DashboardSidebar/hooks/useNavigateAwayFromWorkspace";
import { useDashboardSidebarState } from "renderer/routes/_authenticated/hooks/useDashboardSidebarState";
import { useCollections } from "renderer/routes/_authenticated/providers/CollectionsProvider";
import {
	getCollections,
	preloadCollections,
} from "renderer/routes/_authenticated/providers/CollectionsProvider/collections";
import { useLocalHostService } from "renderer/routes/_authenticated/providers/LocalHostServiceProvider";
import {
	applyProjectSidebarState,
	collectProjectSidebarState,
} from "./moveProjectSidebarState";

const TARGET_HOST_READY_TIMEOUT_MS = 30_000;
const TARGET_HOST_POLL_INTERVAL_MS = 500;

export interface MoveProjectToOrganizationArgs {
	projectId: string;
	targetOrganizationId: string;
}

export interface MoveProjectToOrganizationResult {
	/** Worktrees the target host refused to adopt, by workspace name. */
	skippedWorkspaces: string[];
}

/**
 * Moves a project — its worktrees, its cloud rows and its sidebar placement —
 * from the active organization to another one the user belongs to.
 *
 * Which org a project belongs to locally is decided by which host database
 * holds its row (`~/.superset/host/<orgId>/host.db` — there is no org column),
 * so a move is a re-registration on the target org's host rather than an
 * update. The project id is preserved throughout: worktrees live under
 * `~/.superset/worktrees/<projectId>/`, so keeping the id means nothing on
 * disk has to move.
 *
 * Order is load-bearing:
 *  1. start the target host FIRST — it registers the machine in the target org
 *     (`host.ensure`), which the cloud move needs before it can re-key
 *     workspaces across the `(organization_id, host_id)` foreign key;
 *  2. move the cloud rows;
 *  3. adopt the project and its worktrees onto the target host;
 *  4. copy the sidebar placement and hide the project in the source org;
 *  5. detach from the source host LAST, and only via `project.detach`, which
 *     drops rows without running `git worktree remove` — the ordinary remove
 *     would delete the worktrees just adopted.
 *
 * Live terminals and agent sessions do not survive: they belong to the source
 * org's pty daemon and there is no way to re-parent them across orgs.
 */
export function useMoveProjectToOrganization() {
	const collections = useCollections();
	const { activeHostUrl, activeOrganizationId, waitForHostReady } =
		useLocalHostService();
	const { removeProjectFromSidebar } = useDashboardSidebarState();
	const { navigateAwayFromWorkspace } = useNavigateAwayFromWorkspace();
	const utils = electronTrpc.useUtils();
	const { mutateAsync: startHostService } =
		electronTrpc.hostServiceCoordinator.start.useMutation();
	const [isMoving, setIsMoving] = useState(false);

	/** Brings up the target org's host and returns its loopback URL. */
	const waitForTargetHost = useCallback(
		async (organizationId: string): Promise<string> => {
			await startHostService({ organizationId });
			const deadline = Date.now() + TARGET_HOST_READY_TIMEOUT_MS;
			while (Date.now() < deadline) {
				const connection =
					await utils.hostServiceCoordinator.getConnection.fetch({
						organizationId,
					});
				if (connection?.port) {
					const hostUrl = `http://127.0.0.1:${connection.port}`;
					if (connection.secret)
						setHostServiceSecret(hostUrl, connection.secret);
					return hostUrl;
				}
				await new Promise((resolve) =>
					setTimeout(resolve, TARGET_HOST_POLL_INTERVAL_MS),
				);
			}
			throw new Error(
				"The destination organization's host service did not start. Try again in a moment.",
			);
		},
		[startHostService, utils],
	);

	const moveProjectToOrganization = useCallback(
		async ({
			projectId,
			targetOrganizationId,
		}: MoveProjectToOrganizationArgs): Promise<MoveProjectToOrganizationResult> => {
			if (targetOrganizationId === activeOrganizationId) {
				throw new Error("That project is already in this organization.");
			}

			setIsMoving(true);
			try {
				const sourceHostUrl = activeHostUrl ?? (await waitForHostReady());
				if (!sourceHostUrl) {
					throw new Error("The local host service isn't running.");
				}
				const sourceClient = getHostServiceClientByUrl(sourceHostUrl);

				const project = await sourceClient.project.get.query({ projectId });
				if (!project) {
					throw new Error("That project isn't set up on this device.");
				}
				const allWorkspaces = await sourceClient.workspace.list.query();
				const projectWorkspaces = allWorkspaces.filter(
					(workspace) => workspace.projectId === projectId,
				);

				const targetHostUrl = await waitForTargetHost(targetOrganizationId);
				const targetClient = getHostServiceClientByUrl(targetHostUrl);

				const cloudMove =
					await apiTrpcClient.v2Project.moveToOrganization.mutate({
						id: projectId,
						targetOrganizationId,
					});

				// From here the cloud row (if there is one) already sits in the
				// destination org while the local rows are still on the source
				// host. Anything that throws before the local side is registered
				// leaves the project split between the two, so undo the cloud
				// move rather than leaving it that way.
				let targetSetupSucceeded = false;
				const undoCloudMove = async (cause: unknown): Promise<never> => {
					// `project.setup` may already have run, leaving the destination
					// host holding a registration for a project that is about to
					// belong to the source org again. Drop it — detach touches rows
					// only, so the worktrees are untouched either way.
					if (targetSetupSucceeded) {
						try {
							await targetClient.project.detach.mutate({ projectId });
						} catch (detachError) {
							console.error(
								"[move-project] failed to unwind destination setup",
								detachError,
							);
						}
					}
					if (cloudMove.cloudRowMissing || !activeOrganizationId) throw cause;
					try {
						await apiTrpcClient.v2Project.moveToOrganization.mutate({
							id: projectId,
							targetOrganizationId: activeOrganizationId,
						});
					} catch (undoError) {
						console.error("[move-project] rollback failed", undoError);
						throw new Error(
							`The move failed part way and couldn't be undone. The project now belongs to the destination organization in the cloud but is still set up on this device under the old one. Switch to the destination organization and move it back. Original error: ${
								cause instanceof Error ? cause.message : String(cause)
							}`,
						);
					}
					throw cause;
				};

				// `origin` skips the cloud lookup: the row has already moved, and
				// the host would otherwise resolve it against its own org.
				// `mainWorkspaceId` keeps the repo's own checkout on the id it
				// already had — without it setup mints a new one and every piece
				// of local state keyed to the old id (pane layout, pins) is
				// stranded, along with its cloud row.
				const mainWorkspaceId = projectWorkspaces.find(
					(workspace) => workspace.type === "main",
				)?.id;
				try {
					await targetClient.project.setup.mutate({
						projectId,
						...(mainWorkspaceId ? { mainWorkspaceId } : {}),
						origin: { repoCloneUrl: project.repoUrl, name: project.name },
						mode: { kind: "import", repoPath: project.repoPath },
					});
					targetSetupSucceeded = true;

					// Per-project settings `project.setup` doesn't carry over.
					if (project.worktreeBaseDir) {
						await targetClient.project.setWorktreeBaseDir.mutate({
							projectId,
							path: project.worktreeBaseDir,
						});
					}
					if (project.branchPrefixMode) {
						await targetClient.project.setBranchPrefix.mutate({
							projectId,
							mode: project.branchPrefixMode,
							customPrefix: project.branchPrefixCustom ?? undefined,
						});
					}
				} catch (error) {
					await undoCloudMove(error);
				}

				// Adopt each worktree in place, keeping its id and path. One that
				// can't be adopted (branch gone, path moved) must not strand the
				// rest of the move — it's reported instead.
				const skippedWorkspaces: string[] = [];
				for (const workspace of projectWorkspaces) {
					if (workspace.type !== "worktree") continue;
					try {
						await targetClient.workspaceCreation.adopt.mutate({
							projectId,
							existingWorkspaceId: workspace.id,
							workspaceName: workspace.name,
							branch: workspace.branch,
							worktreePath: workspace.worktreePath,
						});
					} catch (error) {
						console.error(
							"[move-project] failed to adopt worktree",
							workspace.id,
							error,
						);
						skippedWorkspaces.push(workspace.name);
					}
				}

				// Past this point the project is live in the destination — cloud
				// rows moved, host registered, worktrees adopted. What is left is
				// tidying the source, so a failure here is not worth unwinding a
				// good move; it leaves the project listed in both orgs, and the
				// error has to say that rather than read like the move failed.
				try {
					// The target org's local rows must exist before anything is
					// written into them — these are plain localStorage collections
					// with no rollback, so a torn write would persist.
					const targetCollections = getCollections(targetOrganizationId);
					await preloadCollections(targetOrganizationId);
					applyProjectSidebarState(
						targetCollections,
						projectId,
						collectProjectSidebarState(collections, projectId),
					);

					// Leave the workspace route before its local state disappears,
					// otherwise the open panes are wiped in place.
					for (const workspace of projectWorkspaces) {
						navigateAwayFromWorkspace(workspace.id);
					}

					removeProjectFromSidebar(projectId);
					await sourceClient.project.detach.mutate({ projectId });
				} catch (error) {
					console.error("[move-project] cleanup after the move failed", error);
					throw new Error(
						`${project.name} moved successfully, but clearing it out of the old organization didn't finish, so it may still be listed there. Remove it from the old organization's sidebar. Details: ${
							error instanceof Error ? error.message : String(error)
						}`,
					);
				}

				return { skippedWorkspaces };
			} finally {
				setIsMoving(false);
			}
		},
		[
			activeHostUrl,
			activeOrganizationId,
			collections,
			navigateAwayFromWorkspace,
			removeProjectFromSidebar,
			waitForHostReady,
			waitForTargetHost,
		],
	);

	return { moveProjectToOrganization, isMoving };
}
