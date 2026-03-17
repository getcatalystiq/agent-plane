# @getcatalystiq/agent-plane

TypeScript SDK for the [AgentPlane](https://github.com/getcatalystiq/agent-plane) API. Run Claude Code agents in isolated sandboxes.

## Install

```sh
npm install @getcatalystiq/agent-plane
```

## Quick Start

```ts
import { AgentPlane } from "@getcatalystiq/agent-plane";

const client = new AgentPlane({
  baseUrl: "https://your-deployment.vercel.app",
  apiKey: "ap_live_...",
});
// or set AGENT_PLANE_BASE_URL and AGENT_PLANE_API_KEY environment variables

// Stream events from a run
const stream = await client.runs.create({
  agent_id: "agent_abc123",
  prompt: "Create a landing page",
});

for await (const event of stream) {
  if (event.type === "text_delta") {
    process.stdout.write(event.text);
  }
}
```

## Usage

### Create a run and wait for completion

```ts
const run = await client.runs.createAndWait({
  agent_id: "agent_abc123",
  prompt: "Fix the login bug",
});

console.log(run.status); // "completed" | "failed" | "cancelled" | "timed_out"
```

`createAndWait` handles stream detach automatically — if the server disconnects at 4.5 minutes, it polls until the run finishes (10 minute default timeout).

### Stream events

```ts
const stream = await client.runs.create({
  agent_id: "agent_abc123",
  prompt: "Add unit tests",
});

for await (const event of stream) {
  switch (event.type) {
    case "run_started":
      console.log("Run started:", event.run_id);
      break;
    case "text_delta":
      process.stdout.write(event.text);
      break;
    case "assistant":
      // Full message object: event.message.content is an array of content blocks
      console.log("Assistant turn:", event.message);
      break;
    case "tool_use":
      console.log("Tool:", event.name);
      break;
    case "tool_result":
      console.log("Result:", event.content);
      break;
    case "result":
      console.log("Done:", event.subtype);
      break;
    case "stream_detached":
      // Stream disconnected after 4.5 min — poll manually or use createAndWait
      console.log("Stream detached, poll:", event.poll_url);
      break;
  }
}
```

### Cancel a run

```ts
const { cancelled } = await client.runs.cancel("run_abc123");
// cancelled: false if run already finished (409)
```

### Get run transcript

```ts
for await (const event of client.runs.transcript("run_abc123")) {
  console.log(event.type, event);
}
```

### Manage agents

```ts
// List agents
const { data } = await client.agents.list();

// Create an agent
const agent = await client.agents.create({
  name: "my-agent",
  model: "claude-sonnet-4-20250514",
});

// Update
await client.agents.update(agent.id, { max_turns: 10 });

// Delete
await client.agents.delete(agent.id);
```

### Skills

Manage custom skill files injected into an agent's sandbox.

```ts
// List skills
const skills = await client.agents.skills.list(agentId);

// Create a skill
await client.agents.skills.create(agentId, {
  folder: "code-review",
  files: [{ path: "SKILL.md", content: "Review code for best practices..." }],
});

// Update a skill's files
await client.agents.skills.update(agentId, "code-review", {
  files: [{ path: "SKILL.md", content: "Updated instructions..." }],
});

// Delete a skill
await client.agents.skills.delete(agentId, "code-review");
```

### Plugins

Install plugins from a marketplace into an agent.

```ts
// List installed plugins
const plugins = await client.agents.plugins.list(agentId);

// Add a plugin
await client.agents.plugins.add(agentId, {
  marketplace_id: "mp_abc123",
  plugin_name: "linter",
});

// Remove a plugin
await client.agents.plugins.remove(agentId, "mp_abc123", "linter");
```

### Connectors (Composio)

Manage Composio toolkit connections for an agent.

```ts
// List connector statuses
const connectors = await client.agents.connectors.list(agentId);

// Save an API key for a toolkit
await client.agents.connectors.saveApiKey(agentId, {
  toolkit: "github",
  api_key: "ghp_...",
});

// Initiate OAuth flow — returns { redirect_url }
const { redirect_url } = await client.agents.connectors.initiateOauth(agentId, "gmail");

// Discover available toolkits and tools
const toolkits = await client.connectors.availableToolkits();
const tools = await client.connectors.availableTools("github");
```

### Custom Connectors (MCP)

Manage custom MCP server connections for an agent.

```ts
// List available MCP servers
const servers = await client.customConnectors.listServers();

// List connections for an agent
const connections = await client.agents.customConnectors.list(agentId);

// Initiate OAuth flow — returns { redirectUrl }
const { redirectUrl } = await client.agents.customConnectors.initiateOauth(agentId, serverId);

// List tools on a connected server
const tools = await client.agents.customConnectors.listTools(agentId, serverId);

// Update allowed tools
await client.agents.customConnectors.updateAllowedTools(agentId, serverId, ["tool1", "tool2"]);

// Disconnect
await client.agents.customConnectors.delete(agentId, serverId);
```

### Plugin Marketplaces

Browse the global plugin marketplace registry.

```ts
// List marketplaces
const marketplaces = await client.pluginMarketplaces.list();

// List plugins in a marketplace
const plugins = await client.pluginMarketplaces.listPlugins(marketplaceId);
```

### Sessions (Multi-Turn Chat)

Sessions provide persistent multi-turn conversations with agents. Unlike one-shot runs, sessions keep the sandbox alive between messages and use Claude Agent SDK's `resume` for full conversation context.

#### Create a session and send the first message

```ts
// Create session + send first message (returns a stream)
const stream = await client.sessions.create({
  agent_id: "agent_abc123",
  prompt: "Set up a React project with TypeScript",
});

for await (const event of stream) {
  if (event.type === "text_delta") {
    process.stdout.write(event.text);
  }
}
```

#### Create a session without a prompt

```ts
// Create session without a prompt (returns Session object)
const session = await client.sessions.create({ agent_id: "agent_abc123" });
console.log(session.id); // "sess_..."
```

#### Send follow-up messages

```ts
const stream = await client.sessions.sendMessage(session.id, {
  prompt: "Now add unit tests for the App component",
});

for await (const event of stream) {
  if (event.type === "text_delta") {
    process.stdout.write(event.text);
  }
}
```

#### Send a message and wait for completion

```ts
const result = await client.sessions.sendMessageAndWait(session.id, {
  prompt: "What files did you create?",
});

console.log(result.text); // Full response text
console.log(result.events); // All stream events
```

#### List and manage sessions

```ts
// List sessions
const { data } = await client.sessions.list({ agent_id: "agent_abc123" });

// Get session details with message history
const session = await client.sessions.get("sess_abc123");
console.log(session.runs); // Array of runs (one per message)

// Stop a session
await client.sessions.stop("sess_abc123");
```

### Abort a stream

```ts
const controller = new AbortController();
const stream = await client.runs.create(
  { agent_id: "agent_abc123", prompt: "..." },
  { signal: controller.signal },
);

// Cancel from outside
setTimeout(() => controller.abort(), 5000);

for await (const event of stream) {
  // ...
}
```

## Error Handling

All API errors throw `AgentPlaneError` with `code` and `status` fields:

```ts
import { AgentPlaneError } from "@getcatalystiq/agent-plane";

try {
  await client.runs.get("run_nonexistent");
} catch (err) {
  if (err instanceof AgentPlaneError) {
    console.log(err.code);    // "not_found"
    console.log(err.status);  // 404
    console.log(err.message); // "Run not found"
  }
}
```

Error codes: `unauthorized`, `forbidden`, `budget_exceeded`, `not_found`, `validation_error`, `conflict`, `rate_limited`, `concurrency_limit`, `internal_error`.

Stream disconnections throw `StreamDisconnectedError` (extends `AgentPlaneError`) with a `run_id` for recovery:

```ts
import { StreamDisconnectedError } from "@getcatalystiq/agent-plane";

try {
  for await (const event of stream) { /* ... */ }
} catch (err) {
  if (err instanceof StreamDisconnectedError && err.run_id) {
    const run = await client.runs.get(err.run_id);
  }
}
```

## Configuration

```ts
const client = new AgentPlane({
  baseUrl: "https://your-deployment.vercel.app", // or AGENT_PLANE_BASE_URL env var
  apiKey: "ap_live_...",                          // or AGENT_PLANE_API_KEY env var
  fetch: customFetch,                             // custom fetch implementation
});
```

Both `baseUrl` and `apiKey` are required. They can be passed as options or set via `AGENT_PLANE_BASE_URL` and `AGENT_PLANE_API_KEY` environment variables. HTTPS is required for all non-localhost URLs.

## Requirements

- Node.js >= 18
- Works with any runtime that supports `fetch` and `ReadableStream` (Node.js, Deno, Bun, Cloudflare Workers)
