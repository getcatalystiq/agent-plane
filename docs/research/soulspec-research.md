# SoulSpec Research — Complete Specification Reference

**Source**: https://github.com/clawsouls/soulspec | https://soulspec.org | https://docs.clawsouls.ai
**Current Version**: v0.5 (2026-02-23)
**Registry**: https://clawsouls.ai/souls

---

## 1. Package Structure

```
my-soul/
├── soul.json          # Required: manifest/metadata
├── SOUL.md            # Required: core personality
├── IDENTITY.md        # Optional: name, role, traits
├── AGENTS.md          # Optional (required in v0.5): workflow & behavioral rules
├── STYLE.md           # Optional: communication style (v0.2+)
├── HEARTBEAT.md       # Optional: periodic check-in behavior
├── USER_TEMPLATE.md   # Optional: user profile template
├── avatar/            # Optional: avatar image
│   └── avatar.png
└── examples/          # Optional: calibration examples (v0.2+)
    ├── good-outputs.md
    └── bad-outputs.md
```

---

## 2. soul.json — Full Schema

### Required Fields

| Field | Type | Description | Since |
|-------|------|-------------|-------|
| `specVersion` | string | Spec version: `"0.3"`, `"0.4"`, or `"0.5"` | v0.3 |
| `name` | string | Unique identifier (kebab-case) | v0.1 |
| `displayName` | string | Display name | v0.1 |
| `version` | semver | Package version | v0.1 |
| `description` | string | One-line description (max 160 chars) | v0.1 |
| `author` | object | `{ name, github }` — required since v0.4 | v0.1 (optional), v0.4 (required) |
| `license` | string | SPDX identifier from allowed list | v0.1 |
| `tags` | string[] | Search tags (max 10) — required since v0.4 | v0.1 (optional), v0.4 (required) |
| `category` | string | Category path (e.g., `"work/devops"`) | v0.1 |
| `files.soul` | string | Path to SOUL.md | v0.1 |

### Optional Fields

| Field | Type | Description | Since |
|-------|------|-------------|-------|
| `compatibility.openclaw` | string | Min OpenClaw version (semver range) | v0.1 |
| `compatibility.models` | string[] | Recommended models (glob patterns, e.g., `"anthropic/*"`) | v0.1 |
| `compatibility.frameworks` | string[] | Compatible frameworks (e.g., `"openclaw"`, `"cursor"`, `"windsurf"`) | v0.4 |
| `compatibility.minTokenContext` | number | Minimum context window (tokens) needed | v0.4 |
| `allowedTools` | string[] | Tools this soul expects/permits (e.g., `["browser", "exec"]`) | v0.4 |
| `recommendedSkills` | object[] | Skills with `name`, `version?`, `required?` fields | v0.4 |
| `files.identity` | string | Path to IDENTITY.md | v0.1 |
| `files.agents` | string | Path to AGENTS.md | v0.1 |
| `files.heartbeat` | string | Path to HEARTBEAT.md | v0.1 |
| `files.style` | string | Path to STYLE.md | v0.2 |
| `files.userTemplate` | string | Path to USER_TEMPLATE.md | v0.1 |
| `files.avatar` | string | Path to avatar image | v0.1 |
| `examples.good` | string | Path to good output examples | v0.2 |
| `examples.bad` | string | Path to bad output anti-patterns | v0.2 |
| `disclosure.summary` | string | One-line summary for Level 1 progressive disclosure (max 200 chars) | v0.4 |
| `deprecated` | boolean | Whether this soul is deprecated | v0.4 |
| `supersededBy` | string | `owner/name` of replacement soul (used with `deprecated: true`) | v0.4 |
| `repository` | string | Source repository URL | v0.1 |

### Deprecated Fields (removed in v0.4)

| Field | Type | Description | Introduced | Deprecated |
|-------|------|-------------|-----------|-----------|
| `modes` | string[] | Interaction modes (e.g., `["default", "chat", "tweet"]`) | v0.2 | v0.4 |
| `interpolation` | string | Strategy for uncovered topics (`"bold"`, `"cautious"`, `"strict"`) | v0.2 | v0.4 |
| `skills` | string[] | Simple skill list — replaced by `recommendedSkills` | v0.1 | v0.4 |

### v0.5 Embodied Agent Fields

