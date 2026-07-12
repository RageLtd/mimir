type Keyset = {
  v: number;
  privateKey: string;
  publicKey: string;
};

type DeviceEnvelope = {
  v: 1;
  credentialId: string;
  salt: string;
  wrappedSecret: string;
};

type CredentialDependencies = {
  json: (path: string, init?: RequestInit) => Promise<unknown>;
  post: (path: string, body: unknown) => Promise<unknown>;
  toB64u: (value: ArrayBuffer | Uint8Array) => string;
  fromB64u: (value: string) => Uint8Array;
  generateKeyset: () => Promise<Keyset>;
  encryptKeyset: (secret: Uint8Array, keyset: Keyset) => Promise<string>;
  decryptKeyset: (secret: Uint8Array, encrypted: string) => Promise<Keyset>;
  wrapKeyring: (publicKey: string, keyring: unknown) => Promise<string>;
  unwrapKeyring: (keyset: Keyset, wrapped: string) => Promise<unknown>;
  registerPasskey: (
    name: string,
    salt: Uint8Array,
    requirePrf?: boolean,
  ) => Promise<{ credentialId: string; output: Uint8Array | null }>;
  authenticate: (credentialId: string, salt: Uint8Array) => Promise<Uint8Array>;
  wrapDeviceSecret: (prf: Uint8Array, secret: Uint8Array) => Promise<string>;
  unwrapDeviceSecret: (prf: Uint8Array, wrapped: string) => Promise<Uint8Array>;
};

