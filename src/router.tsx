import React, {
    createContext,
    memo,
    ReactNode,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
} from 'react';
import { pathToRegexp } from 'path-to-regexp';
import { stringify } from 'query-string';
import { nanoid } from 'nanoid';

// From: https://stackoverflow.com/questions/40510611/typescript-interface-require-one-of-two-properties-to-exist
type RequireAtLeastOne<T, Keys extends keyof T = keyof T> = Pick<T, Exclude<keyof T, Keys>> &
    {
        [K in Keys]-?: Required<Pick<T, K>> & Partial<Pick<T, Exclude<Keys, K>>>;
    }[Keys];

// The params parsed from the path matcher for a route. Ie the params from the variable/wildcard
// parts of a routes `match` attribute.
export type MatchParams = Record<string, string> | null;

// Our own internal location to keep things simple
export interface RouterLocation {
    pathname: string;
    search: string;
}

// The params needed by the useLocation setter func
interface LocationSetterParams {
    pathname?: string;
    search?: Record<string, any> | string;
}
// The location setter function
export type LocationChanger = (params: LocationSetterParams) => void;

// Guards
export type Guards = ArrayGuards;
type ArrayGuards = Guard[];
export type Guard = (params: GuardParams) => Promise<any>;
export interface GuardParams {
    route: Route;
    redirect: LocationChanger;
    location: RouterLocation;
}

// Resolvers
export type Resolvers = ArrayResolvers;
type ArrayResolvers = ObjectResolvers[];
type ObjectResolvers = Record<string, any>;
export type Resolver = (params: ResolverParams) => Promise<any>;
export interface ResolverParams {
    route: Route;
    redirect: LocationChanger;
    location: RouterLocation;
}

// Route structure
type ComponentOrChildren = RequireAtLeastOne<{
    component: React.ComponentType<any>;
    children: Route[];
}>;
export type RouteWithoutIds = {
    match: string;
    resolvers?: Resolvers;
    guards?: Guards;
} & ComponentOrChildren;

type RouteWithIds = {
    id: string;
    children?: RouteWithIds[];
} & RouteWithoutIds;
export type Route = RouteWithIds | RouteWithoutIds;

//
// The router state. Should always be in sync with the url
interface RouterState {
    routes: RouteWithIds[];
    location: RouterLocation;
    currentMatch: { hierarchy: string[]; params: MatchParams | null };
    hierarchyMap: HierarchyMap;
    routeStates: Record<string, RouteState>;
}

// A mapping of path matchers (ie /profile/{id}/settings) to
// a list of route ids that represent the routes to render
// for a given path
type HierarchyMap = Record<string, string[]>;

// Route state that tracks a routes guarding and resolving status
export type RouteState = {
    loading: boolean;
    resolvedData: Record<string, any>;
    completed: boolean;
};

// The props passed to each route component. Ie the `component` property on each Route
// will get these.
export type RouteComponentProps = {
    route: RouteWithIds;
    routeState: RouteState;
    children?: ReactNode;
};

const RouterContext = createContext<
    [RouterState | null, React.Dispatch<React.SetStateAction<RouterState>> | null]
>([null, null]);

// HELPERS

const cancellablePromise = (promise: Promise<any>) => {
    let isCancelled = false;

    const wrappedPromise = new Promise((resolve, reject) => {
        promise
            .then((...args) => !isCancelled && resolve(...args))
            .catch((error) => !isCancelled && reject(error));
    });

    return {
        promise: wrappedPromise,
        cancel() {
            isCancelled = true;
        },
    };
};

/**
 * Allows you to merge two paths without thinking
 * to hard about leading/trailing slashes
 */
const mergePaths = (left: string, right: string) => {
    const leftSlash = left.charAt(left.length - 1) === '/';
    const rightSlash = right.charAt(0) === '/';
    if (leftSlash && rightSlash) {
        return left + right.substring(1);
    }
    if ((leftSlash && !rightSlash) || (!leftSlash && rightSlash)) {
        return left + right;
    }

    return `${left}/${right}`;
};

/**
 * Given a path, grab the associated hierarchy from
 * the hierarchy map
 */
