import { describe, expect, it } from "vitest";
import {
  arkModels,
  checkResolution,
  checkSeconds,
  DEFAULT_RESOLUTION,
  DEFAULT_SECONDS,
  modelsOf,
  resolveArkModel
} from "../../models";

const INTL_20 = "dreamina-seedance-2-0-260128";
const CN_20 = "doubao-seedance-2-0-260128";
const INTL_25 = "dreamina-seedance-2-5-260628";
const CN_25 = "doubao-seedance-2-5-260628";

describe("catalog", () => {
  it("has the Seedance 2.0 row of each region", () => {
    const ids = arkModels.map(model => model.id);
    expect(ids).toContain(INTL_20);
    expect(ids).toContain(CN_20);
  });

  it("has unique ids", () => {
    const ids = arkModels.map(model => model.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives every row seconds limits, resolutions, ref limits and a price", () => {
    for (const model of arkModels) {
      expect(model.minSeconds).toBeGreaterThan(0);
      expect(model.maxSeconds).toBeGreaterThan(model.minSeconds);
      expect(model.resolutions.length).toBeGreaterThan(0);
      expect(model.maxRefImages).toBeGreaterThan(0);
      expect(model.price.base).toBeGreaterThan(0);
      expect(model.price.withVideoInput).toBeGreaterThan(0);
    }
  });

  it("keeps the documented Seedance 2.0 data", () => {
    expect(resolveArkModel(INTL_20, "intl")).toEqual({
      id: INTL_20,
      region: "intl",
      minSeconds: 4,
      maxSeconds: 15,
      resolutions: ["480p", "720p", "1080p"],
      maxRefImages: 9,
      maxRefVideos: 3,
      maxRefAudios: 3,
      supportsSeed: false,
      supportsAudio: true,
      price: { base: 7, withVideoInput: 4.3 }
    });
    expect(resolveArkModel(CN_20, "cn").price).toEqual({ base: 46, withVideoInput: 28 });
  });
});

describe("Seedance 2.5 rows", () => {
  it("resolves each 2.5 id in its own region with the documented data", () => {
    expect(resolveArkModel(INTL_25, "intl")).toEqual({
      id: INTL_25,
      region: "intl",
      minSeconds: 4,
      maxSeconds: 30,
      resolutions: ["480p", "720p"],
      maxRefImages: 30,
      maxRefVideos: 10,
      maxRefAudios: 10,
      supportsSeed: false,
      supportsAudio: true,
      price: { base: 10.7, withVideoInput: 6.4 }
    });
    expect(resolveArkModel(CN_25, "cn")).toEqual({
      id: CN_25,
      region: "cn",
      minSeconds: 4,
      maxSeconds: 30,
      resolutions: ["480p", "720p"],
      maxRefImages: 30,
      maxRefVideos: 10,
      maxRefAudios: 10,
      supportsSeed: false,
      supportsAudio: true,
      price: { base: 70, withVideoInput: 42 }
    });
  });

  it("rejects each 2.5 id in the other region", () => {
    expect(() => resolveArkModel(INTL_25, "cn")).toThrow(
      `[ai] Model ${INTL_25} is a intl model.\n  Set ark region to "intl" or pick a cn model.`
    );
    expect(() => resolveArkModel(CN_25, "intl")).toThrow(
      `[ai] Model ${CN_25} is a cn model.\n  Set ark region to "cn" or pick a intl model.`
    );
  });

  it("takes a 25 s clip on 2.5 but not on 2.0", () => {
    for (const [id25, id20, region] of [
      [INTL_25, INTL_20, "intl"],
      [CN_25, CN_20, "cn"]
    ] as const) {
      expect(checkSeconds(resolveArkModel(id25, region), 25)).toBe(25);
      expect(() => checkSeconds(resolveArkModel(id20, region), 25)).toThrow(
        `[ai] Model ${id20} takes 4 to 15 seconds.\n  Got 25; set input.seconds in that range.`
      );
    }
  });

  it("rejects 1080p on 2.5", () => {
    expect(() => checkResolution(resolveArkModel(INTL_25, "intl"), "1080p")).toThrow(
      `[ai] Model ${INTL_25} does not take resolution "1080p".\n  Use one of: 480p, 720p.`
    );
  });
});

describe("modelsOf", () => {
  it("lists only the region's rows, in catalog order", () => {
    const intl = modelsOf("intl");
    const cn = modelsOf("cn");

    expect(intl).toContain(INTL_20);
    expect(intl).not.toContain(CN_20);
    expect(cn).toContain(CN_20);
    expect(cn).not.toContain(INTL_20);
    expect(intl).toEqual([INTL_20, INTL_25]);
    expect(cn).toEqual([CN_20, CN_25]);
    expect([...intl, ...cn].toSorted()).toEqual(arkModels.map(model => model.id).toSorted());
  });
});

describe("resolveArkModel", () => {
  it("throws for an unknown id, listing the known ids", () => {
    const known = arkModels.map(model => model.id).join(", ");
    expect(() => resolveArkModel("seedance-9", "intl")).toThrow(
      `[ai] Unknown ark model "seedance-9".\n  Known: ${known}.`
    );
  });

  it("throws for a model of the other region", () => {
    expect(() => resolveArkModel(CN_20, "intl")).toThrow(
      `[ai] Model ${CN_20} is a cn model.\n  Set ark region to "cn" or pick a intl model.`
    );
    expect(() => resolveArkModel(INTL_20, "cn")).toThrow(
      `[ai] Model ${INTL_20} is a intl model.\n  Set ark region to "intl" or pick a cn model.`
    );
  });

  it("does not resolve inherited object keys", () => {
    expect(() => resolveArkModel("toString", "intl")).toThrow('Unknown ark model "toString"');
  });
});

describe("checkSeconds", () => {
  const model = resolveArkModel(INTL_20, "intl");

  it("defaults to 5 seconds", () => {
    expect(DEFAULT_SECONDS).toBe(5);
    expect(checkSeconds(model, undefined)).toBe(5);
  });

  it("accepts the model's bounds", () => {
    expect(checkSeconds(model, 4)).toBe(4);
    expect(checkSeconds(model, 15)).toBe(15);
  });

  it("rejects seconds outside the model's limits, naming them", () => {
    expect(() => checkSeconds(model, 3)).toThrow(
      `[ai] Model ${INTL_20} takes 4 to 15 seconds.\n  Got 3; set input.seconds in that range.`
    );
    expect(() => checkSeconds(model, 16)).toThrow("takes 4 to 15 seconds.\n  Got 16;");
  });
});

describe("checkResolution", () => {
  const model = resolveArkModel(INTL_20, "intl");

  it("defaults to 720p", () => {
    expect(DEFAULT_RESOLUTION).toBe("720p");
    expect(checkResolution(model, undefined)).toBe("720p");
  });

  it("accepts every listed resolution", () => {
    for (const resolution of model.resolutions) {
      expect(checkResolution(model, resolution)).toBe(resolution);
    }
  });

  it("rejects a resolution the model does not list", () => {
    expect(() => checkResolution(model, "4k")).toThrow(
      `[ai] Model ${INTL_20} does not take resolution "4k".\n  Use one of: 480p, 720p, 1080p.`
    );
  });
});
