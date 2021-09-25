import { useState } from 'react';

export const useLocation = () => {
    const [{ path, search }, setLocationState] = useState(() => ({
        path: location.pathname,
        search: location.search,
    }));

    return { path, search };
};
