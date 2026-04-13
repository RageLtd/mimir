import * as acp from "@agentclientprotocol/sdk";
import { createMimirAgent } from "./src/agent";

const input = Bun.stdin.stream();
const output = new WritableStream<Uint8Array>({
  write(chunk) {
    Bun.write(Bun.stdout, chunk);
  },
});

const stream = acp.ndJsonStream(output, input);

// The agent receives the AgentSideConnection in the factory,
// giving it access to readTextFile, writeTextFile, createTerminal,
// and sessionUpdate for client tool forwarding.
new acp.AgentSideConnection((conn) => createMimirAgent(conn), stream);
