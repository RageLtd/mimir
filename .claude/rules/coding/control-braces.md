---
paths: ["*.c", "*.cc", "*.cpp", "*.cxx", "*.h", "*.hh", "*.hpp", "*.hxx", "*.inl", "*.ipp", "*.ixx", "*.cppm", "*.m", "*.mm"]
tools: ["Edit", "Write", "MultiEdit"]
---
# Control Blocks Require Braces

No control block (`if`, `for`, `while`, `do`, `switch`) may omit its braces, even when its body contains only one statement.

```cpp
// Good.
if (slot >= kMaxEntities) { return; }

for (int32_t i = 0; i < n; ++i) { work(i); }

// Bad.
if (slot >= kMaxEntities) return;
for (int32_t i = 0; i < n; ++i) work(i);
```

This rule is scoped to the C family (C, C++, Objective-C). It does not apply to TypeScript, Rust, or Go, where a brace-less early return is idiomatic.
