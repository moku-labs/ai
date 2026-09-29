import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  EstimateInput,
  EstimateRequest,
  VideoFile,
  VideoRequest
} from "../../../video/contract";
import { TerminalProviderError } from "../../errors";
import type { InputUrls, SeedanceBody, SubmitBody } from "../../video/models";
import {
  apimodelsAliases,
  buildBody,
  checkRequest,
  requestResolution,
  requestSeconds,
  resolveModel
} from "../../video/models";
import { PROMPT, thrownBy } from "./fixtures";

/** A fake resolved file (bodies and checks never read it). */
function file(name: string, mimeType = "image/png"): VideoFile {
  return { path: `/store/${name}`, mimeType, hash: `${name}-hash` };
}

const IMAGE = file("anna.png");
const END = file("end.png");

/** Upload URLs with only a first frame. */
const URLS: InputUrls = {
  image: "https://files/anna.png",
  imageRefs: [],
  audioRefs: [],
  videoRefs: []
};

/** Asserts `work` throws a terminal 400 with exactly `message`. */
function expectTerminal400(work: () => unknown, message: string): void {
  const error = thrownBy(work);
  expect(error).toBeInstanceOf(TerminalProviderError);
  expect((error as TerminalProviderError).status).toBe(400);
  expect((error as Error).message).toBe(message);
}

/** Runs checkRequest for `request` on its own model. */
function check(request: EstimateRequest): void {
  checkRequest(resolveModel(request.model), request);
}

/** `count` refs still unresolved (estimate time). */
function unresolved(count: number): EstimateInput[] {
  return Array.from({ length: count }, (_, index) => ({ $file: `refs/${index}.mp3` }));
}

describe("catalog", () => {
  it("serves the four Seedance aliases in order", () => {
    expect(apimodelsAliases()).toEqual([
      "seedance-2.5",
      "seedance-2.5-ref",
      "seedance-2.0",
      "seedance-2.0-ref"
    ]);
  });

  it("maps 2.5 aliases to model seedance-2.5 and 2.0 aliases to seedance-2.0-official", () => {
    expect(resolveModel("seedance-2.5").apiModel).toBe("seedance-2.5");
    expect(resolveModel("seedance-2.5-ref").apiModel).toBe("seedance-2.5");
    expect(resolveModel("seedance-2.0").apiModel).toBe("seedance-2.0-official");
    expect(resolveModel("seedance-2.0-ref").apiModel).toBe("seedance-2.0-official");
  });

  it("refuses an unknown alias with a terminal 400 listing the aliases", () => {
    expectTerminal400(
      () => resolveModel("veo-3.1"),
      '[ai] Unknown apimodels video model "veo-3.1".\n  Use one of: seedance-2.5, seedance-2.5-ref, seedance-2.0, seedance-2.0-ref.'
    );
  });

  it("refuses inherited object keys as aliases", () => {
    expect(() => resolveModel("toString")).toThrow(TerminalProviderError);
  });

  it("defaults to 5 seconds and 720p", () => {
    const request = { model: "seedance-2.0", prompt: "p" };
    expect(requestSeconds(request)).toBe(5);
    expect(requestResolution(resolveModel("seedance-2.0"), request)).toBe("720p");
    expect(
      requestResolution(resolveModel("seedance-2.0"), { ...request, resolution: "1080p" })
    ).toBe("1080p");
  });
});

