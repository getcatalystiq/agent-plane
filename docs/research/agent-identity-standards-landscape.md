# AI Agent Identity Standards Landscape (2023-2026)

Research compiled March 2026.

---

## 1. SoulSpec — The Open Standard for AI Agent Personas

**URL:** https://soulspec.org | **GitHub:** https://github.com/clawsouls/soulspec
**Version:** 0.4 | **Created by:** ClawSouls (https://clawsouls.ai)
**Backed by research:** arXiv:2510.21413 — "Context Engineering for AI Agents in Open-Source Software" (MSR 2026), which analyzed 466 open-source AI agent projects and found no standardized structure for persona definitions.

### What it defines

A minimal, portable file structure (Markdown + JSON, no build step) for defining AI agent identity:

```
my-agent/
├── soul.json      ← manifest (required) — metadata, versioning, compatibility, discovery
├── SOUL.md        ← personality (required) — values, communication style, opinions, behavioral guidelines
├── IDENTITY.md    ← who the agent is — name, role, backstory, contextual positioning
├── AGENTS.md      ← operational workflow — task handling, tool usage, memory patterns
├── STYLE.md       ← communication style
├── HEARTBEAT.md   ← autonomous check-in behavior
└── examples/
    ├── good-outputs.md
    └── bad-outputs.md
```

**soul.json** is the manifest (like package.json for personas):
- `specVersion`, `name`, `displayName`, `version`, `description`
- `license`, `tags`
- `compatibility.frameworks` — e.g., `["openclaw", "cursor", "windsurf"]`
- `files` — maps logical roles to filenames

### Key distinction
> "AGENTS.md defines how agents work on your code. SoulSpec defines **who your agent is**."

### Ecosystem
- **ClawSouls CLI** — `npx clawsouls install clawsouls/surgical-coder --use claude-code`
- **Registry** — 91+ published souls, 2,543+ downloads, 33 categories
- **Compatible frameworks:** Claude Code, Claude Desktop, Cursor, Windsurf, ChatGPT, VS Code, OpenClaw
- **SoulScan** — verification tool for security and quality of soul packages

### Popular souls on registry
- **Surgical Coder** — disciplined, think-first, minimal-change coding style
- **Brad** — formal development partner, Korean/English bilingual
- **API Architect** — RESTful API and microservices specialist
- **Academic Writer** — academic writing specialist

---

## 2. AGENTS.md — The Operational Complement

**URL:** https://agents.md
**Created by:** OpenAI (initially), now broadly adopted

### What it defines
Operational context for coding agents — build steps, tests, conventions. Complements README.md (which targets humans). Recommended sections:
- Project overview
- Build and test commands
- Code style guidelines
- Testing instructions
- Security considerations

### Ecosystem adoption
Supported by: Codex (OpenAI), Jules (Google), Cursor, Windsurf, VS Code, Devin, Aider, Goose, Zed, Warp, Junie (JetBrains), RooCode, Gemini CLI, Amp, Factory, UiPath, and others.

### Relationship to SoulSpec
AGENTS.md is about *what the agent does* (workflows, tools, tasks). SoulSpec is about *who the agent is* (personality, values, identity). They are complementary — SoulSpec even includes an optional `AGENTS.md` file in its spec.

---

## 3. Character Card Spec (V1/V2) — The RP/Chat Community Standard

**GitHub:** https://github.com/malfoyslastname/character-card-spec-v2
**Version:** V2 (approved May 2023)
**Origin:** Pygmalion/TavernAI roleplay community

### What it defines
A JSON format embedded in PNG image metadata for portable AI character definitions:

```typescript
type TavernCardV2 = {
  spec: 'chara_card_v2'
  spec_version: '2.0'
  data: {
    name: string
    description: string          // character description
    personality: string          // personality traits
    scenario: string             // conversation context
    first_mes: string            // opening message
    mes_example: string          // example conversations
    // V2 additions:
    creator_notes: string        // instructions for users
    system_prompt: string        // system prompt override
    post_history_instructions: string  // "jailbreak" / post-history injection
    alternate_greetings: string[]
    character_book?: CharacterBook  // embedded lorebook/world info
    tags: string[]
    creator: string
    character_version: string
    extensions: Record<string, any>  // extensible metadata
  }
}
```

### Key concepts
- **Character Book** — embedded lorebook with keyword-triggered context entries (stacks with world books)
- **Extensions** — namespaced arbitrary key-value pairs for forward compatibility
- **Portability** — character data embedded in PNG EXIF, shareable as image files

### Ecosystem
- **Frontends:** SillyTavern, RisuAI, Agnai
- **Repositories:** characterhub.org, Pygmalion Booru
- **Utility library:** `character-card-utils` npm package

### Relationship to SoulSpec
Character Cards target conversational/roleplay agents with rich narrative context. SoulSpec targets coding/productivity agents with behavioral specifications. Character Cards are JSON-in-PNG; SoulSpec is Markdown files in a directory.

---

## 4. ElizaOS Character Interface — Framework-Native Identity

**URL:** https://docs.elizaos.ai/agents/character-interface
**GitHub:** https://github.com/elizaOS/eliza (17.9k stars, 5.5k forks)

### What it defines
A TypeScript `Character` interface that serves as the blueprint for agent instances:

```typescript
interface Character {
  name: string
  bio: string | string[]           // backstory, can be randomized array
  system?: string                  // system prompt override
  templates?: Record<string, string>  // per-action prompt templates
  messageExamples?: MessageExample[][]  // conversation training data
  style?: {
    all?: string[]                 // universal style rules
    chat?: string[]                // chat-specific style
    post?: string[]                // social media style
  }
  topics?: string[]                // areas of knowledge
  adjectives?: string[]            // personality descriptors
  plugins?: string[]               // capability plugins
  settings?: { /* model, voice, etc. */ }
}
```

### Design philosophy
- **Character** = static configuration (blueprint)
- **Agent** = runtime instance with lifecycle (extends Character with `status`, `createdAt`, `updatedAt`)
- Bio as string array enables randomized personality facets
- Three style contexts: `all`, `chat`, `post` for platform-aware behavior

### Relationship to SoulSpec
ElizaOS is framework-specific (TypeScript/JSON). SoulSpec is framework-agnostic (Markdown). ElizaOS focuses on conversational agents with social media integration. SoulSpec focuses on coding/productivity agents with IDE integration.

---

## 5. Other Notable Approaches

### A2A Protocol Agent Cards (Linux Foundation / Google)
- **Purpose:** Machine-readable discovery (capabilities, skills, auth) — NOT personality
- **Format:** JSON served at `/.well-known/agent-card.json`
- **Focus:** Interoperability between agent systems, not identity/personality

### Open Souls (souls.chat)
- **Status:** Appears defunct (expired SSL certificate, 404 GitHub repos as of March 2026)
- **Was:** A "Soul Engine" for stateful AI characters with cognitive architectures
- **Concept:** "Soul" as a persistent cognitive entity with mental processes, memories, and evolving personality

### a16z AI Town
- **Purpose:** Simulated town with AI characters that live, chat, and socialize
- **Identity approach:** Character descriptions as structured data in a game engine context
- **Not a standard** — research/demo project

### Vendor-Specific Context Files
Each vendor has its own format that SoulSpec/AGENTS.md aim to unify:
- **Claude Code:** `CLAUDE.md`
- **Cursor:** `.cursorrules`
- **Windsurf:** `.windsurfrules`
- **GitHub Copilot:** `.github/copilot-instructions.md`

---

## 6. Taxonomy of Concepts

| Concept | Definition | Examples |
|---------|-----------|----------|
| **Soul** | Core personality essence — values, voice, stance, worldview | SoulSpec SOUL.md, Open Souls |
| **Persona** | Complete identity package — soul + role + context | SoulSpec (full package), ElizaOS Character |
| **Character Card** | Portable character definition for conversational AI | TavernAI V2 spec |
| **Agent Card** | Machine-readable capability/discovery metadata | A2A protocol |
| **Identity Spec** | Behavioral parameters — autonomy, risk tolerance, escalation | SoulSpec IDENTITY.md |
| **Context File** | Operational instructions for coding agents | AGENTS.md, CLAUDE.md, .cursorrules |

---

## 7. Key Observations

1. **Two distinct communities:** The roleplay/chat community (Character Cards, ElizaOS) and the coding/productivity community (SoulSpec, AGENTS.md) are solving the same problem independently with different priorities.

2. **SoulSpec is the first attempt at a cross-framework open standard** for agent personality. Its research foundation (466-project MSR study) gives it academic credibility.

3. **The "soul" metaphor is gaining traction** — ClawSouls has a registry with 91+ published souls and real adoption across major IDE agents.

4. **Markdown is winning over JSON** for personality specs. SoulSpec, AGENTS.md, CLAUDE.md all use Markdown. Character Cards (JSON-in-PNG) are the exception, optimized for image-board sharing.

5. **Identity vs. Capability is an important distinction.** A2A Agent Cards define what an agent *can do*. SoulSpec defines who an agent *is*. Both are needed.

6. **No dominant standard yet.** The MSR 2026 paper confirms "no established content structure" across 466 projects. SoulSpec v0.4 is the most structured attempt but still early.

7. **AgentPlane already implements SoulSpec concepts** via `src/lib/identity.ts` — parsing SOUL.md (Voice & Tone, Values, Stance, Boundaries, Essence) and IDENTITY.md (communication verbosity/tone, decision autonomy, risk tolerance, collaboration mode, escalation preferences) into structured `AgentIdentity` JSONB.

---

## 8. Implications for AgentPlane

AgentPlane's current identity implementation (`src/lib/identity.ts`) is well-aligned with SoulSpec:
- Parses `soul_md` and `identity_md` fields from agents
- Extracts structured `AgentIdentity` with soul block (voice, values, stance, essence) and behavioral parameters
- Prepends identity content to prompts via `prependIdentity()`
- Uses `soulspec:identity` metadata key

Potential enhancements to consider:
- **soul.json manifest support** — for versioning and framework compatibility metadata
- **STYLE.md** — separate communication style from personality (SoulSpec v0.4 addition)
- **HEARTBEAT.md** — autonomous check-in behavior for long-running/scheduled agents
- **Registry integration** — allow importing published souls from ClawSouls registry
- **Character Card import** — convert TavernAI V2 cards to SoulSpec format for broader agent reuse
- **Examples directory** — good/bad output examples for few-shot personality alignment