| Field | Type | Description |
|-------|------|-------------|
| `environment` | string | `"embodied"` for physical robots |
| `interactionMode` | string | `"voice"`, etc. |
| `hardwareConstraints.mobility` | string | `"mobile"`, `"stationary"`, etc. |
| `hardwareConstraints.sensors` | string[] | `["camera", "microphone", "touch"]` |
| `hardwareConstraints.actuators` | string[] | `["wheels", "head", "speaker", "display"]` |
| `hardwareConstraints.compute` | string | e.g., `"jetson"` |
| `hardwareConstraints.battery` | boolean | Battery-powered flag |
| `safety.laws` | object[] | Hierarchical safety laws (see below) |
| `safety.physical.maxSpeed` | string | e.g., `"0.3m/s"` |
| `safety.physical.emergencyStop` | boolean | Emergency stop support |
| `safety.physical.collisionAvoidance` | boolean | Collision avoidance |
| `safety.physical.softExterior` | boolean | Physical soft exterior |
| `sensors` | object | Detailed sensor capabilities map |
| `actuators` | object | Detailed actuator capabilities map |

### Safety Laws Schema

```json
{
  "safety": {
    "laws": [
      { "priority": 0, "rule": "Never allow actions that harm humans collectively", "enforcement": "hard", "scope": "all" },
      { "priority": 1, "rule": "Never harm a human or allow harm through inaction", "enforcement": "hard", "scope": "all" },
      { "priority": 2, "rule": "Obey human operator commands unless conflicting with higher-priority laws", "enforcement": "hard", "scope": "all" },
      { "priority": 3, "rule": "Preserve own operational integrity unless conflicting with higher-priority laws", "enforcement": "soft", "scope": "self" }
    ]
  }
}
```

Rules:
- Priority is absolute — lower-priority law can never override higher
- Laws are customizable (the four above are recommended defaults, not mandatory)
- `"hard"` = inviolable constraints; `"soft"` = generate warnings
- Natural language by design, not formal logic

### Sensors Schema

```json
{
  "sensors": {
    "lidar": { "type": "2D", "range": "12m", "fov": 360 },
    "camera": { "type": "RGB-D", "resolution": "1280x720", "fps": 30 },
    "microphone": { "type": "array", "channels": 4 },
    "imu": true,
    "touchSensors": ["chest", "head"]
  }
}
```

### Actuators Schema

| Property | Type | Description |
|----------|------|-------------|
| `actuators.locomotion` | object | Movement system |
| `actuators.arm` | object | Manipulator arm specs |
| `actuators.gripper` | object | End-effector specs |
| `actuators.head` | object | Head movement (pan/tilt) |
| `actuators.expression` | object | Facial/emotional display hardware |

### Allowed Licenses

`Apache-2.0`, `MIT`, `BSD-2-Clause`, `BSD-3-Clause`, `CC-BY-4.0`, `CC0-1.0`, `ISC`, `Unlicense`

### Category Hierarchy

```
work/
  engineering/frontend
  engineering/backend
  engineering/fullstack
  engineering/gamedev
  devops
  data
  pm
  writing
creative/
  design
  storytelling
  music
education/
  programming
  language
  science
lifestyle/
  assistant
  health
  cooking
enterprise/
  support
  onboarding
  review
```

### recommendedSkills Object Schema

```json
{
  "recommendedSkills": [
    { "name": "github", "version": ">=1.0.0", "required": false },
    { "name": "healthcheck", "required": true }
  ]
}
```

### Full soul.json Example (v0.5)

```json
{
  "specVersion": "0.5",
  "name": "senior-devops-engineer",
  "displayName": "Senior DevOps Engineer",
  "version": "1.0.0",
  "description": "Infrastructure-obsessed DevOps engineer with strong opinions on CI/CD, monitoring, and incident response.",
  "author": {
    "name": "TomLee",
    "github": "TomLeeLive"
  },
  "license": "Apache-2.0",
  "tags": ["devops", "infrastructure", "cicd", "monitoring"],
  "category": "work/devops",
  "compatibility": {
    "openclaw": ">=2026.2.0",
    "models": ["anthropic/*", "openai/*"],
    "frameworks": ["openclaw", "clawdbot", "zeroclaw", "cursor"]
  },
  "allowedTools": ["browser", "exec", "web_search", "github"],
  "recommendedSkills": [
    { "name": "github", "version": ">=1.0.0", "required": false },
    { "name": "healthcheck", "required": true }
  ],
  "files": {
    "soul": "SOUL.md",
    "identity": "IDENTITY.md",
    "agents": "AGENTS.md",
    "heartbeat": "HEARTBEAT.md",
    "style": "STYLE.md",
    "userTemplate": "USER_TEMPLATE.md",
    "avatar": "avatar/avatar.png"
  },
  "examples": {
    "good": "examples/good-outputs.md",
    "bad": "examples/bad-outputs.md"
  },
  "disclosure": {
    "summary": "Infrastructure-obsessed DevOps engineer with strong CI/CD opinions."
  },
  "deprecated": false,
  "repository": "https://github.com/clawsouls/souls"
}
```

