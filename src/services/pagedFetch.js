/**
 * services/pagedFetch.js
 * Reads every page of a paged list API faster than one page after another:
 * the first page says how many pages there are, then the rest are fetched
 * a few at a time. The result is in page order, exactly as a sequential read
 * would give it. (Token refresh is already serialized per user in
 * services/authManager.js, so parallel calls can't race a rotating refresh token.)
 *
 * fetchPage(index) -> { items: [...], totalPages }  (index is 0-based; only the
 * first page's totalPages is used). `concurrency` pages are in flight at once —
 * kept small to stay friendly to Revizto's and Autodesk's rate limits.
 */
const DEFAULT_CONCURRENCY = 4;

async function fetchAllPages(fetchPage, { concurrency = DEFAULT_CONCURRENCY } = {}) {
  const first = await fetchPage(0);
  const totalPages = Math.max(1, Number(first.totalPages) || 1);
  const pages = [first.items || []];
  for (let start = 1; start < totalPages; start += concurrency) {
    const indexes = [];
    for (let i = start; i < Math.min(start + concurrency, totalPages); i++) indexes.push(i);
    const batch = await Promise.all(indexes.map((i) => fetchPage(i)));
    for (const page of batch) pages.push(page.items || []);
  }
  return pages.flat();
}

module.exports = { fetchAllPages, DEFAULT_CONCURRENCY };
