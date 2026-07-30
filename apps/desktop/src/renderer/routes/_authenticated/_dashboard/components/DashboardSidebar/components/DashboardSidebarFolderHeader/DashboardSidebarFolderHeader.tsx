import { useDroppable } from "@dnd-kit/core";
import { Button } from "@superset/ui/button";
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
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
} from "@superset/ui/dropdown-menu";
import { toast } from "@superset/ui/sonner";
import { cn } from "@superset/ui/utils";
import { useCallback, useEffect, useState } from "react";
import { HiCheck, HiChevronRight } from "react-icons/hi2";
import {
	LuEllipsis,
	LuImage,
	LuPalette,
	LuPencil,
	LuSmile,
	LuTrash2,
	LuX,
} from "react-icons/lu";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { RenameInput } from "renderer/screens/main/components/WorkspaceSidebar/RenameInput";
import {
	PROJECT_COLOR_DEFAULT,
	PROJECT_COLORS,
} from "shared/constants/project-colors";
import type { DashboardSidebarFolder } from "../../types";
import { folderDropId } from "../../utils/folderDnd";
import {
	FOLDER_ICON_EMOJI,
	isImageIcon,
	shrinkIconDataUrl,
} from "../../utils/folderIcon";

type MenuKind = "context" | "dropdown";

interface DashboardSidebarFolderHeaderProps {
	folder: DashboardSidebarFolder;
	projectCount: number;
	/** Auto-enter rename mode (used right after the folder is created). */
	autoRename?: boolean;
	/** Called once an auto-initiated rename is committed or cancelled, so the
	 * caller can clear its pending flag and not re-open rename on remount. */
	onAutoRenameEnd?: () => void;
	onToggleCollapse: (folderId: string) => void;
	onRename: (folderId: string, name: string) => void;
	onSetColor: (folderId: string, color: string | null) => void;
	onSetIcon: (folderId: string, icon: string | null) => void;
	onDelete: (folderId: string) => void;
}

/**
 * Header row for a sidebar folder — the grouping level above projects.
 * Mirrors the section header one level down: chevron collapse, coloured left
 * border, inline rename, and a hover actions menu.
 */