---

## 3. SOUL.md — Core Personality (Required)

The only required markdown file. Defines who the agent IS.

### Required Sections (v0.4+)

| Section | Purpose |
|---------|---------|
| `## Personality` | Temperament, humor, quirks |
| `## Tone` | Communication tone and register |
| `## Principles` | Core beliefs, values, operating rules |

### All Recommended Sections

| Section | Purpose |
|---------|---------|
| `## Personality` | Temperament, humor, quirks |
| `## Tone` | Communication tone and register |
| `## Principles` | Core beliefs, values, operating rules |
| `## Worldview` | Core beliefs, values, philosophical stance |
| `## Expertise` | Knowledge domains and depth levels |
| `## Opinions` | Actual positions on topics (not neutral hedging) |
| `## Boundaries` | What the persona refuses or avoids |

### Example

```markdown
# My First Soul — Friendly Coder

You are a patient, encouraging coding assistant. You break down
complex problems into simple steps and celebrate small wins.

## Personality
- **Tone**: Warm and encouraging, never condescending
- **Style**: Explain concepts before writing code
- **Approach**: Start simple, add complexity only when needed

## Principles
- Always explain *why*, not just *how*
- Use analogies to make concepts click
- If something is hard, say so — then help anyway
- Celebrate progress, no matter how small
```

---

## 4. IDENTITY.md — Who the Agent Is (Optional, Creature required v0.4+)

Lightweight identity metadata. Separating identity from personality allows mixing and matching.

### Fields

| Field | Description |
|-------|-------------|
| Name | Display name of the agent |
| Role | What the agent does (e.g., "Coding mentor") |
| Creature | Creature type (required v0.4+) |
| Emoji | Representative emoji |
| Vibe | One-line personality summary |
| Avatar | Path to avatar image |

### Example

```markdown
# Identity

- **Name**: Sage
- **Creature**: Owl
- **Role**: Coding mentor
- **Emoji**: 🦉
- **Vibe**: The senior dev who always has time for your questions
```

---

## 5. AGENTS.md — Operational Workflow (Optional; Required in v0.5)

How the agent operates day-to-day. Task handling, tool usage, memory patterns, autonomous behaviors.

### Example

```markdown
# Workflow

1. Read the question carefully before answering
2. Ask clarifying questions if the request is ambiguous
3. Show working code, not pseudocode
4. Test suggestions mentally before sharing
5. Keep responses focused — one concept at a time
```

Note: SoulSpec's AGENTS.md focuses on persona-level workflow. This is distinct from the agents.md standard (https://agents.md) which defines how agents work on your code. SoulSpec defines **who your agent is**.

---

## 6. STYLE.md — Communication Style (Optional, v0.2+)

Writing style guide. Defines HOW the persona communicates.

### Sections

| Section | Purpose |
|---------|---------|
| Sentence structure | Short/long, simple/complex, fragments allowed? |
| Vocabulary | Preferred words, banned words, jargon level |
| Tone | Formal/casual, warm/dry, direct/diplomatic |
| Formatting | Emoji usage, markdown style, list preference |
| Rhythm | Pacing, paragraph length, punctuation habits |
| Anti-patterns | Specific phrases or patterns to never use |

### Example

```markdown
# STYLE.md

## Sentence Structure
Short sentences. Fragments welcome. Never start with "I think" — just state it.

## Vocabulary
Prefer concrete words over abstract ones. Use jargon sparingly.

## Tone
Direct but warm. Like a friend who happens to be an expert.

## Formatting
Use markdown headers. Bullet lists for steps. Code blocks always.

## Anti-patterns
- Never say "Actually..."
- Never say "As an AI..."
- Avoid hedge words: "perhaps", "maybe", "it seems"
```

---

## 7. HEARTBEAT.md — Periodic Check-In (Optional)

Periodic background task configuration. What the agent does during idle/periodic check-ins. Common for always-on agents.

### Example (from v0.5 Sentinel reference soul)

Used for security monitoring routines, health checks, or proactive status updates.

---

