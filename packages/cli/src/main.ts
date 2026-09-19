#!/usr/bin/env bun
import { createApp } from "./core/app.ts";
import { runPrint } from "./frontends/print/print.ts";
import { runTui } from "./frontends/tui/tui.ts";

const app = createApp();
const prompt = process.argv.slice(2).join(" ").trim();

await (prompt === "" ? runTui(app) : runPrint(app, prompt));
