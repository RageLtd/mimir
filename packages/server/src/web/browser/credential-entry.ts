import { registerCredentialElement } from "./credential-ceremony";
import {
  authenticate,
  decryptKeyset,
  encryptKeyset,
  fromB64u,
  generateKeyset,
  json,
  post,
  registerPasskey,
  toB64u,
  unwrapDeviceSecret,
  unwrapKeyring,
  wrapDeviceSecret,
  wrapKeyring,
} from "./credentials-element";

registerCredentialElement({
  json,
  post,
  toB64u,
  fromB64u,
  generateKeyset,
  encryptKeyset,
  decryptKeyset,
  wrapKeyring,
  unwrapKeyring,
  registerPasskey,
  authenticate,
  wrapDeviceSecret,
  unwrapDeviceSecret,
});