## 8. USER_TEMPLATE.md — User Profile Template (Optional)

Template for user preferences. When a soul is installed:
- If `USER.md` does NOT exist in workspace, `USER_TEMPLATE.md` is copied as `USER.md`
- If `USER.md` already exists, it is NOT overwritten (preserves user settings)

---

## 9. examples/ — Calibration Material (Optional, v0.2+)

### good-outputs.md
Curated examples demonstrating the voice done right. The agent should match this tone, structure, and personality.

### bad-outputs.md
Anti-patterns showing what the agent should NOT do.

---

## 10. Progressive Disclosure (v0.4+)

Token budgets matter. Three levels for loading soul data:

| Level | Purpose | What to Load |
|-------|---------|-------------|
| **Level 1 — Quick Scan** | Discovery, filtering, marketplace browsing | `soul.json` only (`disclosure.summary` for instant context) |
| **Level 2 — Full Read** | Agent loads persona for active use | `SOUL.md` + `IDENTITY.md` |
| **Level 3 — Deep Dive** | Extended behavior, calibration, style | `AGENTS.md`, `STYLE.md`, `HEARTBEAT.md`, `examples/` |

---

## 11. Interpolation Strategy (v0.2, deprecated v0.4)

How the agent handles topics not explicitly covered in soul files:

| Strategy | Behavior |
|----------|----------|
| `bold` | Extrapolate freely from worldview. Prefer interesting takes over safe ones. |
| `cautious` | Extrapolate from adjacent positions. Flag uncertainty in-character. |
| `strict` | Only respond to explicitly covered topics. Redirect others in-character. |

**Source Priority (all strategies):**
1. Explicit positions in SOUL.md -> use directly
2. Covered in examples/ -> reference for grounding
3. Adjacent to known positions -> extrapolate from worldview
4. Completely novel -> depends on strategy setting

---

## 12. Version History

| Version | Date | Status | Key Changes |
|---------|------|--------|-------------|
| v0.1 | 2026-02-12 | Internal | Initial spec (Korean). soul.json, SOUL.md, IDENTITY.md, AGENTS.md, HEARTBEAT.md, USER_TEMPLATE.md |
| v0.2 | 2026-02-13 | Internal | Added STYLE.md, examples/, modes, interpolation, source priority rules. Translated to English |
| v0.3 | 2026-02-16 | Supported | Added `specVersion` field. Renamed `clawsoul.json` to `soul.json`. License allowlist. Minimum for registry publish |
| v0.4 | 2026-02-20 | Supported | `compatibility.frameworks`, `allowedTools`, `recommendedSkills`, progressive disclosure (`disclosure.summary`), `deprecated`/`supersededBy`. Deprecated `modes`, `interpolation`, `skills`. SOUL.md now requires `## Personality`, `## Tone`, `## Principles` headers. `author` and `tags` now required. IDENTITY.md requires `Creature` field |
| v0.5 | 2026-02-23 | **Current** | Robotics/embodied agents. `environment`, `interactionMode`, `hardwareConstraints`, `safety.laws`, `safety.physical`, `sensors`, `actuators`. AGENTS.md now required. ROS2 mapping |

### Version Requirement Matrix

| Feature | v0.3 | v0.4 | v0.5 |
|---------|------|------|------|
| `specVersion` | required | required | required |
| `author` | optional | **required** | **required** |
| `tags` | optional | **required** | **required** |
| `## Personality` in SOUL.md | optional | **required** | **required** |
| `## Tone` in SOUL.md | optional | **required** | **required** |
| `## Principles` in SOUL.md | optional | **required** | **required** |
| `Creature` in IDENTITY.md | optional | **required** | **required** |
| AGENTS.md | recommended | recommended | **required** |
| `safety.laws` | n/a | n/a | recommended |
| `compatibility` | n/a | n/a | supported |
| `allowedTools` | n/a | n/a | supported |

### specVersion Backward Compatibility

- If `specVersion` missing, tools infer version:
  - `soul.json` present -> assumed v0.3
  - `clawsoul.json` present -> assumed v0.2
  - Neither -> assumed v0.1
- Tools SHOULD warn if missing but MUST NOT reject

---

## 13. Registry & Publishing

### Publishing Flow

```bash
clawsouls validate ./my-soul     # Validate structure
clawsouls soulscan ./my-soul     # Security scan
clawsouls login <token>          # Authenticate
clawsouls publish ./my-soul      # Publish
```

