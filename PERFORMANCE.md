# Performance changes

This build keeps Supabase and optimizes the startup path instead of migrating backends.

## What changed

- Reduced the forced splash-screen minimum from ~620 ms to ~120 ms.
- The splash no longer blocks on the network. If no local snapshot exists, the app shell and its loading state appear immediately.
- Added a per-user/per-month local snapshot for settings, current month data, and active shift.
- Repeat launches render the cached snapshot immediately and revalidate from Supabase in the background.
- Reused the authenticated session user id instead of repeatedly calling `auth.getUser()`.
- Initial Supabase data still loads in one `kv_store` query for settings, current month, and active shift.
- Added DNS prefetch / cross-origin preconnect for the Supabase project.
- Bumped the service-worker cache version so the optimized shell replaces the previous cached build.
- Kept XLSX lazy-loaded; it is still not part of the startup path.

## Expected effect

On repeat launches, UI rendering no longer waits for a Supabase round trip. On a first launch/login, the shell appears immediately and the data fills in when the single initial query returns.

## Instant-launch cache update

- Navigation now uses the cached `index.html` immediately and refreshes it in the background instead of waiting on the network.
- Service-worker registration starts in `index.html`, before the Supabase runtime is requested.
- The Supabase browser runtime is version-pinned and pre-cached by the service worker; repeat launches no longer need the CDN to start the app.
- Static app-shell assets still use stale-while-revalidate, so cached files render immediately while fresh copies are prepared for later requests.
- Old attendance shell caches are removed without deleting unrelated caches on the same origin.
- Attendance writes remain server-confirmed; no optimistic/fake confirmation was added to check-in or check-out.
