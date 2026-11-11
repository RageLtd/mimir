#!/usr/bin/env bun
/**
 * Land the repo's persona seed (packages/server/system-prompt.md) in
 * ~/.mimir, as an install would land the server's copy. Run by
 * dev-install.sh: an install fetches the prompt from mimir-server, which
 * only serves a changed seed after a redeploy, so without this a persona
 * edit could not be tried before it was released.
 *
 * The seed is what a fresh deploy serves. A server whose stored prompt an
 * operator has edited keeps that edit, so this is not always what
 * production hands out.
 */

import { join } from "node:path";
import { writePersonaFiles } from "../src/persona-files";

const SEED = join(import.meta.dir, "../../server/system-prompt.md");

const written = await writePersonaFiles(await Bun.file(SEED).text());
console.log(`dev-prompt: ${written.promptPath}`);
console.log(`dev-prompt: ${written.ccPromptPath}`);
