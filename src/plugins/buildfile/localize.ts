/**
 * @file buildfile localize — expands `locales` items into one item per locale and
 * resolves `$cast` members. Pure: no I/O, no ctx. `compileSource` calls it after
 * `itemsFrom` expansion and before the `$ref` graph check.
 */
import { LOCALE_PLACEHOLDER } from "./schema";
import type { BuildItem, BuildSpec } from "./types";

/** The slice of a `BuildSpec` the expansion reads: the locale set and the cast. */
export type LocalizeSpec = Pick<BuildSpec, "locales" | "cast">;

/** Either the expanded items, or the first problem as `"<path>: <message>"` (no trailing period). */
export type LocalizeResult = { items: BuildItem[]; sources: number[] } | { problem: string };

/** One cast member: base fields plus per-locale overrides under `locales`. */
type CastEntry = NonNullable<BuildSpec["cast"]>[string];

/** What the value walk needs to know about the item it is in. */
type Scope = {
  /** The locale being built, or `undefined` for an item that does not expand. */
  locale: string | undefined;
  /** Every locale a localized value may be keyed by (top-level list plus the item's own). */
  localeSet: ReadonlySet<string>;
  cast: Record<string, CastEntry>;
  /**
   * What `id` strings in this section must do about the locale placeholder: `require` it
   * (an expanding item's input), `forbid` it (a non-expanding item's input), or `ignore` it.
   */
  ids: "require" | "forbid" | "ignore";
};

/** The ONE internal failure the walk throws; `localizeItems` turns it into a `problem`. */
class LocalizeProblem extends Error {}

/** A trailing nine-slice hint, which the locale suffix must stay in front of. */
const TRAILING_NINE_HINT = /\{nine=\d+,\d+,\d+,\d+\}$/;

/**
 * Expands every item that names `locales` into one item per locale and
 * resolves `$cast` members in all items.
 *
 * @param spec - The build file's top-level `locales` and `cast`.
 * @param items - The build file's items, `itemsFrom` already merged in.
 * @returns The expanded items in order (each expanding item replaced in place by
 *   its locales) with `sources`, the index in `items` each output item came from, or
 *   `{ problem }` with the first error.
 * @example
 * ```ts
 * const result = localizeItems(
 *   { locales: ["ru", "en"] },
 *   [{ task: "voiceover", id: "line", locales: true, input: { text: { ru: "Да", en: "Yes" } } }]
 * );
 * // { items: [{ id: "line-ru", ... text: "Да" }, { id: "line-en", ... text: "Yes" }] }
 * ```
 */
export function localizeItems(spec: LocalizeSpec, items: readonly BuildItem[]): LocalizeResult {
  try {
    const expanded = items.map((item, index) => expandItem(item, index, spec));
    return {
      items: expanded.flat(),
      sources: expanded.flatMap((group, index) => group.map(() => index))
    };
  } catch (error) {
    if (error instanceof LocalizeProblem) return { problem: error.message };
    throw error;
  }
}

/**
 * Expands one item: into its locales when it names any, else into itself with `$cast` resolved.
 *
 * @param source - The item.
 * @param index - The item's position, for error paths.
 * @param spec - The build file's locales and cast.
 * @returns One item per locale, or the single resolved item (neither carries `locales`).
 * @example
 * ```ts
 * const door = { task: "image", id: "door", input: { prompt: "a door" }, locales: true };
 * expandItem(door, 0, { locales: ["ru", "en"] }).map(copy => copy.id); // => ["door-ru", "door-en"]
 * ```
 */
function expandItem(source: BuildItem, index: number, spec: LocalizeSpec): BuildItem[] {
  const { locales: own, ...item } = source;
  const cast = spec.cast ?? {};
  const locales = localesOf(own, index, spec);

  if (locales === undefined) {
    if (item.id?.includes(LOCALE_PLACEHOLDER)) throw placeholderWithoutLocales(`items.${index}.id`);
    const scope: Scope = { locale: undefined, localeSet: new Set(), cast, ids: "forbid" };
    return [withValues(item, index, scope)];
  }

  const { id } = item;
  if (id === undefined) throw problemAt(`items.${index}.id`, "a localized item needs an id");

  const localeSet = new Set([...(spec.locales ?? []), ...locales]);
  return locales.map(locale => {
    const scope: Scope = { locale, localeSet, cast, ids: "require" };
    return { ...withValues(item, index, scope), id: localizedId(id, locale) };
  });
}

/**
 * The locales an item expands over, validated against the top-level list.
 *
 * @param own - The item's own `locales` value.
 * @param index - The item's position, for error paths.
 * @param spec - The build file's locales.
 * @returns The locale list, or `undefined` when the item does not expand.
 * @throws {LocalizeProblem} When `true` has no top-level list, or an entry is not in it.
 * @example
 * ```ts
 * localesOf(true, 0, { locales: ["ru"] }); // => ["ru"]
 * ```
 */
