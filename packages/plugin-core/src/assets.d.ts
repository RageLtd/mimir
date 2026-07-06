// Bun supports `import x from "./file.ext" with { type: "text" }` to embed
// text contents directly into the compiled bundle. TypeScript doesn't know
// the resulting type by default, so we declare it once here for every asset
// extension the install flows text-import across cc-plugin / acp / oc-plugin.
//
// Shared from plugin-core and referenced by each package's tsconfig `include`
// so the set can't drift per-package again.

declare module "*.template" {
  const text: string;
  export default text;
}

declare module "*.md" {
  const text: string;
  export default text;
}

declare module "*.sh" {
  const text: string;
  export default text;
}
