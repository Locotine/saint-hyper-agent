// FILE: useCommittedPathname.ts
// Purpose: Pathname of the route that is actually rendered, for shell code that also reads params.
// Layer: Web routing hook
// Exports: resolveCommittedPathname, useCommittedPathname

import { useRouter, useRouterState } from "@tanstack/react-router";

interface CommittedPathnameRouterState {
  readonly isLoading: boolean;
  readonly location: { readonly pathname: string };
  readonly resolvedLocation?: { readonly pathname: string } | undefined;
  readonly matches?: ReadonlyArray<{ readonly id: string }> | undefined;
}

/** The pathname a subscriber last reported and the matches it was reported with. */
export interface CommittedPathnameHold {
  readonly pathname: string;
  readonly matchId: string | undefined;
}

/**
 * TanStack Router publishes a navigation as several store updates: `location` first
 * (with `isLoading: true`), then the new `matches`, then `isLoading: false`. Router
 * 1.171 commits the matches while `isLoading` is still set, so the pathname follows
 * whichever comes first: new matches or the end of loading. Holding it until then
 * makes it change in the update that also changes `useParams`/`useSearch`.
 *
 * The value is `location.pathname` itself, never a match's `pathname`: matches carry
 * the interpolated route path (`/pull-requests/` for an index route, re-encoded params,
 * no unmatched tail), which is not string-identical to the location.
 */
export function resolveCommittedPathname(
  state: CommittedPathnameRouterState,
  held: CommittedPathnameHold | null,
): CommittedPathnameHold {
  const matchId = state.matches?.at(-1)?.id;
  if (!state.isLoading || (held !== null && matchId !== held.matchId)) {
    return { pathname: state.location.pathname, matchId };
  }
  // No pathname held yet means the first subscriber mounted mid-navigation; the
  // last resolved location is the closest record of what the rendered matches show.
  return held ?? { pathname: (state.resolvedLocation ?? state.location).pathname, matchId };
}

// Shared per router so every subscriber reports the same pathname, including one
// that mounts while a navigation is pending.
const heldPathnameByRouter = new WeakMap<object, CommittedPathnameHold>();

/**
 * Like `useLocation({ select: (location) => location.pathname })`, but it changes in
 * the same commit as the route params instead of one render earlier, so pathname and
 * params never disagree and a navigation renders the subscriber once.
 */
export function useCommittedPathname(): string {
  const router = useRouter();
  return useRouterState({
    select: (state) => {
      const held = resolveCommittedPathname(state, heldPathnameByRouter.get(router) ?? null);
      heldPathnameByRouter.set(router, held);
      return held.pathname;
    },
  });
}
