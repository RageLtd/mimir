import { Hono } from "hono";
import { compress } from "hono/compress";
import type { IdentityEnv } from "../middleware/identity";
import { PageFrame, pageRenderer } from "./chrome";
import { safeReturnTo } from "./paths";

export const web = new Hono<IdentityEnv>();

web.use("*", compress({ threshold: 0 }));
web.use("*", pageRenderer);

web.get("/sign-in", (c) => {
  const returnTo = safeReturnTo(c.req.query("returnTo"));
  const signUpHref = `/sign-up?${new URLSearchParams({ returnTo })}`;
  return c.render(
    <PageFrame actions={<a href={signUpHref}>Create account</a>}>
      <section class="hero" aria-labelledby="sign-in-title">
        <p class="kicker">Welcome back</p>
        <h1 id="sign-in-title">Sign in to Mimir.</h1>
        <p class="lede">
          Your private agent memory and project context are waiting. Sign-in
          controls arrive in the next dashboard slice.
        </p>
        <a class="button" href={signUpHref}>
          Create account
        </a>
      </section>
    </PageFrame>,
    {
      title: "Sign in — Mimir",
      description: "Sign in to your Mimir dashboard.",
    },
  );
});

web.get("/sign-up", (c) => {
  const returnTo = safeReturnTo(c.req.query("returnTo"));
  const signInHref = `/sign-in?${new URLSearchParams({ returnTo })}`;
  return c.render(
    <PageFrame actions={<a href={signInHref}>Sign in</a>}>
      <section class="hero" aria-labelledby="sign-up-title">
        <p class="kicker">Get started</p>
        <h1 id="sign-up-title">Create your account.</h1>
        <p class="lede">
          Join an invited organization or claim a new Mimir instance. Account
          controls arrive in the next dashboard slice.
        </p>
        <a class="button" href={signInHref}>
          Sign in instead
        </a>
      </section>
    </PageFrame>,
    {
      title: "Create account — Mimir",
      description: "Create a Mimir dashboard account.",
    },
  );
});

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
