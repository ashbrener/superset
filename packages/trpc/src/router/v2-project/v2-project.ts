import { dbWs } from "@superset/db/client";
import {
	automationRuns,
	automations,
	chatAttachments,
	chatSessions,
	githubRepositories,
	organizations,
	v2Hosts,
	v2Projects,
	v2Workspaces,
} from "@superset/db/schema";
import { getCurrentTxid } from "@superset/db/utils";
import { parseGitHubRemote } from "@superset/shared/github-remote";
import type { TRPCRouterRecord } from "@trpc/server";
import { TRPCError } from "@trpc/server";
import { del } from "@vercel/blob";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { posthog } from "../../lib/analytics";
import { jwtProcedure, protectedProcedure } from "../../trpc";
import { verifyOrgMembership, verifyOrgOwner } from "../integration/utils";
import { requireActiveOrgId } from "../utils/active-org";
import {
	requireOrgResourceAccess,
	requireOrgScopedResource,
} from "../utils/org-resource-access";

async function getScopedGithubRepository(
	organizationId: string,
	githubRepositoryId: string,
) {
	return requireOrgScopedResource(
		() =>
			dbWs.query.githubRepositories.findFirst({
				columns: {
					id: true,
					organizationId: true,
				},
				where: eq(githubRepositories.id, githubRepositoryId),
			}),
		{
			code: "BAD_REQUEST",
			message: "GitHub repository not found in this organization",
			organizationId,
		},
	);
}

async function getProjectAccess(
	userId: string,
	projectId: string,
	options?: {
		access?: "admin" | "member";
		organizationId?: string;
	},
) {
	return requireOrgResourceAccess(
		userId,
		() =>
			dbWs.query.v2Projects.findFirst({
				columns: {
					id: true,
					organizationId: true,
				},
				where: eq(v2Projects.id, projectId),
			}),
		{
			access: options?.access,
			message: "Project not found",
			organizationId: options?.organizationId,
		},
	);
}

