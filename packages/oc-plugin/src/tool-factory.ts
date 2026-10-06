import type * as Tool from "@opencode/plugin/promise/tool";

type Field = {
  type: "string" | "number" | "integer" | "boolean" | "array";
  description?: string;
  enum?: readonly string[];
  items?: { type: "string" };
  optional?: boolean;
};
type Value<F extends Field> = F extends { enum: readonly (infer V)[] }
  ? V
  : F["type"] extends "string"
    ? string
    : F["type"] extends "boolean"
      ? boolean
      : F["type"] extends "array"
        ? string[]
        : number;
type Args<F extends Record<string, Field>> = {
  [K in keyof F as F[K] extends { optional: true } ? never : K]: Value<F[K]>;
} & {
  [K in keyof F as F[K] extends { optional: true } ? K : never]?: Value<F[K]>;
};

const valid = (value: unknown, field: Field) => {
  if (field.enum)
    return typeof value === "string" && field.enum.includes(value);
  switch (field.type) {
    case "string":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "array":
      return (
        Array.isArray(value) && value.every((item) => typeof item === "string")
      );
  }
};

/** Native JSON Schema tools for ctx.tool.transform; validate unknown protocol input
 * before invoking typed handlers, including direct calls outside OpenCode. */
export const tool = <const F extends Record<string, Field>>(definition: {
  description: string;
  args: F;
  execute: (args: Args<F>, context: Tool.ToolContext) => Promise<string>;
}) => {
  const fields = Object.entries(definition.args);
  return {
    description: definition.description,
    input: {
      type: "object",
      properties: Object.fromEntries(
        fields.map(([name, { optional: _, ...schema }]) => [name, schema]),
      ),
      required: fields
        .filter(([, field]) => !field.optional)
        .map(([name]) => name),
      additionalProperties: false,
    },
    async execute(input: unknown, context: Tool.ToolContext) {
      if (typeof input !== "object" || input === null || Array.isArray(input)) {
        throw new Error("Tool input must be an object.");
      }
      // Protocol boundary: checked against every declared field before the cast.
      const values = input as Record<string, unknown>;
      for (const key of Object.keys(values)) {
        if (!Object.hasOwn(definition.args, key))
          throw new Error(`Unknown tool argument: ${key}`);
      }
      for (const [name, field] of fields) {
        if (values[name] === undefined && field.optional) continue;
        if (!valid(values[name], field))
          throw new Error(`Invalid tool argument: ${name}`);
      }
      return { content: await definition.execute(values as Args<F>, context) };
    },
  } satisfies Omit<Tool.Info, "name">;
};
