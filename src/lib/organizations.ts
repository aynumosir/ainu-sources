import organizations from './data/organizations.json';
const normalize = (name: string) => name.normalize('NFKC').replace(/\s+/g, '');
export function organizationForName(name: string) {
 const key = normalize(name);
 return organizations.find(org => org.aliases.some(alias => normalize(alias) === key))?.institution;
}
export function organizationForPersonSlug(slug: string) {
 return organizations.find(org => org.personSlug === slug)?.institution;
}
