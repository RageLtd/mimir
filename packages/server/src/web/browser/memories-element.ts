import { json, post } from "./credentials-element";
import { registerMemoryElement } from "./memory-ceremony";
import {
  clearUnlocked,
  openMemoryEnvelope,
  sealMemoryEnvelope,
  unlockKeys,
} from "./memory-crypto";

registerMemoryElement({
  json,
  post,
  unlockKeys,
  clearUnlocked,
  openMemoryEnvelope,
  sealMemoryEnvelope,
});