function localesOf(
  own: BuildItem["locales"],
  index: number,
  spec: LocalizeSpec
): string[] | undefined {
  const path = `items.${index}.locales`;
  if (own === undefined) return undefined;

  if (own === true) {
    if (spec.locales === undefined) throw problemAt(path, "true needs a top-level locales list");
    return spec.locales;
  }

  const known = spec.locales;
  const missing = known === undefined ? undefined : own.find(l => !known.includes(l));
  if (missing !== undefined) {
    throw problemAt(path, `${JSON.stringify(missing)} is not in the top-level locales list`);
  }
  return own;
}

/**
 * An item's id for one locale: `${locale}` replaced, else `-L` appended in front of a nine-slice hint.
 *
 * @param id - The item's id.
 * @param locale - The locale code.
 * @returns The id for that locale.
 * @example
 * ```ts
 * localizedId("man-door", "ru"); // => "man-door-ru"
 * localizedId("button{nine=1,2,3,4}", "ru"); // => "button-ru{nine=1,2,3,4}"
 * ```
 */
function localizedId(id: string, locale: string): string {
  if (id.includes(LOCALE_PLACEHOLDER)) return id.replaceAll(LOCALE_PLACEHOLDER, locale);

  const hint = TRAILING_NINE_HINT.exec(id);
  if (hint === null) return `${id}-${locale}`;
  return `${id.slice(0, hint.index)}-${locale}${hint[0]}`;
}

/**
 * Copies an item with its `input` and `params` walked for the scope.
 *
 * @param item - The item.
 * @param index - The item's position, for error paths.
 * @param scope - The locale scope (a locale-less scope only resolves `$cast`).
 * @returns The new item.
 */
function withValues(item: BuildItem, index: number, scope: Scope): BuildItem {
  const { input, params, ...rest } = item;
  const base = `items.${index}`;
  const output: BuildItem = { ...rest, input: walkSection(input, [base, "input"], scope) };
  if (params === undefined) return output;

  const paramsScope: Scope = { ...scope, ids: "ignore" };
  return { ...output, params: walkSection(params, [base, "params"], paramsScope) };
}

/**
 * Walks an item's `input` or `params` and checks it is still an object afterwards
 * (a localized value at the section's root could pick a string).
 *
 * @param section - The raw `input` or `params`.
 * @param path - The section's path.
 * @param scope - The locale scope.
 * @returns The walked section.
 * @throws {LocalizeProblem} When the walk turned the section into something that is not an object.
 * @example
 * ```ts
 * walkSection({ text: "hi" }, ["items", "0", "input"], scope);
 * ```
 */
function walkSection(
  section: Record<string, unknown>,
  path: string[],
  scope: Scope
): Record<string, unknown> {
  const walked = walkValue(section, path, scope);
  if (!isPlainObject(walked)) throw problemAt(path.join("."), "must be an object");
  return walked;
}

/**
 * Walks one value: strings get the locale substituted, arrays and objects are
 * descended into, localized values are picked and `$cast` objects merged.
 *
 * @param value - Any value found in `input` or `params`.
 * @param path - Where it was found, for error messages.
 * @param scope - The locale scope.
 * @returns The resolved value.
 * @example
 * ```ts
 * walkValue("voice-${locale}", ["items", "0", "input", "voice"], scope);
 * ```
 */
function walkValue(value: unknown, path: string[], scope: Scope): unknown {
  if (typeof value === "string") return substitute(value, scope);
  if (Array.isArray(value)) {
    return value.map((entry: unknown, position) =>
      walkValue(entry, [...path, String(position)], scope)
    );
  }
  return isPlainObject(value) ? walkObject(value, path, scope) : value;
}

/**
 * Walks one plain object: localized-value check first, then `$cast`, then its entries.
 *
 * @param object - The object.
 * @param path - Where it was found.
 * @param scope - The locale scope.
 * @returns The resolved value (a localized value becomes its picked entry).
 * @example
 * ```ts
 * walkObject({ ru: "Да", en: "Yes" }, path, scope);
 * ```
 */
function walkObject(object: Record<string, unknown>, path: string[], scope: Scope): unknown {
  if (isLocalizedValue(object, scope))
    return walkValue(pickLocale(object, path, scope), path, scope);

  const resolved = Object.hasOwn(object, "$cast") ? mergeCast(object, path, scope) : object;
  const entries = Object.entries(resolved).map(([key, child]): [string, unknown] => {
    requireLocaleInId(key, child, [...path, key], scope);
    return [key, walkValue(child, [...path, key], scope)];
  });
  return Object.fromEntries(entries);
}

/**
 * Replaces the locale placeholder in a string; strings of a locale-less scope are left alone.
 *
 * @param text - The string.
 * @param scope - The locale scope.
 * @returns The string for the scope's locale.
 * @example
 * ```ts
 * substitute("voice-${locale}", scope); // => "voice-ru"
 * ```
 */
function substitute(text: string, scope: Scope): string {
  if (scope.locale === undefined) return text;
  return text.replaceAll(LOCALE_PLACEHOLDER, scope.locale);
}