const matchHierarchy = (
    path: string,
    hierarchyMap: HierarchyMap
): { hierarchy: string[]; params: MatchParams | null } => {
    for (const [matchPath, hierarchy] of Object.entries(hierarchyMap)) {
        if (typeof matchPath === 'string') {
            if (matchPath === '*') {
                return { hierarchy, params: null };
            }

            const [regexMatch, params] = matchesRegex(path, matchPath);
            if (regexMatch) {
                return { hierarchy, params };
            }
        }
    }

    // eslint-disable-next-line
    console.error('No route found');

    return { hierarchy: [], params: null };
};

/**
 * Whether or not a route needs to go through preloading (guarding/resolving)
 */
const needsPreloading = (route: Route): boolean => {
    const hasGuards = route.guards && route.guards.length > 0;
    const hasResolvers = route.resolvers && route.resolvers.length > 0;

    return Boolean(hasGuards || hasResolvers);
};

/**
 * Builds the hierarchy map from the routes object
 */
const buildHierarchyMap = (routes: RouteWithIds[]): HierarchyMap => {
    const map: HierarchyMap = {};
    for (const route of routes) {
        if (route.children) {
            const childMap = buildHierarchyMap(route.children);

            for (const [childMatch, childHierarchy] of Object.entries(childMap)) {
                map[mergePaths(route.match, childMatch)] = [route.id, ...childHierarchy];
            }
        }

        map[route.match] = [route.id];
    }

    return map;
};

/**
 * Checks if a path matches a path matcher and returns the
 * url params if the path matches
 */
const matchesRegex = (path: string, matchPath: string): [boolean, MatchParams] => {
    const keys: any[] = [];

    // TODO: cache
    const regex = pathToRegexp(matchPath, keys);
    const regexResult = regex.exec(path);

    if (!regexResult) {
        return [false, null];
    }

    const params = keys.reduce((p, key, i) => {
        // eslint-disable-next-line
        p[key.name] = regexResult[i + 1];
        return p;
    }, {});

    return [true, params];
};

/**
 * Converts a location into a clean routerState object
 *
 * This function is expensive and should only be called when necessary
 */
const routerStateFromLocation = (
    routes: RouteWithIds[],
    location: RouterLocation,
    previous?: RouterState
): RouterState => {
    const hierarchyMap = buildHierarchyMap(routes);
    const currentMatch = matchHierarchy(location.pathname, hierarchyMap);

    // Copy routeStates if the route still exists
    // in the hierarchy
    const routeStates: Record<string, RouteState> = {};
    Object.entries(previous?.routeStates || {}).forEach(([id, state]) => {
        if (currentMatch.hierarchy.includes(id)) {
            routeStates[id] = state;
        }
    });

    // Init new routeStates
    mapHierarchyToRoutes(currentMatch.hierarchy, routes).forEach((route) => {
        if (!(route.id in routeStates)) {
            routeStates[route.id] = {
                loading: needsPreloading(route),
                resolvedData: {},
                completed: false,
            };
        }
    });

    return {
        routes,
        location,
        currentMatch,
        hierarchyMap,
        routeStates,
    };
};

/**
 * Converts a location into a RouerLocation
 */
const getRouterLocationFromLocation = (location: Location): RouterLocation => ({
    pathname: location.pathname,
    search: location.search,
});

/**
 * Helper method to great a search string
 * from an object
 */
const buildSearchString = (search: string | Record<string, any>) => {
    let newSearch;
    if (typeof search === 'string') {
        if (search.charAt(0) === '?') {
            newSearch = search;
        } else {
            newSearch = `?${search}`;
        }
    } else {
        newSearch = `?${stringify(search)}`;
    }

    return newSearch;
};

const addIdsToRoutes = (routes: Route[]): RouteWithIds[] => {
    const newRoutes: RouteWithIds[] = routes.map((route) => {
        if (route.children) {
            return {
                ...route,
                children: addIdsToRoutes(route.children),
                id: 'id' in route ? route.id : nanoid(),
            };
        }

        return {
            ...(route as RouteWithIds), // stupid ts
            id: 'id' in route ? route.id : nanoid(),
        };
    });

    return newRoutes;
};

