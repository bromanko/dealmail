# DealMail Development Guide

## Development Environment
- Load dev environment: `direnv allow` or `nix develop`

## Commands
- Setup: `pnpm install`
- Build: `pnpm run build`
- Test: `pnpm test`
- Test single file: `pnpm test -- path/to/test.spec.ts`
- Lint: `pnpm run lint`
- Type check: `pnpm run typecheck`

## Code Style
- Use TypeScript strict mode with explicit types
- Format with Prettier, configured in package.json
- Prefer async/await over Promise chains
- Use named exports over default exports
- PascalCase for classes/types, camelCase for variables/functions
- Group imports: built-in → external → internal
- Error handling: use typed errors with meaningful messages
- Organize code in feature-based directories
- Prefer functional programming patterns and using fp-ts
- Only add comments for complex logic

## Project Structure
- `src/` - Source code
- `dist/` - Compiled output
- `tests/` - Test files
