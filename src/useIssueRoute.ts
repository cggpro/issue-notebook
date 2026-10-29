import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

export type IssueRoute = string | null;
const routeFromLocation = (): IssueRoute => window.location.pathname.match(/^\/issues\/(new|ISSUE-\d{4,})\/?$/)?.[1] || null;
const routePath = (id: IssueRoute) => id ? `/issues/${id}` : '/';

/** Small, local navigation: shareable issue URLs without another framework. */
export function useIssueRoute() {
  const [issueId, setIssueId] = useState(routeFromLocation);
  const current = useRef(issueId);
  const index = useRef<number>(window.history.state?.issueNoteIndex ?? 0);
  const beforeLeave = useRef<() => boolean>(() => true);
  const restoring = useRef(false);
  const listScroll = useRef(0);
  const previousRestoration = useRef(window.history.scrollRestoration);

  useEffect(() => {
    window.history.replaceState({ ...window.history.state, issueNoteIndex: index.current }, '', window.location.href);
    window.history.scrollRestoration = 'manual';
    const onPop = (event: PopStateEvent) => {
      if (restoring.current) { restoring.current = false; return; }
      const nextIndex = event.state?.issueNoteIndex ?? 0;
      const nextId = routeFromLocation();
      if (nextId !== current.current && !beforeLeave.current()) {
        const delta = index.current - nextIndex;
        if (delta) { restoring.current = true; window.history.go(delta); }
        else window.history.replaceState({ ...event.state, issueNoteIndex: index.current }, '', routePath(current.current));
        return;
      }
      if (!current.current) listScroll.current = window.scrollY;
      index.current = nextIndex; current.current = nextId; setIssueId(nextId);
    };
    window.addEventListener('popstate', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
      window.history.scrollRestoration = previousRestoration.current;
    };
  }, []);

  useLayoutEffect(() => {
    window.scrollTo({ top: issueId ? 0 : listScroll.current, behavior: 'instant' });
  }, [issueId]);

  const navigate = useCallback((id: IssueRoute, options: { replace?: boolean; saved?: boolean } = {}) => {
    if (id === current.current) return true;
    if (!options.saved && !beforeLeave.current()) return false;
    if (!current.current) listScroll.current = window.scrollY;
    if (!options.replace) index.current += 1;
    window.history[options.replace ? 'replaceState' : 'pushState']({ issueNoteIndex: index.current }, '', routePath(id));
    current.current = id; setIssueId(id);
    return true;
  }, []);

  const registerGuard = useCallback((guard: () => boolean) => {
    beforeLeave.current = guard;
    return () => { if (beforeLeave.current === guard) beforeLeave.current = () => true; };
  }, []);

  return { issueId, navigate, registerGuard };
}
