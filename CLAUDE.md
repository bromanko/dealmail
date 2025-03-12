# DealMail Development Guide

## Development Environment
- Load dev environment: `direnv allow` or `nix develop`

## Commands
- Setup: `pnpm install`
- Build: `pnpm run build`
- Test: `pnpm test`
- Test single file: `pnpm test -- path/to/test.spec.ts`
- Lint: `pnpm run lint`
- Lint and fix: `pnpm run lint:fix`
- Format code: `pnpm run format`
- Check code: `pnpm run check`
- Check and fix code: `pnpm run check:fix`
- Type check: `pnpm run typecheck`

## Code Style
- Use TypeScript strict mode with explicit types
- Format with Biome.js, configured in biome.json
- Prefer async/await over Promise chains
- Use named exports over default exports
- PascalCase for classes/types, camelCase for variables/functions
- Group imports: built-in → external → internal
- Error handling: use typed errors with meaningful messages
- Organize code in feature-based directories
- Prefer functional programming patterns and using fp-ts
- ONLY add comments for complex logic. Don't add comments for simple logic
- Avoid deeply nested callback chains. Prefer using fp-ts constructs such as `pipe`, `flow`, and `chain` to compose functions
- Prefer arrow functions with implicit returns
- Prefer functions that use a single pipe rather than mixing some imperative logic followed by a pipeline

## Project Structure
- `src/` - Source code
- `dist/` - Compiled output
- `tests/` - Test files
