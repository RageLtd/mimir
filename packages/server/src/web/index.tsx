import { Hono } from "hono";
import { compress } from "hono/compress";
import { PageFrame, pageRenderer } from "./chrome";

export const web = new Hono();

web.use("*", compress({ threshold: 0 }));
web.use("*", pageRenderer);

web.get("/", (c) =>
  c.render(
    <PageFrame actions={<a href="/app">Dashboard</a>}>
      <section class="hero" aria-labelledby="welcome-title">
        <p class="kicker">Persistent context</p>
        <h1 id="welcome-title">Your agents remember.</h1>
        <p class="lede">
          Mimir gives coding agents private, durable context across projects and
          editors—without surrendering your data to the operator.
        </p>
        <a class="button" href="/app">
          Open dashboard
        </a>
      </section>
    </PageFrame>,
    {
      title: "Mimir — Private agent memory",
      description:
        "Private, durable memory and project context for your coding agents.",
    },
  ),
);

web.get("/app", (c) =>
  c.render(
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
      <section aria-labelledby="dashboard-title">
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
  ),
);
