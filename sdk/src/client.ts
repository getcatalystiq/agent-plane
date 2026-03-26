import type { AgentPlaneOptions } from "./types";
import { AgentPlaneError } from "./errors";
import { RunsResource } from "./resources/runs";
import { AgentsResource } from "./resources/agents";
import { SessionsResource } from "./resources/sessions";
import { ConnectorsResource } from "./resources/connectors";
import { CustomConnectorsResource } from "./resources/custom-connectors";
import { PluginMarketplacesResource } from "./resources/plugin-marketplaces";
import { ModelsResource } from "./resources/models";
import { DashboardResource } from "./resources/dashboard";
import { TenantsResource } from "./resources/tenants";
import { ComposioResource } from "./resources/composio";
import { KeysResource } from "./resources/keys";
import { SkillsDirectoryResource } from "./resources/skills-directory";

const VERSION = "0.2.1";
const MAX_ERROR_BODY_BYTES = 64 * 1024; // 64KB

export class AgentPlane {
  readonly runs: RunsResource;
  readonly agents: AgentsResource;
  readonly sessions: SessionsResource;
  readonly connectors: ConnectorsResource;
  readonly customConnectors: CustomConnectorsResource;
  readonly pluginMarketplaces: PluginMarketplacesResource;
  readonly models: ModelsResource;
  readonly dashboard: DashboardResource;
  readonly tenants: TenantsResource;
  readonly composio: ComposioResource;
  readonly keys: KeysResource;
  readonly skillsDirectory: SkillsDirectoryResource;

  private readonly _getAuthHeader: () => string;
  private readonly _baseUrl: string;
  private readonly _fetch: typeof globalThis.fetch;

  constructor(options: AgentPlaneOptions = {}) {
    // Resolve API key
    const apiKey =
      options.apiKey ??
      (typeof process !== "undefined" ? process.env?.["AGENT_PLANE_API_KEY"] : undefined);

    if (!apiKey) {
      throw new AgentPlaneError(
        "configuration_error",
        0,
        "API key is required. Pass apiKey in options or set AGENT_PLANE_API_KEY environment variable.",
      );
    }

    // Resolve base URL
    const rawBaseUrl =
      options.baseUrl ??
      (typeof process !== "undefined" ? process.env?.["AGENT_PLANE_BASE_URL"] : undefined);

    if (!rawBaseUrl) {
      throw new AgentPlaneError(
        "configuration_error",
        0,
        "Base URL is required. Pass baseUrl in options or set AGENT_PLANE_BASE_URL environment variable.",
      );
    }

    // HTTPS enforcement (allow localhost for development)
    const baseUrl = rawBaseUrl.replace(/\/+$/, "");
    if (!baseUrl.startsWith("https://")) {
      try {
        const parsed = new URL(baseUrl);
        if (parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
          throw new AgentPlaneError(
            "configuration_error",
            0,
            "Base URL must use HTTPS to protect API key in transit. Only localhost URLs are permitted over HTTP.",
          );
        }
      } catch (err) {
        if (err instanceof AgentPlaneError) throw err;
        throw new AgentPlaneError("configuration_error", 0, `Invalid base URL: ${baseUrl}`);
      }
    }

    // Store auth in closure to prevent leaking via JSON.stringify/console.log
    const authHeader = `Bearer ${apiKey}`;
    this._getAuthHeader = () => authHeader;
    this._baseUrl = baseUrl;
    this._fetch = options.fetch ?? globalThis.fetch.bind(globalThis);

    // Initialize resource namespaces
    const connectors = new ConnectorsResource(this);
    const customConnectors = new CustomConnectorsResource(this);
    this.connectors = connectors;
    this.customConnectors = customConnectors;
    this.pluginMarketplaces = new PluginMarketplacesResource(this);
    this.runs = new RunsResource(this);
    this.sessions = new SessionsResource(this);
    this.agents = new AgentsResource(this, connectors, customConnectors);
    this.models = new ModelsResource(this);
    this.dashboard = new DashboardResource(this);
    this.tenants = new TenantsResource(this);
    this.composio = new ComposioResource(this);
    this.keys = new KeysResource(this);
    this.skillsDirectory = new SkillsDirectoryResource(this);
  }

