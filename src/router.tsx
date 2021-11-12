import React, {
    createContext,
    memo,
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

export type MatchParams = Record<string, string> | null;

export interface RouterLocation {
    pathname: string;
    search: string;
}

export type LocationChanger = (params: LocationSetterParams) => void;

export type Guards = ArrayGuards;
type ArrayGuards = Guard[];
export type Guard = (params: GuardParams) => Promise<any>;
export interface GuardParams {
    route: Route;
    redirect: LocationChanger;
    location: RouterLocation;
}

export type Resolvers = ArrayResolvers;
type ArrayResolvers = ObjectResolvers[];
type ObjectResolvers = Record<string, any>;
export type Resolver = (params: ResolverParams) => Promise<any>;
export interface ResolverParams {
    route: Route;
    redirect: LocationChanger;
    location: RouterLocation;
}

type ComponentOrChildren = RequireAtLeastOne<{
    component: React.ComponentType<any>;
    children: Routes;
}>;
export type Routes = Route[];
export type Route = {
    match: string;
    resolvers?: Resolvers;
    guards?: Guards;
} & ComponentOrChildren;

type InternalRoute = {
    id: string;
    children?: InternalRoute[];
} & Route;

type FlatRoutes = FlatRoute[];
type FlatRoute = {
    match: string;
    // component: React.ComponentType<any>;
    hierarchy: Route[];
};

type RouterLocationStateSetter = (stateBuilder: (state: RouterLocation) => RouterLocation) => void;

interface RouterState {
    routes: InternalRoute[];
    // flatRoutes: FlatRoutes;
    location: RouterLocation;
    currentMatch: { hierarchy: string[]; params: MatchParams | null };
    hierarchyMap: HierarchyMap;
    // currentFlatRouteState: { route: FlatRoute | null; params: MatchParams | null };
}

interface LocationSetterParams {
    pathname?: string;
    search?: Record<string, any> | string;
}

type HierarchyMap = Record<string, string[]>;

const RouterContext = createContext<[RouterState | null, RouterLocationStateSetter | null]>([
    null,
    null,
]);

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

const match = (
    path: string,
    routes: FlatRoutes
): { route: FlatRoute | null; params: MatchParams | null } => {
    for (const route of routes) {
        const { match } = route;

        if (typeof match === 'string') {
            if (match === '*') {
                return { route, params: null };
            }

            const [regexMatch, params] = matchesRegex(path, match);
            if (regexMatch) {
                return { route, params };
            }
        }
    }

    console.error('No route found');

    return { route: null, params: null };
};

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

    console.error('No route found');

    return { hierarchy: [], params: null };
};

const needsPreloading = (route: Route): boolean => {
    const hasGuards = route.guards && route.guards.length > 0;
    const hasResolvers = route.resolvers && route.resolvers.length > 0;

    return Boolean(hasGuards || hasResolvers);
};

