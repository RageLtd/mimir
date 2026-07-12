import type { Context } from "hono";
import { SETUP_TOKEN_HEADER, SIGNIN_PATH, SIGNUP_PATH } from "../auth/paths";
import type { IdentityEnv } from "../middleware/identity";
import { attempt } from "../util/result";
import { PageFrame } from "./chrome";
import { EMPTY_FORM, formValue, hasTrustedOrigin, readForm } from "./forms";
import { safeReturnTo } from "./paths";

const MAX_NAME_LENGTH = 100;
const MAX_EMAIL_LENGTH = 320;
const MAX_PASSWORD_LENGTH = 1_024;
const MAX_SETUP_TOKEN_LENGTH = 1_024;
const GENERIC_ERROR =
  "We couldn't complete that request. Check your details and try again.";

export type AuthFormOptions = {
  origin: string;
  request: (path: string, init: RequestInit) => Response | Promise<Response>;
};

type AuthPageState = {
  email?: string;
  error?: boolean;
  returnTo?: string;
  status?: 400 | 401 | 403 | 502;
};

function validEmail(email: string) {
  return email.length > 0 && email.length <= MAX_EMAIL_LENGTH;
}

function validPassword(password: string) {
  return password.length >= 8 && password.length <= MAX_PASSWORD_LENGTH;
}

function errorStatus(status: number) {
  if (status === 401) return 401;
  if (status === 403) return 403;
  return 400;
}

