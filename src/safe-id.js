// Group ids end up in file paths (media folders, message stream files). They come from received
// messages and cannot be trusted: only base64url characters are accepted (the app makes group ids
// from 16 random bytes in base64url); anything else is invalid.
import { resolve, sep } from 'node:path';

const GROUP_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function isSafeGroupId(id) {
  return typeof id === 'string' && GROUP_ID.test(id);
}

/** The path of parts under base; throws if the result is not inside base. */
export function pathInside(base, ...parts) {
  const root = resolve(base);
  const full = resolve(root, ...parts);
  if (full !== root && !full.startsWith(root + sep)) throw new Error(`path_outside:${parts.join('/')}`);
  return full;
}