export function DashboardSidebarFolderHeader({
	folder,
	projectCount,
	autoRename = false,
	onAutoRenameEnd,
	onToggleCollapse,
	onRename,
	onSetColor,
	onSetIcon,
	onDelete,
}: DashboardSidebarFolderHeaderProps) {
	const [isRenaming, setIsRenaming] = useState(autoRename);
	const [renameValue, setRenameValue] = useState(folder.name);

	useEffect(() => {
		if (!isRenaming) setRenameValue(folder.name);
	}, [folder.name, isRenaming]);

	const startRename = useCallback(() => {
		setRenameValue(folder.name);
		setIsRenaming(true);
	}, [folder.name]);

	const submitRename = useCallback(() => {
		const trimmed = renameValue.trim();
		if (trimmed) onRename(folder.id, trimmed);
		setIsRenaming(false);
		onAutoRenameEnd?.();
	}, [folder.id, onRename, renameValue, onAutoRenameEnd]);

	const cancelRename = useCallback(() => {
		setRenameValue(folder.name);
		setIsRenaming(false);
		onAutoRenameEnd?.();
	}, [folder.name, onAutoRenameEnd]);

	// Dropping a dragged project on this header moves it into the folder.
	const { setNodeRef: setDropRef, isOver } = useDroppable({
		id: folderDropId(folder.id),
	});

	const hasColor =
		folder.color != null && folder.color !== PROJECT_COLOR_DEFAULT;
	const selectedValue = folder.color ?? PROJECT_COLOR_DEFAULT;
	const colorOptions = [
		{ name: "Default", value: PROJECT_COLOR_DEFAULT },
		...PROJECT_COLORS,
	];

	const selectImageFile = electronTrpc.window.selectImageFile.useMutation();

	// A picked file is re-encoded small before it goes in the store: folder
	// rows share the sidebar's local quota with everything else in it.
	const chooseImageIcon = async () => {
		try {
			const result = await selectImageFile.mutateAsync();
			if (result.canceled || !result.dataUrl) return;
			onSetIcon(folder.id, await shrinkIconDataUrl(result.dataUrl));
		} catch (error) {
			toast.error("Couldn't use that image", {
				description: error instanceof Error ? error.message : String(error),
			});
		}
	};

	// One item list rendered as either a right-click ContextMenu or the hover
	// "..." DropdownMenu, matching how section actions are built.
	const renderMenuItems = (kind: MenuKind) => {
		const Item = kind === "context" ? ContextMenuItem : DropdownMenuItem;
		const Separator =
			kind === "context" ? ContextMenuSeparator : DropdownMenuSeparator;
		const Sub = kind === "context" ? ContextMenuSub : DropdownMenuSub;
		const SubTrigger =
			kind === "context" ? ContextMenuSubTrigger : DropdownMenuSubTrigger;
		const SubContent =
			kind === "context" ? ContextMenuSubContent : DropdownMenuSubContent;
		const iconClassName = kind === "context" ? "size-4 mr-2" : "size-4";

		return (
			<>
				<Item onSelect={startRename}>
					<LuPencil className={iconClassName} />
					Rename folder
				</Item>
				<Sub>
					<SubTrigger>
						<LuPalette className={iconClassName} />
						Set folder color
					</SubTrigger>
					<SubContent className="max-h-80 w-40 overflow-y-auto">
						{colorOptions.map((option) => {
							const isDefault = option.value === PROJECT_COLOR_DEFAULT;
							return (
								<Item
									key={option.value}
									onSelect={() =>
										onSetColor(folder.id, isDefault ? null : option.value)
									}
								>
									<span
										className="mr-2 size-3 shrink-0 rounded-full border border-border"
										style={{
											backgroundColor: isDefault ? "transparent" : option.value,
										}}
									/>
									<span className="flex-1">{option.name}</span>
									{selectedValue === option.value && (
										<HiCheck className="size-4 text-primary" />
									)}
								</Item>
							);
						})}
					</SubContent>
				</Sub>
				<Sub>
					<SubTrigger>
						<LuSmile className={iconClassName} />
						Set folder icon
					</SubTrigger>
					<SubContent className="w-56">
						<div className="grid grid-cols-8 gap-0.5 p-1">
							{FOLDER_ICON_EMOJI.map((emoji) => (
								<button
									key={emoji}
									type="button"
									aria-label={`Use ${emoji} as the folder icon`}
									onClick={() => onSetIcon(folder.id, emoji)}
									className={cn(
										"flex size-6 items-center justify-center rounded text-base hover:bg-fill-hover",
										folder.icon === emoji && "bg-fill-selected",
									)}
								>
									{emoji}
								</button>
							))}
						</div>
						<Separator />
						<Item onSelect={() => void chooseImageIcon()}>
							<LuImage className={iconClassName} />
							Choose image…
						</Item>
						{folder.icon && (
							<Item onSelect={() => onSetIcon(folder.id, null)}>
								<LuX className={iconClassName} />
								Remove icon
							</Item>
						)}
					</SubContent>
				</Sub>
				<Separator />
				<Item variant="destructive" onSelect={() => onDelete(folder.id)}>
					<LuTrash2 className={iconClassName} />
					Delete folder
				</Item>
			</>
		);
	};

	return (
		<ContextMenu>
			<ContextMenuTrigger asChild>
				{/* biome-ignore lint/a11y/noStaticElementInteractions: header is a single toggle target while keeping nested inline controls. */}
				<div
					ref={setDropRef}
					role={isRenaming ? undefined : "button"}
					tabIndex={isRenaming ? undefined : 0}
					onClick={isRenaming ? undefined : () => onToggleCollapse(folder.id)}
					onKeyDown={
						isRenaming
							? undefined
							: (event) => {
									if (event.key === "Enter" || event.key === " ") {
										event.preventDefault();
										onToggleCollapse(folder.id);
									}
								}
					}
					className={cn(
						"group mx-2 flex min-h-7 items-center rounded-md py-1 pl-2 pr-2 text-[13px] font-semibold",
						"text-muted-foreground transition-colors hover:bg-fill-hover",
						// Highlight while a dragged project hovers this folder.
						isOver && "bg-fill-hover ring-1 ring-primary/50",
					)}
					style={{
						borderLeft: hasColor
							? `2px solid ${folder.color}`
							: "2px solid var(--color-border)",
					}}
				>
					<div className="mr-2 grid h-5 w-5 shrink-0 items-center justify-center [&>*]:col-start-1 [&>*]:row-start-1">
						<HiChevronRight
							className={cn(
								"size-3 text-muted-foreground transition-transform duration-150",
								!folder.isCollapsed && "rotate-90",
							)}
						/>
					</div>

					<div className="flex min-w-0 flex-1 items-center gap-1.5">
						{isRenaming ? (
							<RenameInput
								value={renameValue}
								onChange={setRenameValue}
								onSubmit={submitRename}
								onCancel={cancelRename}
								className="-ml-1 h-5 w-full min-w-0 border-none bg-transparent px-1 py-0 text-[13px] font-semibold text-muted-foreground outline-none"
							/>
						) : (
							<>
								{folder.icon &&
									(isImageIcon(folder.icon) ? (
										<img
											src={folder.icon}
											alt=""
											className="size-3.5 shrink-0 rounded-sm object-cover"
										/>
									) : (
										<span className="shrink-0 text-[13px] leading-none">
											{folder.icon}
										</span>
									))}
								<span className="truncate">{folder.name}</span>
								<span className="shrink-0 text-muted-foreground/60">
									{projectCount}
								</span>
							</>
						)}
					</div>

					{!isRenaming && (
						// biome-ignore lint/a11y/noStaticElementInteractions: wrapper only isolates events from the header toggle.
						<div
							className="ml-1 hidden size-5 shrink-0 items-center justify-center group-hover:flex has-[[data-state=open]]:flex"
							onClick={(event) => event.stopPropagation()}
							onKeyDown={(event) => event.stopPropagation()}
						>
							<DropdownMenu>
								<DropdownMenuTrigger asChild>
									<Button
										variant="ghost"
										size="icon"
										className="size-5"
										aria-label="Folder actions"
									>
										<LuEllipsis className="size-3.5" />
									</Button>
								</DropdownMenuTrigger>
								<DropdownMenuContent align="end" className="w-44">
									{renderMenuItems("dropdown")}
								</DropdownMenuContent>
							</DropdownMenu>
						</div>
					)}
				</div>
			</ContextMenuTrigger>
			<ContextMenuContent className="w-44">
				{renderMenuItems("context")}
			</ContextMenuContent>
		</ContextMenu>
	);
}