/**
 * Whether an object is a localized value: non-empty, every key a known locale code.
 *
 * @param object - The object.
 * @param scope - The locale scope.
 * @returns True when the object is keyed only by locales (and the scope has a locale).
 * @example
 * ```ts
 * isLocalizedValue({ ru: "Да", en: "Yes" }, scope); // => true
 * isLocalizedValue({ width: 1 }, scope); // => false
 * ```
 */
function isLocalizedValue(object: Record<string, unknown>, scope: Scope): boolean {
  if (scope.locale === undefined) return false;
  const keys = Object.keys(object);
  return keys.length > 0 && keys.every(key => scope.localeSet.has(key));
}

/**
 * Takes the current locale's entry out of a localized value.
 *
 * @param object - The localized value.
 * @param path - Where it was found.
 * @param scope - The locale scope (its locale is set).
 * @returns The entry for the scope's locale.
 * @throws {LocalizeProblem} When the locale has no entry.
 * @example
 * ```ts
 * pickLocale({ ru: "Да", en: "Yes" }, path, scope);
 * ```
 */
function pickLocale(object: Record<string, unknown>, path: string[], scope: Scope): unknown {
  const locale = scope.locale ?? "";
  if (!Object.hasOwn(object, locale)) throw problemAt(path.join("."), `no "${locale}" value`);
  return object[locale];
}

/**
 * Replaces a `$cast: <name>` object by the cast member's fields; the object's own keys win.
 *
 * @param object - The object holding `$cast`.
 * @param path - Where it was found.
 * @param scope - The locale scope.
 * @returns The merged object, without the `$cast` key.
 * @throws {LocalizeProblem} When the cast has no such member.
 * @example
 * ```ts
 * mergeCast({ $cast: "alice", text: "hi" }, path, scope);
 * ```
 */
function mergeCast(
  object: Record<string, unknown>,
  path: string[],
  scope: Scope
): Record<string, unknown> {
  const { $cast: name, ...rest } = object;
  const entry =
    typeof name === "string" && Object.hasOwn(scope.cast, name) ? scope.cast[name] : undefined;
  if (entry === undefined) {
    throw problemAt([...path, "$cast"].join("."), `no cast member ${JSON.stringify(name)}`);
  }
  return { ...castFields(entry, scope.locale), ...rest };
}

/**
 * A cast member's fields for a locale: the base fields, shallow-merged with that locale's override.
 *
 * @param entry - The cast member.
 * @param locale - The locale, or `undefined` for the base fields only.
 * @returns The fields, without the `locales` key.
 * @example
 * ```ts
 * castFields({ voice: "a", locales: { en: { voice: "b" } } }, "en"); // => { voice: "b" }
 * ```
 */
function castFields(entry: CastEntry, locale: string | undefined): Record<string, unknown> {
  const { locales, ...base } = entry;
  const override = locale === undefined ? undefined : locales?.[locale];
  return { ...base, ...override };
}

/**
 * Checks an `id` string inside `input` against the locale placeholder: in a localized item it
 * must carry it (every locale would otherwise export to the same file), in an item that does
 * not expand it must not (no locale exists to fill it).
 *
 * @param key - The object key.
 * @param child - The value at that key (before the walk).
 * @param path - The path of the value.
 * @param scope - The locale scope.
 * @throws {LocalizeProblem} When the key is `id`, the value a string, and the placeholder is missing or misplaced.
 * @example
 * ```ts
 * requireLocaleInId("id", "line-1", path, scope);
 * ```
 */
function requireLocaleInId(key: string, child: unknown, path: string[], scope: Scope): void {
  const isIdString = key === "id" && typeof child === "string";
  if (scope.ids === "ignore" || !isIdString) return;

  const hasPlaceholder = child.includes(LOCALE_PLACEHOLDER);
  if (scope.ids === "forbid" && hasPlaceholder) throw placeholderWithoutLocales(path.join("."));
  if (scope.ids === "require" && !hasPlaceholder) {
    throw problemAt(path.join("."), `an id inside a localized item needs ${LOCALE_PLACEHOLDER}`);
  }
}

/**
 * The failure for a locale placeholder in an item that has no `locales`.
 *
 * @param path - The path of the id.
 * @returns The error to throw.
 * @example
 * ```ts
 * throw placeholderWithoutLocales("items.0.id");
 * ```
 */
function placeholderWithoutLocales(path: string): LocalizeProblem {
  return problemAt(path, `${LOCALE_PLACEHOLDER} needs locales on the item`);
}

/**
 * Whether a value is a plain object: a literal or a null-prototype object. Arrays, typed
 * arrays, dates and class instances are not, so a `.ts` build file's values pass through whole.
 *
 * @param value - Any value.
 * @returns True for `{...}`.
 * @example
 * ```ts
 * isPlainObject({}); // => true
 * isPlainObject(new Uint8Array(2)); // => false
 * ```
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Builds the internal failure for a path.
 *
 * @param path - The dotted path.
 * @param message - The message, no trailing period.
 * @returns The error to throw.
 * @example
 * ```ts
 * throw problemAt("items.0.id", "a localized item needs an id");
 * ```
 */
function problemAt(path: string, message: string): LocalizeProblem {
  return new LocalizeProblem(`${path}: ${message}`);
}
