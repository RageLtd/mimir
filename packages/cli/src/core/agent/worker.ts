import { assertNever } from "../result.ts";
import type { Action } from "../store/actions.ts";
import type { AgentCommand } from "./protocol.ts";
import { startSession } from "./session.ts";

declare var self: Worker;

const NOT_STARTED = "agent session not started";

const emit = (action: Action) => self.postMessage(action);

let session: ReturnType<typeof startSession> | null = null;

self.addEventListener("message", (event: MessageEvent<AgentCommand>) => {
  const command = event.data;
  switch (command.type) {
    case "agent/start":
      if (session === null) {
        session = startSession(
          {
            model: command.model,
            permissionMode: command.permissionMode,
            mcpServers: command.mcpServers,
            plugins: command.plugins,
          },
          emit,
        );
      }
      return;
    case "agent/send":
      if (session === null) {
        emit({ type: "agent/error", message: NOT_STARTED });
        return;
      }
      session.send(command.text);
      return;
    case "agent/permission":
      session?.answerPermission(command.id, command.behavior);
      return;
    case "agent/close":
      session?.close();
      session = null;
      return;
    default:
      assertNever(command);
  }
});
