import { copyFileSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A temporary copy of the migrations directory with contiguous numbering. While the Step 5h (0012)
 * and Step 6a (0013) migrations are on other branches, 0014_property.sql follows a gap that the
 * runner refuses; this copy renumbers the files after a gap (0014 becomes 0012 here). Once the other
 * branches are merged the copy is identical to the real directory. Scratch databases only.
 */
export function contiguousMigrations(): string {
  const src = fileURLToPath(new URL("../../db/migrations", import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "pt-migrations-property-"));
  const files = readdirSync(src)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  files.forEach((f, i) => {
    copyFileSync(join(src, f), join(dir, `${String(i + 1).padStart(4, "0")}${f.slice(4)}`));
  });
  return dir;
}
