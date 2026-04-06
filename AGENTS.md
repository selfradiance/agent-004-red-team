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
- Keep diffs under ~100 lines per change. If a change exceeds 300 lines, stop and break it into smaller pieces before proceeding.

## Anti-Rationalization

| Excuse | Rebuttal |
|--------|----------|
| "I'll add tests later" | Tests are not optional. Write them now. |
| "It's just a prototype" | Prototypes become production. Build it right. |
| "This change is too small to break anything" | Small changes cause subtle bugs. Run the tests. |
| "I already know this works" | You don't. Verify it. |
| "Cleaning up this adjacent code will save time" | Stay in scope. File it for later. |
| "The user probably meant X" | Don't assume. Ask. |
| "Skipping the audit since it's straightforward" | Straightforward changes still need verification. |
| "I'll commit everything at the end" | Commit after each verified change. No batching. |

## Slicing Strategies

- **Vertical slice:** implement one complete feature top to bottom (route, logic, test) before starting another
- **Risk-first slice:** tackle the riskiest or most uncertain piece first to surface problems early
- **Contract-first slice:** define the API contract or interface first, then implement behind it