describe("buildBody field mapping", () => {
  it("seedance-2.5: image → first_frame_url, endImage → last_frame_url, no aspect_ratio", () => {
    const request: VideoRequest = {
      model: "seedance-2.5",
      prompt: PROMPT,
      image: IMAGE,
      endImage: END
    };
    expect(
      buildBody(resolveModel("seedance-2.5"), request, {
        ...URLS,
        endImage: "https://files/end.png"
      })
    ).toEqual({
      model: "seedance-2.5",
      prompt: PROMPT,
      resolution: "720p",
      duration: 5,
      generate_audio: false,
      first_frame_url: "https://files/anna.png",
      last_frame_url: "https://files/end.png"
    });
  });

  it("seedance-2.0: the same fields, model seedance-2.0-official, no last_frame_url without an end frame", () => {
    const request: VideoRequest = {
      model: "seedance-2.0",
      prompt: PROMPT,
      image: IMAGE,
      seconds: 10,
      resolution: "1080p",
      aspect: "16:9",
      audio: false
    };
    expect(buildBody(resolveModel("seedance-2.0"), request, URLS)).toEqual({
      model: "seedance-2.0-official",
      prompt: PROMPT,
      resolution: "1080p",
      duration: 10,
      generate_audio: false,
      first_frame_url: "https://files/anna.png"
    });
  });

  it("seedance-2.5-ref: image leads reference_image_urls, audio and video refs get their own fields", () => {
    const request: VideoRequest = { model: "seedance-2.5-ref", prompt: PROMPT, image: IMAGE };
    const urls: InputUrls = {
      image: "asset://asset-1",
      imageRefs: ["https://files/ben.png"],
      audioRefs: ["https://files/voice.mp3"],
      videoRefs: ["https://files/tail.mp4"]
    };
    expect(buildBody(resolveModel("seedance-2.5-ref"), request, urls)).toEqual({
      model: "seedance-2.5",
      prompt: PROMPT,
      resolution: "720p",
      duration: 5,
      aspect_ratio: "9:16",
      generate_audio: false,
      reference_image_urls: ["asset://asset-1", "https://files/ben.png"],
      reference_audio_urls: ["https://files/voice.mp3"],
      reference_video_urls: ["https://files/tail.mp4"]
    });
  });

  it("seedance-2.0-ref: no audio or video fields when there are no such refs", () => {
    const request: VideoRequest = {
      model: "seedance-2.0-ref",
      prompt: PROMPT,
      image: IMAGE,
      aspect: "1:1"
    };
    expect(buildBody(resolveModel("seedance-2.0-ref"), request, URLS)).toEqual({
      model: "seedance-2.0-official",
      prompt: PROMPT,
      resolution: "720p",
      duration: 5,
      aspect_ratio: "1:1",
      generate_audio: false,
      reference_image_urls: ["https://files/anna.png"]
    });
  });

  it("sends generate_audio: false by default (video contract), true only when the request asks", () => {
    const request: VideoRequest = { model: "seedance-2.5", prompt: PROMPT, image: IMAGE };
    const model = resolveModel("seedance-2.5");

    expect(buildBody(model, request, URLS).generate_audio).toBe(false);
    expect(buildBody(model, { ...request, audio: true }, URLS).generate_audio).toBe(true);
  });

  it("merges params last and strips the reserved assets key", () => {
    const request: VideoRequest = {
      model: "seedance-2.5",
      prompt: PROMPT,
      image: IMAGE,
      params: { assets: ["image"], output_format: "mov", duration: 6 }
    };
    const body = buildBody(resolveModel("seedance-2.5"), request, URLS);
    expect(body.output_format).toBe("mov");
    expect(body.duration).toBe(6);
    expect(body).not.toHaveProperty("assets");
  });

  it("never sends the negative prompt (not supported upstream)", () => {
    const request: VideoRequest = {
      model: "seedance-2.5",
      prompt: PROMPT,
      image: IMAGE,
      negative: "blur"
    };
    expect(JSON.stringify(buildBody(resolveModel("seedance-2.5"), request, URLS))).not.toContain(
      "blur"
    );
  });
});

describe("SeedanceBody", () => {
  it("types the fixed body fields; only the merged params stay open", () => {
    const body = buildBody(
      resolveModel("seedance-2.5"),
      { model: "seedance-2.5", prompt: "p" },
      URLS
    );

    expectTypeOf(body).toMatchTypeOf<SeedanceBody>();
    expectTypeOf(body.duration).toEqualTypeOf<number>();
    expectTypeOf(body.generate_audio).toEqualTypeOf<boolean>();
    expectTypeOf<SeedanceBody["reference_image_urls"]>().toEqualTypeOf<string[] | undefined>();
    expect(body.first_frame_url).toBe("https://files/anna.png");
  });

  it("refuses a fixed field of the wrong type", () => {
    const body: SeedanceBody = {
      model: "seedance-2.5",
      prompt: "p",
      resolution: "720p",
      // @ts-expect-error -- duration is a number of seconds, never text
      duration: "5",
      generate_audio: false
    };
    expect(body.duration).toBe("5");
  });

  it("refuses a misspelled fixed field: the fixed body is closed", () => {
    const body: SeedanceBody = {
      model: "seedance-2.5",
      prompt: "p",
      resolution: "720p",
      duration: 5,
      generate_audio: false,
      // @ts-expect-error -- the field is first_frame_url; a closed body catches the typo
      first_frame: "asset://a1"
    };
    expect(body).toHaveProperty("first_frame", "asset://a1");
  });

  it("opens only the merged params, and only for reading", () => {
    const body = buildBody(
      resolveModel("seedance-2.5"),
      { model: "seedance-2.5", prompt: "p", params: { output_format: "mov" } },
      URLS
    );

    expectTypeOf(buildBody).returns.toEqualTypeOf<SubmitBody>();
    expect(body.output_format).toBe("mov");
    // @ts-expect-error -- a pass-through param is read, never written after the merge
    body.output_format = "mp4";
  });
});

