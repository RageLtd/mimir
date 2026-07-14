type Keyset = {
  v: number;
  privateKey: string;
  publicKey: string;
};

type MemberDependencies = {
  json: (path: string, init?: RequestInit) => Promise<unknown>;
  post: (path: string, body: unknown) => Promise<unknown>;
  fromB64u: (value: string) => Uint8Array;
  toB64u: (value: ArrayBuffer | Uint8Array) => string;
  decryptKeyset: (secret: Uint8Array, encrypted: string) => Promise<Keyset>;
  authenticate: (credentialId: string, salt: Uint8Array) => Promise<Uint8Array>;
  unwrapDeviceSecret: (prf: Uint8Array, wrapped: string) => Promise<Uint8Array>;
  unwrapKeyring: (keyset: Keyset, wrapped: string) => Promise<unknown>;
  wrapKeyring: (publicKey: string, keyring: unknown) => Promise<string>;
};

type KeyMember = {
  memberId: string;
  publicKey: string | null;
  hasWrap: boolean;
};

type KeyState = {
  keyGeneration: number;
  recoveryPublicKey: string | null;
  encryptedKeyset: string;
  wrappedOrgKey: string;
  members: KeyMember[];
};

function keyMember(value: unknown) {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof Reflect.get(value, "memberId") !== "string"
  ) {
    return null;
  }
  const publicKey = Reflect.get(value, "publicKey");
  if (publicKey !== null && typeof publicKey !== "string") return null;
  return {
    memberId: String(Reflect.get(value, "memberId")),
    publicKey,
    hasWrap: Reflect.get(value, "hasWrap") === true,
  } satisfies KeyMember;
}

function keyState(value: unknown) {
  if (typeof value !== "object" || value === null) return null;
  const generation = Reflect.get(value, "keyGeneration");
  const recoveryPublicKey = Reflect.get(value, "recoveryPublicKey");
  const self = Reflect.get(value, "self");
  const rawMembers = Reflect.get(value, "members");
  if (
    !Number.isSafeInteger(generation) ||
    Number(generation) < 1 ||
    (recoveryPublicKey !== null && typeof recoveryPublicKey !== "string") ||
    typeof self !== "object" ||
    self === null ||
    typeof Reflect.get(self, "encryptedKeyset") !== "string" ||
    typeof Reflect.get(self, "wrappedOrgKey") !== "string" ||
    !Array.isArray(rawMembers)
  ) {
    return null;
  }
  const members = rawMembers.map(keyMember);
  if (members.some((member) => member === null)) return null;
  return {
    keyGeneration: Number(generation),
    recoveryPublicKey,
    encryptedKeyset: String(Reflect.get(self, "encryptedKeyset")),
    wrappedOrgKey: String(Reflect.get(self, "wrappedOrgKey")),
    members: members.flatMap((member) => (member ? [member] : [])),
  } satisfies KeyState;
}

function deviceEnvelope(userId: string) {
  const stored = localStorage.getItem(`mimir:device:${userId}`);
  if (!stored) throw new Error("Enroll this browser on the Credentials page");
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
  return {
    credentialId: String(Reflect.get(parsed, "credentialId")),
    salt: String(Reflect.get(parsed, "salt")),
    wrappedSecret: String(Reflect.get(parsed, "wrappedSecret")),
  };
}

function nextKeyring(
  value: unknown,
  generation: number,
  toB64u: MemberDependencies["toB64u"],
) {
  if (
    typeof value !== "object" ||
    value === null ||
    Reflect.get(value, "v") !== 1
  ) {
    throw new Error("Organization keyring is malformed");
  }
  const rawKeys = Reflect.get(value, "keys");
  if (typeof rawKeys !== "object" || rawKeys === null) {
    throw new Error("Organization keyring is malformed");
  }
  const entries = Object.entries(rawKeys);
  if (
    entries.some(
      ([name, encoded]) =>
        !Number.isSafeInteger(Number(name)) ||
        Number(name) < 1 ||
        typeof encoded !== "string",
    ) ||
    !entries.some(([name]) => Number(name) === generation)
  ) {
    throw new Error("Organization keyring is malformed");
  }
  const nextGeneration = generation + 1;
  if (!Number.isSafeInteger(nextGeneration) || nextGeneration > 0xffff_ffff) {
    throw new Error("Organization key generation is exhausted");
  }
  return {
    generation: nextGeneration,
    keyring: {
      v: 1,
      keys: {
        ...Object.fromEntries(entries),
        [String(nextGeneration)]: toB64u(
          crypto.getRandomValues(new Uint8Array(32)),
        ),
      },
    },
  };
}

