export const DEPLOYED_SEARCH_MODES = ['phrase', 'regex', 'soft', 'similar'] as const;
export type DeployedSearchMode = (typeof DEPLOYED_SEARCH_MODES)[number];
export type SearchMode = DeployedSearchMode | 'semantic';
export type SearchTolerance = 'strict' | 'normal' | 'loose';