### Requirements
- `soul.json` must include all required fields
- `SOUL.md` must exist
- License must be in allowed list
- SoulScan score must be above minimum threshold
- `name` must be unique within your account
- `specVersion` must be `0.3` or higher

### Installation Flow

```bash
openclaw soul install <name>     # Download from registry
openclaw soul use <name>         # Apply to workspace
openclaw soul search "query"     # Search registry
openclaw soul list               # List installed
openclaw soul remove <name>      # Remove
openclaw soul init               # Scaffold new soul
openclaw soul publish            # Publish
```

Installation behavior:
1. Download from ClawSouls registry
2. Save to `~/.openclaw/souls/<name>/`
3. On `use`: copy SOUL.md, IDENTITY.md to workspace; merge AGENTS.md (preserve user settings); copy STYLE.md, examples/, avatar; copy USER_TEMPLATE.md to USER.md only if USER.md doesn't exist
4. Backup existing files to `~/.openclaw/souls/_backup/`

### Registry URL Pattern

Published at: `clawsouls.ai/souls/{owner}/{name}/{version}`

---

## 14. SoulScan — Security Verification

### Scan Stages

| Stage | What It Checks |
|-------|---------------|
| Stage 1: Schema Validation | soul.json structure, required fields, specVersion |
| Stage 2: File Structure | Allowed extensions, size limits, recommended files |
| Stage 2.5: Manifest Security | Embodied agents without safety laws, safety vs persona contradictions |
| Stage 3: Pattern Security | Prompt injection, system prompt override, data exfiltration, secret leaks, unauthorized tool usage |
| Stage 3.5: Memory Hygiene | Context-aware PII detection (email, phone, SSN, API keys, etc.) with false positive filtering |
| Stage 4: Content Quality | SOUL.md length, description quality |
| Stage 5: Persona Consistency | Name consistency across files, tone contradictions, persona reference validation |

### Scoring

```
integratedScore = personaScore x 0.6 + memoryScore x 0.4
```

| Issue Type | Penalty |
|-----------|---------|
| Error | -25 points |
| Warning | -5 points |

Embodied agent bonus: up to +10 points for environment, interactionMode, hardwareConstraints, safety.physical fields.

| Score | Grade |
|-------|-------|
| 90-100 | Verified |
| 70-89 | Low Risk |
| 40-69 | Medium Risk |
| 1-39 | High Risk |
| 0 | Blocked (cannot publish) |

---

## 15. ROS2 Mapping (v0.5 Embodied Agents)

```
soul.json          -> ROS2 package manifest (package.xml)
SOUL.md            -> System prompt for LLM node
IDENTITY.md        -> Robot namespace / TF frame identity
safety.physical    -> Safety controller parameters
sensors            -> Sensor topic subscriptions
actuators          -> Action server capabilities
```

Recommended ROS2 node structure:
```
/robot_soul_loader       — Reads soul package, configures LLM
/robot_personality_node  — Publishes personality-aware responses
/safety_monitor          — Enforces safety.physical constraints
```

---

## 16. Security Considerations

- Soul packages must contain only markdown files and images (no executable code)
- AGENTS.md external action rules require user confirmation before applying
- Automatic scan on publish (prompt injection detection)
- Report & flagging system
- STYLE.md and examples/ are instruction-only, no code execution
- Interpolation strategy limits hallucination scope
- SoulScan cross-references `allowedTools` with actual tool usage to detect undeclared tool expectations

---

## 17. Compatible Frameworks

SoulSpec works with any framework that reads SOUL.md:
- OpenClaw (CLI Agent)
- Claude Code (CLI Agent)
- Claude Desktop (Desktop App)
- Claude Cowork (Team Agent)
- Cursor (IDE Agent)
- Windsurf (IDE Agent)
- ChatGPT (Chat App)
- ROS2 (Robotics, v0.5)

---

## 18. Documentation Site Structure

The Docusaurus docs site at docs.clawsouls.ai contains:

```
docs/
  getting-started/installation.md, quick-start.md, your-first-soul.md
  spec/overview.md, v0.3.md, v0.4.md, v0.5.md, examples.md, migration.md
  guides/openclaw.md, claude-code.md, claude-desktop.md, cursor.md, windsurf.md, memory-sync.md, migration-from-openclaw.md
  platform/publishing.md, soulscan.md, soulclaw-cli.md, web-editor.md, soul-memory.md, dag-memory.md, checkpoint.md, swarm.md
  api/cli.md, mcp.md, rest-api.md, soulscan-api.md
  community/changelog.md, contributing.md
```
