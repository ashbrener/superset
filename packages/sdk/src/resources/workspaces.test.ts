import { expect, test } from "bun:test";
import { Superset } from "../client";
import { Workspaces } from "./workspaces";

test.each([
	"local",
	"worktree",
	undefined,
] as const)("routes checkout %s to the matching host procedure", async (checkout) => {
	let procedure: string | undefined;
	const client = {
		hostMutation: (_hostId: string, route: { procedure: string }) => {
			procedure = route.procedure;
			return Promise.resolve({});
		},
	} as unknown as Superset;
	const workspaces = new Workspaces(client);
	await workspaces.create({
		hostId: "host",
		projectId: "project",
		name: "test",
		checkout,
	});
	expect(procedure).toBe(
		checkout === "local" ? "workspaces.createLocal" : "workspaces.create",
	);
});

test.each([
	undefined,
	"3563ac2b-8a82-47db-8b40-87be68fbb5d9",
])("keeps one Local id across a transport retry (caller id: %s)", async (id) => {
	const requests: Array<{ id: string; checkout: string }> = [];
	const client = new Superset({
		apiKey: "sk_test_fake",
		organizationId: "org",
		baseURL: "https://api.invalid",
		relayURL: "https://relay.invalid",
		maxRetries: 1,
		fetch: async (url, init) => {
			if (String(url).endsWith("/api/auth/token"))
				return Response.json({ token: "fake" });
			if (!String(url).includes("relay.invalid"))
				return Response.json({ result: { data: { json: {} } } });
			expect(String(url)).toEndWith(
				"/hosts/org:host/trpc/workspaces.createLocal",
			);
			const body = JSON.parse(String(init?.body)).json;
			requests.push(body);
			if (requests.length === 1)
				return Response.json(
					{ error: "Response lost after create" },
					{ status: 502, headers: { "retry-after": "0" } },
				);
			return Response.json({
				result: {
					data: { json: { workspace: { id: body.id }, alreadyExists: true } },
				},
			});
		},
	});
	const params = {
		id,
		hostId: "host",
		projectId: "project",
		name: "local",
		checkout: "local" as const,
	};
	const result = await client.workspaces.create(params);
	expect(requests).toHaveLength(2);
	expect(requests[0]?.id).toMatch(
		/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
	);
	expect(requests[1]?.id).toBe(requests[0]?.id);
	expect(result.workspace.id).toBe(requests[0]?.id);
	if (id) expect(requests[0]?.id).toBe(id);
	const next = await client.workspaces.create(params);
	if (id) expect(next.workspace.id).toBe(result.workspace.id);
	else expect(next.workspace.id).not.toBe(result.workspace.id);
	expect(params.id).toBe(id);
});
