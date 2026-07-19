import { createHash } from "node:crypto";
import { attemptSync } from "../util/result";

export const MAX_INSTANCE_NAME_LENGTH = 80;
export const MAX_SUPPORT_URL_LENGTH = 500;
export const MAX_SYSTEM_PROMPT_LENGTH = 100_000;
export const MIN_OPERATOR_TOKEN_LENGTH = 32;
export const MAX_OPERATOR_TOKEN_LENGTH = 512;

const OPAQUE_ID = /^[A-Za-z0-9:_-]{1,200}$/;
const EMAIL = /^[^\s@]+@[^\s@]+$/;
const SLUG = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const TOKEN = /^[\x21-\x7e]+$/;

export function boundedId(value: string) {
  return OPAQUE_ID.test(value) ? value : null;
}

export function normalizeName(value: string) {
  const name = value.trim();
  return name.length > 0 && name.length <= MAX_INSTANCE_NAME_LENGTH
    ? name
    : null;
}

export function normalizeSupportUrl(value: string) {
  const candidate = value.trim();
  if (!candidate) return "";
  if (candidate.length > MAX_SUPPORT_URL_LENGTH) return null;
  const [error, url] = attemptSync(() => new URL(candidate));
  if (
    error ||
    !url ||
    url.username ||
    url.password ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && url.hostname === "localhost"))
  ) {
    return null;
  }
  return url.toString();
}

export function normalizeSystemPrompt(value: string) {
  return value.length > 0 && value.length <= MAX_SYSTEM_PROMPT_LENGTH
    ? value
    : null;
}

export function normalizeEmail(value: string) {
  const email = value.trim().toLowerCase();
  return email.length <= 320 && EMAIL.test(email) ? email : null;
}

export function normalizeSlug(value: string) {
  const slug = value.trim().toLowerCase();
  return slug.length >= 3 && slug.length <= 64 && SLUG.test(slug) ? slug : null;
}

export function validToken(value: string) {
  return (
    value.length >= MIN_OPERATOR_TOKEN_LENGTH &&
    value.length <= MAX_OPERATOR_TOKEN_LENGTH &&
    TOKEN.test(value)
  );
}

export function operatorTokenDigest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
