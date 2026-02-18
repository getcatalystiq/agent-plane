# Contributing to AgentPlane

Thanks for your interest in contributing! Here's how to get started.

## Development Setup

1. **Clone the repo**

   ```bash
   git clone https://github.com/getcatalystiq/agentplane.git
   cd agentplane
   ```

2. **Install dependencies**

   ```bash
   npm install
   ```

3. **Configure environment**

   Copy `.env.example` to `.env.local` and fill in the required values. See `CLAUDE.md` for the full list of environment variables.

4. **Run database migrations**

   ```bash
   npm run migrate
   ```

5. **Start the dev server**

   ```bash
   npm run dev
   ```

## Running Tests

```bash
npm run test          # single run
npm run test:watch    # watch mode
```

## Building

```bash
npm run build
```

This runs TypeScript type-checking and the Next.js production build.

## Pull Request Guidelines

- Branch from `main`
- Describe what your PR changes and why
- Keep PRs focused — one concern per PR
- Ensure `npm run build` and `npm run test` pass before submitting
- Add tests for new functionality when practical

## Code Style

- TypeScript strict mode — no `any` unless absolutely necessary
- Use Zod for request/response validation
- Follow existing patterns (branded types, `withErrorHandler()`, typed DB helpers)
- Keep files focused and imports clean

## Reporting Issues

Open an issue at [github.com/getcatalystiq/agentplane/issues](https://github.com/getcatalystiq/agentplane/issues) with:

- A clear description of the problem or suggestion
- Steps to reproduce (for bugs)
- Expected vs actual behavior

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
