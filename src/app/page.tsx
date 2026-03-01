import Image from "next/image";
import Link from "next/link";
import { ArrowRight, Zap, Shield, Globe, Terminal, Layers, Clock, Github } from "lucide-react";

function Nav() {
  return (
    <nav className="fixed top-0 left-0 right-0 z-50 border-b border-white/[0.08] bg-[hsl(240,10%,3.9%)]/80 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
        <Link href="/" className="flex items-center gap-2.5">
          <Image src="/logo-32.png" alt="AgentPlane" width={24} height={24} />
          <span className="text-[15px] font-semibold tracking-tight text-white">AgentPlane</span>
        </Link>
        <div className="flex items-center gap-6">
          <Link
            href="https://github.com/getcatalystiq/agentplane"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[hsl(240,5%,65%)] transition-colors hover:text-white"
          >
            <Github className="h-5 w-5" />
          </Link>
          <Link
            href="/admin"
            className="inline-flex h-9 items-center gap-2 rounded-lg bg-white px-4 text-sm font-medium text-[hsl(240,10%,3.9%)] transition-all hover:bg-white/90"
          >
            Dashboard
          </Link>
        </div>
      </div>
    </nav>
  );
}

function GridBackground() {
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      {/* Grid pattern */}
      <div
        className="absolute inset-0 opacity-[0.03]"
        style={{
          backgroundImage: `linear-gradient(hsl(0,0%,100%) 1px, transparent 1px), linear-gradient(90deg, hsl(0,0%,100%) 1px, transparent 1px)`,
          backgroundSize: "64px 64px",
        }}
      />
      {/* Top gradient glow */}
      <div
        className="absolute -top-[40%] left-1/2 h-[800px] w-[1200px] -translate-x-1/2"
        style={{
          background: "radial-gradient(ellipse at center, hsl(240,50%,50%,0.08) 0%, transparent 70%)",
        }}
      />
    </div>
  );
}

function Hero() {
  return (
    <section className="relative flex min-h-[90vh] flex-col items-center justify-center px-6 pt-16">
      <GridBackground />
      <div className="relative z-10 mx-auto max-w-4xl text-center">
        {/* Badge */}
        <div className="mb-8 inline-flex items-center gap-2 rounded-full border border-white/[0.08] bg-white/[0.03] px-4 py-1.5">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
          </span>
          <span className="text-sm text-[hsl(240,5%,65%)]">Now in public beta</span>
        </div>

        {/* Heading */}
        <h1 className="text-5xl font-bold leading-[1.08] tracking-tight text-white sm:text-7xl">
          Claude Agents{" "}
          <br className="hidden sm:block" />
          <span className="bg-gradient-to-r from-white via-white/80 to-white/50 bg-clip-text text-transparent">
            as an API
          </span>
        </h1>

        {/* Subheading */}
        <p className="mx-auto mt-6 max-w-xl text-lg leading-relaxed text-[hsl(240,5%,55%)]">
          Run Claude Agent SDK in isolated sandboxes. Skills, connectors, streaming, and ready for production.
          One POST request to launch an agent.
        </p>

        {/* CTAs */}
        <div className="mt-10 flex items-center justify-center gap-4">
          <Link
            href="/admin"
            className="group inline-flex h-11 items-center gap-2 rounded-lg bg-white px-6 text-sm font-medium text-[hsl(240,10%,3.9%)] transition-all hover:bg-white/90"
          >
            Dashboard
            <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
          </Link>
          <Link
            href="https://github.com/getcatalystiq/agentplane"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-11 items-center gap-2 rounded-lg border border-white/[0.12] bg-white/[0.03] px-6 text-sm font-medium text-white transition-all hover:border-white/[0.2] hover:bg-white/[0.06]"
          >
            <Github className="h-4 w-4" />
            GitHub
          </Link>
        </div>

        {/* Code preview */}
        <div className="mx-auto mt-16 max-w-2xl">
          <div className="overflow-hidden rounded-xl border border-white/[0.08] bg-[hsl(240,10%,5%)] shadow-2xl shadow-black/40">
            <div className="flex items-center gap-2 border-b border-white/[0.06] px-4 py-3">
              <div className="flex gap-1.5">
                <div className="h-3 w-3 rounded-full bg-white/[0.08]" />
                <div className="h-3 w-3 rounded-full bg-white/[0.08]" />
                <div className="h-3 w-3 rounded-full bg-white/[0.08]" />
              </div>
              <span className="ml-2 text-xs text-[hsl(240,5%,40%)] font-[family-name:var(--font-geist-mono)]">
                curl
              </span>
            </div>
            <pre className="overflow-x-auto p-5 text-[13px] leading-6 font-[family-name:var(--font-geist-mono)]">
              <code>
                <span className="text-[hsl(240,5%,50%)]">$ </span>
                <span className="text-emerald-400">curl</span>
                <span className="text-white"> -X POST $BASE_URL/api/runs \</span>
                {"\n"}
                <span className="text-white">  -H </span>
                <span className="text-amber-300">{'"Authorization: Bearer $API_KEY"'}</span>
                <span className="text-white"> \</span>
                {"\n"}
                <span className="text-white">  -d </span>
                <span className="text-sky-300">{"'"}</span>
                <span className="text-sky-300">{'{"agent_id": "ag_01", "prompt": "Deploy the app"}'}</span>
                <span className="text-sky-300">{"'"}</span>
              </code>
            </pre>
          </div>
        </div>
      </div>
    </section>
  );
}

