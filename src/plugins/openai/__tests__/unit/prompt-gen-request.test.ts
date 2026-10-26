import { describe, expect, it } from "vitest";
import type { ChatMessage, ContentPart, PromptGenRequest } from "../../../promptGen/contract";
import { TerminalProviderError } from "../../errors";
import { buildResponsesBody, estimateInputTokens, planResponses } from "../../prompt-gen/request";
import type { OpenaiReasoningItem, OpenaiResponsesRequestBody } from "../../types";

/** `ChatMessage.content` of a tool-only assistant turn is null by contract. */
// eslint-disable-next-line unicorn/no-null -- see comment above
const NO_TEXT = null;

/**
 * A text part with a cache mark.
 *
 * @param text - The text.
 * @returns The part.
 */
function marked(text: string): ContentPart {
  return { type: "text", text, cache: true };
}

/** The configured default model (`config.models.chat`). */
const DEFAULT_MODEL = "gpt-4o-mini";

/** The explicit cache breakpoint of a marked part. */
const MARK = { mode: "explicit" };

/** An image part of a message. */
const IMAGE = { type: "image" as const, path: "a.png", mimeType: "image/png", hash: "h" };

/**
 * The body of a request, with no remembered turns unless given.
 *
 * @param request - The prompt-gen request.
 * @param imageUrls - Data URLs of its images.
 * @param turns - Remembered reasoning items.
 * @returns The Responses body.
 */
function bodyOf(
  request: PromptGenRequest,
  imageUrls: string[] = [],
  turns: Map<string, OpenaiReasoningItem[]> = new Map()
): OpenaiResponsesRequestBody {
  return buildResponsesBody(request, planResponses(request, DEFAULT_MODEL), imageUrls, turns);
}

/**
 * The error a planning call throws.
 *
 * @param request - The request to plan.
 * @returns The thrown value.
 */
function planError(request: PromptGenRequest): unknown {
  try {
    planResponses(request, DEFAULT_MODEL);
  } catch (error) {
    return error;
  }
  throw new Error("expected planResponses to throw");
}

