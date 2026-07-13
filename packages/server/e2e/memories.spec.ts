import { expect, test } from "@playwright/test";

const MEMORY = "Playwright private canary alpha";
const UPDATED_MEMORY = "Playwright private canary beta";

test("enrolls, unlocks, manages, and fails closed on encrypted memories", async ({
  context,
  page,
}) => {
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable", { enableUI: false });
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      ctap2Version: "ctap2_1",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      hasPrf: true,
      automaticPresenceSimulation: true,
      isUserVerified: true,
    },
  });

  const syncRequests: Array<{ url: string; body: string }> = [];
  page.on("request", (request) => {
    if (!request.url().includes("/v1/sync/")) return;
    syncRequests.push({ url: request.url(), body: request.postData() ?? "" });
  });

  await page.goto("/sign-up");
  await page.getByLabel("Name").fill("Playwright User");
  await page.getByLabel("Email").fill("playwright@example.com");
  await page.getByLabel("Password").fill("playwright-password-123");
  await page.getByLabel(/Setup token/).fill("mimir-playwright-setup");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/app$/);

  await page.goto("/app/credentials");
  await page.getByRole("button", { name: "Enroll browser" }).click();
  await expect(page.locator("p[role=status]")).toContainText(
    "Browser enrolled and locally verified",
  );
  await expect(page.locator("[data-device-secret]")).not.toBeEmpty();

  await page.goto("/app/memories");
  await expect(page.locator("mimir-memory-manager")).toBeVisible();
  await expect(page.locator("body")).not.toContainText(MEMORY);
  await page.getByRole("button", { name: "Unlock memories" }).click();
  await expect(page.locator("p[role=status]")).toContainText(
    "Synchronized 0 memories locally",
  );

  const create = page.locator('[data-form="create"]');
  await create.getByLabel("Memory").fill(MEMORY);
  await create.getByLabel("Project ID").fill("project-playwright");
  await create.getByRole("button", { name: "Encrypt & save" }).click();
  await expect(page.locator("p[role=status]")).toContainText(
    "Memory encrypted and synchronized",
  );
  await expect(page.locator(".memory-item")).toContainText(MEMORY);

  const requestsBeforeSearch = syncRequests.length;
  await page.getByLabel("Search plaintext locally").fill("alpha");
  await expect(page.locator(".memory-item")).toHaveCount(1);
  await page.getByLabel("Search plaintext locally").fill("missing phrase");
  await expect(page.locator(".memory-item")).toHaveCount(0);
  await page.getByLabel("Search plaintext locally").fill("");
  expect(syncRequests).toHaveLength(requestsBeforeSearch);

  const item = page.locator(".memory-item");
  await item.getByText("Edit locally").click();
  const requestsBeforeDraft = syncRequests.length;
  await item.getByLabel("Memory").fill(UPDATED_MEMORY);
  expect(syncRequests).toHaveLength(requestsBeforeDraft);
  await item.getByRole("button", { name: "Encrypt & save" }).click();
  await expect(page.locator(".memory-item")).toContainText(UPDATED_MEMORY);

  const rawSync = await page.evaluate(() =>
    fetch("/v1/sync/pull?since=0").then((response) => response.text()),
  );
  expect(rawSync).not.toContain(MEMORY);
  expect(rawSync).not.toContain(UPDATED_MEMORY);

  for (const request of syncRequests) {
    expect(request.url).not.toContain(MEMORY);
    expect(request.url).not.toContain(UPDATED_MEMORY);
    expect(request.body).not.toContain(MEMORY);
    expect(request.body).not.toContain(UPDATED_MEMORY);
  }
  const stored = await page.evaluate(() => JSON.stringify(localStorage));
  expect(stored).not.toContain(MEMORY);
  expect(stored).not.toContain(UPDATED_MEMORY);

  await page.getByRole("button", { name: "Lock" }).click();
  await expect(page.locator("body")).not.toContainText(UPDATED_MEMORY);
  await expect(page.locator("[data-unlocked]")).toBeHidden();

  await page.getByRole("button", { name: "Unlock memories" }).click();
  await expect(page.locator(".memory-item")).toContainText(UPDATED_MEMORY);
  await page.goto("/app");
  await page.goBack();
  await expect(page.locator("[data-unlocked]")).toBeHidden();
  await expect(page.locator("body")).not.toContainText(UPDATED_MEMORY);

  await page.route("**/v1/sync/pull?**", async (route) => {
    const response = await route.fetch();
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null) {
      await route.fulfill({ response });
      return;
    }
    const envelopes = Reflect.get(body, "envelopes");
    if (Array.isArray(envelopes) && envelopes[0]) {
      const first = envelopes[0];
      if (typeof first === "object" && first !== null) {
        const payload = Reflect.get(first, "payload");
        if (typeof payload === "string" && payload.length > 0) {
          Reflect.set(
            first,
            "payload",
            `${payload.slice(0, -1)}${payload.endsWith("A") ? "B" : "A"}`,
          );
        }
      }
    }
    await route.fulfill({ response, json: body });
  });
  await page.getByRole("button", { name: "Unlock memories" }).click();
  await expect(page.locator("p[role=status]")).toContainText(
    "encrypted records failed validation; browser locked",
  );
  await expect(page.locator("[data-unlocked]")).toBeHidden();
  await expect(page.locator("body")).not.toContainText(UPDATED_MEMORY);
  await page.unroute("**/v1/sync/pull?**");

  await page.getByRole("button", { name: "Unlock memories" }).click();
  await expect(page.locator(".memory-item")).toContainText(UPDATED_MEMORY);
  await page.locator(".memory-item").getByText("Delete memory").click();
  await page
    .locator(".memory-item")
    .getByRole("button", { name: "Confirm encrypted deletion" })
    .click();
  await expect(page.locator("p[role=status]")).toContainText(
    "Memory tombstone synchronized",
  );
  await expect(page.locator(".memory-item")).toHaveCount(0);
});
