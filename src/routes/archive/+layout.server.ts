import type { LayoutServerLoad } from './$types';
import { resolveArchiveLayoutData } from '$lib/server/archive/layout-data';

export const load: LayoutServerLoad = (event) => resolveArchiveLayoutData(event);