export const v2ProjectRouter = {
	list: jwtProcedure
		.input(
			z.object({
				organizationId: z.string().uuid(),
			}),
		)
		.query(async ({ ctx, input }) => {
			if (!ctx.organizationIds.includes(input.organizationId)) {
				throw new TRPCError({
					code: "FORBIDDEN",
					message: "Not a member of this organization",
				});
			}
			return dbWs
				.select({
					id: v2Projects.id,
					name: v2Projects.name,
					slug: v2Projects.slug,
					repoCloneUrl: v2Projects.repoCloneUrl,
					githubRepositoryId: v2Projects.githubRepositoryId,
				})
				.from(v2Projects)
				.where(eq(v2Projects.organizationId, input.organizationId));
		}),

	get: jwtProcedure
		.input(
			z.object({
				organizationId: z.string().uuid(),
				id: z.string().uuid(),
			}),
		)
		.query(async ({ ctx, input }) => {
			if (!ctx.organizationIds.includes(input.organizationId)) {
				throw new TRPCError({
					code: "FORBIDDEN",
					message: "Not a member of this organization",
				});
			}
			const row = await requireOrgScopedResource(
				() =>
					dbWs.query.v2Projects.findFirst({
						where: eq(v2Projects.id, input.id),
						with: { githubRepository: true },
					}),
				{
					message: "Project not found",
					organizationId: input.organizationId,
				},
			);
			return row;
		}),

	findByGitHubRemote: jwtProcedure
		.input(
			z.object({
				organizationId: z.string().uuid(),
				repoCloneUrl: z.string().min(1),
			}),
		)
		.query(async ({ ctx, input }) => {
			if (!ctx.organizationIds.includes(input.organizationId)) {
				throw new TRPCError({
					code: "FORBIDDEN",
					message: "Not a member of this organization",
				});
			}
			const parsed = parseGitHubRemote(input.repoCloneUrl);
			if (!parsed) return { candidates: [] };
			// GitHub slugs are case-insensitive; parseGitHubRemote returns a
			// canonical https URL. Compare lower-cased on both sides.
			const canonicalUrl = parsed.url.toLowerCase();

			const rows = await dbWs
				.select({
					id: v2Projects.id,
					name: v2Projects.name,
					slug: v2Projects.slug,
					organizationId: v2Projects.organizationId,
					organizationName: organizations.name,
				})
				.from(v2Projects)
				.innerJoin(
					organizations,
					eq(v2Projects.organizationId, organizations.id),
				)
				.where(
					and(
						eq(sql`lower(${v2Projects.repoCloneUrl})`, canonicalUrl),
						eq(v2Projects.organizationId, input.organizationId),
					),
				);

			return { candidates: rows };
		}),

	create: jwtProcedure
		.input(
			z.object({
				organizationId: z.string().uuid(),
				// Optional client-supplied id. Cloud-last create pipelines
				// generate the UUID locally so they can persist
				// downstream rows that reference the project before this
				// commit-point insert runs.
				id: z.string().uuid().optional(),
				name: z.string().min(1),
				slug: z.string().min(1),
				// Optional — empty-mode and local-only imports have no
				// remote yet. When provided we store the canonical https
				// URL and try to link a matching github_repositories row.
				repoCloneUrl: z.string().min(1).optional(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			if (!ctx.organizationIds.includes(input.organizationId)) {
				throw new TRPCError({
					code: "FORBIDDEN",
					message: "Not a member of this organization",
				});
			}

			let canonicalUrl: string | null = null;
			let linkedRepoId: string | null = null;
			if (input.repoCloneUrl) {
				const parsed = parseGitHubRemote(input.repoCloneUrl);
				if (!parsed) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: "Could not parse GitHub remote URL",
					});
				}
				canonicalUrl = parsed.url;
				const fullNameLower = `${parsed.owner}/${parsed.name}`.toLowerCase();
				const repo = await dbWs.query.githubRepositories.findFirst({
					columns: { id: true },
					where: and(
						eq(sql`lower(${githubRepositories.fullName})`, fullNameLower),
						eq(githubRepositories.organizationId, input.organizationId),
					),
				});
				linkedRepoId = repo?.id ?? null;
			}

			let project: typeof v2Projects.$inferSelect | undefined;
			let txid: number | null = null;
			try {
				const result = await dbWs.transaction(async (tx) => {
					const [inserted] = await tx
						.insert(v2Projects)
						.values({
							...(input.id ? { id: input.id } : {}),
							organizationId: input.organizationId,
							name: input.name,
							slug: input.slug,
							repoCloneUrl: canonicalUrl,
							githubRepositoryId: linkedRepoId,
						})
						.returning();

					if (!inserted) {
						return { project: undefined, txid: null };
					}

					const currentTxid = await getCurrentTxid(tx);
					return { project: inserted, txid: currentTxid };
				});
				project = result.project;
				txid = result.txid;
			} catch (err) {
				// Drizzle wraps pg errors in a "Failed query:" envelope; the
				// real constraint name lives on the underlying cause. Walk
				// the chain to find it.
				let cur: unknown = err;
				let constraint: string | null = null;
				while (cur && constraint === null) {
					const c = (cur as { constraint?: unknown }).constraint;
					if (typeof c === "string") constraint = c;
					cur = (cur as { cause?: unknown }).cause;
				}
				if (constraint === "v2_projects_pkey") {
					throw new TRPCError({
						code: "CONFLICT",
						message: "Project id already in use",
						cause: err,
					});
				}
				if (constraint === "v2_projects_org_slug_unique") {
					throw new TRPCError({
						code: "CONFLICT",
						message: "Project slug already exists",
						cause: err,
					});
				}
				throw err;
			}
			if (!project) {
				throw new TRPCError({
					code: "INTERNAL_SERVER_ERROR",
					message: "Failed to create project",
				});
			}

			posthog.capture({
				distinctId: ctx.userId,
				event: "project_opened",
				properties: {
					project_id: project.id,
					organization_id: project.organizationId,
					method: input.repoCloneUrl ? "github" : "empty",
					surface: "v2",
				},
			});

			return { ...project, txid };
		}),

	linkRepoCloneUrl: jwtProcedure
		.input(
			z.object({
				organizationId: z.string().uuid(),
				id: z.string().uuid(),
				repoCloneUrl: z.string().min(1),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			if (!ctx.organizationIds.includes(input.organizationId)) {
				throw new TRPCError({
					code: "FORBIDDEN",
					message: "Not a member of this organization",
				});
			}
			const parsed = parseGitHubRemote(input.repoCloneUrl);
			if (!parsed) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Could not parse GitHub remote URL",
				});
			}
			const canonicalUrl = parsed.url;

			await requireOrgScopedResource(
				() =>
					dbWs.query.v2Projects.findFirst({
						columns: { id: true, organizationId: true },
						where: eq(v2Projects.id, input.id),
					}),
				{
					message: "Project not found",
					organizationId: input.organizationId,
				},
			);

			const fullNameLower = `${parsed.owner}/${parsed.name}`.toLowerCase();
			const repo = await dbWs.query.githubRepositories.findFirst({
				columns: { id: true },
				where: and(
					eq(sql`lower(${githubRepositories.fullName})`, fullNameLower),
					eq(githubRepositories.organizationId, input.organizationId),
				),
			});

			const [updated] = await dbWs
				.update(v2Projects)
				.set({
					repoCloneUrl: canonicalUrl,
					githubRepositoryId: repo?.id ?? null,
				})
				.where(
					and(
						eq(v2Projects.id, input.id),
						eq(v2Projects.organizationId, input.organizationId),
						isNull(v2Projects.repoCloneUrl),
					),
				)
				.returning();
			if (!updated) {
				throw new TRPCError({
					code: "CONFLICT",
					message: "Project already has a linked repository",
				});
			}

			return updated;
		}),

	update: protectedProcedure
		.input(
			z.object({
				id: z.string().uuid(),
				name: z.string().min(1).optional(),
				slug: z.string().min(1).optional(),
				githubRepositoryId: z.string().uuid().nullable().optional(),
				repoCloneUrl: z.string().min(1).nullable().optional(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const organizationId = requireActiveOrgId(ctx, "No active organization");
			const project = await getProjectAccess(ctx.session.user.id, input.id, {
				organizationId,
			});

			if (input.githubRepositoryId) {
				await getScopedGithubRepository(
					project.organizationId,
					input.githubRepositoryId,
				);
			}

			let canonicalRepoCloneUrl: string | null | undefined;
			let resolvedGithubRepositoryId: string | null | undefined =
				input.githubRepositoryId;
			if (input.repoCloneUrl === null) {
				canonicalRepoCloneUrl = null;
				resolvedGithubRepositoryId = null;
			} else if (input.repoCloneUrl !== undefined) {
				const parsed = parseGitHubRemote(input.repoCloneUrl);
				if (!parsed) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: "Could not parse GitHub remote URL",
					});
				}
				canonicalRepoCloneUrl = parsed.url;
				if (input.githubRepositoryId === undefined) {
					const fullNameLower = `${parsed.owner}/${parsed.name}`.toLowerCase();
					const repo = await dbWs.query.githubRepositories.findFirst({
						columns: { id: true },
						where: and(
							eq(sql`lower(${githubRepositories.fullName})`, fullNameLower),
							eq(githubRepositories.organizationId, project.organizationId),
						),
					});
					resolvedGithubRepositoryId = repo?.id ?? null;
				}
			}

			const data = {
				githubRepositoryId: resolvedGithubRepositoryId,
				name: input.name,
				slug: input.slug,
				repoCloneUrl: canonicalRepoCloneUrl,
			};
			if (
				Object.keys(data).every(
					(k) => data[k as keyof typeof data] === undefined,
				)
			) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "No fields to update",
				});
			}
			const result = await dbWs.transaction(async (tx) => {
				const [updated] = await tx
					.update(v2Projects)
					.set(data)
					.where(eq(v2Projects.id, project.id))
					.returning();

				const txid = await getCurrentTxid(tx);

				return { updated, txid };
			});
			const { updated, txid } = result;
			if (!updated) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Project not found",
				});
			}
			return { ...updated, txid };
		}),

	moveToOrganization: protectedProcedure
		.input(
			z.object({
				id: z.string().uuid(),
				targetOrganizationId: z.string().uuid(),
				// Callers pass a slug only to resolve a clash in the target org;
				// otherwise the project keeps the one it already has.
				slug: z.string().min(1).optional(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const sourceOrgId = requireActiveOrgId(ctx, "No active organization");
			if (input.targetOrganizationId === sourceOrgId) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Project is already in this organization",
				});
			}

			await getProjectAccess(ctx.session.user.id, input.id, {
				organizationId: sourceOrgId,
			});
			// The destination is not the active org, so no upstream check covers
			// it — a move is a write into that org and needs its own membership
			// check.
			await verifyOrgMembership(
				ctx.session.user.id,
				input.targetOrganizationId,
			);

			const project = await dbWs.query.v2Projects.findFirst({
				where: eq(v2Projects.id, input.id),
			});
			if (!project) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Project not found",
				});
			}

			const slug = input.slug ?? project.slug;
			const clash = await dbWs.query.v2Projects.findFirst({
				columns: { id: true },
				where: and(
					eq(v2Projects.organizationId, input.targetOrganizationId),
					eq(v2Projects.slug, slug),
				),
			});
			if (clash) {
				throw new TRPCError({
					code: "CONFLICT",
					message: `A project with slug "${slug}" already exists in the target organization. Pass a different slug to move it.`,
				});
			}

			// v2_workspaces carries a composite FK (organization_id, host_id) →
			// v2_hosts(organization_id, machine_id). Without this pre-flight the
			// FK aborts mid-transaction and the whole move rolls back with an
			// opaque driver error.
			const workspaceHosts = await dbWs
				.selectDistinct({ hostId: v2Workspaces.hostId })
				.from(v2Workspaces)
				.where(eq(v2Workspaces.projectId, input.id));
			const hostIds = workspaceHosts.map((row) => row.hostId);
			if (hostIds.length > 0) {
				const targetHosts = await dbWs
					.select({ machineId: v2Hosts.machineId })
					.from(v2Hosts)
					.where(
						and(
							eq(v2Hosts.organizationId, input.targetOrganizationId),
							inArray(v2Hosts.machineId, hostIds),
						),
					);
				const registered = new Set(targetHosts.map((row) => row.machineId));
				const missing = hostIds.filter((hostId) => !registered.has(hostId));
				if (missing.length > 0) {
					throw new TRPCError({
						code: "PRECONDITION_FAILED",
						message: `Host ${missing.join(", ")} is not registered in the target organization. Start the host there first so it registers, then retry the move.`,
					});
				}
			}

			// github_repositories.repo_id is globally unique and every resolver
			// re-filters repositories by org, so a carried-over id would silently
			// resolve to nothing in the target org. Re-resolve the same repo there
			// by full name (what `create` and `linkRepoCloneUrl` match on).
			let targetGithubRepositoryId: string | null = null;
			if (project.githubRepositoryId) {
				const sourceRepo = await dbWs.query.githubRepositories.findFirst({
					columns: { fullName: true },
					where: eq(githubRepositories.id, project.githubRepositoryId),
				});
				if (sourceRepo) {
					const targetRepo = await dbWs.query.githubRepositories.findFirst({
						columns: { id: true },
						where: and(
							eq(
								sql`lower(${githubRepositories.fullName})`,
								sourceRepo.fullName.toLowerCase(),
							),
							eq(githubRepositories.organizationId, input.targetOrganizationId),
						),
					});
					targetGithubRepositoryId = targetRepo?.id ?? null;
				}
			}

			let moved: typeof v2Projects.$inferSelect | undefined;
			let txid: number | null = null;
			try {
				const result = await dbWs.transaction(async (tx) => {
					const movedRows = await tx
						.update(v2Projects)
						.set({
							organizationId: input.targetOrganizationId,
							slug,
							githubRepositoryId: targetGithubRepositoryId,
						})
						.where(
							and(
								eq(v2Projects.id, input.id),
								eq(v2Projects.organizationId, sourceOrgId),
							),
						)
						.returning();
					const movedProject = movedRows[0];
					// Zero rows means a concurrent move or delete beat us to it.
					if (!movedProject || movedRows.length !== 1) {
						throw new TRPCError({
							code: "NOT_FOUND",
							message: "Project not found",
						});
					}

					const workspaceRows = await tx
						.update(v2Workspaces)
						.set({
							organizationId: input.targetOrganizationId,
							// Tasks are org-scoped rather than project-scoped, so they
							// stay behind; keeping the reference would leave the
							// workspace pointing at a task in the source org.
							taskId: null,
						})
						.where(eq(v2Workspaces.projectId, input.id))
						.returning({ id: v2Workspaces.id });

					const workspaceIds = workspaceRows.map((row) => row.id);
					if (workspaceIds.length > 0) {
						const sessionRows = await tx
							.update(chatSessions)
							.set({ organizationId: input.targetOrganizationId })
							.where(inArray(chatSessions.v2WorkspaceId, workspaceIds))
							.returning({ id: chatSessions.id });
						const sessionIds = sessionRows.map((row) => row.id);
						if (sessionIds.length > 0) {
							await tx
								.update(chatAttachments)
								.set({ organizationId: input.targetOrganizationId })
								.where(inArray(chatAttachments.chatSessionId, sessionIds));
						}
					}

					// automations.v2_project_id has no foreign key, so nothing
					// cascades here — the org column has to be rewritten by hand.
					const automationRows = await tx
						.update(automations)
						.set({ organizationId: input.targetOrganizationId })
						.where(eq(automations.v2ProjectId, input.id))
						.returning({ id: automations.id });
					const automationIds = automationRows.map((row) => row.id);
					if (automationIds.length > 0) {
						await tx
							.update(automationRuns)
							.set({ organizationId: input.targetOrganizationId })
							.where(inArray(automationRuns.automationId, automationIds));
					}

					const currentTxid = await getCurrentTxid(tx);
					return { project: movedProject, txid: currentTxid };
				});
				moved = result.project;
				txid = result.txid;
			} catch (err) {
				// The slug pre-check above is racy, so keep the constraint-name
				// catch as the authoritative guard. Drizzle wraps pg errors in a
				// "Failed query:" envelope; walk the cause chain for the name.
				let cur: unknown = err;
				let constraint: string | null = null;
				while (cur && constraint === null) {
					const c = (cur as { constraint?: unknown }).constraint;
					if (typeof c === "string") constraint = c;
					cur = (cur as { cause?: unknown }).cause;
				}
				if (constraint === "v2_projects_org_slug_unique") {
					throw new TRPCError({
						code: "CONFLICT",
						message: `A project with slug "${slug}" already exists in the target organization. Pass a different slug to move it.`,
						cause: err,
					});
				}
				throw err;
			}
			if (!moved) {
				throw new TRPCError({
					code: "INTERNAL_SERVER_ERROR",
					message: "Failed to move project",
				});
			}

			posthog.capture({
				distinctId: ctx.session.user.id,
				event: "project_moved_organization",
				properties: {
					project_id: moved.id,
					organization_id: moved.organizationId,
					source_organization_id: sourceOrgId,
					surface: "v2",
				},
			});

			return { ...moved, txid };
		}),

	delete: jwtProcedure
		.input(
			z.object({
				organizationId: z.string().uuid(),
				id: z.string().uuid(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			await verifyOrgOwner(ctx.userId, input.organizationId);
			const project = await dbWs.query.v2Projects.findFirst({
				columns: { id: true, organizationId: true, iconUrl: true },
				where: eq(v2Projects.id, input.id),
			});
			// Idempotent on missing: if it's already gone (or scoped to a
			// different org), treat as success. Cloud-first delete pipelines
			// rely on this so retries don't error after a partial success.
			if (!project || project.organizationId !== input.organizationId) {
				return { success: true };
			}
			await dbWs.delete(v2Projects).where(eq(v2Projects.id, project.id));
			if (project.iconUrl) {
				try {
					await del(project.iconUrl);
				} catch (error) {
					console.warn("Failed to delete project icon from blob storage", {
						projectId: project.id,
						iconUrl: project.iconUrl,
						error,
					});
				}
			}
			return { success: true };
		}),
} satisfies TRPCRouterRecord;
