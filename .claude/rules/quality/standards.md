# Quality Standards

- Run a security self-review before completing any task that modifies code
- No features without test coverage
- When a test fails: read the actual vs expected output and question test validity before modifying working code
- When an error occurs, surface it with a specific message including what failed and why. No empty catch blocks, no silent returns, no swallowed errors
- Do not refactor working code without approval
- When applicable, use Red-Green-Refactor TDD cycle