const buildHierarchyMap = (routes: InternalRoute[]): HierarchyMap => {
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

const flatten = (routes: Routes): FlatRoutes => {
    const flatRoutes: FlatRoutes = [];

    for (const route of routes) {
        const flatRoute = { component: route.component, match: route.match, hierarchy: [route] };

        if (route.children) {
            const children = flatten(route.children);

            for (const child of children) {
                // const Component = flatRoute.component;
                // const ChildComponent = child.component;

                // let NewComponent: React.ComponentType<any> = Component
                //     ? (props: any) => (
                //           <Component {...props}>
                //               <ChildComponent />
                //           </Component>
                //       )
                //     : () => <ChildComponent />;

                // if (needsPreloading(route)){
                //     NewComponent = withRoutePreloader({ route, component: NewComponent })
                // }

                flatRoutes.push({
                    match: mergePaths(flatRoute.match, child.match),
                    // component: NewComponent,
                    hierarchy: [...flatRoute.hierarchy, ...child.hierarchy],
                });
            }
        } else if (route.component) {
            // if (needsPreloading(route)){
            //     flatRoutes.push({ ...flatRoute, component: withRoutePreloader({ route, component: route.component }) })
            // } else {
            flatRoutes.push(flatRoute as FlatRoute);
            // }
        } else {
            console.error('Found route with no component or children properties. Ignoring');
        }
    }

    return flatRoutes;
};

const matchesRegex = (path: string, matchPath: string): [boolean, MatchParams] => {
    const keys: any[] = [];

    // TODO: cache
    const regex = pathToRegexp(matchPath, keys);
    const regexResult = regex.exec(path);

    if (!regexResult) {
        return [false, null];
    }

    const params = keys.reduce((p, key, i) => {
        p[key.name] = regexResult[i + 1];
        return p;
    }, {});

    return [true, params];
};

const routerStateFromLocation = (
    routes: InternalRoute[],
    location: RouterLocation
): RouterState => {
    // const flatRoutes = flatten(routes);
    const hierarchyMap = buildHierarchyMap(routes);
    return {
        routes,
        location,
        currentMatch: matchHierarchy(location.pathname, hierarchyMap),
        hierarchyMap,
        // flatRoutes,
        // currentFlatRouteState: match(location.pathname, flatRoutes),
    };
};
const getRouterLocationFromLocation = (location: Location) => ({
    pathname: location.pathname,
    search: location.search,
});

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

const useComponentCache = (): Record<string, React.ComponentType<any>> => {
    const cache = useRef({});
    return cache.current;
};

const useRouterState = () => {
    const [routerState, setRouterLocationState] = useContext(RouterContext);

    if (!routerState || !setRouterLocationState) {
        throw new Error(
            'Invalid use of a router hook outside of the router context. Did put the <Router /> component at the root of your application?'
        );
    }

    return [routerState, setRouterLocationState] as [RouterState, RouterLocationStateSetter];
};

export const useLocation = (): [RouterLocation, LocationChanger] => {
    const [routerState, setRouterLocationState] = useRouterState();

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

    console.log('Location', routerState.location);
    return [routerState.location, locationSetter];
};

// const useCurrentFlatRoute = () => {
//     const [routerState] = useRouterState();

//     return routerState.currentFlatRouteState;
// };

// export const useCurrentRoute = () => {
//     const { route: flatRoute, params } = useCurrentFlatRoute();

//     if (!flatRoute) {
//         throw new Error(
//             "Trying to access route when none has been found. Did you remember to have a '*' catch-all?"
//         );
//     }

//     return { route: flatRoute.hierarchy[flatRoute.hierarchy.length - 1], params };
// };

const addIdsToRoutes = (routes: Route[]): InternalRoute[] => {
    const newRoutes: InternalRoute[] = routes.map((route) => {
        if (route.children) {
            return {
                ...route,
                children: addIdsToRoutes(route.children),
                id: nanoid(),
            };
        }

        return {
            ...(route as InternalRoute), // stupid ts
            id: nanoid(),
        };
    });

    return newRoutes;
};

const useCurrentMatch = () => {
    const [routerState] = useRouterState();

    return routerState.currentMatch;
};

export const Router = memo(({ routes: nonStaticRoutes }: { routes: Routes }) => {
    // Make routes static
    const routes = useMemo(() => nonStaticRoutes, []);

    const routesWithIds = useMemo(() => addIdsToRoutes(routes), [routes]);

    const [routerState, setRouterState] = useState<RouterState>(() =>
        routerStateFromLocation(routesWithIds, getRouterLocationFromLocation(location))
    );

    const setRouterLocationState = useCallback(
        (stateBuilder: (state: RouterLocation) => RouterLocation) => {
            setRouterState((oldState) => {
                const newLocationState = stateBuilder(oldState.location);
                return routerStateFromLocation(routesWithIds, newLocationState);
            });
        },
        [setRouterState, routesWithIds]
    );

    console.log('Router State:', routerState);

    // Sync location to url
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

    const popStateListener = useCallback(() => {
        setRouterState(routerStateFromLocation(routesWithIds, location));
    }, [routes, setRouterState]);

    const previousPopstateListener = useRef(popStateListener);

    useEffect(() => {
        // Skip remove on initial render
        if (previousPopstateListener.current !== popStateListener) {
            window.removeEventListener('popstate', previousPopstateListener.current);
        }
        window.addEventListener('popstate', popStateListener);
        previousPopstateListener.current = popStateListener;
    }, [popStateListener]);

    return (
        <RouterContext.Provider value={[routerState, setRouterLocationState]}>
            <RouterConsumer />
        </RouterContext.Provider>
    );
});

const RouterConsumer = memo(() => {
    // const { route } = useCurrentFlatRoute();
    const { hierarchy } = useCurrentMatch();

    if (!hierarchy.length) {
        console.error(
            "Trying to access route when none has been found. Did you remember to have a '*' catch-all?"
        );

        return null;
    }

    return <RenderHierarchy />;
});

const getRouteListFromHierarchy = (
    hierarchy: string[],
    routes: InternalRoute[]
): InternalRoute[] => {
    let routeList: InternalRoute[] = [];
    const currentHierarchy = [...hierarchy];
    const id = currentHierarchy.shift();
    console.log('RouteList from hierarchy', id, routes);

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
                const childRoutes = getRouteListFromHierarchy(currentHierarchy, route.children);
                routeList = routeList.concat(childRoutes);
            }
        }
    }

    return routeList;
};