const mapHierarchyToRoutes = (hierarchy: string[], routes: RouteWithIds[]): RouteWithIds[] => {
    let routeList: RouteWithIds[] = [];
    const currentHierarchy = [...hierarchy];
    const id = currentHierarchy.shift();

    for (const route of routes) {
        if (route.id === id) {
            routeList.push(route);

            if (route.children && currentHierarchy.length === 0) {
                throw new Error(
                    `Hierachy does not match routes object. Found route ${route.id} with children and no hierarchy`
                );
            } else if (!route.children && currentHierarchy.length > 0) {
                throw new Error(
                    `Hierachy does not match routes object. Found route ${route.id} with no children and hierarchy ${currentHierarchy}`
                );
            } else if (route.children) {
                const childRoutes = mapHierarchyToRoutes(currentHierarchy, route.children);
                routeList = routeList.concat(childRoutes);
            }
        }
    }

    return routeList;
};

const preloadRoute = (
    route: Route,
    location: RouterLocation,
    redirect: LocationChanger,
    setRouteState: (state: RouteState) => void
) => {
    const guardPromise = (route.guards || []).reduce(
        (prom, guard) => prom.then(() => guard({ route, redirect, location })),
        Promise.resolve()
    );

    const resolvePromise = (route.resolvers || []).reduce((prom, resolverObject) => {
        const resolvedData: Record<string, any> = {};
        const resolvePromises = Object.entries(resolverObject).map(([key, resolver]) =>
            resolver({ route, redirect, location }).then((result: any) => {
                resolvedData[key] = result;
            })
        );

        return Promise.all(resolvePromises).then(() => resolvedData);
    }, Promise.resolve());

    const preloadPromise = guardPromise.then(() => resolvePromise);

    preloadPromise.then((resolvedData) => {
        setRouteState({ loading: false, resolvedData, completed: true });
    });

    return cancellablePromise(preloadPromise);
};

export const preloadPath = async (
    routes: Route[],
    location: RouterLocation,
    redirect: LocationChanger
) => {
    const routesWithIds = addIdsToRoutes(routes);

    const routerState = routerStateFromLocation(routesWithIds, location);

    const { hierarchy } = routerState.currentMatch;

    const routeList = mapHierarchyToRoutes(hierarchy, routesWithIds);

    let redirected = false;
    const wrappedRedirect: LocationChanger = (params) => {
        redirected = true;
        return redirect(params);
    };

    let preloadCancel;
    for (const route of routeList) {
        if (redirected) {
            break;
        }

        const setRouteState = (state: RouteState) => {
            routerState.routeStates[route.id] = state;
        };

        const { promise, cancel } = preloadRoute(route, location, wrappedRedirect, setRouteState);

        preloadCancel = cancel;

        // eslint-disable-next-line
        await promise;
    }

    if (redirected) {
        if (preloadCancel) preloadCancel();
        return null;
    }

    return routerState;
};

// HOOKS

const useComponentCache = (): Record<string, React.ComponentType<any>> => {
    const cache = useRef({});
    return cache.current;
};

const useRouterState = () => {
    const [routerState, setRouterState] = useContext(RouterContext);

    if (!routerState || !setRouterState) {
        throw new Error(
            'Invalid use of a router hook outside of the router context. Did put the <Router /> component at the root of your application?'
        );
    }

    return [routerState, setRouterState] as [typeof routerState, typeof setRouterState];
};

const useCurrentMatch = () => {
    const [routerState] = useRouterState();

    if (!routerState.currentMatch.hierarchy.length) {
        throw new Error(
            "Trying to access route when none has been found. Did you remember to have a '*' catch-all?"
        );
    }

    return routerState.currentMatch;
};

export const useParams = () => {
    const { params } = useCurrentMatch();

    return params;
};

