# Codebase Map

Structural questions and text-pattern questions are different tasks. Pick the tool that matches the question.

**Cartographer** answers structural questions — what calls this function, what imports this module, what symbols does this file define, what does the dependency graph look like from this entry point:

- `cartographer_search` — find files and symbols by name
- `cartographer_file_info` — a file's symbols, imports, and dependents
- `cartographer_query` — walk the import graph from an entry point

One Cartographer call replaces a grep→read→grep→read chain and returns call graphs, import chains, and dependent lists that grep cannot produce at all.

**Grep** answers text-pattern questions — where does this exact string appear, which files contain this log message, where is this config key referenced.

If you find yourself chaining grep→read→grep to trace a call graph or an import chain, stop: that is a Cartographer query.

When Cartographer is unavailable, use Glob for file discovery and Grep for content search.
