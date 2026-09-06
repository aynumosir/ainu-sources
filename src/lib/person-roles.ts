/** Group recorded-source creators with authors in the catalogue. */
export function personRole(role: string): string {
	return role === 'recorder' ? 'author' : role;
}