export function registerMemberKeyManager(dependencies: MemberDependencies) {
  class MemberKeyManager extends HTMLElement {
    #abort?: AbortController;

    connectedCallback() {
      this.#abort?.abort();
      this.#abort = new AbortController();
      this.addEventListener("click", (event) => this.#clicked(event), {
        signal: this.#abort.signal,
      });
    }

    disconnectedCallback() {
      this.#abort?.abort();
    }

    #status(message: string, error = false) {
      const status = this.querySelector("[role=status]");
      if (status) {
        status.textContent = message;
        status.classList.toggle("form-error", error);
      }
    }

    async #unlocked() {
      const userId = this.dataset.userId;
      if (!userId) throw new Error("The active user is unavailable");
      const enrolled = deviceEnvelope(userId);
      this.#status("Waiting for your passkey…");
      const prf = await dependencies.authenticate(
        enrolled.credentialId,
        dependencies.fromB64u(enrolled.salt),
      );
      const secret = await dependencies.unwrapDeviceSecret(
        prf,
        enrolled.wrappedSecret,
      );
      prf.fill(0);
      try {
        const state = keyState(await dependencies.json("/v1/keys/org"));
        if (!state) throw new Error("Organization keys are not ready");
        const keyset = await dependencies.decryptKeyset(
          secret,
          state.encryptedKeyset,
        );
        const keyring = await dependencies.unwrapKeyring(
          keyset,
          state.wrappedOrgKey,
        );
        return { state, keyring };
      } finally {
        secret.fill(0);
      }
    }

    async #provision() {
      const { state, keyring } = await this.#unlocked();
      const pending = state.members.filter(
        (member) => member.publicKey && !member.hasWrap,
      );
      for (const member of pending) {
        const publicKey = member.publicKey;
        if (!publicKey) continue;
        await dependencies.post("/v1/keys/wrap", {
          memberId: member.memberId,
          wrappedOrgKey: await dependencies.wrapKeyring(publicKey, keyring),
        });
      }
      this.#status(
        pending.length === 0
          ? "No members are waiting for key access."
          : `Provisioned key access for ${pending.length} member(s).`,
      );
      if (pending.length > 0) window.location.reload();
    }

    async #remove(memberId: string) {
      const { state, keyring: current } = await this.#unlocked();
      const { generation, keyring } = nextKeyring(
        current,
        state.keyGeneration,
        dependencies.toB64u,
      );
      const wraps = await Promise.all(
        state.members.flatMap((member) =>
          member.publicKey && member.memberId !== memberId
            ? [
                dependencies
                  .wrapKeyring(member.publicKey, keyring)
                  .then((wrappedOrgKey) => ({
                    memberId: member.memberId,
                    wrappedOrgKey,
                  })),
              ]
            : [],
        ),
      );
      const recovery = state.recoveryPublicKey
        ? {
            recoveryPublicKey: state.recoveryPublicKey,
            wrappedRecoveryKey: await dependencies.wrapKeyring(
              state.recoveryPublicKey,
              keyring,
            ),
          }
        : undefined;
      await dependencies.post("/v1/keys/rotate", {
        keyGeneration: generation,
        wraps,
        ...(recovery ? { recovery } : {}),
        removeMemberId: memberId,
      });
      window.location.assign("/admin/members?notice=removed");
    }

    async #clicked(event: Event) {
      const button = event.target;
      if (!(button instanceof HTMLButtonElement) || !button.dataset.action) {
        return;
      }
      event.preventDefault();
      button.disabled = true;
      try {
        if (button.dataset.action === "provision") await this.#provision();
        if (button.dataset.action === "remove") {
          const memberId = button.dataset.memberId;
          if (!memberId) throw new Error("The member is unavailable");
          await this.#remove(memberId);
        }
      } catch (error) {
        this.#status(
          error instanceof Error ? error.message : "The key operation failed",
          true,
        );
      } finally {
        button.disabled = false;
      }
    }
  }

  if (!customElements.get("mimir-member-key-manager")) {
    customElements.define("mimir-member-key-manager", MemberKeyManager);
  }
}