async function submitToBetterAuth(
  c: Context<IdentityEnv>,
  options: AuthFormOptions,
  path: string,
  body: Record<string, string>,
  setupToken = "",
) {
  const headers = new Headers(c.req.raw.headers);
  headers.delete("content-length");
  headers.delete(SETUP_TOKEN_HEADER);
  headers.set("content-type", "application/json");
  if (setupToken) headers.set(SETUP_TOKEN_HEADER, setupToken);
  return options.request(path, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function redirectWithSession(response: Response, returnTo: string) {
  const cookies = response.headers.getSetCookie();
  if (!response.ok || cookies.length === 0) return null;
  const headers = new Headers({
    "cache-control": "private, no-store",
    location: returnTo,
  });
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(null, { status: 303, headers });
}

function AuthError() {
  return (
    <p class="form-error" id="auth-error" role="alert">
      {GENERIC_ERROR}
    </p>
  );
}

export function renderSignIn(
  c: Context<IdentityEnv>,
  state: AuthPageState = {},
) {
  const returnTo = safeReturnTo(state.returnTo ?? c.req.query("returnTo"));
  const signUpHref = `/sign-up?${new URLSearchParams({ returnTo })}`;
  c.header("cache-control", "private, no-store");
  c.status(state.status ?? 200);
  return c.render(
    <PageFrame actions={<a href={signUpHref}>Create account</a>}>
      <section class="hero" aria-labelledby="sign-in-title">
        <p class="kicker">Welcome back</p>
        <h1 id="sign-in-title">Sign in to Mimir.</h1>
        <p class="lede">Use your account to open the private dashboard.</p>
        {state.error ? <AuthError /> : null}
        <form class="auth-form" method="post" action="/sign-in">
          <input type="hidden" name="returnTo" value={returnTo} />
          <label for="sign-in-email">Email</label>
          <input
            id="sign-in-email"
            name="email"
            type="email"
            autocomplete="email"
            maxlength={MAX_EMAIL_LENGTH}
            value={state.email ?? ""}
            aria-invalid={state.error ? "true" : undefined}
            aria-describedby={state.error ? "auth-error" : undefined}
            required
          />
          <label for="sign-in-password">Password</label>
          <input
            id="sign-in-password"
            name="password"
            type="password"
            autocomplete="current-password"
            minlength={8}
            maxlength={MAX_PASSWORD_LENGTH}
            aria-invalid={state.error ? "true" : undefined}
            aria-describedby={state.error ? "auth-error" : undefined}
            required
          />
          <button class="button" type="submit">
            Sign in
          </button>
        </form>
      </section>
    </PageFrame>,
    {
      title: "Sign in — Mimir",
      description: "Sign in to your Mimir dashboard.",
    },
  );
}

export function renderSignUp(
  c: Context<IdentityEnv>,
  state: AuthPageState = {},
) {
  const returnTo = safeReturnTo(state.returnTo ?? c.req.query("returnTo"));
  const signInHref = `/sign-in?${new URLSearchParams({ returnTo })}`;
  c.header("cache-control", "private, no-store");
  c.status(state.status ?? 200);
  return c.render(
    <PageFrame actions={<a href={signInHref}>Sign in</a>}>
      <section class="hero" aria-labelledby="sign-up-title">
        <p class="kicker">Get started</p>
        <h1 id="sign-up-title">Create your account.</h1>
        <p class="lede">
          Join an invited organization or claim a new Mimir instance.
        </p>
        {state.error ? <AuthError /> : null}
        <form class="auth-form" method="post" action="/sign-up">
          <input type="hidden" name="returnTo" value={returnTo} />
          <label for="sign-up-name">Name</label>
          <input
            id="sign-up-name"
            name="name"
            autocomplete="name"
            maxlength={MAX_NAME_LENGTH}
            required
          />
          <label for="sign-up-email">Email</label>
          <input
            id="sign-up-email"
            name="email"
            type="email"
            autocomplete="email"
            maxlength={MAX_EMAIL_LENGTH}
            value={state.email ?? ""}
            aria-invalid={state.error ? "true" : undefined}
            aria-describedby={state.error ? "auth-error" : undefined}
            required
          />
          <label for="sign-up-password">Password</label>
          <input
            id="sign-up-password"
            name="password"
            type="password"
            autocomplete="new-password"
            minlength={8}
            maxlength={MAX_PASSWORD_LENGTH}
            aria-invalid={state.error ? "true" : undefined}
            aria-describedby={state.error ? "auth-error" : undefined}
            required
          />
          <label for="setup-token">
            Setup token <span>(first account only)</span>
          </label>
          <input
            id="setup-token"
            name="setupToken"
            type="password"
            autocomplete="off"
            maxlength={MAX_SETUP_TOKEN_LENGTH}
          />
          <button class="button" type="submit">
            Create account
          </button>
        </form>
      </section>
    </PageFrame>,
    {
      title: "Create account — Mimir",
      description: "Create a Mimir dashboard account.",
    },
  );
}

export const createSignInAction =
  (options: AuthFormOptions) => async (c: Context<IdentityEnv>) => {
    const form = await readForm(c);
    const values = form ?? EMPTY_FORM;
    const email = formValue(values, "email").trim();
    const password = formValue(values, "password");
    const returnTo = safeReturnTo(formValue(values, "returnTo"));
    if (!form || !validEmail(email) || !validPassword(password)) {
      return renderSignIn(c, { email, error: true, returnTo, status: 400 });
    }
    if (!hasTrustedOrigin(c, options)) {
      return renderSignIn(c, { email, error: true, returnTo, status: 403 });
    }

    const [error, response] = await attempt(() =>
      submitToBetterAuth(c, options, SIGNIN_PATH, { email, password }),
    );
    if (error || !response) {
      return renderSignIn(c, { email, error: true, returnTo, status: 502 });
    }
    const redirect = redirectWithSession(response, returnTo);
    if (redirect) return redirect;
    return renderSignIn(c, {
      email,
      error: true,
      returnTo,
      status: errorStatus(response.status),
    });
  };

export const createSignUpAction =
  (options: AuthFormOptions) => async (c: Context<IdentityEnv>) => {
    const form = await readForm(c);
    const values = form ?? EMPTY_FORM;
    const name = formValue(values, "name").trim();
    const email = formValue(values, "email").trim();
    const password = formValue(values, "password");
    const setupToken = formValue(values, "setupToken");
    const returnTo = safeReturnTo(formValue(values, "returnTo"));
    if (
      !form ||
      name.length === 0 ||
      name.length > MAX_NAME_LENGTH ||
      !validEmail(email) ||
      !validPassword(password) ||
      setupToken.length > MAX_SETUP_TOKEN_LENGTH
    ) {
      return renderSignUp(c, { email, error: true, returnTo, status: 400 });
    }
    if (!hasTrustedOrigin(c, options)) {
      return renderSignUp(c, { email, error: true, returnTo, status: 403 });
    }

    const [error, response] = await attempt(() =>
      submitToBetterAuth(
        c,
        options,
        SIGNUP_PATH,
        { name, email, password },
        setupToken,
      ),
    );
    if (error || !response) {
      return renderSignUp(c, { email, error: true, returnTo, status: 502 });
    }
    const redirect = redirectWithSession(response, returnTo);
    if (redirect) return redirect;
    return renderSignUp(c, {
      email,
      error: true,
      returnTo,
      status: errorStatus(response.status),
    });
  };
