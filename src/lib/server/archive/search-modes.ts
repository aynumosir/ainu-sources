export const DEPLOYED_SEARCH_MODES = ['phrase', 'regex', 'soft', 'similar', 'semantic'] as const;
export type SearchMode = (typeof DEPLOYED_SEARCH_MODES)[number];
export type SearchTolerance = 'strict' | 'normal' | 'loose';
