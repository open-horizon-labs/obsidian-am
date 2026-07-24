import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
	FetchTransport,
	MarvinApiClient,
	MarvinRouter,
} from "@open-horizon/marvin-client";
import { createCachePreferringOperations } from "./incrementalCacheOperations.js";
import { createMarvinMcpServer, type MarvinOperations } from "./tools.js";

export interface MarvinMcpEnvironment {
	[key: string]: string | undefined;
	AMAZING_MARVIN_API_TOKEN?: string;
	AMAZING_MARVIN_PUBLIC_API_URL?: string;
	AMAZING_MARVIN_USE_LOCAL?: string;
	AMAZING_MARVIN_LOCAL_API_URL?: string;
	// Points at the same marvin-incremental-cache-v1.json the Obsidian
	// plugin's incremental sync already maintains, if the user has that
	// enabled. Optional — REST remains the default with no config at all.
	AMAZING_MARVIN_INCREMENTAL_CACHE_PATH?: string;
	AMAZING_MARVIN_INCREMENTAL_CACHE_MAX_AGE_MS?: string;
}

export function createRouterFromEnvironment(
	environment: MarvinMcpEnvironment = process.env,
): MarvinRouter {
	const apiToken = environment.AMAZING_MARVIN_API_TOKEN?.trim();
	if (!apiToken) {
		throw new Error("AMAZING_MARVIN_API_TOKEN is required");
	}

	const transport = new FetchTransport();
	const publicClient = new MarvinApiClient({
		apiToken,
		baseUrl: environment.AMAZING_MARVIN_PUBLIC_API_URL
			?? "https://serv.amazingmarvin.com/api",
		origin: "public",
		transport,
	});
	const localClient = environment.AMAZING_MARVIN_USE_LOCAL === "true"
		? new MarvinApiClient({
			apiToken,
			baseUrl: environment.AMAZING_MARVIN_LOCAL_API_URL
				?? "http://localhost:12082/api",
			origin: "local",
			transport,
		})
		: undefined;

	return new MarvinRouter({
		publicClient,
		...(localClient === undefined ? {} : { localClient }),
	});
}

export function createOperationsFromEnvironment(
	environment: MarvinMcpEnvironment = process.env,
): MarvinOperations {
	const router = createRouterFromEnvironment(environment);
	const cachePath = environment.AMAZING_MARVIN_INCREMENTAL_CACHE_PATH?.trim();
	if (!cachePath) {
		return router;
	}
	const maxAgeMs = Number(environment.AMAZING_MARVIN_INCREMENTAL_CACHE_MAX_AGE_MS);
	return createCachePreferringOperations(router, {
		cachePath,
		readFile: (path) => readFile(path, "utf8"),
		...(Number.isFinite(maxAgeMs) && maxAgeMs > 0 ? { maxAgeMs } : {}),
	});
}

export async function runMcpServer(
	environment: MarvinMcpEnvironment = process.env,
): Promise<void> {
	const server = createMarvinMcpServer(createOperationsFromEnvironment(environment));
	await server.connect(new StdioServerTransport());
	console.error("Amazing Marvin MCP server running on stdio");
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
	runMcpServer().catch((error) => {
		console.error("Amazing Marvin MCP server failed:", error);
		process.exitCode = 1;
	});
}
