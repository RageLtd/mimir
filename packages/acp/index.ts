import * as acp from "@agentclientprotocol/sdk";
import { runKeysCommand } from "@mimir/plugin-core/keys/cli";
import { runSyncCommand } from "@mimir/plugin-core/sync/cli";
import { createMimirAgent } from "./src/agent";

// Pre-handshake argv dispatch: `mimir-acp keys …` / `mimir-acp sync` run
// the shared ceremonies (MIM-87/88) so Zed-only users have a working
// surface with the binary they already installed. Anything else falls
// through to the ACP stdio agent.
if (Bun.argv[2] === "keys") {
  process.exit(await runKeysCommand(Bun.argv.slice(3)));
}
if (Bun.argv[2] === "sync") {
  process.exit(await runSyncCommand());
}

const input = Bun.stdin.stream();
const output = new WritableStream<Uint8Array>({
  write(chunk) {
    return new Promise<void>((resolve, reject) => {
      process.stdout.write(chunk, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  },
});

const stream = acp.ndJsonStream(output, input);

// The agent receives the AgentSideConnection in the factory,
// giving it access to readTextFile, writeTextFile, createTerminal,
// and sessionUpdate for client tool forwarding.
new acp.AgentSideConnection((conn) => createMimirAgent(conn), stream);
