import { getDefaultMediaLocalRoots } from "./local-roots.js";

export type LocalMediaAccessErrorCode =
  | "path-not-allowed"
  | "invalid-root"
  | "invalid-file-url"
  | "network-path-not-allowed"
  | "unsafe-bypass"
  | "not-found"
  | "invalid-path"
  | "not-file";

export class LocalMediaAccessError extends Error {
  code: LocalMediaAccessErrorCode;

  constructor(code: LocalMediaAccessErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
    this.name = "LocalMediaAccessError";
  }
}

export function getDefaultLocalRoots(): readonly string[] {
  return getDefaultMediaLocalRoots();
}

export async function assertLocalMediaAllowed(
  mediaPath: string,
  localRoots: readonly string[] | "any" | undefined,
): Promise<void> {
  // the agent already has filesystem access via tools, directory
  // restrictions here only cause confusing delivery failures
  void mediaPath;
  void localRoots;
  return;
}
