// Bun supports `import x from "./file.ext" with { type: "text" }` to embed
// text contents directly into the compiled binary. TypeScript doesn't know
// the resulting type by default, so we declare it for the template extensions
// shared across all Mimir adapters.
//
// Each consumer's tsconfig includes this file via its `include` array so
// the ambient module declarations register globally. This is how the
// install templates (CC's mcp.json.template, future OC's opencode.json
// .template) get a clean string type instead of `unknown`.

declare module "*.template" {
  const text: string;
  export default text;
}

declare module "*.sh" {
  const text: string;
  export default text;
}
