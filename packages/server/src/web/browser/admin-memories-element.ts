import { registerAdminMemoryElement } from "./admin-memory-ceremony";
import { json, post } from "./credentials-element";
import {
  clearUnlocked,
  openMemoryEnvelope,
  sealMemoryEnvelope,
  unlockKeys,
} from "./memory-crypto";

registerAdminMemoryElement({
  json,
  post,
  unlockKeys,
  clearUnlocked,
  openMemoryEnvelope,
  sealMemoryEnvelope,
});
