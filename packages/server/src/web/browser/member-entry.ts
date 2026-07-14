import {
  authenticate,
  decryptKeyset,
  fromB64u,
  json,
  post,
  toB64u,
  unwrapDeviceSecret,
  unwrapKeyring,
  wrapKeyring,
} from "./credentials-element";
import { registerMemberKeyManager } from "./member-ceremony";

registerMemberKeyManager({
  json,
  post,
  fromB64u,
  toB64u,
  decryptKeyset,
  authenticate,
  unwrapDeviceSecret,
  unwrapKeyring,
  wrapKeyring,
});
