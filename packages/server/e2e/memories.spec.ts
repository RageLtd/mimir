import { type BrowserContext, expect, type Page, test } from "@playwright/test";

const MEMORY = "Playwright private canary alpha";
const UPDATED_MEMORY = "Playwright private canary beta";
const ADMIN_MEMORY_A = "Playwright admin memory first";
const ADMIN_MEMORY_B = "Playwright admin memory second";
const ADMIN_UPDATED_MEMORY = "Playwright admin memory revised";
const OWNER_EMAIL = "playwright@example.com";
const MEMBER_EMAIL = "playwright-member@example.com";

async function enableVirtualAuthenticator(context: BrowserContext, page: Page) {
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
}

async function tamperMemoryPull(page: Page) {
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
            `${payload.startsWith("A") ? "B" : "A"}${payload.slice(1)}`,
          );
        }
      }
    }
    await route.fulfill({ response, json: body });
  });
}

test("manages encrypted memories and rotation-backed member access", async ({
  browser,
  context,
  page,
}) => {
  await enableVirtualAuthenticator(context, page);

  const syncRequests: Array<{ url: string; body: string }> = [];
  const passkeySignIns: string[] = [];
  page.on("request", (request) => {
    if (
      request.url().includes("/passkey/generate-authenticate-options") ||
      request.url().includes("/passkey/verify-authentication")
    ) {
      passkeySignIns.push(request.url());
    }
    if (
      !request.url().includes("/v1/sync/") &&
      !request.url().includes("/admin/memories/maintenance")
    ) {
      return;
    }
    syncRequests.push({ url: request.url(), body: request.postData() ?? "" });
  });

  await page.goto("/sign-up");
  await page.getByLabel("Name").fill("Playwright User");
  await page.getByLabel("Email").fill(OWNER_EMAIL);
  await page.getByLabel("Password").fill("playwright-password-123");
  await page.getByLabel(/Setup token/).fill("mimir-playwright-setup");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/app$/);

  const ownerNavigation = page.getByRole("navigation", { name: "Dashboard" });
  await expect(
    ownerNavigation.getByRole("link", { name: "Account" }),
  ).toHaveAttribute("aria-current", "page");
  await expect(
    ownerNavigation.getByRole("link", { name: "Credentials" }),
  ).toBeVisible();
  await expect(
    ownerNavigation.getByRole("link", { name: "Memories" }),
  ).toBeVisible();
  await expect(
    ownerNavigation.getByText("Organization", { exact: true }),
  ).toHaveCount(1);
  await expect(
    ownerNavigation.getByText("Server operation", { exact: true }),
  ).toHaveCount(1);

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

  await tamperMemoryPull(page);
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
  expect(passkeySignIns).toHaveLength(0);

  for (const content of [ADMIN_MEMORY_A, ADMIN_MEMORY_B]) {
    await create.getByLabel("Memory").fill(content);
    await create.getByLabel("Project ID").fill("project-admin");
    await create.getByRole("button", { name: "Encrypt & save" }).click();
    await expect(page.locator("p[role=status]")).toContainText(
      "Memory encrypted and synchronized",
    );
  }

  await page.goto("/admin/memories");
  await expect(page.locator("mimir-admin-memory-manager")).toBeVisible();
  await expect(page.locator("body")).not.toContainText(ADMIN_MEMORY_A);
  await page
    .getByRole("button", { name: "Unlock organization memories" })
    .click();
  await expect(page.locator("p[role=status]")).toContainText(
    "Synchronized 2 decrypted records locally",
  );
  await expect(page.locator(".memory-item")).toHaveCount(2);

  const requestsBeforeAdminSearch = syncRequests.length;
  await page.getByLabel("Search").fill("first");
  await expect(page.locator(".memory-item")).toHaveCount(1);
  await page.getByLabel("Search").fill("");
  expect(syncRequests).toHaveLength(requestsBeforeAdminSearch);

  await page.getByRole("button", { name: "Lock" }).click();
  await tamperMemoryPull(page);
  await page
    .getByRole("button", { name: "Unlock organization memories" })
    .click();
  await expect(page.locator("p[role=status]")).toContainText(
    "Encrypted memory validation failed; browser locked",
  );
  await expect(page.locator("[data-unlocked]")).toBeHidden();
  await expect(page.locator("body")).not.toContainText(ADMIN_MEMORY_A);
  await page.unroute("**/v1/sync/pull?**");

  await page
    .getByRole("button", { name: "Unlock organization memories" })
    .click();
  const adminItem = page
    .locator(".memory-item")
    .filter({ hasText: ADMIN_MEMORY_A });
  await adminItem.getByText("Edit locally").click();
  const requestsBeforeAdminDraft = syncRequests.length;
  await adminItem
    .getByLabel("Memory", { exact: true })
    .fill(ADMIN_UPDATED_MEMORY);
  expect(syncRequests).toHaveLength(requestsBeforeAdminDraft);
  await adminItem.getByRole("button", { name: "Encrypt & save" }).click();
  await expect(page.locator("p[role=status]")).toContainText(
    "Memory edit encrypted, synchronized, and audited",
  );
  await expect(
    page.locator(".memory-item").filter({ hasText: ADMIN_UPDATED_MEMORY }),
  ).toHaveCount(1);

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export encrypted backup" }).click();
  const download = await downloadPromise;
  const downloadPath = await download.path();
  if (!downloadPath) throw new Error("Encrypted backup was not downloaded");
  const backupStream = await download.createReadStream();
  let backup = "";
  for await (const chunk of backupStream) backup += chunk.toString();
  expect(backup).toContain('"payload"');
  expect(backup).not.toContain(ADMIN_UPDATED_MEMORY);
  expect(backup).not.toContain(ADMIN_MEMORY_B);

  const selection = page.locator("[data-select-id]");
  await selection.nth(0).check();
  await selection.nth(1).check();
  const requestsBeforeBulk = syncRequests.length;
  await page.getByLabel("Confirmation count").fill("1");
  await page
    .getByRole("button", { name: "Create selected tombstones" })
    .click();
  await expect(page.locator("p[role=status]")).toContainText(
    "Confirmation count must exactly match the selection",
  );
  expect(syncRequests).toHaveLength(requestsBeforeBulk);
  await page.getByLabel("Confirmation count").fill("2");
  await page
    .getByRole("button", { name: "Create selected tombstones" })
    .click();
  await expect(page.locator("p[role=status]")).toContainText(
    "2 authenticated tombstones synchronized and audited",
  );
  await expect(page.locator(".memory-item")).toHaveCount(0);

  for (const request of syncRequests) {
    for (const plaintext of [
      MEMORY,
      UPDATED_MEMORY,
      ADMIN_MEMORY_A,
      ADMIN_MEMORY_B,
      ADMIN_UPDATED_MEMORY,
    ]) {
      expect(request.url).not.toContain(plaintext);
      expect(request.body).not.toContain(plaintext);
    }
  }

  await page.goto("/admin/members");
  const inviteCard = page.locator("section.card").filter({
    has: page.getByRole("heading", { name: "Invite a member" }),
  });
  await inviteCard.getByLabel("Email").fill(MEMBER_EMAIL);
  await inviteCard.getByLabel("Role").selectOption("member");
  await inviteCard.getByRole("button", { name: "Create invitation" }).click();
  await expect(page).toHaveURL(/\/admin\/members\?notice=invited$/);
  await expect(page.locator("body")).toContainText(MEMBER_EMAIL);

  const keyMaterial = await page.evaluate(async () => {
    const state: unknown = await fetch("/v1/keys/org").then((response) =>
      response.json(),
    );
    if (typeof state !== "object" || state === null) return [];
    const self = Reflect.get(state, "self");
    const members = Reflect.get(state, "members");
    return [
      Reflect.get(state, "recoveryPublicKey"),
      Reflect.get(state, "wrappedRecoveryKey"),
      typeof self === "object" && self ? Reflect.get(self, "publicKey") : null,
      typeof self === "object" && self
        ? Reflect.get(self, "encryptedKeyset")
        : null,
      typeof self === "object" && self
        ? Reflect.get(self, "wrappedOrgKey")
        : null,
      ...(Array.isArray(members)
        ? members.map((member) =>
            typeof member === "object" && member
              ? Reflect.get(member, "publicKey")
              : null,
          )
        : []),
    ].flatMap((value) => (typeof value === "string" && value ? [value] : []));
  });
  const memberDirectoryHtml = await page.content();
  for (const value of keyMaterial) {
    expect(memberDirectoryHtml).not.toContain(value);
  }

  const origin = new URL(page.url()).origin;
  const memberContext = await browser.newContext({ baseURL: origin });
  const memberPage = await memberContext.newPage();
  await enableVirtualAuthenticator(memberContext, memberPage);

  await memberPage.goto("/sign-up");
  await memberPage.getByLabel("Name").fill("Playwright Member");
  await memberPage.getByLabel("Email").fill(MEMBER_EMAIL);
  await memberPage
    .getByLabel("Password")
    .fill("playwright-member-password-123");
  await memberPage.getByRole("button", { name: "Create account" }).click();
  await expect(memberPage).toHaveURL(/\/app$/);

  const memberNavigation = memberPage.getByRole("navigation", {
    name: "Dashboard",
  });
  await expect(
    memberNavigation.getByRole("link", { name: "Account" }),
  ).toBeVisible();
  await expect(
    memberNavigation.getByRole("link", { name: "Credentials" }),
  ).toBeVisible();
  await expect(
    memberNavigation.getByRole("link", { name: "Memories" }),
  ).toBeVisible();
  await expect(
    memberNavigation.getByText("Organization", { exact: true }),
  ).toHaveCount(0);
  await expect(
    memberNavigation.getByText("Server operation", { exact: true }),
  ).toHaveCount(0);

  await memberPage.goto("/app/credentials");
  await memberPage.getByRole("button", { name: "Enroll browser" }).click();
  await expect(memberPage.locator("p[role=status]")).toContainText(
    "Browser enrolled and locally verified",
  );

  await page.goto("/admin/members");
  const activeMember = page
    .locator('[aria-labelledby="active-members-title"] .item')
    .filter({ hasText: MEMBER_EMAIL });
  await expect(activeMember).toContainText("Pending key access");
  await page
    .getByRole("button", { name: "Provision pending key access" })
    .click();
  await expect(activeMember).toContainText("Key access available");

  await memberPage.reload();
  await memberPage.getByRole("button", { name: "Unlock", exact: true }).click();
  await expect(memberPage.locator("p[role=status]")).toContainText(
    "organization key generation 1",
  );

  const memberAdminPage = await memberPage.goto("/admin/memories");
  expect(memberAdminPage?.status()).toBe(403);

  await activeMember.getByLabel("Role").selectOption("admin");
  await activeMember.getByRole("button", { name: "Change role" }).click();
  await expect(page).toHaveURL(/\/admin\/members\?notice=role$/);
  await expect(activeMember).toContainText("admin");

  const promotedAdminPage = await memberPage.goto("/admin/memories");
  expect(promotedAdminPage?.status()).toBe(200);
  await expect(
    memberPage
      .getByRole("navigation", { name: "Dashboard" })
      .getByText("Organization", { exact: true }),
  ).toHaveCount(1);
  await expect(
    memberPage
      .getByRole("navigation", { name: "Dashboard" })
      .getByText("Server operation", { exact: true }),
  ).toHaveCount(0);

  await page.goto("/admin/members");
  const successor = page
    .locator('[aria-labelledby="active-members-title"] .item')
    .filter({ hasText: MEMBER_EMAIL });
  await successor.getByLabel("Role").selectOption("owner");
  await successor.getByRole("button", { name: "Change role" }).click();
  await expect(page).toHaveURL(/\/admin\/members\?notice=role$/);
  await expect(successor).toContainText("owner");

  await memberPage.goto("/admin/settings");
  const organizationName = await memberPage
    .getByLabel("Display name")
    .inputValue();
  await expect(memberPage.locator("body")).toContainText(
    "Recovery keys cannot restore ciphertext after the server purge",
  );
  await memberPage.getByLabel(/Type .* to confirm/).fill(organizationName);
  await memberPage
    .getByRole("button", { name: "Schedule organization deletion" })
    .click();
  await expect(memberPage).toHaveURL(
    /\/admin\/settings\?notice=deletion-scheduled$/,
  );
  await memberPage
    .getByRole("button", { name: "Cancel organization deletion" })
    .click();
  await expect(memberPage).toHaveURL(
    /\/admin\/settings\?notice=deletion-cancelled$/,
  );

  await page.goto("/admin/members");
  const departingOwner = page
    .locator('[aria-labelledby="active-members-title"] .item')
    .filter({ hasText: OWNER_EMAIL });
  await departingOwner.getByText("Leave organization").click();
  await departingOwner
    .getByRole("button", { name: "Confirm rotation-backed departure" })
    .click();
  await expect(page).toHaveURL(/\/admin\/members\?notice=removed$/);
  await expect(page.locator("body")).toHaveText("Forbidden");

  const successorApp = await memberPage.goto("/app");
  expect(successorApp?.status()).toBe(200);
  const successorAdmin = await memberPage.goto("/admin/memories");
  expect(successorAdmin?.status()).toBe(200);
  expect(
    await memberPage.evaluate(() =>
      fetch("/v1/keys/org").then((response) => response.status),
    ),
  ).toBe(200);

  await memberPage.goto("/admin/activity");
  await expect(memberPage.locator("body")).not.toContainText(MEMBER_EMAIL);
  await expect(memberPage.locator("body")).toContainText(
    "encryption.generation_changed",
  );
  await expect(memberPage.locator("body")).toContainText(
    "organization.ownership_changed",
  );
  await expect(memberPage.locator("body")).toContainText("memory.maintenance");
  await expect(memberPage.locator("body")).not.toContainText(
    ADMIN_UPDATED_MEMORY,
  );
  await memberContext.close();
});
