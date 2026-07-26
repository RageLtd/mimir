---
paths: ["*.ts", "*.tsx", "*.js", "*.jsx", "*.mts", "*.mjs", "*.rs", "*.go", "*.py"]
---
# Constants Over Bare Strings

If a string or number literal is used more than once, extract it into a named constant. This applies to URLs, ports, paths, keys, and any repeated magic value.
