import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@superset/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@superset/ui/tooltip";
import { LuFolderInput, LuFolderPlus, LuUngroup, LuX } from "react-icons/lu";
import type {
	DashboardSidebarCollection,
	DashboardSidebarProject,
} from "../../../../types";
import { hasCustomColor } from "../../../../utils/collectionColor";

interface DashboardSidebarProjectBulkToolbarProps {
	selectedProjects: DashboardSidebarProject[];
	collections: DashboardSidebarCollection[];
	onClearSelection: () => void;
	/** Move every selected project into a collection, or to the root when null. */
	onMoveToCollection: (collectionId: string | null) => void;
	onCreateCollection: () => void;
}

/**
 * Replaces the PROJECTS header while projects are bulk-selected — the collection
 * counterpart of the workspace bulk toolbar above it in the tree.
 */
export function DashboardSidebarProjectBulkToolbar({
	selectedProjects,
	collections,
	onClearSelection,
	onMoveToCollection,
	onCreateCollection,
}: DashboardSidebarProjectBulkToolbarProps) {
	const count = selectedProjects.length;
	const noun = count === 1 ? "project" : "projects";
	const anyInCollection = selectedProjects.some(
		(project) => project.collectionId !== null,
	);

	return (
		<div
			role="toolbar"
			aria-label="Selected project actions"
			className="flex min-h-8 w-full shrink-0 items-center gap-0.5 py-1 pl-2 pr-2"
		>
			<Tooltip delayDuration={300}>
				<TooltipTrigger asChild>
					<button
						type="button"
						onClick={onClearSelection}
						className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-fill-hover hover:text-foreground"
						aria-label="Clear project selection"
					>
						<LuX className="size-3.5" />
					</button>
				</TooltipTrigger>
				<TooltipContent side="bottom">Clear selection (Esc)</TooltipContent>
			</Tooltip>

			<span className="min-w-0 flex-1 truncate pl-1 text-xs font-medium text-foreground">
				{count} {noun}
			</span>

			<div className="mx-1 h-4 w-px bg-border" />

			<DropdownMenu>
				<Tooltip delayDuration={300}>
					<TooltipTrigger asChild>
						<DropdownMenuTrigger asChild>
							<button
								type="button"
								className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-fill-hover hover:text-foreground"
								aria-label={`Move ${count} selected ${noun} to a collection`}
							>
								<LuFolderInput className="size-3.5" />
							</button>
						</DropdownMenuTrigger>
					</TooltipTrigger>
					<TooltipContent side="bottom">Move to collection</TooltipContent>
				</Tooltip>
				<DropdownMenuContent align="end" side="bottom" className="w-48">
					<DropdownMenuItem onSelect={onCreateCollection}>
						<LuFolderPlus className="size-4" />
						New collection
					</DropdownMenuItem>
					{collections.length > 0 && <DropdownMenuSeparator />}
					{collections.map((collection) => (
						<DropdownMenuItem
							key={collection.id}
							onSelect={() => onMoveToCollection(collection.id)}
						>
							<span
								className="size-2 shrink-0 rounded-full bg-muted-foreground/40"
								style={
									hasCustomColor(collection.color)
										? { backgroundColor: collection.color ?? undefined }
										: undefined
								}
							/>
							<span className="truncate">{collection.name}</span>
						</DropdownMenuItem>
					))}
				</DropdownMenuContent>
			</DropdownMenu>

			<Tooltip delayDuration={300}>
				<TooltipTrigger asChild>
					<button
						type="button"
						disabled={!anyInCollection}
						onClick={() => onMoveToCollection(null)}
						className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-fill-hover hover:text-foreground disabled:pointer-events-none disabled:opacity-35"
						aria-label="Remove selected projects from their collections"
					>
						<LuUngroup className="size-3.5" />
					</button>
				</TooltipTrigger>
				<TooltipContent side="bottom">Remove from collection</TooltipContent>
			</Tooltip>
		</div>
	);
}
