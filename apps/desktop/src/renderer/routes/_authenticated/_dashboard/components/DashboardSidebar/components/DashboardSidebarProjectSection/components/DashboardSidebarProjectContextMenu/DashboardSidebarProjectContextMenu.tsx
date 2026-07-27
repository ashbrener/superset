import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuSub,
	ContextMenuSubContent,
	ContextMenuSubTrigger,
	ContextMenuTrigger,
} from "@superset/ui/context-menu";
import { HiCheck } from "react-icons/hi2";
import {
	LuFolderOpen,
	LuFolderPlus,
	LuFolders,
	LuPencil,
	LuSettings,
	LuX,
} from "react-icons/lu";
import { PROJECT_COLOR_DEFAULT } from "shared/constants/project-colors";
import type { DashboardSidebarFolder } from "../../../../types";

interface DashboardSidebarProjectContextMenuProps {
	onCreateSection: () => void;
	onOpenInFinder: () => void;
	onOpenSettings: () => void;
	onRemoveFromSidebar: () => void;
	onRename: () => void;
	/** Folders available to move this project into. */
	folders: DashboardSidebarFolder[];
	/** Folder the project currently sits in, or null when at the root. */
	currentFolderId: string | null;
	onMoveToFolder: (folderId: string | null) => void;
	onCreateFolderWithProject: () => void;
	children: React.ReactNode;
}

export function DashboardSidebarProjectContextMenu({
	onCreateSection,
	onOpenInFinder,
	onOpenSettings,
	onRemoveFromSidebar,
	onRename,
	folders,
	currentFolderId,
	onMoveToFolder,
	onCreateFolderWithProject,
	children,
}: DashboardSidebarProjectContextMenuProps) {
	return (
		<ContextMenu>
			<ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
			<ContextMenuContent onCloseAutoFocus={(event) => event.preventDefault()}>
				<ContextMenuItem onSelect={onRename}>
					<LuPencil className="size-4 mr-2" />
					Rename
				</ContextMenuItem>
				<ContextMenuSeparator />
				<ContextMenuItem onSelect={onOpenInFinder}>
					<LuFolderOpen className="size-4 mr-2" />
					Open in Finder
				</ContextMenuItem>
				<ContextMenuItem onSelect={onOpenSettings}>
					<LuSettings className="size-4 mr-2" />
					Project Settings
				</ContextMenuItem>
				<ContextMenuItem onSelect={onCreateSection}>
					<LuFolderPlus className="size-4 mr-2" />
					New group
				</ContextMenuItem>
				<ContextMenuSeparator />
				<ContextMenuSub>
					<ContextMenuSubTrigger>
						<LuFolders className="size-4 mr-2" />
						Move to folder
					</ContextMenuSubTrigger>
					<ContextMenuSubContent className="max-h-80 w-48 overflow-y-auto">
						<ContextMenuItem onSelect={onCreateFolderWithProject}>
							<LuFolderPlus className="size-4 mr-2" />
							New folder…
						</ContextMenuItem>
						{folders.length > 0 && <ContextMenuSeparator />}
						{folders.map((folder) => {
							const hasColor =
								folder.color != null && folder.color !== PROJECT_COLOR_DEFAULT;
							return (
								<ContextMenuItem
									key={folder.id}
									onSelect={() => onMoveToFolder(folder.id)}
								>
									<span
										className="mr-2 size-3 shrink-0 rounded-full border border-border"
										style={{
											backgroundColor: hasColor
												? (folder.color ?? undefined)
												: "transparent",
										}}
									/>
									<span className="flex-1 truncate">{folder.name}</span>
									{currentFolderId === folder.id && (
										<HiCheck className="size-4 text-primary" />
									)}
								</ContextMenuItem>
							);
						})}
						{currentFolderId !== null && (
							<>
								<ContextMenuSeparator />
								<ContextMenuItem onSelect={() => onMoveToFolder(null)}>
									<LuX className="size-4 mr-2" />
									Remove from folder
								</ContextMenuItem>
							</>
						)}
					</ContextMenuSubContent>
				</ContextMenuSub>
				<ContextMenuSeparator />
				<ContextMenuItem
					onSelect={onRemoveFromSidebar}
					className="text-destructive focus:text-destructive"
				>
					<LuX className="size-4 mr-2 text-destructive" />
					Remove from Sidebar
				</ContextMenuItem>
			</ContextMenuContent>
		</ContextMenu>
	);
}