  /** @internal Make a JSON API request. */
  async _request<T>(
    method: string,
    path: string,
    options?: {
      body?: unknown;
      query?: Record<string, string | number | undefined>;
      signal?: AbortSignal;
    },
  ): Promise<T> {
    const url = this._buildUrl(path, options?.query);
    const headers: Record<string, string> = {
      Authorization: this._getAuthHeader(),
      "User-Agent": `agent-plane-sdk/${VERSION}`,
    };
    let body: string | undefined;
    if (options?.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(options.body);
    }

    const init: RequestInit = { method, headers };
    if (body !== undefined) init.body = body;
    if (options?.signal) init.signal = options.signal;

    const response = await this._fetch(url, init);

    if (!response.ok) {
      const errorBody = await this._readBoundedBody(response);
      let parsed: unknown;
      try {
        parsed = JSON.parse(errorBody);
      } catch {
        parsed = null;
      }
      throw AgentPlaneError.fromResponse(response.status, parsed);
    }

    return (await response.json()) as T;
  }

  /** @internal Make a streaming request (returns raw Response). */
  async _requestStream(
    method: string,
    path: string,
    options?: {
      body?: unknown;
      signal?: AbortSignal;
    },
  ): Promise<Response> {
    const url = this._buildUrl(path);
    const headers: Record<string, string> = {
      Authorization: this._getAuthHeader(),
      "User-Agent": `agent-plane-sdk/${VERSION}`,
    };
    let body: string | undefined;
    if (options?.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(options.body);
    }

    const init: RequestInit = { method, headers };
    if (body !== undefined) init.body = body;
    if (options?.signal) init.signal = options.signal;

    const response = await this._fetch(url, init);

    if (!response.ok) {
      const errorBody = await this._readBoundedBody(response);
      let parsed: unknown;
      try {
        parsed = JSON.parse(errorBody);
      } catch {
        parsed = null;
      }
      throw AgentPlaneError.fromResponse(response.status, parsed);
    }

    return response;
  }

  private _buildUrl(path: string, query?: Record<string, string | number | undefined>): string {
    // Concatenate baseUrl + path to preserve base path segments.
    // new URL('/api/runs', 'https://host/proxy') would discard '/proxy'.
    const url = new URL(this._baseUrl + path);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) {
          url.searchParams.set(key, String(value));
        }
      }
    }
    return url.toString();
  }

  /** Read response body up to MAX_ERROR_BODY_BYTES to prevent memory exhaustion. */
  private async _readBoundedBody(response: Response): Promise<string> {
    const contentLength = response.headers.get("content-length");
    if (contentLength && parseInt(contentLength, 10) > MAX_ERROR_BODY_BYTES) {
      await response.body?.cancel();
      return "";
    }

    const reader = response.body?.getReader();
    if (!reader) return "";

    const chunks: Uint8Array[] = [];
    let totalSize = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalSize += value.byteLength;
        if (totalSize > MAX_ERROR_BODY_BYTES) {
          await reader.cancel();
          break;
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }

    const merged = new Uint8Array(totalSize > MAX_ERROR_BODY_BYTES ? MAX_ERROR_BODY_BYTES : totalSize);
    let offset = 0;
    for (const chunk of chunks) {
      const bytesToCopy = Math.min(chunk.byteLength, merged.byteLength - offset);
      merged.set(chunk.subarray(0, bytesToCopy), offset);
      offset += bytesToCopy;
    }

    return new TextDecoder().decode(merged);
  }

  // Prevent credentials from leaking in logs/serialization
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return "AgentPlane { <credentials hidden> }";
  }

  toJSON(): Record<string, string> {
    return { type: "AgentPlane", baseUrl: this._baseUrl };
  }
}
