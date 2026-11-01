// Request ids: unique per session, ≤ 64 chars (SPEC §2). Random suffix + monotonic counter.

import { bytesToHex, randomBytes } from "../crypto/bytes";

export interface RequestIdGenerator {
  next(): string;
}

export function createRequestIdGenerator(prefix = "r"): RequestIdGenerator {
  const tag = bytesToHex(randomBytes(4));
  let n = 0;
  return {
    next() {
      n += 1;
      return `${prefix}${tag}-${n.toString(36)}`;
    },
  };
}

const shared = createRequestIdGenerator();

export function newRequestId(): string {
  return shared.next();
}