export function registerCredentialElement(
  dependencies: CredentialDependencies,
) {
  class CredentialCeremony extends HTMLElement {
    #abort?: AbortController;
    #secret?: Uint8Array;

    connectedCallback() {
      this.#abort?.abort();
      this.#abort = new AbortController();
      this.addEventListener("click", (event) => this.#clicked(event), {
        signal: this.#abort.signal,
      });
    }

    disconnectedCallback() {
      this.#abort?.abort();
      this.#secret?.fill(0);
      this.#secret = undefined;
    }

    async #clicked(event: Event) {
      const button = event.target;
      if (!(button instanceof HTMLButtonElement) || !button.dataset.action)
        return;
      event.preventDefault();
      button.disabled = true;
      try {
        if (button.dataset.action === "register") await this.#registerOnly();
        if (button.dataset.action === "enroll") await this.#enroll();
        if (button.dataset.action === "unlock") await this.#unlock();
        if (button.dataset.action === "lock") this.#lock();
      } catch (error) {
        this.#status(
          error instanceof Error ? error.message : "The ceremony failed",
          true,
        );
      } finally {
        button.disabled = false;
      }
    }

    #status(message: string, error = false) {
      const status = this.querySelector("[role=status]");
      if (status) {
        status.textContent = message;
        status.classList.toggle("form-error", error);
      }
    }

    #storageKey() {
      return `mimir:device:${this.dataset.userId ?? "unknown"}`;
    }

    #name() {
      const input = this.querySelector('[name="passkeyName"]');
      return input instanceof HTMLInputElement && input.value.trim()
        ? input.value.trim()
        : "Browser device";
    }

    async #registerOnly() {
      this.#status("Waiting for your authenticator…");
      await dependencies.registerPasskey(
        this.#name(),
        crypto.getRandomValues(new Uint8Array(32)),
      );
      this.#status("Passkey registered. Refresh to see it in the list.");
    }

    #lock() {
      this.#secret?.fill(0);
      this.#secret = undefined;
      const output = this.querySelector("[data-device-secret]");
      if (output) output.textContent = "";
      this.#status("Browser locked; plaintext key material was cleared.");
    }

    async #enroll() {
      this.#status("Preparing this browser…");
      const state: unknown = await dependencies.json("/v1/keys/org");
      if (typeof state !== "object" || state === null)
        throw new Error("Key state is malformed");
      const self = Reflect.get(state, "self");
      const encrypted =
        typeof self === "object" && self
          ? Reflect.get(self, "encryptedKeyset")
          : null;
      let secret: Uint8Array;
      let keyset: Keyset;
      let encryptedKeyset = typeof encrypted === "string" ? encrypted : "";
      if (typeof encrypted === "string") {
        const input = this.querySelector('[name="deviceSecret"]');
        if (!(input instanceof HTMLInputElement) || !input.value.trim()) {
          throw new Error(
            "Paste the device secret saved during first enrollment",
          );
        }
        secret = dependencies.fromB64u(input.value.trim());
        keyset = await dependencies.decryptKeyset(secret, encrypted);
        input.value = "";
      } else {
        secret = crypto.getRandomValues(new Uint8Array(32));
        keyset = await dependencies.generateKeyset();
        encryptedKeyset = await dependencies.encryptKeyset(secret, keyset);
      }
      const salt = crypto.getRandomValues(new Uint8Array(32));
      const registered = await dependencies.registerPasskey(
        this.#name(),
        salt,
        true,
      );
      if (!registered.output)
        throw new Error("WebAuthn PRF produced no secret");
      if (typeof encrypted !== "string") {
        await dependencies.post("/api/auth/update-user", {
          publicKey: keyset.publicKey,
          encryptedKeyset,
        });
      }
      await dependencies.decryptKeyset(secret, encryptedKeyset);
      const envelope: DeviceEnvelope = {
        v: 1,
        credentialId: registered.credentialId,
        salt: dependencies.toB64u(salt),
        wrappedSecret: await dependencies.wrapDeviceSecret(
          registered.output,
          secret,
        ),
      };
      localStorage.setItem(this.#storageKey(), JSON.stringify(envelope));
      this.#secret = secret;
      const output = this.querySelector("[data-device-secret]");
      if (output) output.textContent = dependencies.toB64u(secret);
      if (Reflect.get(state, "initialized") !== true) {
        const keyring = {
          v: 1,
          keys: {
            "1": dependencies.toB64u(
              crypto.getRandomValues(new Uint8Array(32)),
            ),
          },
        };
        await dependencies.post("/v1/keys/init", {
          wrappedOrgKey: await dependencies.wrapKeyring(
            keyset.publicKey,
            keyring,
          ),
        });
      }
      this.#status(
        "Browser enrolled and locally verified. Save the displayed device secret in your password manager.",
      );
    }

    async #unlock() {
      const stored = localStorage.getItem(this.#storageKey());
      if (!stored) throw new Error("Enroll this browser before unlocking it");
      const parsed: unknown = JSON.parse(stored);
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Reflect.get(parsed, "v") !== 1 ||
        typeof Reflect.get(parsed, "credentialId") !== "string" ||
        typeof Reflect.get(parsed, "salt") !== "string" ||
        typeof Reflect.get(parsed, "wrappedSecret") !== "string"
      ) {
        throw new Error("Stored browser enrollment is unsupported");
      }
      const envelope = {
        v: 1,
        credentialId: Reflect.get(parsed, "credentialId") as string,
        salt: Reflect.get(parsed, "salt") as string,
        wrappedSecret: Reflect.get(parsed, "wrappedSecret") as string,
      } satisfies DeviceEnvelope;
      this.#status("Waiting for your passkey…");
      const prf = await dependencies.authenticate(
        envelope.credentialId,
        dependencies.fromB64u(envelope.salt),
      );
      const secret = await dependencies.unwrapDeviceSecret(
        prf,
        envelope.wrappedSecret,
      );
      const state: unknown = await dependencies.json("/v1/keys/org");
      if (typeof state !== "object" || state === null)
        throw new Error("Key state is malformed");
      const self = Reflect.get(state, "self");
      const encrypted =
        typeof self === "object" && self
          ? Reflect.get(self, "encryptedKeyset")
          : null;
      if (typeof encrypted !== "string")
        throw new Error("No encrypted keyset is registered");
      const keyset = await dependencies.decryptKeyset(secret, encrypted);
      const wrapped =
        typeof self === "object" && self
          ? Reflect.get(self, "wrappedOrgKey")
          : null;
      if (typeof wrapped !== "string") {
        this.#status(
          "Device unlocked. Organization access is waiting for another member to deliver a wrap.",
        );
        return;
      }
      await dependencies.unwrapKeyring(keyset, wrapped);
      this.#secret?.fill(0);
      this.#secret = secret;
      this.#status(
        `Device unlocked locally for organization key generation ${Reflect.get(state, "keyGeneration") ?? "unknown"}.`,
      );
    }
  }

  if (!customElements.get("mimir-credential-ceremony")) {
    customElements.define("mimir-credential-ceremony", CredentialCeremony);
  }
}