describe("checkRequest", () => {
  it("needs an image on every alias", () => {
    for (const model of apimodelsAliases()) {
      expectTerminal400(
        () => check({ model, prompt: "p" }),
        `[ai] apimodels model "${model}" needs an image.\n  Set input.image to a $ref or $file.`
      );
    }
  });

  it("refuses an end frame on the -ref aliases", () => {
    expectTerminal400(
      () => check({ model: "seedance-2.5-ref", prompt: "p", image: IMAGE, endImage: END }),
      '[ai] apimodels model "seedance-2.5-ref" takes no end frame.\n  Remove input.endImage, or use a model that takes one: seedance-2.5, seedance-2.0.'
    );
    expect(() =>
      check({ model: "seedance-2.0", prompt: "p", image: IMAGE, endImage: END })
    ).not.toThrow();
  });

  it("refuses refs on the plain aliases, but not an empty list", () => {
    expectTerminal400(
      () => check({ model: "seedance-2.0", prompt: "p", image: IMAGE, refs: [file("ben.png")] }),
      '[ai] apimodels model "seedance-2.0" takes no refs.\n  Remove input.refs, or use a model that takes them: seedance-2.5-ref, seedance-2.0-ref.'
    );
    expect(() =>
      check({ model: "seedance-2.5", prompt: "p", image: IMAGE, refs: [] })
    ).not.toThrow();
  });

  it("refuses a resolution outside the alias list", () => {
    expectTerminal400(
      () => check({ model: "seedance-2.5", prompt: "p", image: IMAGE, resolution: "1080p" }),
      '[ai] apimodels model "seedance-2.5" has no resolution "1080p".\n  Set input.resolution to one of: 480p, 720p.'
    );
    expect(() =>
      check({ model: "seedance-2.0-ref", prompt: "p", image: IMAGE, resolution: "1080p" })
    ).not.toThrow();
  });

  it.each([
    ["seedance-2.5", 3, "4 to 30"],
    ["seedance-2.5", 31, "4 to 30"],
    ["seedance-2.5-ref", 4.5, "4 to 30"],
    ["seedance-2.0", 16, "4 to 15"],
    ["seedance-2.0-ref", 0, "4 to 15"]
  ])("refuses %s with %d seconds", (model, seconds, range) => {
    expectTerminal400(
      () => check({ model, prompt: "p", image: IMAGE, seconds }),
      `[ai] apimodels model "${model}" takes ${range} seconds, got ${seconds}.\n  Set input.seconds to a whole number from ${range}.`
    );
  });

  it("accepts the range ends", () => {
    expect(() =>
      check({ model: "seedance-2.5", prompt: "p", image: IMAGE, seconds: 30 })
    ).not.toThrow();
    expect(() =>
      check({ model: "seedance-2.0", prompt: "p", image: IMAGE, seconds: 4 })
    ).not.toThrow();
  });

  it("counts the first frame in the reference image limit", () => {
    const eight = Array.from({ length: 8 }, (_, index) => file(`ref${index}.png`));
    expect(() =>
      check({ model: "seedance-2.0-ref", prompt: "p", image: IMAGE, refs: eight })
    ).not.toThrow();
    expectTerminal400(
      () =>
        check({
          model: "seedance-2.0-ref",
          prompt: "p",
          image: IMAGE,
          refs: [...eight, file("x.png")]
        }),
      '[ai] apimodels model "seedance-2.0-ref" takes at most 9 reference images (input.image included), got 10.\n  Remove refs from input.refs, or use a model that takes more.'
    );
    const thirty = Array.from({ length: 30 }, (_, index) => file(`ref${index}.png`));
    expect(() =>
      check({ model: "seedance-2.5-ref", prompt: "p", image: IMAGE, refs: thirty.slice(1) })
    ).not.toThrow();
    expect(() =>
      check({ model: "seedance-2.5-ref", prompt: "p", image: IMAGE, refs: thirty })
    ).toThrow("takes at most 30 reference images (input.image included), got 31.");
  });

  it("limits audio and video refs to 10 each, told apart by MIME", () => {
    const audio = Array.from({ length: 11 }, (_, index) => file(`a${index}.mp3`, "audio/mpeg"));
    const videos = Array.from({ length: 11 }, (_, index) => file(`v${index}.mp4`, "video/mp4"));
    expectTerminal400(
      () => check({ model: "seedance-2.5-ref", prompt: "p", image: IMAGE, refs: audio }),
      '[ai] apimodels model "seedance-2.5-ref" takes at most 10 reference audio files, got 11.\n  Remove refs from input.refs, or use a model that takes more.'
    );
    expectTerminal400(
      () => check({ model: "seedance-2.0-ref", prompt: "p", image: IMAGE, refs: videos }),
      '[ai] apimodels model "seedance-2.0-ref" takes at most 10 reference videos, got 11.\n  Remove refs from input.refs, or use a model that takes more.'
    );
    expect(() =>
      check({
        model: "seedance-2.0-ref",
        prompt: "p",
        image: IMAGE,
        refs: [...audio.slice(1), ...videos.slice(1)]
      })
    ).not.toThrow();
  });

  it("at estimate time, counts unresolved refs only against the total, never as images", () => {
    const image = { $file: "cast/anna.png" };
    expect(() =>
      check({ model: "seedance-2.0-ref", prompt: "p", image, refs: unresolved(25) })
    ).not.toThrow();
    expectTerminal400(
      () => check({ model: "seedance-2.0-ref", prompt: "p", image, refs: unresolved(29) }),
      '[ai] apimodels model "seedance-2.0-ref" takes at most 29 inputs in total (input.image included), got 30.\n  Remove refs from input.refs, or use a model that takes more.'
    );
  });

  it("refuses refs on a plain alias even when they are unresolved", () => {
    expect(() =>
      check({ model: "seedance-2.5", prompt: "p", image: IMAGE, refs: [{ $ref: "s01.key" }] })
    ).toThrow("takes no refs.");
  });
});
