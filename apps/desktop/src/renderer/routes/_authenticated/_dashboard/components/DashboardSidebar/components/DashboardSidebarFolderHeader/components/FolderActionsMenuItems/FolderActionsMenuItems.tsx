import {
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuSub,
	ContextMenuSubContent,
	ContextMenuSubTrigger,
} from "@superset/ui/context-menu";
import {
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
} from "@superset/ui/dropdown-menu";
import { toast } from "@superset/ui/sonner";
import { cn } from "@superset/ui/utils";
import { HiCheck } from "react-icons/hi2";
import {
	LuImage,
	LuPalette,
	LuPencil,
	LuSmile,
	LuTrash2,
	LuX,
} from "react-icons/lu";
import { electronTrpc } from "renderer/lib/electron-trpc";
import {
	PROJECT_COLOR_DEFAULT,
	PROJECT_COLORS,
} from "shared/constants/project-colors";
import type { DashboardSidebarFolder } from "../../../../types";
import {
	FOLDER_ICON_EMOJI,
	shrinkIconDataUrl,
} from "../../../../utils/folderIcon";

export type FolderActionsMenuKind = "context" | "dropdown";

interface FolderActionsMenuItemsProps {
	folder: DashboardSidebarFolder;
	kind: FolderActionsMenuKind;
	onRename: () => void;
	onSetColor: (color: string | null) => void;
	onSetIcon: (icon: string | null) => void;
	onDelete: () => void;
}

/**
 * The folder actions shared by the right-click ContextMenu and the hover "..."
 * DropdownMenu — the folder counterpart of SectionActionsMenuItems one level
 * down.
 */
export function FolderActionsMenuItems({
	folder,
	kind,
	onRename,
	onSetColor,
	onSetIcon,
	onDelete,
}: FolderActionsMenuItemsProps) {
	const Item = kind === "context" ? ContextMenuItem : DropdownMenuItem;
	const Separator =
		kind === "context" ? ContextMenuSeparator : DropdownMenuSeparator;
	const Sub = kind === "context" ? ContextMenuSub : DropdownMenuSub;
	const SubTrigger =
		kind === "context" ? ContextMenuSubTrigger : DropdownMenuSubTrigger;
	const SubContent =
		kind === "context" ? ContextMenuSubContent : DropdownMenuSubContent;
	const iconClassName = kind === "context" ? "size-4 mr-2" : "size-4";

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
			onSetIcon(await shrinkIconDataUrl(result.dataUrl));
		} catch (error) {
			toast.error("Couldn't use that image", {
				description: error instanceof Error ? error.message : String(error),
			});
		}
	};

	return (
		<>
			<Item onSelect={onRename}>
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
								onSelect={() => onSetColor(isDefault ? null : option.value)}
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
								onClick={() => onSetIcon(emoji)}
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
						<Item onSelect={() => onSetIcon(null)}>
							<LuX className={iconClassName} />
							Remove icon
						</Item>
					)}
				</SubContent>
			</Sub>
			<Separator />
			<Item variant="destructive" onSelect={onDelete}>
				<LuTrash2 className={iconClassName} />
				Delete folder
			</Item>
		</>
	);
}
