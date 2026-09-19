import type { App } from "../../core/app.ts";
import { summarize } from "../../core/permissions/rules.ts";
import type { Line } from "../../core/transcript/reducer.ts";

const linePrefix = (line: Line) => {
  switch (line.kind) {
    case "tool":
      return "⚙ ";
    case "error":
      return "✗ ";
    case "notice":
    case "user":
    case "assistant":
    case "blank":
      return "";
    default:
      return "";
  }
};

/**
 * Pipe-friendly frontend: one prompt, assistant text streamed to stdout,
 * everything else to stderr, exit after the turn. There is no TTY to ask,
 * so any permission request not covered by an allow rule is denied.
 */
export const runPrint = (app: App, prompt: string) => {
  let exitCode = 0;
  let printed = 0;

  app.subscribe(
    (state) => state.transcript.streaming,
    (text) => {
      if (text === null) {
        printed = 0;
        return;
      }
      process.stdout.write(text.slice(printed));
      printed = text.length;
    },
  );

  app.subscribe(
    (state) => state.transcript.lines,
    (lines, previous) => {
      for (const line of lines.slice(previous.length)) {
        switch (line.kind) {
          case "assistant":
            process.stdout.write("\n");
            break;
          case "tool":
          case "error":
          case "notice":
            console.error(`${linePrefix(line)}${line.text}`);
            break;
          case "user":
          case "blank":
            break;
          default:
            break;
        }
        if (line.kind === "error") {
          exitCode = 1;
        }
      }
    },
  );

  app.subscribe(
    (state) => state.permissions.pending,
    (pending, previous) => {
      for (const request of pending.filter((r) => !previous.includes(r))) {
        console.error(
          `✗ denied (no TTY): ${request.toolName} ${summarize(request)}`,
        );
        app.answerPermission(request.id, "deny");
      }
    },
  );

  app.onTurnEnd(app.quit);
  app.onQuit(() => process.exit(exitCode));
  app.submit(prompt);
  return new Promise<void>(() => {});
};
