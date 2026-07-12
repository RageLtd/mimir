import type { Context } from "hono";
import type { IdentityEnv } from "../middleware/identity";
import { attempt } from "../util/result";

const FORM_CONTENT_TYPE = "application/x-www-form-urlencoded";
const MAX_FORM_BYTES = 16_384;

export const EMPTY_FORM = { get: () => null };

export function formValue(form: { get(name: string): unknown }, name: string) {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

export async function readForm(c: Context<IdentityEnv>) {
  const contentType = c.req.header("content-type")?.split(";", 1)[0]?.trim();
  const contentLength = Number(c.req.header("content-length") ?? "0");
  if (
    contentType !== FORM_CONTENT_TYPE ||
    (Number.isFinite(contentLength) && contentLength > MAX_FORM_BYTES)
  ) {
    return null;
  }
  const [error, form] = await attempt(() => c.req.raw.formData());
  return error ? null : form;
}

export function hasTrustedOrigin(
  c: Context<IdentityEnv>,
  options: { origin: string },
) {
  return c.req.header("origin") === options.origin;
}
