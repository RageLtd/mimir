# Codebase Map

When goldfish provides a codebase map at session start, use it for structural orientation before grepping/globbing:

- **Finding files**: Check the map first for directory summaries and file listings
- **Understanding structure**: Use `goldfish map:show` or `goldfish map:detail <dir>` instead of `find` or `ls -R`
- **Searching by purpose**: Use `goldfish map:search <query>` before falling back to grep

If no codebase map is available, use Glob for file discovery and Grep for content search.
