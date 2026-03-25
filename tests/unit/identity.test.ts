import { describe, it, expect } from "vitest";
import {
  parseSoulMd,
  parseIdentityMd,
  parseStyleMd,
  deriveIdentity,
  buildIdentityPrefix,
  type ParseWarning,
} from "@/lib/identity";

describe("parseSoulMd", () => {
  it("extracts all sections from valid content", () => {
    const content = `## Personality
Direct, concise, technical.

## Tone
Professional and warm.

## Principles
Clarity over completeness.

## Worldview
Technology empowers people.

## Expertise
Full-stack engineering.

## Opinions
Tests are non-negotiable.

## Boundaries
- Never modify production data directly`;

    const { sections, warnings } = parseSoulMd(content);
    expect(warnings).toHaveLength(0);
    expect(sections.personality).toEqual(["Direct, concise, technical."]);
    expect(sections.tone).toEqual(["Professional and warm."]);
    expect(sections.principles).toEqual(["Clarity over completeness."]);
    expect(sections.worldview).toEqual(["Technology empowers people."]);
    expect(sections.expertise).toEqual(["Full-stack engineering."]);
    expect(sections.opinions).toEqual(["Tests are non-negotiable."]);
    expect(sections.boundaries).toEqual(["- Never modify production data directly"]);
  });

  it("returns ERROR warnings for missing required sections", () => {
    const content = `## Worldview
Technology empowers people.`;

    const { warnings } = parseSoulMd(content);
    const messages = warnings.map((w) => w.message);
    expect(messages).toContain("ERROR: Missing required section 'Personality'");
    expect(messages).toContain("ERROR: Missing required section 'Tone'");
    expect(messages).toContain("ERROR: Missing required section 'Principles'");
  });

  it("does not warn for missing recommended sections", () => {
    const content = `## Personality
Direct.

## Tone
Warm.

## Principles
Be clear.`;

    const { warnings } = parseSoulMd(content);
    expect(warnings).toHaveLength(0);
  });

  it("warns on unrecognized sections and ignores them", () => {
    const content = `## Personality
Direct.

## Tone
Warm.

## Principles
Be clear.

## Hobbies
Gardening.`;

    const { sections, warnings } = parseSoulMd(content);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain("Unrecognized section");
    expect(warnings[0].message).toContain("Hobbies");
    expect(sections["hobbies"]).toBeUndefined();
  });

  it("rejects __proto__ key (prototype pollution prevention)", () => {
    const content = `## __proto__
Malicious content.

## Personality
Safe content.`;

    const { sections } = parseSoulMd(content);
    expect(sections["__proto__"]).toBeUndefined();
    expect(sections.personality).toEqual(["Safe content."]);
  });
});

describe("parseIdentityMd", () => {
  it("extracts identity fields from valid content", () => {
    const content = `- **Name:** Atlas
- **Role:** Engineering Assistant
- **Creature:** Owl
- **Emoji:** 🦉
- **Vibe:** Wise and calm
- **Avatar:** https://example.com/owl.png`;

    const { fields, warnings } = parseIdentityMd(content);
    expect(warnings).toHaveLength(0);
    expect(fields.name).toBe("Atlas");
    expect(fields.role).toBe("Engineering Assistant");
    expect(fields.creature).toBe("Owl");
    expect(fields.emoji).toBe("🦉");
    expect(fields.vibe).toBe("Wise and calm");
    expect(fields.avatar).toBe("https://example.com/owl.png");
  });

  it("returns ERROR warning when creature is missing", () => {
    const content = `- **Name:** Atlas
- **Role:** Engineering Assistant`;

    const { warnings } = parseIdentityMd(content);
    const messages = warnings.map((w) => w.message);
    expect(messages).toContain("ERROR: Missing required field 'creature'");
  });

  it("ignores unknown fields", () => {
    const content = `- **Creature:** Owl
- **Communication Verbosity:** concise`;

    const { fields } = parseIdentityMd(content);
    expect(fields.creature).toBe("Owl");
    expect(fields["communication_verbosity"]).toBeUndefined();
  });
});

describe("parseStyleMd", () => {
  it("extracts all style sections", () => {
    const content = `## Sentence Structure
Short, punchy sentences. Fragments are fine.

## Vocabulary
Technical but accessible.

## Tone
Warm and encouraging.

## Formatting
Use bullet points for lists.

## Rhythm
Vary length. Short then long.

## Anti-patterns
Never use corporate jargon.`;

    const { sections, warnings } = parseStyleMd(content);
    expect(warnings).toHaveLength(0);
    expect(sections.sentence_structure).toBe("Short, punchy sentences. Fragments are fine.");
    expect(sections.vocabulary).toBe("Technical but accessible.");
    expect(sections.tone).toBe("Warm and encouraging.");
    expect(sections.formatting).toBe("Use bullet points for lists.");
    expect(sections.rhythm).toBe("Vary length. Short then long.");
    expect(sections.anti_patterns).toBe("Never use corporate jargon.");
  });

  it("all sections are optional", () => {
    const content = `## Tone
Just a tone.`;

    const { sections, warnings } = parseStyleMd(content);
    expect(warnings).toHaveLength(0);
    expect(sections.tone).toBe("Just a tone.");
    expect(sections.vocabulary).toBeUndefined();
  });

  it("warns on unrecognized sections", () => {
    const content = `## Tone
Warm.

## Color Palette
Blue and green.`;

    const { warnings } = parseStyleMd(content);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain("Unrecognized section");
    expect(warnings[0].message).toContain("Color Palette");
  });
});

