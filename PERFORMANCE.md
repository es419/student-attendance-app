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
