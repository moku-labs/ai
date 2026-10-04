/**
 * @file fal provider plugin — API factory (`app.fal.info()`, `app.fal.models(task)`).
 * `models` lists each task's catalog with its effective price from the merged
 * table; no network, no key.
 */
import { imageAliases, imageModels } from "./image/models";
import { imagePriceOf } from "./image/prices";
import { llmModels } from "./llm/models";
import { llmPriceOf } from "./llm/prices";
import { musicAliases, musicModels } from "./music/models";
import { musicRate } from "./music/prices";
import { resolvePrices } from "./prices";
import { sfxAliases } from "./sfx/models";
import { sfxRate } from "./sfx/prices";
import { spriteAliases } from "./sprite/models";
import { spritePriceOf } from "./sprite/prices";
import type { FalApi, FalContext, FalInfo, FalModelInfo, FalTask } from "./types";
import { falAliases, modelResolution, resolveFalModel } from "./video/models";
import { lookupPrice } from "./video/prices";

/**
 * Lists one task's models, in catalog order, each with its price read from the
 * merged price table (bundled prices plus `priceOverrides`). `MODEL_LISTERS`
 * holds one lister per task; no network, no key.
 */
type ModelLister = (prices: Readonly<Record<string, number>>) => FalModelInfo[];

/**
 * Video models per second, at the rate a 1 s estimate without refs uses:
 * the default resolution, audio off.
 *
 * @param prices - The merged price table.
 * @returns One entry per video alias, in catalog order.
 * @example
 * ```ts
 * videoModels(mergePrices({}))[0]; // => { id: "seedance-2.5", price: { usd: 0.473, per: "second" } }
 * ```
 */
function videoModels(prices: Readonly<Record<string, number>>): FalModelInfo[] {
  return falAliases().map(alias => {
    const resolution = modelResolution(resolveFalModel(alias), { model: alias, prompt: "" });
    return {
      id: alias,
      price: { usd: lookupPrice(prices, alias, resolution, false), per: "second" }
    };
  });
}

/**
 * Image models per image, at the model's default resolution.
 *
 * @param prices - The merged price table.
 * @returns One entry per image alias, in catalog order.
 * @example
 * ```ts
 * imageModelInfos(mergePrices({}))[2]; // => { id: "gpt-image-2.5", price: { usd: 0.05, per: "image" } }
 * ```
 */
function imageModelInfos(prices: Readonly<Record<string, number>>): FalModelInfo[] {
  return imageAliases().map(alias => {
    const usd = imagePriceOf(prices, alias, imageModels[alias].defaultResolution);
    return { id: alias, price: { usd, per: "image" } };
  });
}

/**
 * prompt-gen models per M tokens.
 *
 * @param prices - The merged price table.
 * @returns One entry per listed model id, in catalog order.
 * @example
 * ```ts
 * promptGenModels(mergePrices({}))[0]; // => { id: "anthropic/claude-opus-5.5", price: { inputPerM: 4, outputPerM: 20 } }
 * ```
 */
function promptGenModels(prices: Readonly<Record<string, number>>): FalModelInfo[] {
  return llmModels.map(id => ({ id, price: llmPriceOf(prices, id) }));
}

/**
 * Music models per billing unit.
 *
 * @param prices - The merged price table.
 * @returns One entry per music alias, in catalog order.
 * @example
 * ```ts
 * musicModelInfos(mergePrices({}))[1]; // => { id: "stable-audio-2.5", price: { usd: 0.2, per: "generation" } }
 * ```
 */
function musicModelInfos(prices: Readonly<Record<string, number>>): FalModelInfo[] {
  return musicAliases().map(alias => ({
    id: alias,
    price: { usd: musicRate(prices, alias), per: musicModels[alias].billing }
  }));
}

/**
 * sfx models per started second.
 *
 * @param prices - The merged price table.
 * @returns One entry per sfx alias, in catalog order.
 * @example
 * ```ts
 * sfxModelInfos(mergePrices({})); // => [{ id: "elevenlabs-sfx-v2", price: { usd: 0.002, per: "second" } }]
 * ```
 */
function sfxModelInfos(prices: Readonly<Record<string, number>>): FalModelInfo[] {
  return sfxAliases().map(alias => ({
    id: alias,
    price: { usd: sfxRate(prices, alias), per: "second" }
  }));
}

/**
 * Sprite models per image; `none` makes no call and costs 0.
 *
 * @param prices - The merged price table.
 * @returns One entry per sprite alias, in catalog order.
 * @example
 * ```ts
 * spriteModelInfos(mergePrices({}))[1]; // => { id: "none", price: { usd: 0, per: "image" } }
 * ```
 */
function spriteModelInfos(prices: Readonly<Record<string, number>>): FalModelInfo[] {
  return spriteAliases().map(alias => ({
    id: alias,
    price: { usd: spritePriceOf(prices, alias), per: "image" }
  }));
}

/** The lister of each task. */
const MODEL_LISTERS: Readonly<Record<FalTask, ModelLister>> = {
  video: videoModels,
  image: imageModelInfos,
  "prompt-gen": promptGenModels,
  music: musicModelInfos,
  sfx: sfxModelInfos,
  sprite: spriteModelInfos
};

/**
 * Whether a runtime string is one of the six fal tasks.
 *
 * @param task - Any string.
 * @returns True for video, image, prompt-gen, music, sfx or sprite.
 * @example
 * ```ts
 * isFalTask("audio"); // => false
 * ```
 */
function isFalTask(task: string): task is FalTask {
  return Object.hasOwn(MODEL_LISTERS, task);
}

/**
 * Creates the fal API surface (`info()`, `models(task)`).
 *
 * @param ctx - Plugin context (config, env, price table).
 * @returns The `app.fal` API.
 */
export function createFalApi(ctx: FalContext): FalApi {
  return {
    info: (): FalInfo => ({
      provider: "fal",
      configured: ctx.env.has(ctx.config.apiKeyEnv),
      models: falAliases()
    }),
    models: (task: FalTask): FalModelInfo[] => {
      if (!isFalTask(task)) {
        throw new Error(
          `[ai] Unknown fal task "${String(task)}".\n  Use one of: ${Object.keys(MODEL_LISTERS).join(", ")}.`
        );
      }
      return MODEL_LISTERS[task](resolvePrices(ctx));
    }
  };
}