describe("deriveIdentity", () => {
  const validSoul = `# My Agent

A helpful engineering assistant.

## Personality
Direct and focused.

## Tone
Professional.

## Principles
Clarity first.`;

  const validIdentity = `- **Name:** Atlas
- **Creature:** Owl
- **Emoji:** 🦉`;

  const validStyle = `## Vocabulary
Technical but accessible.`;

  it("returns complete AgentIdentity with all files", () => {
    const { identity, warnings } = deriveIdentity(validSoul, validIdentity, validStyle, null, null, null, null, null);
    expect(identity).not.toBeNull();
    expect(identity!.soul?.personality).toBe("Direct and focused.");
    expect(identity!.soul?.tone).toBe("Professional.");
    expect(identity!.soul?.principles).toBe("Clarity first.");
    expect(identity!.identity?.creature).toBe("Owl");
    expect(identity!.style?.vocabulary).toBe("Technical but accessible.");
    expect(identity!.disclosure_summary).toBe("A helpful engineering assistant.");
    expect(warnings).toHaveLength(0);
  });

  it("returns null with no warnings for all-null inputs", () => {
    const { identity, warnings } = deriveIdentity(null, null, null, null, null, null, null, null);
    expect(identity).toBeNull();
    expect(warnings).toHaveLength(0);
  });

  it("sets has_agents_md correctly", () => {
    const { identity } = deriveIdentity(validSoul, null, null, "some agent instructions", null, null, null, null);
    expect(identity).not.toBeNull();
    expect(identity!.has_agents_md).toBe(true);
    expect(identity!.has_heartbeat_md).toBe(false);
  });

  it("sets has_examples when either good or bad examples exist", () => {
    const { identity } = deriveIdentity(validSoul, null, null, null, null, null, "good example", null);
    expect(identity!.has_examples).toBe(true);

    const { identity: identity2 } = deriveIdentity(validSoul, null, null, null, null, null, null, "bad example");
    expect(identity2!.has_examples).toBe(true);
  });

  it("extracts disclosure_summary from first paragraph of SOUL.md", () => {
    const soul = `# Agent Name

This is the first paragraph describing the agent.

## Personality
Direct.

## Tone
Warm.

## Principles
Be clear.`;

    const { identity } = deriveIdentity(soul, null, null, null, null, null, null, null);
    expect(identity!.disclosure_summary).toBe("This is the first paragraph describing the agent.");
  });

  it("returns null identity when nothing meaningful is populated", () => {
    const { identity } = deriveIdentity(null, null, null, null, null, null, null, null);
    expect(identity).toBeNull();
  });

  it("enforces 25KB size limit", () => {
    const longLine = (ch: string, len: number) => ch.repeat(len);
    const hugeSoul = `## Personality
${longLine("a", 5000)}

## Tone
${longLine("b", 5000)}

## Principles
${longLine("c", 5000)}

## Worldview
${longLine("d", 5000)}

## Expertise
${longLine("e", 5000)}

## Opinions
${longLine("f", 5000)}

## Boundaries
${longLine("g", 5000)}`;

    const { identity, warnings } = deriveIdentity(hugeSoul, null, null, null, null, null, null, null);
    if (identity === null) {
      const messages = warnings.map((w) => w.message);
      expect(messages.some((m) => m.includes("25KB limit"))).toBe(true);
    } else {
      expect(JSON.stringify(identity).length).toBeLessThanOrEqual(25600);
    }
  });
});

describe("buildIdentityPrefix", () => {
  it("joins identity_md, soul_md, style_md, agents_md at level 2", () => {
    const result = buildIdentityPrefix({
      soul_md: "soul",
      identity_md: "identity",
      style_md: "style",
      agents_md: "agents",
    });
    expect(result).toBe("identity\n\nsoul\n\nstyle\n\nagents");
  });

  it("returns empty string for null/undefined inputs", () => {
    expect(buildIdentityPrefix({ soul_md: null, identity_md: null })).toBe("");
    expect(buildIdentityPrefix({})).toBe("");
  });

  it("returns only the non-null values", () => {
    expect(buildIdentityPrefix({ soul_md: "soul", identity_md: null })).toBe("soul");
    expect(buildIdentityPrefix({ soul_md: null, identity_md: "identity" })).toBe("identity");
  });

  it("returns disclosure_summary at level 1", () => {
    const result = buildIdentityPrefix({
      soul_md: "# Agent\n\nA helpful assistant.\n\n## Personality\nDirect.",
    }, 1);
    expect(result).toBe("A helpful assistant.");
  });

  it("includes heartbeat and examples at level 3", () => {
    const result = buildIdentityPrefix({
      soul_md: "soul",
      identity_md: "identity",
      heartbeat_md: "heartbeat",
      examples_good_md: "good",
      examples_bad_md: "bad",
    }, 3);
    expect(result).toBe("identity\n\nsoul\n\nheartbeat\n\ngood\n\nbad");
  });
});
