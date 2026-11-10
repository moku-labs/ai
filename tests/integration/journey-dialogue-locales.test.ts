/**
 * @file Journey: one YAML scene with `cast` + `locales: true` → per-locale
 * dialogue and voiceover items through the REAL elevenlabs plugin.
 *
 * buildfile expands the scene into ru and en items, each with its cast
 * member's voices and settings for that locale; the runner estimates them
 * from the elevenlabs price table, runs them against a stubbed `fetch` (no
 * network) and exports the mix plus one named file per dialogue line.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/index";
import {
  dialogueBody,
  fakeJsonResponse,
  syntheticMp3
} from "../../src/plugins/elevenlabs/__tests__/audio-fixtures";
import { fixtureEnvProvider } from "./helpers";

/** The scene: two locales, three cast members, one dialogue and one voiceover item. */
const SCENE = `version: 1
name: ep02
locales: [ru, en]
cast:
  alice:
    voice: ALICE_RU
    locales:
      en: { voice: ALICE_EN }
  daniel:
    voice: DANIEL_RU
    locales:
      en: { voice: DANIEL_EN }
  mira:
    voice: MIRA_RU
    settings: { stability: 0.5 }
    locales:
      en: { voice: MIRA_EN, settings: { stability: 0.6 } }
items:
  - id: voices/ep02-quarrel-\${locale}
    task: dialogue
    provider: elevenlabs
    locales: true
    input:
      model: eleven_v4
      language: \${locale}
      lines:
        - { id: "ep02-signAlice-\${locale}", $cast: alice, text: { ru: "Я ничего не подписывала!", en: "I never signed anything!" } }
        - { id: "ep02-signDaniel-\${locale}", $cast: daniel, text: { ru: "Нам нужны были деньги.", en: "We needed the money." } }
  - id: voices/promo-line3
    task: voiceover
    provider: elevenlabs
    locales: true
    input:
      $cast: mira
      model: eleven_v4
      language: \${locale}
      text: { ru: "Новый пациент.", en: "A new patient." }
`;

/** Every text of the scene, for the expected estimate. */
const TEXTS = [
  "Я ничего не подписывала!",
  "Нам нужны были деньги.",
  "I never signed anything!",
  "We needed the money.",
  "Новый пациент.",
  "A new patient."
];

/** One request the stubbed ElevenLabs answered. */
type Call = { url: string; body: Record<string, unknown> };

/**
 * Stubs ElevenLabs by URL: a dialogue POST gets a JSON scene over a
 * synthetic mp3 (line 0 at 0.1–1.0 s, line 1 at 1.2–2.0 s); a TTS POST gets
 * three audio bytes. Records every request.
 */
function stubElevenlabs(): Call[] {
  const calls: Call[] = [];
  const scene = syntheticMp3(100).bytes;
  const fake = (input: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url: input, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    if (input.includes("/v1/text-to-dialogue/")) {
      return Promise.resolve(
        fakeJsonResponse(
          dialogueBody(scene, [
            { dialogue_input_index: 0, start_time_seconds: 0.1, end_time_seconds: 1 },
            { dialogue_input_index: 1, start_time_seconds: 1.2, end_time_seconds: 2 }
          ])
        )
      );
    }
    return Promise.resolve(new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
  };
  vi.stubGlobal("fetch", vi.fn(fake));
  return calls;
}

/** The `pluginConfigs` type `createApp` declares (regular plugins only). */
type AppPluginConfigs = NonNullable<NonNullable<Parameters<typeof createApp>[0]>["pluginConfigs"]>;

/** The real framework app with journal/store under `tempDir` and a fixture ElevenLabs key. */
function buildApp(tempDir: string) {
  // Audited cast: createApp's type lists only regular plugins, but the kernel
  // also applies the core plugins' (journal, store, env) overrides at runtime.
  const pluginConfigs = {
    journal: { path: path.join(tempDir, "journal.db") },
    store: { dir: path.join(tempDir, "store") },
    env: { providers: [fixtureEnvProvider({ ELEVENLABS_API_KEY: "test-key" })] }
  } as unknown as AppPluginConfigs;
  return createApp({ pluginConfigs });
}

describe("journey: a dialogue scene with cast and locales", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "moku-root-int-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it("builds ru and en items with per-locale voices and settings, prices them, and exports every line", async () => {
    const calls = stubElevenlabs();
    const app = buildApp(tempDir);
    await app.start();
    await writeFile(path.join(tempDir, "ep02.moku.yaml"), SCENE);
    const glob = path.join(tempDir, "*.moku.yaml");

    // Estimate: every character at the v4 price, before any request.
    const estimate = await app.runner.estimate({ files: glob });
    const characters = TEXTS.reduce((sum, text) => sum + text.length, 0);
    expect(estimate.totalUsd).toBeCloseTo(characters * 0.000_08, 10);
    expect(calls).toEqual([]);

    // Run: four items, each locale with its own cast voices.
    const result = await app.runner.run({ files: glob });
    expect(result.status).toBe("done");
    expect(result.totals).toMatchObject({ total: 4, done: 4 });

    const dialogueBodies = calls.filter(call => call.url.includes("/v1/text-to-dialogue/"));
    const byLanguage = new Map(dialogueBodies.map(call => [call.body.language_code, call.body]));
    expect(byLanguage.get("ru")?.inputs).toEqual([
      { text: "Я ничего не подписывала!", voice_id: "ALICE_RU" },
      { text: "Нам нужны были деньги.", voice_id: "DANIEL_RU" }
    ]);
    expect(byLanguage.get("en")?.inputs).toEqual([
      { text: "I never signed anything!", voice_id: "ALICE_EN" },
      { text: "We needed the money.", voice_id: "DANIEL_EN" }
    ]);

    const speech = calls.filter(call => call.url.includes("/v1/text-to-speech/"));
    const ruPromo = speech.find(call => call.url.includes("/MIRA_RU?"));
    const enPromo = speech.find(call => call.url.includes("/MIRA_EN?"));
    expect(ruPromo?.body).toMatchObject({ text: "Новый пациент.", language_code: "ru" });
    expect(ruPromo?.body.voice_settings).toEqual({ stability: 0.5 });
    expect(enPromo?.body).toMatchObject({ text: "A new patient.", language_code: "en" });
    expect(enPromo?.body.voice_settings).toEqual({ stability: 0.6 });

    // Export: the mix and one named file per line, beside it, per locale.
    const exported = await app.runner.export({
      runId: result.runId,
      outDir: path.join(tempDir, "out")
    });
    expect(exported.files.map(file => file.label).toSorted()).toEqual([
      "voices/ep02-quarrel-en",
      "voices/ep02-quarrel-ru",
      "voices/ep02-signAlice-en",
      "voices/ep02-signAlice-ru",
      "voices/ep02-signDaniel-en",
      "voices/ep02-signDaniel-ru",
      "voices/promo-line3-en",
      "voices/promo-line3-ru"
    ]);
    expect(exported.files.every(file => file.path.endsWith(".mp3"))).toBe(true);

    await app.stop();
  });
});
