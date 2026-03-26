# Frontend Performance Optimization Plan

Zero functional changes. All optimizations are internal refactors verified via multi-agent code audit (2 rounds, 4 hops).

## Phase 0: Measurement Baseline

Before any changes, capture baseline metrics:

- [ ] React/Preact DevTools Profiler recording for: chat message append, tab switch, sub-session card drag, quick-input panel open
- [ ] Lighthouse mobile score (Performance, LCP, TBT, CLS)
- [ ] `vite-bundle-visualizer` output — identify which deps are in initial chunk vs lazy
- [ ] Identify top-5 components by render count + render time in Profiler flamegraph

## Phase 1: Quick Wins (Low Risk, High Confidence)

### 1.1 Stabilize inline derived props in `app.tsx`

**Problem**: Multiple `subSessions.map(sub => ({...}))` calls create new array/object references on every render, defeating child component memoization.

**Locations**: `app.tsx` lines ~1760, ~1979, ~2158, ~2298 (4+ instances)

**Fix**: Wrap each in `useMemo`:
```typescript
const mappedSubSessions = useMemo(() =>
  subSessions.map(sub => ({ sessionName: sub.sessionName, type: sub.type, ... })),
  [subSessions]
);
```

**Risk**: Low — pure data identity optimization, no behavioral change.
**Verify**: Profiler shows reduced child component re-render count.

### 1.2 Verify `buildViewItems` memoization in `ChatView.tsx`

**Problem**: `buildViewItems(events)` performs O(n) filtering, deduplication, tool-call merging, and assistant-text grouping. If not memoized, runs on every render.

**Location**: `ChatView.tsx` ~line 291

**Action**: Confirm `useMemo(() => buildViewItems(events), [events])` exists. If missing, add it (one-line fix). If already memoized, the leverage point is upstream — ensuring `events` reference only changes on actual data changes (see 1.4).

**Risk**: Low.

### 1.3 Memoize chat sub-components with `memo()`

**Problem**: `ChatEvent`, `ThinkingEvent`, `ChatTime` are plain functions. Every parent render triggers their render, including `splitPathsAndUrls` regex scanning per message.

**Location**: `ChatView.tsx` ~lines 843-1015

**Fix**: Wrap with `memo()`:
```typescript
const ChatEvent = memo(function ChatEvent({ event, nextTs, onPathClick, serverId }) { ... });
```

**Dependency**: Requires 1.1 first — `memo()` only works if parent props are referentially stable. Without stable props, `memo()` is a no-op.

**Risk**: Low — no behavioral change.
**Verify**: Profiler confirms ChatEvent render count drops to ~0 when no new events arrive.

### 1.4 Fix `useTimeline` unnecessary state setter invocations

**Problem**: Echo dedup calls `setEvents((prev) => { ... return prev; })` — invoking the state setter even when returning the same array. This schedules unnecessary React work.

**Location**: `useTimeline.ts` ~lines 250-265

**Fix**: Move dedup logic outside the state setter; only call `setEvents` when the array actually changes.

**Risk**: Low.

### 1.5 Optimize `SubSessionBar` ordering

**Problem**: `orderedIds.filter(id => subSessions.some(s => s.id === id))` is O(n²). Drag handler calls `setOrderedIds` on every pixel movement (60+ state updates/sec).

**Location**: `SubSessionBar.tsx` ~lines 192-196, ~lines 470-483

**Fix**:
- Replace `.some()` with `Set` lookup — O(n)
- Debounce drag: use ref during drag, commit to state on drop

**Risk**: Low.

### 1.6 Replace `backdrop-filter: blur()` on mobile

**Problem**: `backdrop-filter: blur(8px)` forces GPU rasterization of the entire subtree behind the blur. Causes visible jank on mid-range mobile devices when opening quick-input panel.

**Location**: `styles.css` ~line 214

**Fix**: Replace with solid semi-transparent background:
```css
.qp-backdrop {
  background: rgba(0, 0, 0, 0.7);
  /* backdrop-filter: blur(8px); — removed for mobile perf */
}
```

**Risk**: Low — visual-only change. Verify the overlay still looks acceptable.

## Phase 2: Bundle Optimization (Medium Risk)

### 2.1 Lazy-load heavy optional dependencies

**Candidates** (verify sizes with `vite-bundle-visualizer` in Phase 0):
- `marked` — only used in ChatMarkdown / DiscussionsPage
- `highlight.js` — only used in code block rendering
- `dompurify` — only used in markdown output sanitization
- `xterm` — only used in TerminalView

**Fix**: Dynamic `import()` at component level:
```typescript
const { marked } = await import('marked');
```

**Risk**: Medium — async loading may cause flash of unstyled content. Need loading fallback UI.

### 2.2 SessionControls render isolation

**Problem**: 17 `useState` hooks — any keystroke triggers `setHasText` which re-renders the entire component including all modals, pickers, and upload UI.

**Fix**: Split into sub-components:
- `SessionControlsInput` — fast path (text input, hasText, @ detection)
- `SessionControlsModals` — slow path (voice overlay, file browser, upload progress)

This isolates fast-changing input state from slow, heavy UI. **Not** state grouping (which doesn't reduce render count).

**Risk**: Medium — requires careful prop threading.

## Phase 3: Architecture (Higher Risk, Needs Profiling)

### 3.1 WS dispatch async fan-out

**Problem**: `ws-client.ts` dispatches to all handlers synchronously. A slow handler blocks subsequent handlers on the main thread.

**Location**: `ws-client.ts` ~lines 618-624

**Fix**: Use `queueMicrotask()` for non-critical handlers:
```typescript
for (const h of this.handlers) {
  queueMicrotask(() => { try { h(msg); } catch {} });
}
```

**Risk**: Higher — changes message delivery ordering. Needs thorough regression testing.
**Gate**: Only implement if Phase 0 profiling shows handler fan-out as a measurable bottleneck.

### 3.2 Event immutability audit

**Problem**: `useTimeline` mutates event objects in-place (`event.hidden = true`). This breaks `memo()` assumptions — a memoized component may hold a stale reference to a mutated object.

**Locations**: `useTimeline.ts` ~lines 250-266, `ChatView.tsx` ~lines 82-100

**Fix**: Clone events before mutation, or use an external `hiddenIds` Set instead of mutating.

**Risk**: Medium — requires careful audit of all event mutation sites.
**Gate**: Required before Phase 1.3 `memo()` can be fully reliable.

## Known Non-Issues (Removed from Plan)

- ~~ChatView timer re-renders entire tree~~ — Timer is inside `ActiveThinkingLabel` only, not full tree.
- ~~Capacitor plugins loaded in web~~ — Already guarded with `isNative()` dynamic imports.
- ~~SessionControls state grouping~~ — Grouping `useState` hooks doesn't reduce render count; render isolation (2.2) is the correct approach.

## Verification Criteria

After each phase:
- [ ] Re-capture Profiler flamegraph — confirm reduced render count/time for target components
- [ ] Re-run Lighthouse mobile — confirm no regression, ideally improvement
- [ ] Manual smoke test: chat message send/receive, tab switch, file browse, sub-session drag, terminal input
- [ ] No i18n regressions (all 7 locales)
- [ ] No functional changes — same UX, same features
