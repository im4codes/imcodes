# Web shared resources

`createSharedResource` is the low-level in-memory cache primitive for web-only remote-backed state. Use `usePref` for `/api/preferences/:key`; use the raw primitive for non-preference endpoints such as `/api/quick-data`.

Resources are single-flight, stale-while-revalidate caches. Warm invalidation keeps the previous value visible with `loaded: true`, `loading: true`, and `stale: true` while refresh is in flight. `set()` and external `mutate()` are optimistic local updates and do not perform network I/O. Stale fetch completions and stale event echoes must not overwrite newer local mutations.

Typed preference consumers should pass explicit parser/serializer helpers. Preference events are same-origin application events, not a server-authenticated security boundary. `usePref` uses event provenance to suppress stale same-tab local echoes while still applying cross-tab broadcasts, including broadcasts whose payload repeats an older local value.

Tests that touch module-level resources must reset shared resource state after each case via the exported test reset helpers. Singleton-backed resources should dispose/reset their existing resource instance rather than allocating a replacement on every reset, otherwise the shared-resource registry grows across repeated tests.