const RenderHierarchy = () => {
    const [routerState] = useRouterState();
    const componentCache = useComponentCache();

    const { routes } = routerState;
    const { hierarchy } = routerState.currentMatch;

    console.log('Hierarchy', hierarchy);
    console.log('ComponentCache', componentCache);

    const routeList = useMemo(
        () => getRouteListFromHierarchy(hierarchy, routes),
        [hierarchy, routes]
    );

    console.log('RouteList', routeList);

    const components = useMemo(() => {
        for (const id of Object.keys(componentCache)) {
            if (!hierarchy.includes(id)) {
                delete componentCache[id];
            }
        }

        const componentsList = routeList.map((route) => {
            if (route.id in componentCache) {
                console.log('Using cached component for route', route.id);
                return componentCache[route.id];
            }

            console.log('Using new component for route', route.id);
            const component = withRoutePreloader(route);
            component.displayName = route.id;
            componentCache[route.id] = component;
            return component;
        });

        componentsList.reverse();
        return componentsList;
    }, [routeList, componentCache, hierarchy]);

    console.log('Components', components);

    // const route = useMemo(() => hierarchy[0], [hierarchy]);
    // const newHierarchy = useMemo(() => hierarchy.slice(1), [hierarchy]);

    // const next = useMemo(() => {
    //     if (newHierarchy.length > 0) {
    //         return (props: any) => <RenderHierarchy hierarchy={newHierarchy} {...props} />;
    //     }

    //     return null;
    // }, [newHierarchy]);

    // console.log('RENDER HIERARCHY FOR ROUTE', route, hierarchy, newHierarchy);

    // const Component = useMemo(() => withRoutePreloader({ route, next }), [route, next]);

    // return <Component {...rest} />;

    let componentToRender = null;
    for (const Component of components) {
        componentToRender = <Component>{componentToRender}</Component>;
    }

    return componentToRender;
};

export type PreloadingRoute = Route & {
    preloadingState: { loading: boolean; resolvedData: Record<string, any> };
};

const withRoutePreloader = (route: InternalRoute) =>
    memo(({ children }: { children: any }) => {
        const [preloadingState, setPreloadingState] = useState(() => ({
            loading: needsPreloading(route),
            resolvedData: {},
        }));
        const [locationState, setLocationState] = useLocation();

        const preloadingRoute: PreloadingRoute = useMemo(
            () => ({
                ...route,
                preloadingState,
            }),
            [preloadingState]
        );

        useEffect(() => {
            const guardPromise = (route.guards || []).reduce(
                (prom, guard) =>
                    prom.then(() =>
                        guard({ route, redirect: setLocationState, location: locationState })
                    ),
                Promise.resolve()
            );

            const resolvePromise = (route.resolvers || []).reduce((prom, resolverObject) => {
                const resolvedData: Record<string, any> = {};
                const resolvePromises = Object.entries(resolverObject).map(([key, resolver]) =>
                    resolver({ route, redirect: setLocationState, location: locationState }).then(
                        (result: any) => {
                            resolvedData[key] = result;
                        }
                    )
                );

                return Promise.all(resolvePromises).then(() => resolvedData);
            }, Promise.resolve());

            const preloadPromise = guardPromise.then(() => resolvePromise);

            preloadPromise.then((resolvedData) =>
                setPreloadingState({ loading: false, resolvedData })
            );

            // TODO return function to cancel promise chain
        }, []);

        // const getChildren = () => {
        //     if (preloadingRoute.preloadingState.loading) {
        //         return null;
        //     }

        //     if (!next) {
        //         return null;
        //     }

        //     const Next = next;
        //     return <Next />;
        // };

        // if (route.component) {
        //     return <route.component route={preloadingRoute}>{getChildren()}</route.component>;
        // }

        // return getChildren();

        if (route.component) {
            console.log('Component preloading state is', preloadingRoute.preloadingState);
            return (
                <route.component route={preloadingRoute}>
                    {preloadingRoute.preloadingState.loading ? null : children}
                </route.component>
            );
        }

        return children;
    });

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

// TODO: Routes rerunning all guards/resovlers on leaf change
