import { describe, expect, expectTypeOf, it } from "vitest";
import type { ProjectConfig } from "../../../src/index";
import { createApp, createPlugin, defineConfig } from "../../../src/index";

const greeterPlugin = createPlugin("greeter", {
  config: { greeting: "hello", times: 1 },
  api: ctx => ({ greet: (name: string) => `${ctx.config.greeting} ${name}` })
});

describe("defineConfig", () => {
  it("returns the config object unchanged", () => {
    const config = { pluginConfigs: { ark: { region: "cn" as const } } };

    expect(defineConfig(config)).toBe(config);
  });

  it("types framework plugin configs", () => {
    const config = defineConfig({
      pluginConfigs: { ark: { region: "cn" }, fal: { upload: "data-uri" } }
    });

    expect(config.pluginConfigs?.ark).toEqual({ region: "cn" });

    // @ts-expect-error: no plugin is named "nope"
    defineConfig({ pluginConfigs: { nope: {} } });

    // @ts-expect-error: ark region is "intl" | "cn"
    defineConfig({ pluginConfigs: { ark: { region: 5 } } });

    // @ts-expect-error: ark has no option named "zone"
    defineConfig({ pluginConfigs: { ark: { zone: "cn" } } });
  });

  it("types the configs of the custom plugins it lists, with no explicit generics", () => {
    const config = defineConfig({
      plugins: [greeterPlugin],
      pluginConfigs: { greeter: { greeting: "hi" }, ark: { region: "cn" } }
    });

    expectTypeOf(config.plugins).toEqualTypeOf<[typeof greeterPlugin] | undefined>();

    // @ts-expect-error: greeter.times is a number
    defineConfig({ plugins: [greeterPlugin], pluginConfigs: { greeter: { times: "2" } } });

    // @ts-expect-error: greeter is not listed in plugins, so its key is unknown
    defineConfig({ pluginConfigs: { greeter: { greeting: "hi" } } });
  });

  it("only carries plugins and pluginConfigs", () => {
    // @ts-expect-error: callbacks stay in createApp, not in the project config
    defineConfig({ onReady: () => {} });

    expectTypeOf<keyof ProjectConfig>().toEqualTypeOf<"plugins" | "pluginConfigs">();
  });

  it("is accepted by createApp", () => {
    const config = defineConfig({
      plugins: [greeterPlugin],
      pluginConfigs: { greeter: { times: 2 } }
    });

    const app = createApp(config);

    expectTypeOf(app.greeter.greet).toEqualTypeOf<(name: string) => string>();
    expect(app.greeter.greet("Ann")).toBe("hello Ann");
  });
});
