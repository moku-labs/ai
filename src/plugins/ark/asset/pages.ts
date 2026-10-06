/**
 * @file Shared numbered pagination for Ark's asset and group lists.
 */
import { readField, readNumber } from "../client";

/** Items requested on each numbered page. */
const PAGE_SIZE = 100;

/**
 * Visits every numbered page, counting all returned items toward TotalCount.
 *
 * @param requestPage - Fetches a page by number and size.
 * @param visitPage - Consumes the page's untrusted items.
 * @returns Resolves after a short page or after TotalCount items.
 * @example
 * ```ts
 * await walkAssetPages(
 *   (PageNumber, PageSize) => openApiCall(ctx, "ListAssets", {
 *     Filter: { GroupType: "AIGC" }, PageNumber, PageSize
 *   }),
 *   items => assets.push(...items)
 * );
 * ```
 */
export async function walkAssetPages(
  requestPage: (pageNumber: number, pageSize: number) => Promise<unknown>,
  visitPage: (items: unknown[]) => void
): Promise<void> {
  let pageNumber = 1;
  let seen = 0;

  for (;;) {
    const result = await requestPage(pageNumber, PAGE_SIZE);
    const rawItems = readField(result, "Items");
    const items: unknown[] = Array.isArray(rawItems) ? rawItems : [];
    visitPage(items);

    // Pagination counts every returned item, including entries we cannot use.
    seen += items.length;
    const totalCount = readNumber(result, "TotalCount");
    const isLastPage = items.length < PAGE_SIZE || (totalCount !== undefined && seen >= totalCount);
    if (isLastPage) return;
    pageNumber += 1;
  }
}
