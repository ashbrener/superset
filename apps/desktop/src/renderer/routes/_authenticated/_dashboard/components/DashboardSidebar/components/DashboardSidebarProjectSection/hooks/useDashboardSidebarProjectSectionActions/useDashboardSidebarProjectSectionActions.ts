import { alert } from "@superset/ui/atoms/Alert";
import { toast } from "@superset/ui/sonner";
import { useLiveQuery } from "@tanstack/react-db";
import { useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useHostProjects } from "renderer/hooks/host-projects/useHostProjects";
import { useHostUrl } from "renderer/hooks/host-service/useHostTargetUrl";
import { getHostServiceClientByUrl } from "renderer/lib/host-service-client";
import { useDashboardSidebarSectionRename } from "renderer/routes/_authenticated/_dashboard/components/DashboardSidebar/components/DashboardSidebarSectionRenameContext";
import { useDashboardSidebarState } from "renderer/routes/_authenticated/hooks/useDashboardSidebarState";
import { useMoveProjectToOrganization } from "renderer/routes/_authenticated/hooks/useMoveProjectToOrganization";
import { useCollections } from "renderer/routes/_authenticated/providers/CollectionsProvider";
import { useLocalHostService } from "renderer/routes/_authenticated/providers/LocalHostServiceProvider";
import { useOpenNewWorkspaceModal } from "renderer/stores/new-workspace-modal";
import type { DashboardSidebarProject } from "../../../../types";

interface UseDashboardSidebarProjectSectionActionsOptions {
	project: DashboardSidebarProject;
}

export function useDashboardSidebarProjectSectionActions({
	project,
}: UseDashboardSidebarProjectSectionActionsOptions) {
	const openModal = useOpenNewWorkspaceModal();
	const navigate = useNavigate();
	// Renames commit on a host serving the project — host.db owns the name.
	// Prefer the local host when it serves the project (always reachable);
	// hostIds order is arbitrary and may lead with an offline remote.
	const { projects: hostProjects } = useHostProjects();
	const { machineId } = useLocalHostService();
	const servingHostId = useMemo(() => {
		const hostIds =
			hostProjects.find((item) => item.projectKey === project.id)?.hostIds ??
			[];
		if (machineId && hostIds.includes(machineId)) return machineId;
		return hostIds[0] ?? null;
	}, [hostProjects, machineId, project.id]);
	// undefined (not null) when no host serves it — null would resolve to
	// the local host and rename the wrong replica.
	const servingHostUrl = useHostUrl(servingHostId ?? undefined);
	const { requestSectionRename } = useDashboardSidebarSectionRename();
	const {
		createSection,
		deleteSection,
		removeProjectFromSidebar,
		renameSection,
		toggleProjectCollapsed,
		toggleSectionCollapsed,
	} = useDashboardSidebarState();

	// Orgs the user belongs to, minus the one showing this project. The
	// `organizations` collection is unscoped — it is exactly "orgs I'm in".
	const collections = useCollections();
	const { data: organizations } = useLiveQuery(
		(q) => q.from({ organizations: collections.organizations }),
		[collections],
	);
	const { activeOrganizationId } = useLocalHostService();
	const moveTargetOrganizations = useMemo(
		() =>
			(organizations ?? [])
				.filter((organization) => organization.id !== activeOrganizationId)
				.map((organization) => ({
					id: organization.id,
					name: organization.name,
				})),
		[organizations, activeOrganizationId],
	);
	const { moveProjectToOrganization, isMoving: isMovingToOrganization } =
		useMoveProjectToOrganization();

	const [isRenaming, setIsRenaming] = useState(false);
	const [renameValue, setRenameValue] = useState(project.name);

	const startRename = () => {
		setRenameValue(project.name);
		setIsRenaming(true);
	};

	const cancelRename = () => {
		setIsRenaming(false);
		setRenameValue(project.name);
	};

	const submitRename = () => {
		setIsRenaming(false);
		const trimmed = renameValue.trim();
		if (!trimmed || trimmed === project.name) return;
		if (!servingHostUrl) {
			toast.error("Project's host is unreachable — cannot rename right now");
			return;
		}
		void getHostServiceClientByUrl(servingHostUrl)
			.project.update.mutate({ projectId: project.id, name: trimmed })
			.catch((err) => {
				toast.error(
					`Rename failed: ${err instanceof Error ? err.message : String(err)}`,
				);
			});
	};

	const handleOpenInFinder = () => {
		toast.info("Open in Finder is coming soon");
	};

	const handleOpenSettings = () => {
		navigate({
			to: "/settings/projects/$projectId",
			params: { projectId: project.id },
		});
	};

	const confirmRemoveFromSidebar = () => {
		alert({
			title: "Remove project from sidebar?",
			description:
				"This will remove workspaces from the sidebar and delete all project sections. The workspaces or projects won't be deleted.",
			actions: [
				{ label: "Cancel", variant: "outline", onClick: () => {} },
				{
					label: "Remove",
					variant: "destructive",
					onClick: () => removeProjectFromSidebar(project.id),
				},
			],
		});
	};

	const confirmMoveToOrganization = (organizationId: string) => {
		const organization = moveTargetOrganizations.find(
			(candidate) => candidate.id === organizationId,
		);
		if (!organization) return;
		alert({
			title: `Move to ${organization.name}?`,
			description:
				"The repo and its worktrees move across with their branches intact — nothing on disk changes. Running terminals and agent sessions close, and the project leaves this organization.",
			actions: [
				{ label: "Cancel", variant: "outline", onClick: () => {} },
				{
					label: "Move",
					onClick: () => {
						void moveProjectToOrganization({
							projectId: project.id,
							targetOrganizationId: organizationId,
						})
							.then(({ skippedWorkspaces }) => {
								if (skippedWorkspaces.length > 0) {
									toast.warning(
										`Moved to ${organization.name}, but ${skippedWorkspaces.length} worktree(s) couldn't be adopted: ${skippedWorkspaces.join(", ")}`,
									);
									return;
								}
								toast.success(`Moved ${project.name} to ${organization.name}`);
							})
							.catch((error: unknown) => {
								toast.error("Couldn't move the project", {
									description:
										error instanceof Error ? error.message : String(error),
								});
							});
					},
				},
			],
		});
	};

	const handleNewWorkspace = () => {
		openModal(project.id);
	};

	const handleNewSection = () => {
		const sectionId = createSection(project.id);
		requestSectionRename(sectionId);
		if (project.isCollapsed) {
			toggleProjectCollapsed(project.id);
		}
	};

	return {
		cancelRename,
		confirmMoveToOrganization,
		confirmRemoveFromSidebar,
		deleteSection,
		isMovingToOrganization,
		moveTargetOrganizations,
		handleNewSection,
		handleNewWorkspace,
		handleOpenInFinder,
		handleOpenSettings,
		isRenaming,
		renameSection,
		renameValue,
		setRenameValue,
		startRename,
		submitRename,
		toggleSectionCollapsed,
	};
}
