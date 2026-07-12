// biome-ignore-all lint/style/useConsistentTypeDefinitions lint/style/useShorthandFunctionType: Hono's renderer contract requires declaration merging.
import type { Child } from "hono/jsx";
import { jsxRenderer } from "hono/jsx-renderer";

type PageMetadata = {
  title: string;
  description: string;
};

declare module "hono" {
  interface ContextRenderer {
    (content: string | Promise<string>, metadata: PageMetadata): Response;
  }
}

const STYLES = `
:root{color-scheme:light dark;--bg:#f5f6f3;--surface:#fff;--text:#171a1f;--muted:#626b78;--line:#d7dcd3;--accent:#5946d2;--accent-text:#fff;--danger:#a12525;--max:72rem}
@media(prefers-color-scheme:dark){:root{--bg:#0e1116;--surface:#171b22;--text:#f3f4f6;--muted:#aab1bd;--line:#303642;--accent:#a293ff;--accent-text:#101217}}
*{box-sizing:border-box}html{font:100%/1.5 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:var(--bg);color:var(--text)}body{margin:0;min-height:100vh}a{color:inherit;text-underline-offset:.2em}a:hover{text-decoration-thickness:.14em}:focus-visible{outline:.18rem solid var(--accent);outline-offset:.2rem}.skip{position:absolute;left:.75rem;top:-4rem;z-index:2;padding:.5rem .75rem;background:var(--text);color:var(--bg)}.skip:focus{top:.75rem}.site-head{border-bottom:1px solid var(--line);background:var(--surface)}.head-inner,.page-foot{max-width:var(--max);margin:auto;padding:1rem 1.25rem;display:flex;align-items:center;justify-content:space-between;gap:1rem}.brand{font-weight:800;letter-spacing:-.04em;text-decoration:none}.head-nav{display:flex;gap:1rem;font-size:.9rem}.frame{max-width:var(--max);margin:auto;padding:2rem 1.25rem}.public-frame{min-height:calc(100vh - 8rem);display:grid;place-items:center}.hero{max-width:44rem}.kicker{margin:0 0 .5rem;color:var(--accent);font-weight:700;font-size:.8rem;letter-spacing:.08em;text-transform:uppercase}h1{max-width:18ch;margin:0;font-size:clamp(2.25rem,8vw,4.75rem);line-height:1;letter-spacing:-.055em}h2{margin:.1rem 0 .5rem;font-size:1rem}.lede{max-width:58ch;margin:1.25rem 0;color:var(--muted);font-size:1.1rem}.button{display:inline-block;padding:.65rem 1rem;border:0;border-radius:.45rem;background:var(--accent);color:var(--accent-text);font:inherit;font-weight:700;text-decoration:none;cursor:pointer}.auth-form{display:grid;gap:.45rem;max-width:28rem}.auth-form label{margin-top:.45rem;font-weight:700}.auth-form label span{color:var(--muted);font-weight:400}.auth-form input{width:100%;padding:.6rem .7rem;border:1px solid var(--line);border-radius:.35rem;background:var(--surface);color:var(--text);font:inherit}.auth-form .button{margin-top:.75rem}.form-error{max-width:28rem;padding:.65rem;border-left:.25rem solid var(--danger);background:var(--surface)}.app-frame{display:grid;gap:1.5rem}.side{border-bottom:1px solid var(--line);padding-bottom:1rem}.side nav{display:flex;gap:.5rem;overflow:auto}.side a{padding:.4rem .65rem;border-radius:.35rem;text-decoration:none;white-space:nowrap}.side a[aria-current=page]{background:var(--surface);font-weight:700}.content h1{font-size:clamp(2rem,6vw,3.5rem)}.cards{display:grid;gap:1rem;margin-top:2rem}.card{padding:1rem;border:1px solid var(--line);border-radius:.6rem;background:var(--surface)}.card p{margin:0;color:var(--muted)}.page-foot{border-top:1px solid var(--line);color:var(--muted);font-size:.8rem}@media(min-width:48rem){.app-frame{grid-template-columns:12rem 1fr;padding-top:3rem}.side{border:0;border-right:1px solid var(--line);padding:0 1.5rem 0 0}.side nav{display:grid}.cards{grid-template-columns:repeat(2,minmax(0,1fr))}}
`;

export const pageRenderer = jsxRenderer(({ children, title, description }) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <meta name="description" content={description} />
      <meta name="color-scheme" content="light dark" />
      <title>{title}</title>
      <style>{STYLES}</style>
    </head>
    <body>{children}</body>
  </html>
));

interface PageFrameProps {
  actions: Child;
  children: Child;
  navigation?: Child;
}

export function PageFrame(props: PageFrameProps) {
  return (
    <>
      <a class="skip" href="#main">
        Skip to content
      </a>
      <header class="site-head">
        <div class="head-inner">
          <a class="brand" href="/">
            Mimir
          </a>
          <nav class="head-nav" aria-label="Account">
            {props.actions}
          </nav>
        </div>
      </header>
      <div class={`frame ${props.navigation ? "app-frame" : "public-frame"}`}>
        {props.navigation ? (
          <aside class="side">{props.navigation}</aside>
        ) : null}
        <main id="main" class="content">
          {props.children}
        </main>
      </div>
      <footer class="page-foot">
        <small>Private by design.</small>
      </footer>
    </>
  );
}
