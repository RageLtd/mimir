---
globs: ["*.ts", "*.tsx", "*.js", "*.jsx", "*.rs", "*.go", "*.py", "docker-compose.*", "Dockerfile"]
---
# Reuse Long-Lived Processes

Connect to an existing process instead of spawning a new one. Check if a service is already healthy before starting it ("get or start" pattern).

Only the process that spawned a service should stop it.