const features = [
  {
    icon: Terminal,
    title: "Claude Agent SDK inside",
    description:
      "Full Claude Agent SDK agent with tool use, file editing, and bash. Not a wrapper — the real thing running in a sandbox.",
  },
  {
    icon: Shield,
    title: "Isolated sandboxes",
    description:
      "Every run spins up a fresh Vercel Sandbox with its own filesystem, network policy, and resource limits.",
  },
  {
    icon: Zap,
    title: "Skills",
    description:
      "Inject custom skills into agents as files before execution. Extend agent capabilities without changing code.",
  },
  {
    icon: Layers,
    title: "Multi-tenant",
    description:
      "Row-level security, per-tenant API keys, budget controls, and rate limiting. Built for platforms.",
  },
  {
    icon: Globe,
    title: "MCP connectors",
    description:
      "Connect agents to external tools via Composio. GitHub, Notion, Slack, Firecrawl — one config away.",
  },
  {
    icon: Clock,
    title: "Full observability",
    description:
      "Every run stores a transcript, token usage, cost, and duration. Query runs, replay transcripts, track spend.",
  },
];

function Features() {
  return (
    <section className="relative border-t border-white/[0.06] px-6 py-32">
      <div className="mx-auto max-w-6xl">
        <div className="mb-16 max-w-xl">
          <p className="mb-3 text-sm font-medium uppercase tracking-widest text-[hsl(240,5%,45%)]">
            Platform
          </p>
          <h2 className="text-3xl font-bold tracking-tight text-white sm:text-4xl">
            Everything you need to run agents in production
          </h2>
        </div>

        <div className="grid gap-px overflow-hidden rounded-2xl border border-white/[0.06] bg-white/[0.03] sm:grid-cols-2 lg:grid-cols-3">
          {features.map((f) => (
            <div
              key={f.title}
              className="group relative bg-[hsl(240,10%,3.9%)] p-8 transition-colors hover:bg-[hsl(240,10%,5%)]"
            >
              <f.icon className="mb-4 h-5 w-5 text-[hsl(240,5%,50%)] transition-colors group-hover:text-white" strokeWidth={1.5} />
              <h3 className="mb-2 text-[15px] font-semibold text-white">{f.title}</h3>
              <p className="text-sm leading-relaxed text-[hsl(240,5%,50%)]">{f.description}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function HowItWorks() {
  const steps = [
    {
      step: "01",
      title: "Create a tenant",
      description: "Provision isolated workspaces with API keys, budgets, and rate limits.",
      code: `npm run create-tenant`,
    },
    {
      step: "02",
      title: "Configure an agent",
      description: "Set model, tools, permissions, git repo, and MCP connectors.",
      code: `POST /api/agents
{
  "name": "deploy-bot",
  "model": "claude-sonnet-4-6",
  "composio_toolkits": ["github"]
}`,
    },
    {
      step: "03",
      title: "Run with a prompt",
      description: "POST a prompt, get back a streaming NDJSON response with real-time events.",
      code: `POST /api/runs
{ "agent_id": "ag_01",
  "prompt": "Review the open PRs" }

← {"type":"run_started",...}
← {"type":"assistant",...}
← {"type":"tool_use",...}
← {"type":"result",...}`,
    },
  ];

  return (
    <section className="relative border-t border-white/[0.06] px-6 py-32">
      <div className="mx-auto max-w-6xl">
        <div className="mb-16 max-w-xl">
          <p className="mb-3 text-sm font-medium uppercase tracking-widest text-[hsl(240,5%,45%)]">
            How it works
          </p>
          <h2 className="text-3xl font-bold tracking-tight text-white sm:text-4xl">
            Three steps to your first agent run
          </h2>
        </div>

        <div className="grid gap-8 lg:grid-cols-3">
          {steps.map((s) => (
            <div key={s.step} className="flex flex-col">
              <span className="mb-4 font-[family-name:var(--font-geist-mono)] text-xs text-[hsl(240,5%,35%)]">
                {s.step}
              </span>
              <h3 className="mb-2 text-lg font-semibold text-white">{s.title}</h3>
              <p className="mb-5 text-sm leading-relaxed text-[hsl(240,5%,50%)]">{s.description}</p>
              <div className="mt-auto overflow-hidden rounded-lg border border-white/[0.06] bg-[hsl(240,10%,5%)]">
                <pre className="overflow-x-auto p-4 text-[13px] leading-6 font-[family-name:var(--font-geist-mono)] text-[hsl(240,5%,60%)]">
                  {s.code}
                </pre>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Architecture() {
  return (
    <section className="relative border-t border-white/[0.06] px-6 py-32">
      <div className="mx-auto max-w-6xl">
        <div className="mb-16 text-center">
          <p className="mb-3 text-sm font-medium uppercase tracking-widest text-[hsl(240,5%,45%)]">
            Architecture
          </p>
          <h2 className="text-3xl font-bold tracking-tight text-white sm:text-4xl">
            From API call to agent execution
          </h2>
        </div>

        <div className="mx-auto max-w-3xl overflow-hidden rounded-2xl border border-white/[0.06] bg-[hsl(240,10%,5%)]">
          <div className="border-b border-white/[0.06] px-6 py-4">
            <span className="font-[family-name:var(--font-geist-mono)] text-xs text-[hsl(240,5%,40%)]">
              execution flow
            </span>
          </div>
          <div className="p-8 font-[family-name:var(--font-geist-mono)] text-sm leading-8 text-[hsl(240,5%,50%)]">
            <div className="flex items-center gap-3">
              <span className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-white/[0.06] text-xs text-white">1</span>
              <span>Client POSTs prompt to</span>
              <code className="rounded bg-white/[0.06] px-2 py-0.5 text-emerald-400">/api/agents/:id/runs</code>
            </div>
            <div className="ml-3.5 border-l border-white/[0.06] py-1 pl-7 text-[hsl(240,5%,30%)]">|</div>
            <div className="flex items-center gap-3">
              <span className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-white/[0.06] text-xs text-white">2</span>
              <span>Vercel Sandbox created with Claude Agent SDK + MCP servers</span>
            </div>
            <div className="ml-3.5 border-l border-white/[0.06] py-1 pl-7 text-[hsl(240,5%,30%)]">|</div>
            <div className="flex items-center gap-3">
              <span className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-white/[0.06] text-xs text-white">3</span>
              <span>Events stream back over</span>
              <code className="rounded bg-white/[0.06] px-2 py-0.5 text-amber-300">SSE / NDJSON</code>
            </div>
            <div className="ml-3.5 border-l border-white/[0.06] py-1 pl-7 text-[hsl(240,5%,30%)]">|</div>
            <div className="flex items-center gap-3">
              <span className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-white/[0.06] text-xs text-white">4</span>
              <span>Transcript stored, usage + cost recorded</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function CTA() {
  return (
    <section className="relative border-t border-white/[0.06] px-6 py-32">
      <div className="mx-auto max-w-6xl text-center">
        <h2 className="text-3xl font-bold tracking-tight text-white sm:text-5xl">
          Ship agents,{" "}
          <span className="bg-gradient-to-r from-white/60 to-white/30 bg-clip-text text-transparent">
            not infrastructure
          </span>
        </h2>
        <p className="mx-auto mt-5 max-w-lg text-[hsl(240,5%,50%)]">
          Stop building sandbox orchestration from scratch. AgentPlane gives you
          a production-ready API for running Claude Agent SDK agents.
        </p>
        <div className="mt-10 flex items-center justify-center gap-4">
          <Link
            href="/admin"
            className="group inline-flex h-12 items-center gap-2 rounded-lg bg-white px-8 text-sm font-medium text-[hsl(240,10%,3.9%)] transition-all hover:bg-white/90"
          >
            Go to Dashboard
            <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
          </Link>
        </div>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="border-t border-white/[0.06] px-6 py-8">
      <div className="mx-auto flex max-w-6xl items-center justify-between">
        <div className="flex items-center gap-2.5">
          <Image src="/logo-32.png" alt="AgentPlane" width={18} height={18} className="opacity-50" />
          <span className="text-xs text-[hsl(240,5%,35%)]">AgentPlane</span>
        </div>
        <div className="flex items-center gap-6">
          <Link href="https://github.com/getcatalystiq/agentplane" target="_blank" rel="noopener noreferrer" className="text-xs text-[hsl(240,5%,35%)] hover:text-[hsl(240,5%,65%)]">
            GitHub
          </Link>
          <Link href="/api/health" className="text-xs text-[hsl(240,5%,35%)] hover:text-[hsl(240,5%,65%)]">
            Status
          </Link>
          <Link href="/admin" className="text-xs text-[hsl(240,5%,35%)] hover:text-[hsl(240,5%,65%)]">
            Admin
          </Link>
        </div>
      </div>
    </footer>
  );
}

export default function Home() {
  return (
    <div className="dark min-h-screen bg-[hsl(240,10%,3.9%)] text-white antialiased">
      <Nav />
      <Hero />
      <Features />
      <HowItWorks />
      <Architecture />
      <CTA />
      <Footer />
    </div>
  );
}
