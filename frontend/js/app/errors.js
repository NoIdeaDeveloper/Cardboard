/**
 * Map a fetch/API error to a friendly, user-facing message, extracted from
 * app.js. Pure apart from reading navigator.onLine.
 */
export function classifyError(err) {
  if (err && err.name === 'AbortError') return 'Request timed out — try again.';
  if (!navigator.onLine)  return 'No internet connection — check your network.';
  if (!err.status)        return 'Network error — the server may be unreachable.';
  if (err.status === 400) return `Bad request: ${err.message}`;
  if (err.status === 401) return 'Not authorised — please refresh the page.';
  if (err.status === 403) return 'Access denied.';
  if (err.status === 409) return err.message;
  if (err.status === 422) return `Validation error: ${err.message}`;
  if (err.status === 404) return 'Not found — this item may have been deleted.';
  if (err.status >= 500)  return 'Server error — try again in a moment.';
  if (err.status >= 400)  return `Error ${err.status}: ${err.message}`;
  return err.message;
}
