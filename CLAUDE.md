# DealMail Development Guide

## Development Environment
- Load dev environment: `direnv allow` or `nix develop`

## Commands
- Setup: `npm install`
- Build: `npm run build`
- Test: `npm test`
- Test single file: `npm test -- path/to/test.spec.ts`
- Lint: `npm run lint`
- Type check: `npm run typecheck`

## Code Style
- Use TypeScript strict mode with explicit types
- Format with Prettier, configured in package.json
- Prefer async/await over Promise chains
- Use named exports over default exports
- PascalCase for classes/types, camelCase for variables/functions
- Group imports: built-in → external → internal
- Error handling: use typed errors with meaningful messages
- Organize code in feature-based directories
- Use functional programming patterns

## Project Structure
- `src/` - Source code
- `dist/` - Compiled output
- `tests/` - Test files
