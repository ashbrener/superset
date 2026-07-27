import {
	closestCenter,
	DndContext,
	type DragEndEvent,
	DragOverlay,
	KeyboardSensor,
	MeasuringStrategy,
	MouseSensor,
	TouchSensor,
	useDroppable,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import {
	arrayMove,
	SortableContext,
	sortableKeyboardCoordinates,
	useSortable,
	verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { OverflowFadeContainer } from "@superset/ui/overflow-fade-container";
import { Tooltip, TooltipContent, TooltipTrigger } from "@superset/ui/tooltip";
import { cn } from "@superset/ui/utils";
import { useMatchRoute, useNavigate } from "@tanstack/react-router";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { HiOutlineCog6Tooth } from "react-icons/hi2";
import { HiringBanner } from "renderer/components/HiringBanner";
import { UpdatesPill } from "renderer/components/UpdatesPill";
import { useV2UserPreferences } from "renderer/hooks/useV2UserPreferences";
import { useHotkeyDisplay } from "renderer/hotkeys";
import { OrganizationDropdown } from "renderer/routes/_authenticated/_dashboard/components/TopBar/components/OrganizationDropdown";
import { useDashboardSidebarState } from "renderer/routes/_authenticated/hooks/useDashboardSidebarState";
import { useLocalHostService } from "renderer/routes/_authenticated/providers/LocalHostServiceProvider";
import { useInlineWorkspacePortsEnabled } from "renderer/stores/inline-workspace-ports";
import { useSidebarWorkspacesCollapseStore } from "renderer/stores/sidebar-workspaces-collapse";
import { DashboardSidebarFolderProvider } from "./components/DashboardSidebarFolderContext";
import { DashboardSidebarFolderHeader } from "./components/DashboardSidebarFolderHeader";
import { DashboardSidebarHeader } from "./components/DashboardSidebarHeader";
import { DashboardSidebarHoverCardOverlay } from "./components/DashboardSidebarHoverCardOverlay";
import { DashboardSidebarPinnedSection } from "./components/DashboardSidebarPinnedSection";
import { DashboardSidebarPortsList } from "./components/DashboardSidebarPortsList";
import { DashboardSidebarProjectSection } from "./components/DashboardSidebarProjectSection";
import { DashboardSidebarSectionRenameProvider } from "./components/DashboardSidebarSectionRenameContext";
import { DashboardSidebarWorkspacesHeader } from "./components/DashboardSidebarWorkspacesHeader";
import { V2SetupScriptCard } from "./components/V2SetupScriptCard";
import { useDashboardSidebarData } from "./hooks/useDashboardSidebarData";
import { useDashboardSidebarShortcuts } from "./hooks/useDashboardSidebarShortcuts";
import { DashboardSidebarHoverProvider } from "./providers/DashboardSidebarHoverProvider";
import { DashboardSidebarPortsProvider } from "./providers/DashboardSidebarPortsProvider";
import type { DashboardSidebarProject } from "./types";
import { filterDashboardSidebarProjects } from "./utils/filterDashboardSidebarProjects";
import { FOLDER_DROP_ROOT, parseFolderDropId } from "./utils/folderDnd";
import { sortDashboardSidebarProjects } from "./utils/sortDashboardSidebarProjects";

interface DashboardSidebarProps {
	isCollapsed?: boolean;
}

interface SortableProjectWrapperProps {
	project: DashboardSidebarProject;
	isCollapsed: boolean;
	isDraggingProject: boolean;
	isDragDisabled: boolean;
	// Inner (workspace/section) drag is gated separately: a non-manual sort
	// only reorders projects, but an active filter prunes children, and a
	// drop committed from a pruned list would corrupt hidden siblings' order.
	isInnerDragDisabled: boolean;
	workspaceShortcutLabels: Map<string, string>;
	onWorkspaceHover: (workspaceId: string) => void | Promise<void>;
	onToggleCollapse: (projectId: string) => void;
}

const SortableProjectWrapper = memo(function SortableProjectWrapper({
	project,
	isCollapsed,
	isDraggingProject,
	isDragDisabled,
	isInnerDragDisabled,
	workspaceShortcutLabels,
	onWorkspaceHover,
	onToggleCollapse,
}: SortableProjectWrapperProps) {
	const {
		attributes,
		listeners,
		setNodeRef,
		transform,
		transition,
		isDragging,
	} = useSortable({ id: project.id, disabled: isDragDisabled });

	return (
		<div
			ref={setNodeRef}
			style={{
				transform: CSS.Translate.toString(transform),
				transition,
				opacity: isDragging ? 0.5 : undefined,
			}}
		>
			<DashboardSidebarProjectSection
				project={project}
				isSidebarCollapsed={isCollapsed}
				isDraggingProject={isDraggingProject}
				isDragDisabled={isInnerDragDisabled}
				workspaceShortcutLabels={workspaceShortcutLabels}
				onWorkspaceHover={onWorkspaceHover}
				onToggleCollapse={onToggleCollapse}
				dragHandleListeners={listeners}
				dragHandleAttributes={attributes}
			/>
		</div>
	);
});

/**
 * Drop target for the ungrouped list at the sidebar root, so a project can be
 * dragged back out of a folder. While a drag is active it keeps a minimum
 * height, otherwise an empty root would be an untargetable zero-height strip.
 */
function RootDropZone({
	isDragging,
	showDivider,
	children,
}: {
	isDragging: boolean;
	/**
	 * Rule above the ungrouped list. Folder contents are otherwise flush with
	 * the projects that follow them, so there's no way to see where a folder
	 * ends and the ungrouped projects begin.
	 */
	showDivider: boolean;
	children: React.ReactNode;
}) {
	const { setNodeRef, isOver } = useDroppable({ id: FOLDER_DROP_ROOT });
	return (
		<div
			ref={setNodeRef}
			className={cn(
				showDivider && "mt-2 border-t border-border/60 pt-2",
				isDragging && "min-h-8 rounded-md transition-colors",
				isDragging && isOver && "bg-fill-hover ring-1 ring-primary/50",
			)}
		>
			{children}
		</div>
	);
}

export function DashboardSidebar({
	isCollapsed = false,
}: DashboardSidebarProps) {
	const {
		groups,
		folders,
		pinnedWorkspaces,
		refreshWorkspacePullRequest,
		toggleProjectCollapsed,
	} = useDashboardSidebarData();
	const {
		reorderProjects,
		createFolder,
		deleteFolder,
		moveProjectToFolder,
		renameFolder,
		setFolderColor,
		toggleFolderCollapsed,
	} = useDashboardSidebarState();

	// Folder created from a project's context menu enters rename mode on mount.
	const [autoRenameFolderId, setAutoRenameFolderId] = useState<string | null>(
		null,
	);

	const createFolderForProject = useCallback(
		(projectId: string) => {
			const folderId = createFolder();
			moveProjectToFolder(projectId, folderId);
			setAutoRenameFolderId(folderId);
		},
		[createFolder, moveProjectToFolder],
	);

	// "New folder" from the PROJECTS header: create an empty folder and drop
	// straight into rename, so it can be created before any project exists.
	const handleNewFolder = useCallback(() => {
		const folderId = createFolder();
		setAutoRenameFolderId(folderId);
	}, [createFolder]);

	const folderContextValue = useMemo(
		() => ({ folders, moveProjectToFolder, createFolderForProject }),
		[folders, moveProjectToFolder, createFolderForProject],
	);
	const navigate = useNavigate();
	const matchRoute = useMatchRoute();
	const settingsHotkey = useHotkeyDisplay("OPEN_SETTINGS").text;
	const isSettingsOpen = !!matchRoute({ to: "/settings", fuzzy: true });
	const { activeHostUrl } = useLocalHostService();
	const inlineWorkspacePortsEnabled = useInlineWorkspacePortsEnabled();
	const v2RouteMatch = matchRoute({ to: "/v2-workspace/$workspaceId" });
	const activeV2WorkspaceId = v2RouteMatch ? v2RouteMatch.workspaceId : null;
	const workspacesListCollapsed = useSidebarWorkspacesCollapseStore(
		(s) => s.isCollapsed,
	);
	const { preferences, setSidebarProjectSortMode } = useV2UserPreferences();
	const sortMode = preferences.sidebarProjectSortMode;
	const [projectFilterQuery, setProjectFilterQuery] = useState("");
	// The icon-only sidebar hides the header (and its filter input); a filter
	// left active there would invisibly hide projects.
	useEffect(() => {
		if (isCollapsed) setProjectFilterQuery("");
	}, [isCollapsed]);

	const sensors = useSensors(
		useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
		useSensor(TouchSensor, {
			activationConstraint: { delay: 200, tolerance: 5 },
		}),
		useSensor(KeyboardSensor, {
			coordinateGetter: sortableKeyboardCoordinates,
		}),
	);

	const [activeProject, setActiveProject] =
		useState<DashboardSidebarProject | null>(null);

	// Local project order — syncs from groups, updated on drag end
	const [projectOrder, setProjectOrder] = useState(() =>
		groups.map((p) => p.id),
	);
	useEffect(() => {
		setProjectOrder(groups.map((p) => p.id));
	}, [groups]);

	const orderedGroups = useMemo(() => {
		const byId = new Map(groups.map((g) => [g.id, g]));
		return projectOrder
			.map((id) => byId.get(id))
			.filter((g): g is DashboardSidebarProject => g != null);
	}, [groups, projectOrder]);

	const sortedGroups = useMemo(
		() =>
			sortMode === "manual"
				? orderedGroups
				: sortDashboardSidebarProjects(groups, sortMode),
		[sortMode, orderedGroups, groups],
	);

	const displayedGroups = useMemo(
		() => filterDashboardSidebarProjects(sortedGroups, projectFilterQuery),
		[sortedGroups, projectFilterQuery],
	);

	// Split the displayed projects into folders and the ungrouped root list.
	// A project pointing at a deleted folder falls back to the root so it can
	// never become unreachable.
	const folderIds = useMemo(
		() => new Set(folders.map((folder) => folder.id)),
		[folders],
	);

	const foldersWithProjects = useMemo(() => {
		const byFolder = new Map<string, DashboardSidebarProject[]>();
		for (const project of displayedGroups) {
			if (!project.folderId || !folderIds.has(project.folderId)) continue;
			const list = byFolder.get(project.folderId);
			if (list) list.push(project);
			else byFolder.set(project.folderId, [project]);
		}
		return folders.map((folder) => ({
			folder,
			projects: byFolder.get(folder.id) ?? [],
		}));
	}, [displayedGroups, folders, folderIds]);

	const ungroupedProjects = useMemo(
		() =>
			displayedGroups.filter(
				(project) => !project.folderId || !folderIds.has(project.folderId),
			),
		[displayedGroups, folderIds],
	);

	// dnd-kit requires the SortableContext item order to match the rendered
	// order, so build it exactly as the list below renders: each folder's
	// projects (skipped while that folder is collapsed and therefore not
	// mounted), then the ungrouped ones.
	const sortableProjectIds = useMemo(
		() => [
			...foldersWithProjects.flatMap(({ folder, projects }) =>
				isCollapsed || !folder.isCollapsed
					? projects.map((project) => project.id)
					: [],
			),
			...ungroupedProjects.map((project) => project.id),
		],
		[foldersWithProjects, ungroupedProjects, isCollapsed],
	);

	const isFilterActive = projectFilterQuery.trim() !== "";
	const isDragDisabled = sortMode !== "manual" || isFilterActive;

	// Sorted but unfiltered, so shortcut labels stay stable while typing a
	// filter query.
	const workspaceShortcutLabels = useDashboardSidebarShortcuts(sortedGroups);

	const activeV2Project = useMemo(() => {
		if (!activeV2WorkspaceId) return null;
		// A pinned active workspace renders outside its project group, so
		// resolve its project by id instead.
		const pinned = pinnedWorkspaces.find(
			(workspace) => workspace.id === activeV2WorkspaceId,
		);
		if (pinned) {
			return groups.find((project) => project.id === pinned.projectId) ?? null;
		}
		for (const project of groups) {
			for (const child of project.children) {
				if (
					child.type === "workspace" &&
					child.workspace.id === activeV2WorkspaceId
				) {
					return project;
				}
				if (child.type === "section") {
					for (const ws of child.section.workspaces) {
						if (ws.id === activeV2WorkspaceId) return project;
					}
				}
			}
		}
		return null;
	}, [groups, pinnedWorkspaces, activeV2WorkspaceId]);

	const handleDragEnd = useCallback(
		({ active, over }: DragEndEvent) => {
			if (isDragDisabled) {
				setActiveProject(null);
				return;
			}
			if (over && active.id !== over.id) {
				const activeId = String(active.id);
				const overId = String(over.id);

				// Dropped on a folder header (or the root zone): re-parent only —
				// position within the destination is left to a follow-up drag.
				const dropFolderId = parseFolderDropId(overId);
				if (dropFolderId !== undefined) {
					const current = groups.find((project) => project.id === activeId);
					if (current && current.folderId !== dropFolderId) {
						moveProjectToFolder(activeId, dropFolderId);
					}
					setActiveProject(null);
					return;
				}

				// Dropped on another project: adopt that project's folder (so
				// dragging into a folder's list joins it) and reorder.
				const target = groups.find((project) => project.id === overId);
				const dragged = groups.find((project) => project.id === activeId);
				if (target && dragged && dragged.folderId !== target.folderId) {
					moveProjectToFolder(activeId, target.folderId);
				}

				const oldIndex = projectOrder.indexOf(activeId);
				const newIndex = projectOrder.indexOf(overId);
				if (oldIndex !== -1 && newIndex !== -1) {
					const reordered = arrayMove(projectOrder, oldIndex, newIndex);
					setProjectOrder(reordered);
					reorderProjects(reordered);
				}
			}
			setActiveProject(null);
		},
		[
			isDragDisabled,
			projectOrder,
			reorderProjects,
			groups,
			moveProjectToFolder,
		],
	);

	return (
		<DashboardSidebarFolderProvider value={folderContextValue}>
			<DashboardSidebarSectionRenameProvider>
				<DashboardSidebarHoverProvider>
					<DashboardSidebarPortsProvider enabled={!isCollapsed}>
						<DashboardSidebarHoverCardOverlay>
							<div className="flex h-full flex-col border-r border-border bg-muted/45 dark:bg-muted/35">
								<DashboardSidebarHeader isCollapsed={isCollapsed} />

								{!isCollapsed && (
									<DashboardSidebarWorkspacesHeader
										sortMode={sortMode}
										onSortModeChange={setSidebarProjectSortMode}
										filterQuery={projectFilterQuery}
										onFilterQueryChange={setProjectFilterQuery}
										onNewFolder={handleNewFolder}
									/>
								)}

								<OverflowFadeContainer
									fadeEdges={["top", "bottom"]}
									className="flex-1 overflow-y-auto hide-scrollbar"
								>
									{(isCollapsed || !workspacesListCollapsed) && (
										<DashboardSidebarPinnedSection
											pinnedWorkspaces={pinnedWorkspaces}
											isCollapsed={isCollapsed}
											onWorkspaceHover={refreshWorkspacePullRequest}
										/>
									)}
									{(isCollapsed || !workspacesListCollapsed) && (
										<DndContext
											sensors={sensors}
											collisionDetection={closestCenter}
											measuring={{
												droppable: { strategy: MeasuringStrategy.Always },
											}}
											onDragStart={({ active }) => {
												if (isDragDisabled) return;
												const project = groups.find((p) => p.id === active.id);
												setActiveProject(project ?? null);
											}}
											onDragEnd={handleDragEnd}
											onDragCancel={() => setActiveProject(null)}
										>
											<SortableContext
												items={sortableProjectIds}
												strategy={verticalListSortingStrategy}
											>
												{foldersWithProjects.map(({ folder, projects }) => (
													<div key={folder.id} className="mt-1 first:mt-0">
														{!isCollapsed && (
															<DashboardSidebarFolderHeader
																folder={folder}
																projectCount={projects.length}
																autoRename={autoRenameFolderId === folder.id}
																onAutoRenameEnd={() =>
																	setAutoRenameFolderId(null)
																}
																onToggleCollapse={toggleFolderCollapsed}
																onRename={renameFolder}
																onSetColor={setFolderColor}
																onDelete={deleteFolder}
															/>
														)}
														{(isCollapsed || !folder.isCollapsed) &&
															projects.map((project) => (
																<SortableProjectWrapper
																	key={project.id}
																	project={project}
																	isCollapsed={isCollapsed}
																	isDraggingProject={activeProject != null}
																	isDragDisabled={isDragDisabled}
																	isInnerDragDisabled={isFilterActive}
																	workspaceShortcutLabels={
																		workspaceShortcutLabels
																	}
																	onWorkspaceHover={refreshWorkspacePullRequest}
																	onToggleCollapse={toggleProjectCollapsed}
																/>
															))}
													</div>
												))}
												<RootDropZone
													isDragging={activeProject != null}
													showDivider={
														!isCollapsed &&
														folders.length > 0 &&
														ungroupedProjects.length > 0
													}
												>
													{ungroupedProjects.map((project) => (
														<SortableProjectWrapper
															key={project.id}
															project={project}
															isCollapsed={isCollapsed}
															isDraggingProject={activeProject != null}
															isDragDisabled={isDragDisabled}
															isInnerDragDisabled={isFilterActive}
															workspaceShortcutLabels={workspaceShortcutLabels}
															onWorkspaceHover={refreshWorkspacePullRequest}
															onToggleCollapse={toggleProjectCollapsed}
														/>
													))}
												</RootDropZone>
											</SortableContext>

											{isFilterActive && displayedGroups.length === 0 && (
												<div className="select-text cursor-text px-4 py-2 text-xs text-muted-foreground">
													No projects match "{projectFilterQuery.trim()}"
												</div>
											)}

											{createPortal(
												<DragOverlay dropAnimation={null}>
													{activeProject && (
														<div className="bg-background shadow-lg border-b border-border">
															<DashboardSidebarProjectSection
																project={activeProject}
																isSidebarCollapsed={isCollapsed}
																isDraggingProject
																workspaceShortcutLabels={
																	workspaceShortcutLabels
																}
																onWorkspaceHover={() => {}}
																onToggleCollapse={() => {}}
															/>
														</div>
													)}
												</DragOverlay>,
												document.body,
											)}
										</DndContext>
									)}
								</OverflowFadeContainer>
								{!isCollapsed && !inlineWorkspacePortsEnabled && (
									<DashboardSidebarPortsList />
								)}
								{!isCollapsed && activeV2Project && activeHostUrl && (
									<V2SetupScriptCard
										hostUrl={activeHostUrl}
										projectId={activeV2Project.id}
										projectName={activeV2Project.name}
									/>
								)}
								<HiringBanner surface="v2" isCollapsed={isCollapsed} />
								<div
									className={cn(
										isCollapsed
											? "flex flex-col items-center gap-2 py-2"
											: "flex items-center gap-1 p-2",
									)}
								>
									{isCollapsed ? (
										<OrganizationDropdown variant="collapsed" />
									) : (
										<div className="min-w-0 flex-1">
											<OrganizationDropdown variant="expanded" />
										</div>
									)}

									<UpdatesPill isCollapsed={isCollapsed} />
									<Tooltip delayDuration={300}>
										<TooltipTrigger asChild>
											<button
												type="button"
												aria-label="Settings"
												onClick={() => navigate({ to: "/settings/account" })}
												className={cn(
													"flex size-8 shrink-0 items-center justify-center rounded-md transition-colors",
													isSettingsOpen
														? "bg-fill-selected text-muted-foreground"
														: "text-muted-foreground hover:bg-fill-hover",
												)}
											>
												<HiOutlineCog6Tooth className="size-3.5" />
											</button>
										</TooltipTrigger>
										<TooltipContent side={isCollapsed ? "right" : "top"}>
											{settingsHotkey !== "Unassigned"
												? `Settings (${settingsHotkey})`
												: "Settings"}
										</TooltipContent>
									</Tooltip>
								</div>
							</div>
						</DashboardSidebarHoverCardOverlay>
					</DashboardSidebarPortsProvider>
				</DashboardSidebarHoverProvider>
			</DashboardSidebarSectionRenameProvider>
		</DashboardSidebarFolderProvider>
	);
}