describe("openai unit: prompt-gen request (Responses mapping)", () => {
  describe("planResponses — checks before any I/O", () => {
    it.each<[string, PromptGenRequest, string]>([
      ["a blank prompt", { prompt: "  " }, "needs a non-empty prompt"],
      ["empty messages", { prompt: "p", messages: [] }, "messages must not be empty"],
      [
        "a bad reasoning value",
        { prompt: "p", params: { reasoning: "max" } },
        "params.reasoning must be"
      ],
      [
        "a schema that is not an object",
        { prompt: "p", params: { responseSchema: [] } },
        "responseSchema must be"
      ],
      [
        "params.images with messages",
        { prompt: "", messages: [{ role: "user", content: "hi" }], params: { images: [] } },
        "takes no params.images with messages"
      ],
      [
        "an image without a hash",
        { prompt: "p", params: { images: [{ path: "a.png", mimeType: "image/png" }] } },
        "params.images must be local files"
      ]
    ])("refuses %s with a terminal 400", (_label, request, text) => {
      const error = planError(request);

      expect(error).toBeInstanceOf(TerminalProviderError);
      expect((error as TerminalProviderError).status).toBe(400);
      expect((error as Error).message).toContain(text);
    });

    it("takes the configured default model, and drops the openai/ alias prefix", () => {
      expect(planResponses({ prompt: "p" }, DEFAULT_MODEL).model).toBe("gpt-4o-mini");
      expect(planResponses({ prompt: "p", model: "openai/gpt-6-astra" }, DEFAULT_MODEL).model).toBe(
        "gpt-6-astra"
      );
    });

    it("takes params.max_tokens when a positive integer, else 32 000", () => {
      expect(
        planResponses({ prompt: "p", params: { max_tokens: 128_000 } }, DEFAULT_MODEL)
          .maxOutputTokens
      ).toBe(128_000);
      expect(
        planResponses({ prompt: "p", params: { max_tokens: 0 } }, DEFAULT_MODEL).maxOutputTokens
      ).toBe(32_000);
    });

    it("lists one params.images file or a list, and with messages every image part in message order", () => {
      const file = { path: "a.png", mimeType: "image/png", hash: "h" };
      const parts: ChatMessage[] = [
        {
          role: "user",
          content: [
            { type: "text", text: "x" },
            { ...IMAGE, path: "1.png" }
          ]
        },
        { role: "tool", toolCallId: "c", content: [{ ...IMAGE, path: "2.png" }] }
      ];

      expect(
        planResponses({ prompt: "p", params: { images: file } }, DEFAULT_MODEL).images
      ).toEqual([file]);
      expect(
        planResponses({ prompt: "", messages: parts }, DEFAULT_MODEL).images.map(
          image => image.path
        )
      ).toEqual(["1.png", "2.png"]);
    });
  });

  describe("buildResponsesBody", () => {
    it("is never stored and caps the output at max_output_tokens", () => {
      const body = bodyOf({ prompt: "hi" });

      expect(body).toEqual({
        model: "gpt-4o-mini",
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
        store: false,
        max_output_tokens: 32_000
      });
    });

    it("puts the prompt text first, then one input_image per data URL", () => {
      const body = bodyOf(
        {
          prompt: "Rate it.",
          params: { images: [{ path: "a", mimeType: "image/png", hash: "h" }] }
        },
        ["data:a"]
      );

      expect(body.input).toEqual([
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "Rate it." },
            { type: "input_image", image_url: "data:a", detail: "auto" }
          ]
        }
      ]);
    });

    it("marks the developer message with cacheSystem on GPT-6 models only", () => {
      const request = { prompt: "hi", system: "Bible.", cacheSystem: true };

      const gpt6 = bodyOf({ ...request, model: "gpt-6-sol" });
      const plain = bodyOf({ prompt: "hi", system: "Bible." });

      expect(gpt6.input[0]).toEqual({
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: "Bible.", prompt_cache_breakpoint: MARK }]
      });
      expect(bodyOf(request)).toEqual(plain);
    });

    it("keeps the first 4 cache marks in request order, the system first", () => {
      const body = bodyOf({
        prompt: "",
        model: "gpt-6-astra",
        system: "S",
        cacheSystem: true,
        messages: [
          {
            role: "user",
            content: [
              marked("a"),
              marked("b"),
              { type: "text", text: "plain" },
              marked("c"),
              marked("d")
            ]
          }
        ]
      });

      expect(body.input[1]).toEqual({
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "a", prompt_cache_breakpoint: MARK },
          { type: "input_text", text: "b", prompt_cache_breakpoint: MARK },
          { type: "input_text", text: "plain" },
          { type: "input_text", text: "c", prompt_cache_breakpoint: MARK },
          { type: "input_text", text: "d" }
        ]
      });
    });

    it("maps user, assistant and tool turns; image parts take the data URLs in order", () => {
      const body = bodyOf(
        {
          prompt: "",
          messages: [
            { role: "user", content: [{ type: "text", text: "Check." }, IMAGE] },
            { role: "assistant", content: "Looking." },
            {
              role: "tool",
              toolCallId: "call_1",
              content: [{ type: "text", text: "Frame." }, IMAGE]
            },
            { role: "tool", toolCallId: "call_2", content: "plain result" }
          ]
        },
        ["data:1", "data:2"]
      );

      expect(body.input).toEqual([
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "Check." },
            { type: "input_image", image_url: "data:1", detail: "auto" }
          ]
        },
        { type: "message", role: "assistant", content: "Looking." },
        {
          type: "function_call_output",
          call_id: "call_1",
          output: [
            { type: "input_text", text: "Frame." },
            { type: "input_image", image_url: "data:2", detail: "auto" }
          ]
        },
        { type: "function_call_output", call_id: "call_2", output: "plain result" }
      ]);
    });

    it("sends an assistant tool turn as remembered reasoning, its text, then function calls without ids", () => {
      const reasoning: OpenaiReasoningItem = {
        type: "reasoning",
        id: "rs_1",
        summary: [],
        encrypted_content: "E"
      };
      const turn: ChatMessage = {
        role: "assistant",
        content: "Let me look.",
        toolCalls: [
          { id: "call_1", name: "read_frame", input: { shot: 3 } },
          { id: "call_2", name: "read_frame", input: undefined }
        ]
      };

      const remembered = bodyOf(
        { prompt: "", messages: [turn] },
        [],
        new Map([["call_1", [reasoning]]])
      );
      const forgotten = bodyOf({ prompt: "", messages: [turn] });

      const calls = [
        { type: "function_call", call_id: "call_1", name: "read_frame", arguments: '{"shot":3}' },
        { type: "function_call", call_id: "call_2", name: "read_frame", arguments: "{}" }
      ];
      const text = { type: "message", role: "assistant", content: "Let me look." };
      expect(remembered.input).toEqual([reasoning, text, ...calls]);
      expect(forgotten.input).toEqual([text, ...calls]);
    });

    it("maps tools to non-strict function tools and every toolChoice", () => {
      const tools = [
        { name: "read_frame", description: "One frame.", inputSchema: { type: "object" } }
      ];
      const choiceOf = (toolChoice: PromptGenRequest["toolChoice"]) =>
        bodyOf({ prompt: "p", tools, ...(toolChoice === undefined ? {} : { toolChoice }) })
          .tool_choice;

      expect(bodyOf({ prompt: "p", tools }).tools).toEqual([
        {
          type: "function",
          name: "read_frame",
          description: "One frame.",
          parameters: { type: "object" },
          strict: false
        }
      ]);
      expect(bodyOf({ prompt: "p", tools: [] })).not.toHaveProperty("tools");
      expect([
        choiceOf("auto"),
        choiceOf("none"),
        choiceOf("required"),
        choiceOf({ name: "read_frame" })
      ]).toEqual(["auto", "none", "required", { type: "function", name: "read_frame" }]);
      expect(bodyOf({ prompt: "p", tools })).not.toHaveProperty("tool_choice");
    });

    it.each<[string, string | undefined, string]>([
      ["gpt-6-astra", "off", "low"],
      ["gpt-6.1-sol", "off", "low"],
      ["gpt-6-sol", "off", "none"],
      ["gpt-6-luna", "off", "none"],
      ["gpt-6-astra", "low", "low"],
      ["gpt-6-astra", "high", "high"],
      ["gpt-6-luna", undefined, "medium"]
    ])("sends %s reasoning %s as effort %s, asks for the encrypted reasoning, never a temperature", (model, reasoning, effort) => {
      const params = reasoning === undefined ? {} : { reasoning };

      const body = bodyOf({ prompt: "p", model, temperature: 0.7, params });

      expect(body.reasoning).toEqual({ effort });
      expect(body.include).toEqual(["reasoning.encrypted_content"]);
      expect(body).not.toHaveProperty("temperature");
    });

    it("sends no reasoning to a gpt-4o model and forwards its temperature only when set", () => {
      const withTemperature = bodyOf({
        prompt: "p",
        model: "gpt-4o",
        temperature: 0.7,
        params: { reasoning: "high" }
      });
      const without = bodyOf({ prompt: "p", model: "gpt-4o" });

      expect(withTemperature.temperature).toBe(0.7);
      expect(withTemperature).not.toHaveProperty("reasoning");
      expect(withTemperature).not.toHaveProperty("include");
      expect(without).not.toHaveProperty("temperature");
    });

    it("maps params.responseSchema to a json_schema text format, strict from params.strictSchema", () => {
      const schema = { type: "object", properties: { n: { type: "number" } } };

      const loose = bodyOf({ prompt: "p", params: { responseSchema: schema } });
      const strict = bodyOf({
        prompt: "p",
        params: { responseSchema: schema, strictSchema: true }
      });

      expect(loose.text).toEqual({
        format: { type: "json_schema", name: "answer", schema, strict: false }
      });
      expect(strict.text?.format.strict).toBe(true);
      expect(bodyOf({ prompt: "p" })).not.toHaveProperty("text");
    });
  });

  describe("estimateInputTokens", () => {
    it("counts chars/4 of every turn's text and tool-call arguments plus 1 600 per image", () => {
      const tokens = estimateInputTokens(
        {
          prompt: "ignored",
          system: "sys",
          messages: [
            { role: "user", content: [{ type: "text", text: "abc" }, IMAGE] },
            {
              role: "assistant",
              content: NO_TEXT,
              toolCalls: [{ id: "c", name: "t", input: { a: 1 } }]
            }
          ]
        },
        1
      );

      // "sys\nabc\n{\"a\":1}" is 15 characters: 4 tokens.
      expect(tokens).toBe(4 + 1600);
    });
  });
});