export const useLocation = (): [RouterLocation, LocationChanger] => {
    const [routerState, setRouterState] = useRouterState();

    // Todo maybe not needed?
    const setRouterLocationState = useCallback(
        (stateBuilder: (state: RouterLocation) => RouterLocation) => {
            setRouterState((oldState) => {
                const newLocationState = stateBuilder(oldState.location);
                return routerStateFromLocation(routerState.routes, newLocationState, oldState);
            });
        },
        [routerState, setRouterState]
    );

    const locationSetter = useCallback(({ pathname, search }: LocationSetterParams) => {
        const newState: Partial<RouterLocation> = {};

        if (search) {
            newState.search = buildSearchString(search);
        }

        if (pathname) {
            newState.pathname = pathname;
        }

        setRouterLocationState((oldState) => {
            const newLocationState = { ...oldState, ...newState };
            return newLocationState;
        });
    }, []);

    return [routerState.location, locationSetter];
};

const useLocationSync = () => {
    const [routerState, setRouterLocation] = useRouterState();
    const { routes } = routerState;

    // This useEffect syncs the routerStates location to the
    // browser history and url. This will only be run
    // from navigation via the useLocation hooks setter
    // as other regular browser navigation (back button) will be picked
    // up by the pop state listener
    useEffect(() => {
        if (
            location.pathname === routerState.location.pathname &&
            location.search === routerState.location.search
        ) {
            return;
        }

        window.history.pushState(
            null,
            '',
            routerState.location.pathname + routerState.location.search
        );
    }, [routerState.location]);

    // This listener will be called whenever the window popstate
    // event occurs (ie when the user hits the back button).
    // It updates the router state from the new location
    const popStateListener = useCallback(() => {
        setRouterLocation((oldState) => ({
            ...oldState,
            ...getRouterLocationFromLocation(location),
        }));
    }, [routes, setRouterLocation]);

    // This ref and useEffect will keep the correct popStateListener
    // actively subscribed to the window popstate event
    // so that we can properly handle the back button
    const previousPopstateListener = useRef(popStateListener);
    useEffect(() => {
        // Skip remove on initial render
        if (previousPopstateListener.current !== popStateListener) {
            window.removeEventListener('popstate', previousPopstateListener.current);
        }
        window.addEventListener('popstate', popStateListener);
        previousPopstateListener.current = popStateListener;
    }, [popStateListener]);
};

/**
 * This hooks differs from the useRouterState hook in
 * that it sets up the router state such that this hooks return value
 * can be passed directly to the RouterContext.Provider.
 * This hook should only be used once in the Router component,
 * useRouterState should be used everywhere else to read the router state
 *
 */
const useInitialRouterState = (routes: RouteWithoutIds[], initial?: RouterState) => {
    const routesWithIds = useMemo(() => addIdsToRoutes(routes), [routes]);

    const [routerState, setRouterState] = useState<RouterState>(() => {
        if (initial) return initial;

        return routerStateFromLocation(routesWithIds, getRouterLocationFromLocation(location));
    });

    return [routerState, setRouterState] as [typeof routerState, typeof setRouterState];
};

/**
 * This hook takes the hierarchy of
 * routes that should be rendered and converts it
 * into a list of components that should be rendered
 */
const useCurrentMatchComponents = () => {
    const [routerState] = useRouterState();
    const { hierarchy } = useCurrentMatch();
    const componentCache = useComponentCache();

    const { routes } = routerState;

    const routeList = useMemo(() => mapHierarchyToRoutes(hierarchy, routes), [hierarchy, routes]);

    const components = useMemo(() => {
        for (const id of Object.keys(componentCache)) {
            if (!hierarchy.includes(id)) {
                delete componentCache[id];
            }
        }

        const componentsList = routeList.map((route) => {
            if (route.id in componentCache) {
                return componentCache[route.id];
            }

            const component = withRoutePreloader(route);
            component.displayName = route.id;
            componentCache[route.id] = component;
            return component;
        });

        componentsList.reverse();
        return componentsList;
    }, [routeList, componentCache, hierarchy]);

    return components;
};

