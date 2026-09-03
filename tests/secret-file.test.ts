import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  assertSecretFilePlatformSupported,
  readSecretFile,
} from "../src/utils/secret-file.js";
import {
  resolvePasswordInputPreferFile,
  resolveWalletPassword,
} from "../src/utils/wallets-util.js";

function withSecretFile(
  contents: string,
  run: (filePath: string, dir: string) => void
): void {
  const dir = mkdtempSync(join(tmpdir(), "kohaku-secret-"));
  const filePath = join(dir, "secret");
  try {
    writeFileSync(filePath, contents, { mode: 0o600 });
    chmodSync(filePath, 0o600);
    run(filePath, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("readSecretFile", { skip: process.platform === "win32" }, () => {
  it("reads an owner-only file and removes one trailing newline", () => {
    withSecretFile("correct horse battery staple\n", (filePath) => {
      assert.equal(
        readSecretFile(filePath, { label: "Password" }),
        "correct horse battery staple"
      );
    });
  });

  it("accepts a CRLF line ending", () => {
    withSecretFile("secret\r\n", (filePath) => {
      assert.equal(readSecretFile(filePath, { label: "Password" }), "secret");
    });
  });

  it("preserves whitespace that is part of a password", () => {
    withSecretFile(" leading and trailing ", (filePath) => {
      assert.equal(
        readSecretFile(filePath, { label: "Password" }),
        " leading and trailing "
      );
    });
  });

  it("rejects empty, multiline, oversized, and NUL-containing files", () => {
    for (const [contents, expected] of [
      ["", /cannot be empty/],
      ["one\ntwo\n", /exactly one line/],
      ["a\0b", /NUL byte/],
    ] as const) {
      withSecretFile(contents, (filePath) => {
        assert.throws(
          () => readSecretFile(filePath, { label: "Password" }),
          expected
        );
      });
    }

    withSecretFile("12345", (filePath) => {
      assert.throws(
        () =>
          readSecretFile(filePath, { label: "Password", maxBytes: 4 }),
        /too large/
      );
    });
  });

  it("requires mode 0400 or 0600 on POSIX", { skip: process.platform === "win32" }, () => {
    withSecretFile("secret", (filePath) => {
      for (const mode of [0o644, 0o700]) {
        chmodSync(filePath, mode);
        assert.throws(
          () => readSecretFile(filePath, { label: "Password" }),
          /permissions must be 0400 or 0600/
        );
      }
      chmodSync(filePath, 0o400);
      assert.equal(readSecretFile(filePath, { label: "Password" }), "secret");
    });
  });

  it("does not follow symlinks", { skip: process.platform === "win32" }, () => {
    withSecretFile("secret", (filePath, dir) => {
      const linkPath = join(dir, "secret-link");
      symlinkSync(filePath, linkPath);
      assert.throws(
        () => readSecretFile(linkPath, { label: "Password" }),
        /cannot be a symbolic link/
      );
    });
  });

  it("rejects a missing path without including it in the error", () => {
    const missingPath = "/tmp/kohaku-missing-secret-path-marker";
    assert.throws(
      () => readSecretFile(missingPath, { label: "Password" }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /Unable to securely open password file/);
        assert.doesNotMatch(error.message, new RegExp(missingPath));
        return true;
      }
    );
  });

  it("rejects a directory before opening it", () => {
    const dir = mkdtempSync(join(tmpdir(), "kohaku-secret-dir-"));
    const nestedDir = join(dir, "not-a-file");
    try {
      mkdirSync(nestedDir);
      assert.throws(
        () => readSecretFile(nestedDir, { label: "Password" }),
        /must be a regular file/
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a FIFO before opening it", { skip: process.platform === "win32" }, () => {
    const dir = mkdtempSync(join(tmpdir(), "kohaku-secret-fifo-"));
    const fifoPath = join(dir, "secret-fifo");
    try {
      const made = spawnSync("mkfifo", [fifoPath], { encoding: "utf-8" });
      assert.equal(made.status, 0, made.stderr);
      assert.throws(
        () => readSecretFile(fifoPath, { label: "Password" }),
        /must be a regular file/
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not include secret contents or paths in validation errors", () => {
    const secretValue = "do-not-print-this-value";
    withSecretFile(`${secretValue}\nsecond-line`, (filePath) => {
      let message = "";
      try {
        readSecretFile(filePath, { label: "Password" });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      assert.ok(message);
      assert.doesNotMatch(message, new RegExp(secretValue));
      assert.doesNotMatch(message, new RegExp(filePath));
    });
  });
});

describe("assertSecretFilePlatformSupported", () => {
  it("fails closed when Windows ACLs cannot be validated", () => {
    assert.throws(
      () => assertSecretFilePlatformSupported("win32"),
      /unsupported on Windows/
    );
  });
});

describe(
  "resolvePasswordInputPreferFile",
  { skip: process.platform === "win32" },
  () => {
  it("supports explicit file input without changing legacy literal input", () => {
    withSecretFile("from-file\n", (filePath) => {
      assert.equal(resolvePasswordInputPreferFile(undefined, filePath), "from-file");
      assert.equal(resolvePasswordInputPreferFile("literal"), "literal");
    });
  });

  it("rejects ambiguous simultaneous inputs", () => {
    assert.throws(
      () => resolvePasswordInputPreferFile("literal", "/tmp/password"),
      /mutually exclusive/
    );
  });
  }
);

describe("resolveWalletPassword", { skip: process.platform === "win32" }, () => {
  it("retries legacy-trimmed file contents when unlocking an existing wallet", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kohaku-secret-"));
    const filePath = join(dir, "password");
    try {
      writeFileSync(filePath, " legacy-password \n", { mode: 0o600 });
      chmodSync(filePath, 0o600);
      const attempts: string[] = [];
      const resolved = await resolveWalletPassword({
        flagPasswordFile: filePath,
        validate: (candidate) => {
          attempts.push(candidate);
          if (candidate !== "legacy-password") {
            throw new Error("wrong password");
          }
        },
      });
      assert.equal(resolved, "legacy-password");
      assert.deepEqual(attempts, [" legacy-password ", "legacy-password"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
