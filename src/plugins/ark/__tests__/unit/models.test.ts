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
const INTL_FAST = "dreamina-seedance-2-0-fast-260128";
const INTL_MINI = "dreamina-seedance-2-0-mini-260615";
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
      expect(typeof model.ratioFollowsImage).toBe("boolean");
      expect(typeof model.supportsDraft).toBe("boolean");
      expect("price1080" in model).toBe(true);
    }
  });

  it("keeps the official Seedance 2.0 data, with its 1080p price", () => {
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
      ratioFollowsImage: false,
      supportsDraft: false,
      price: { base: 7, withVideoInput: 4.3 },
      price1080: { base: 7.7, withVideoInput: 4.7 }
    });
    expect(resolveArkModel(CN_20, "cn")).toMatchObject({
      price: { base: 46, withVideoInput: 28 },
      price1080: undefined,
      ratioFollowsImage: false,
      supportsDraft: false
    });
  });
});

describe("Seedance 2.0 fast and mini rows", () => {
  it("resolves fast and mini on intl with the official data", () => {
    const shared = {
      region: "intl",
      minSeconds: 4,
      maxSeconds: 15,
      resolutions: ["480p", "720p"],
      maxRefImages: 9,
      maxRefVideos: 3,
      maxRefAudios: 3,
      supportsSeed: false,
      supportsAudio: true,
      ratioFollowsImage: false,
      supportsDraft: false,
      price1080: undefined
    };
    expect(resolveArkModel(INTL_FAST, "intl")).toEqual({
      ...shared,
      id: INTL_FAST,
      price: { base: 5.6, withVideoInput: 3.3 }
    });
    expect(resolveArkModel(INTL_MINI, "intl")).toEqual({
      ...shared,
      id: INTL_MINI,
      price: { base: 3.5, withVideoInput: 2.1 }
    });
  });

  it("refuses 1080p on mini and fast", () => {
    for (const id of [INTL_MINI, INTL_FAST]) {
      expect(() => checkResolution(resolveArkModel(id, "intl"), "1080p")).toThrow(
        `[ai] Model ${id} does not take resolution "1080p".\n  Use one of: 480p, 720p.`
      );
    }
  });

  it("rejects mini and fast on cn", () => {
    expect(() => resolveArkModel(INTL_MINI, "cn")).toThrow(
      `[ai] Model ${INTL_MINI} is a intl model.`
    );
  });
});

describe("Seedance 2.5 rows", () => {
  it("resolves each 2.5 id in its own region with the documented data", () => {
    expect(resolveArkModel(INTL_25, "intl")).toEqual({
      id: INTL_25,
      region: "intl",
      minSeconds: 4,
      maxSeconds: 30,
      resolutions: ["480p", "720p", "1080p"],
      maxRefImages: 30,
      maxRefVideos: 10,
      maxRefAudios: 10,
      supportsSeed: true,
      supportsAudio: true,
      ratioFollowsImage: true,
      supportsDraft: true,
      price: { base: 10.7, withVideoInput: 6.4 },
      price1080: { base: 11.7, withVideoInput: 7 }
    });
    expect(resolveArkModel(CN_25, "cn")).toEqual({
      id: CN_25,
      region: "cn",
      minSeconds: 4,
      maxSeconds: 30,
      resolutions: ["480p", "720p", "1080p"],
      maxRefImages: 30,
      maxRefVideos: 10,
      maxRefAudios: 10,
      supportsSeed: true,
      supportsAudio: true,
      ratioFollowsImage: true,
      supportsDraft: true,
      price: { base: 70, withVideoInput: 42 },
      price1080: undefined
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

  it("accepts 1080p on 2.5", () => {
    expect(checkResolution(resolveArkModel(INTL_25, "intl"), "1080p")).toBe("1080p");
    expect(checkResolution(resolveArkModel(CN_25, "cn"), "1080p")).toBe("1080p");
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
    expect(intl).toEqual([INTL_20, INTL_FAST, INTL_MINI, INTL_25]);
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
