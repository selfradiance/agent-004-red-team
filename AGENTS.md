# Agent Conventions

## Files That Must Never Be Committed
- .env (contains API keys)
- Any file matching *_PROJECT_CONTEXT.md (private project context)
- Any file matching process-template*.md (private process docs)
- Any file matching agent-identity*.json (contains private keys)

## Git Rules
- Never use `git add .`, `git add -A`, or `git add -f`
- Always stage files explicitly by name
- Confirm .gitignore is correct before every commit

## Workflow
- Read the project context file before making any changes
- Make small, focused diffs — one concern per change
- Run ALL tests after every change
- Commit with a clear message and push immediately
- If tests fail, fix them before doing anything else
