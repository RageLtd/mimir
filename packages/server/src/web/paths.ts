const PUBLIC_PAGE_PATHS = new Set(["/", "/sign-in", "/sign-up"]);
const STATIC_ASSET_PREFIX = "/assets/";
const DEFAULT_RETURN_TO = "/app";

function hasControlCharacters(value: string) {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

export function isPublicWebPath(path: string) {
  return PUBLIC_PAGE_PATHS.has(path) || path.startsWith(STATIC_ASSET_PREFIX);
}

export function safeReturnTo(value: string | undefined) {
  if (
    !value?.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    hasControlCharacters(value)
  ) {
    return DEFAULT_RETURN_TO;
  }
  return value;
}

export function signInLocation(requestUrl: string) {
  const url = new URL(requestUrl);
  const returnTo = `${url.pathname}${url.search}`;
  return `/sign-in?${new URLSearchParams({ returnTo })}`;
}
