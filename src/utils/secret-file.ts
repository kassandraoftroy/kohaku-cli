import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
} from "node:fs";

const DEFAULT_MAX_SECRET_BYTES = 64 * 1024;

export type ReadSecretFileOptions = {
  label: string;
  allowNewlines?: boolean;
  maxBytes?: number;
};

export function assertSecretFilePlatformSupported(
  platform: NodeJS.Platform = process.platform
): void {
  if (platform === "win32") {
    throw new Error(
      "Secure secret-file inputs are unsupported on Windows because file ACLs cannot be validated."
    );
  }
}

/**
 * Read a secret from an owner-only regular file without following symlinks.
 * A single trailing newline is ignored so files created with `printf` or a
 * password manager's file export can be used directly.
 */
export function readSecretFile(
  filePath: string,
  options: ReadSecretFileOptions
): string {
  const trimmedPath = filePath.trim();
  if (!trimmedPath) {
    throw new Error(`${options.label} file path cannot be empty.`);
  }
  assertSecretFilePlatformSupported();

  let pathStat: ReturnType<typeof lstatSync>;
  try {
    pathStat = lstatSync(trimmedPath);
  } catch {
    throw new Error(`Unable to securely open ${options.label.toLowerCase()} file.`);
  }
  if (pathStat.isSymbolicLink()) {
    throw new Error(`${options.label} file cannot be a symbolic link.`);
  }
  if (!pathStat.isFile()) {
    throw new Error(`${options.label} file must be a regular file.`);
  }

  const noFollow = constants.O_NOFOLLOW ?? 0;
  const nonBlock = constants.O_NONBLOCK ?? 0;
  let fd: number;
  try {
    fd = openSync(trimmedPath, constants.O_RDONLY | noFollow | nonBlock);
  } catch {
    throw new Error(`Unable to securely open ${options.label.toLowerCase()} file.`);
  }

  let contents: string;
  try {
    const stat = fstatSync(fd);
    if (stat.dev !== pathStat.dev || stat.ino !== pathStat.ino) {
      throw new Error(`${options.label} file changed while it was being opened.`);
    }
    if (!stat.isFile()) {
      throw new Error(`${options.label} file must be a regular file.`);
    }

    const maxBytes = options.maxBytes ?? DEFAULT_MAX_SECRET_BYTES;
    if (stat.size > maxBytes) {
      throw new Error(
        `${options.label} file is too large (maximum ${maxBytes} bytes).`
      );
    }

    const currentUid = process.getuid?.();
    if (currentUid === undefined) {
      throw new Error(`${options.label} file ownership cannot be validated.`);
    }
    if (stat.uid !== currentUid) {
      throw new Error(`${options.label} file must be owned by the current user.`);
    }
    const permissions = stat.mode & 0o777;
    if (permissions !== 0o400 && permissions !== 0o600) {
      throw new Error(
        `${options.label} file permissions must be 0400 or 0600; run chmod 600 on the file.`
      );
    }

    const bytes = readFileSync(fd);
    if (bytes.length > maxBytes) {
      throw new Error(
        `${options.label} file is too large (maximum ${maxBytes} bytes).`
      );
    }
    contents = bytes.toString("utf-8");
  } finally {
    closeSync(fd);
  }

  if (contents.includes("\0")) {
    throw new Error(`${options.label} file contains a NUL byte.`);
  }

  const value = contents.replace(/(?:\r\n|\n)$/, "");
  if (!options.allowNewlines && /[\r\n]/.test(value)) {
    throw new Error(`${options.label} file must contain exactly one line.`);
  }
  if (!value) {
    throw new Error(`${options.label} file cannot be empty.`);
  }
  return value;
}
