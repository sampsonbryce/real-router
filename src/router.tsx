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

export type Routes = Route[];
export type Route = RequireAtLeastOne<
    {
        match: string;
        component: React.ComponentType<any>;
        children: Routes;
    },
    'component' | 'children'
>;

type FlatRoutes = FlatRoute[];
type FlatRoute = Required<Omit<Route, 'children'>> & {
    hierarchy: Route[];
};

type RouterLocationStateSetter = (stateBuilder: (state: RouterLocation) => RouterLocation) => void

interface RouterState {
    routes: Routes;
    flatRoutes: FlatRoutes;
    location: RouterLocation;
    currentFlatRouteState: { route: FlatRoute | null; params: MatchParams | null };
}

interface LocationSetterParams {
    pathname?: string;
    search?: Record<string, any> | string;
}

const RouterContext = createContext<[RouterState | null, RouterLocationStateSetter | null]>([null, null]);

const mergePaths = (left: string, right: string) => {
    const leftSlash = left.charAt(left.length - 1) === '/';
    const rightSlash = right.charAt(0) === '/';
    if (leftSlash && rightSlash) {
        return left + right.substring(1);
    } else if ((leftSlash && !rightSlash) || (!leftSlash && rightSlash)) {
        return left + right;
    }

    return left + '/' + right;
};

const match = (
    path: string,
    routes: FlatRoutes
): { route: FlatRoute | null; params: MatchParams | null } => {
    for (const route of routes) {
        const match = route.match;

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

const flatten = (routes: Routes): FlatRoutes => {
    const flatRoutes: FlatRoutes = [];

    for (const route of routes) {
        const flatRoute = { component: route.component, match: route.match, hierarchy: [route] };

        if (route.children) {
            const children = flatten(route.children);

            for (const child of children) {
                const Component = flatRoute.component;
                const ChildComponent = child.component;

                const NewComponent = Component
                    ? () => (
                          <Component>
                              <ChildComponent />
                          </Component>
                      )
                    : () => <ChildComponent />;

                flatRoutes.push({
                    match: mergePaths(flatRoute.match, child.match),
                    component: NewComponent,
                    hierarchy: [...flatRoute.hierarchy, ...child.hierarchy],
                });
            }
        } else if (route.component) {
            flatRoutes.push(flatRoute as FlatRoute);
        } else {
            console.error('Found route with no component or children properties. Ignoring');
        }
    }

    return flatRoutes;
};

const matchesRegex = (path: string, match: string): [boolean, MatchParams] => {
    const keys: any[] = [];

    // TODO: cache
    const regex = pathToRegexp(match, keys);
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

const routerStateFromLocation = (routes: Routes, location: RouterLocation) => {
    const flatRoutes = flatten(routes);
    return {
        routes,
        location,
        flatRoutes,
        currentFlatRouteState: match(location.pathname, flatRoutes),
    };
};

const getRouterLocationFromLocation = (location: Location) => ({
    pathname: location.pathname,
    search: location.search,
});

const useRouterState = () => {
    const [routerState, setRouterLocationState] = useContext(RouterContext);

    if (!routerState || !setRouterLocationState) {
        throw new Error(
            'Invalid use of a router hook outside of the router context. Did put the <Router /> component at the root of your application?'
        );
    }

    return [routerState, setRouterLocationState] as [RouterState, RouterLocationStateSetter];
};

export const useLocation = (): [RouterLocation, (params: LocationSetterParams) => void] => {
    const [routerState, setRouterLocationState] = useRouterState();

    const locationSetter = useCallback(
        ({ pathname, search }: LocationSetterParams) => {
            const newState: Partial<RouterLocation> = {};

            if (typeof search === 'string') {
                if (search.charAt(0) === '?') {
                    newState.search = search;
                } else {
                    newState.search = '?' + search;
                }
            } else if (search) {
                newState.search = '?' + stringify(search);
            }

            if (pathname) {
                newState.pathname = pathname;
            }

            setRouterLocationState((oldState) => {
                const newLocationState = { ...oldState, ...newState };
                return newLocationState;
            });
        },
        []
    );

    console.log('Location', routerState.location);
    return [routerState.location, locationSetter];
};


const useCurrentFlatRoute = () => {
    const [routerState] = useRouterState();

    return routerState.currentFlatRouteState;
};

export const useCurrentRoute = () => {
    const { route: flatRoute, params } = useCurrentFlatRoute();

    if (!flatRoute) {
        throw new Error(
            "Trying to access route when none has been found. Did you remember to have a '*' catch-all?"
        );
    }

    return { route: flatRoute.hierarchy[flatRoute.hierarchy.length - 1], params };
};



export const Router = memo(({ routes: nonStaticRoutes }: { routes: Routes }) => {

    // Make routes static
    const routes = useMemo(() => nonStaticRoutes, [])

    const [routerState, setRouterState] = useState<RouterState>(() =>
        routerStateFromLocation(routes, getRouterLocationFromLocation(location))
    );

    const setRouterLocationState = useCallback((stateBuilder: (state: RouterLocation) => RouterLocation) => {
        setRouterState(oldState => {
            const newLocationState = stateBuilder(oldState.location)
            return routerStateFromLocation(routes, newLocationState);
        })
    }, [setRouterState, routes])

    console.log('Router State:', routerState);

    useEffect(() => {
        if(location.pathname === routerState.location.pathname && location.search === routerState.location.search){
            return;
        }

        window.history.pushState(null, '', routerState.location.pathname + routerState.location.search);
    }, [routerState.location])


    const popStateListener = useCallback(() => {
            setRouterState(routerStateFromLocation(routes, location));
        }, [routes, setRouterState])

    const previousPopstateListener = useRef(popStateListener)

    useEffect(() => {
        // Skip remove on initial render
        if(previousPopstateListener.current !== popStateListener){
            window.removeEventListener('popstate', previousPopstateListener.current)
        }
        window.addEventListener('popstate', popStateListener);
        previousPopstateListener.current = popStateListener;
    }, [popStateListener])


    return (
        <RouterContext.Provider value={[routerState, setRouterLocationState]}>
            <RouterConsumer />
        </RouterContext.Provider>
    );
});

const RouterConsumer = memo(() => {
    const { route } = useCurrentFlatRoute();

    if (!route) {
        console.error(
            "Trying to access route when none has been found. Did you remember to have a '*' catch-all?"
        );

        return null;
    }

    return <route.component />;
});


