const baseUrl = process.argv[2] ?? Bun.env.AUTH_BASE_URL;
if (!baseUrl) {
  throw new Error("pass a public base URL or set AUTH_BASE_URL");
}

const url = new URL("/sign-in", baseUrl).href;
const processResult = Bun.spawn(
  [
    "curl",
    "--http2",
    "--silent",
    "--show-error",
    "--dump-header",
    "-",
    "--output",
    "/dev/null",
    "--header",
    "Accept-Encoding: br, zstd, gzip, deflate",
    "--write-out",
    "\nMIMIR_HTTP_VERSION:%{http_version}\n",
    url,
  ],
  { stdout: "pipe", stderr: "pipe" },
);
const [stdout, stderr, exitCode] = await Promise.all([
  new Response(processResult.stdout).text(),
  new Response(processResult.stderr).text(),
  processResult.exited,
]);
if (exitCode !== 0) {
  throw new Error(stderr.trim() || `curl exited ${exitCode}`);
}

const version = /MIMIR_HTTP_VERSION:([^\s]+)/.exec(stdout)?.[1] ?? "";
const major = Number.parseInt(version.split(".", 1)[0] ?? "", 10);
if (!Number.isFinite(major) || major < 2) {
  throw new Error(
    `public edge negotiated HTTP/${version || "unknown"}; require HTTP/2+`,
  );
}
if (!/^content-encoding:\s*br\s*$/im.test(stdout)) {
  throw new Error("public web response did not select Brotli");
}

process.stdout.write(
  `${JSON.stringify({ url, httpVersion: version, contentEncoding: "br" })}\n`,
);
