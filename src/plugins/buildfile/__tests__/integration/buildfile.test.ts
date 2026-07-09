import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { coreConfig, createCore } from "../../../../config";
import { buildfilePlugin } from "../../index";

/**
 * Converts a relative filesystem path into a valid relative ES module
 * import specifier (ensures a leading "./" or "../").
 */
function toImportSpecifier(relativePath: string): string {
  const normalized = relativePath.replaceAll("\\", "/");
  return normalized.startsWith(".") ? normalized : `./${normalized}`;
}

/**
 * Assembles a fresh framework wiring only `buildfilePlugin` as a regular
 * plugin. `journal` is a core plugin baked into the real `coreConfig`, so
 * it is always present too — its `path` is pinned at `dbPath` so its
 * `onStart` never writes `.moku/journal.db` into the repo's real cwd.
 */
function buildFramework(dbPath: string) {
  return createCore(coreConfig, {
    plugins: [buildfilePlugin],
    pluginConfigs: { journal: { path: dbPath } }
  });
}

describe("buildfile integration", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "moku-buildfile-integration-"));
    dbPath = path.join(tempDir, "journal.db");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("exercises the full lifecycle: createApp -> start -> api -> stop", async () => {
    const { createApp } = buildFramework(dbPath);
    const app = createApp({
      pluginConfigs: { buildfile: { schemaPath: ".moku/build.schema.json" } }
    });

    await app.start();

    const text = app.buildfile.template({ name: "demo" });
    expect(text).toContain("# yaml-language-server: $schema=.moku/build.schema.json");

    const compiled = await app.buildfile.compile({ text, lang: "yaml" });
    expect(compiled.spec.name).toBe("demo");

    await app.stop();
  });

  it("compiles a real YAML fixture file from a temp dir", async () => {
    const { createApp } = buildFramework(dbPath);
    const app = createApp();
    await app.start();

    const filePath = path.join(tempDir, "build.moku.yaml");
    await writeFile(
      filePath,
      "version: 1\nname: yaml-fixture\nitems:\n  - task: voiceover\n    input:\n      text: hi\n      voice: v1\n"
    );

    const compiled = await app.buildfile.compile({ path: filePath });

    expect(compiled.file).toBe(filePath);
    expect(compiled.spec.name).toBe("yaml-fixture");
    expect(compiled.spec.items).toHaveLength(1);

    await app.stop();
  });

  it("compiles a real TS fixture file default-exporting a defineBuild() result", async () => {
    const { createApp } = buildFramework(dbPath);
    const app = createApp();
    await app.start();

    const pluginDir = path.dirname(fileURLToPath(import.meta.url));
    const definePath = path.resolve(pluginDir, "../../define.ts");
    const filePath = path.join(tempDir, "build.moku.ts");
    const importSpecifier = toImportSpecifier(path.relative(tempDir, definePath));
    await writeFile(
      filePath,
      `import { defineBuild } from "${importSpecifier}";

export default defineBuild({
  version: 1,
  name: "ts-fixture",
  items: [{ task: "translate", input: { text: "hi", targetLang: "es" } }]
});
`
    );

    const compiled = await app.buildfile.compile({ path: filePath });

    expect(compiled.spec.name).toBe("ts-fixture");
    expect(compiled.spec.items[0]?.task).toBe("translate");

    await app.stop();
  });

  it("loadGlob compiles matches across nested directories in deterministic path order", async () => {
    const { createApp } = buildFramework(dbPath);
    const app = createApp();
    await app.start();

    await mkdir(path.join(tempDir, "sub"), { recursive: true });
    const zPath = path.join(tempDir, "z.moku.yaml");
    const aPath = path.join(tempDir, "sub", "a.moku.yaml");
    // Written in reverse-alphabetical order to prove the output order is
    // sorted, not filesystem enumeration/creation order.
    await writeFile(zPath, "version: 1\nname: z\nitems: []\n");
    await writeFile(aPath, "version: 1\nname: a\nitems: []\n");

    const compiled = await app.buildfile.loadGlob(path.join(tempDir, "**/*.moku.yaml"));

    expect(compiled.map(build => build.file)).toEqual([aPath, zPath].toSorted());
    expect(compiled.map(build => build.spec.name)).toEqual(["a", "z"]);

    await app.stop();
  });

  it("loadGlob throws a two-line error suggesting moku new when nothing matches", async () => {
    const { createApp } = buildFramework(dbPath);
    const app = createApp();
    await app.start();

    const pattern = path.join(tempDir, "**/*.moku.yaml");
    await expect(app.buildfile.loadGlob(pattern)).rejects.toThrow(
      `[ai] No build files matched "${pattern}".\n  Run "moku new" to create one.`
    );

    await app.stop();
  });
});