export const useRouteState = (route: RouteWithIds) => {
    const [routerState, setRouterState] = useRouterState();
    const { routeStates } = routerState;

    const setRouteState = useCallback(
        (state: RouteState) => {
            setRouterState((old) => ({
                ...old,
                routeStates: {
                    ...old.routeStates,
                    [route.id]: state,
                },
            }));
        },
        [setRouterState, route]
    );

    if (route.id in routeStates) {
        // type ResolverType = typeof route.resolvers;
        // type ResolverItems = ResolverType extends Iterable<Promise<infer X>> ? X : never;
        const routeState = routeStates[route.id];
        return [routeState, setRouteState] as [
            // RouteState<ResolvedData<typeof route.resolvers>>,
            typeof routeState,
            typeof setRouteState
        ];
    }

    throw new Error(`Attempt to access uninitialized routeState. Route ${route.id}`);
};

// const resolvers = [Promise.resolve({ a: 'green' }), Promise.resolve({ b: 1 })];
// type ResolverType = typeof resolvers;
// type ResolverItems = ResolverType extends Iterable<Promise<infer X>> ? X : never;

// Black magic https://stackoverflow.com/questions/50374908/transform-union-type-to-intersection-type
// type UnionToIntersection<U> = (U extends any ? (k: U) => void : never) extends (k: infer I) => void
//     ? I
//     : never;
// type ResolvedObject = ResolverItems extends infer O ? { [K in keyof O]: O[K] } : never;
// type ResolvedObject = UnionToIntersection<ResolverItems>;

// type ResolvedData<RT> = RT extends Iterable<Promise<Record<string, any>>>
//     ? UnionToIntersection<RT extends Iterable<Promise<infer X>> ? X : {}>
//     : {};

const useRoutePreload = (route: RouteWithIds) => {
    const [locationState, setLocationState] = useLocation();
    const [routeState, setRouteState] = useRouteState(route);

    useEffect(() => {
        if (routeState.completed) {
            return () => null;
        }

        const { cancel } = preloadRoute(route, locationState, setLocationState, setRouteState);

        // Cancel preload promises if the component is unmounted
        return () => {
            cancel();
        };
    }, []);
};

// ROUTER

export const Router = memo(
    ({
        routes: nonStaticRoutes,
        initialRouterState,
    }: {
        routes: Route[];
        initialRouterState?: RouterState;
    }) => {
        // Make routes static. Routes should not be dynamic
        const routes = useMemo(() => nonStaticRoutes, []);

        const [routerState, setRouterLocationState] = useInitialRouterState(
            routes,
            initialRouterState
        );

        return (
            <RouterContext.Provider value={[routerState, setRouterLocationState]}>
                <RouterConsumer />
            </RouterContext.Provider>
        );
    }
);

/**
 * The consumer is separate from the Router
 * as it consumes the router context instead of providing
 * the context. So the main reason for this component
 * is that we can just call useRouterState
 */
const RouterConsumer = memo(() => {
    useLocationSync();

    const components = useCurrentMatchComponents();

    let componentToRender = null;
    for (const Component of components) {
        componentToRender = <Component>{componentToRender}</Component>;
    }

    return componentToRender;
});

/**
 * This HOC handles the guarding and resolving of routes,
 * as well as defining and updating the routeState based
 * on the guarding and resolving status
 */
const withRoutePreloader = (route: RouteWithIds) =>
    memo(({ children }: { children: any }) => {
        useRoutePreload(route);

        if (route.component) {
            return <route.component route={route}>{children}</route.component>;
        }

        return children;
    });

// LINK

export const Link = ({
    to,
    onClick = () => null,
    children = null,
    ...rest
}: {
    to: string;
    children?: React.ReactNode;
    onClick?: (event: any) => void;
}) => {
    const [_, setLocation] = useLocation();

    const handleClick = useCallback(
        (event) => {
            if (
                event.ctrlKey ||
                event.metaKey ||
                event.altKey ||
                event.shiftKey ||
                event.button !== 0
            ) {
                return;
            }

            event.preventDefault();

            setLocation({ pathname: to });

            if (onClick) {
                onClick(event);
            }
        },
        [onClick, setLocation]
    );

    return (
        <a href={to} onClick={handleClick} {...rest}>
            {children}
        </a>
    );
};
