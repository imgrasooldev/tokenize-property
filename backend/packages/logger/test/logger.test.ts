import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createLogger } from "../src/index.ts";

function capture() {
  const lines: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  return { lines, destination };
}

describe("logger", () => {
  it("redacts secrets and personal data at any common depth", () => {
    const { lines, destination } = capture();
    const log = createLogger({ service: "test", destination });
    log.info(
      {
        password: "p1",
        investor: { cnic: "35202-1234567-1", iban: "PK36SCBL0000001123456702", name: "Alice" },
        req: { headers: { authorization: "Bearer abc" } },
        signer: { privateKey: "0xdeadbeef" },
      },
      "event",
    );
    const out = lines.join("");
    for (const secret of ["p1", "35202-1234567-1", "PK36SCBL0000001123456702", "Bearer abc", "0xdeadbeef"]) {
      expect(out).not.toContain(secret);
    }
    expect(out).toContain("[REDACTED]");
    expect(out).toContain("Alice");
    expect((JSON.parse(out) as { service: string }).service).toBe("test");
  });
});
