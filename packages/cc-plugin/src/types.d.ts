// Bun supports `import x from "./file.ext" with { type: "text" }` to embed
// text contents directly into the compiled binary. TypeScript doesn't know
// the resulting type by default, so we declare it for the template extensions
// we actually use.

declare module "*.template" {
  const text: string;
  export default text;
}

declare module "*.sh" {
  const text: string;
  export default text;
}
