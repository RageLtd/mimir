import { Hono } from "hono";
import { compress } from "hono/compress";
import type { IdentityEnv } from "../middleware/identity";
import {
  type AuthFormOptions,
  createSignInAction,
  createSignUpAction,
  renderSignIn,
  renderSignUp,
} from "./auth-forms";
import { PageFrame, pageRenderer } from "./chrome";

interface WebOptions {
  authForms?: AuthFormOptions;
}

export function createWeb(options: WebOptions = {}) {
  const web = new Hono<IdentityEnv>();
  web.use("*", compress({ threshold: 0 }));
  web.use("*", pageRenderer);

  web.get("/sign-in", (c) => renderSignIn(c));
  web.get("/sign-up", (c) => renderSignUp(c));
  if (options.authForms) {
    web.post("/sign-in", createSignInAction(options.authForms));
    web.post("/sign-up", createSignUpAction(options.authForms));
  }

  web.get("/app", (c) => {
    const identity = c.get("identity");
    return c.render(
      <PageFrame
        actions={<a href="/">Home</a>}
        navigation={
          <nav aria-label="Dashboard">
            <a href="/app" aria-current="page">
              Overview
            </a>
          </nav>
        }
      >
        <section
          aria-labelledby="dashboard-title"
          data-user-id={identity?.userId}
          data-organization-id={identity?.orgId}
        >
          <p class="kicker">Workspace</p>
          <h1 id="dashboard-title">Dashboard</h1>
          <p class="lede">
            Your account, devices, and shared context will live here.
          </p>
          <div class="cards">
            <section class="card" aria-labelledby="account-card-title">
              <h2 id="account-card-title">Account</h2>
              <p>Manage your identity and active organization.</p>
            </section>
            <section class="card" aria-labelledby="memory-card-title">
              <h2 id="memory-card-title">Memory</h2>
              <p>Review the encrypted context available to your agents.</p>
            </section>
          </div>
        </section>
      </PageFrame>,
      {
        title: "Dashboard — Mimir",
        description: "Manage your Mimir account, devices, and agent context.",
      },
    );
  });

  return web;
}

export const web = createWeb();
