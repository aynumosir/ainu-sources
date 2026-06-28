import { fail, redirect, error } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { getSourceDetail, updateSource, mergeNotice } from '$lib/server/queries';
import { parseSourceForm, revisionSummary } from '$lib/server/form';
import { asArray } from '$lib/format';

export const load: PageServerLoad = async ({ params, locals, url }) => {
	if (!locals.user) redirect(302, '/login?redirect=' + encodeURIComponent(url.pathname));
	const detail = await getSourceDetail(params.slug);
	if (!detail) error(404, 'Source not found');
	const s = detail.source;
	const initial = {
		slug: s.slug,
		title: s.title,
		titleEn: s.titleEn ?? '',
		titleAin: s.titleAin ?? '',
		category: s.category,
		type: s.type,
		author: s.author ?? '',
		yearText: s.yearText ?? '',
		yearStart: s.yearStart,
		yearEnd: s.yearEnd,
		yearCertainty: s.yearCertainty ?? 'exact',
		dialect: s.dialect ?? '',
		region: s.region ?? '',
		languages: asArray(s.languages).join(', '),
		scripts: asArray(s.scripts).join(', '),
		holdingInstitution: s.holdingInstitution ?? '',
		callNumber: s.callNumber ?? '',
		entryCount: s.entryCount,
		entryCountLabel: s.entryCountLabel ?? '',
		license: s.license ?? '',
		summary: s.summary ?? '',
		notes: s.notes ?? '',
		reliability: s.reliability ?? '',
		links: detail.links.map((l) => ({ type: l.type, label: l.label ?? '', url: l.url })),
		tags: detail.tags.map((t) => t.name).join(', ')
	};
	return { initial, slug: s.slug, title: s.title };
};

export const actions: Actions = {
	default: async ({ request, params, locals }) => {
		// Open editing is a feature: any signed-in account may edit any source.
		// Changes are attributed + versioned in sourceRevisions (wiki-style), so
		// we gate on authentication only — ownership/roles are intentionally absent.
		if (!locals.user) return fail(401, { error: 'Sign in to edit.' });
		const detail = await getSourceDetail(params.slug);
		if (!detail) return fail(404, { error: 'Source not found.' });
		const fd = await request.formData();
		const { input, error: err } = parseSourceForm(fd);
		if (!input) return fail(400, { error: err });
		const { result } = await updateSource(
			detail.source.id,
			input,
			{ id: locals.user.id, name: locals.user.name },
			revisionSummary(fd)
		);
		// Held/conflict/rejected parts of an edit are surfaced, never silently
		// dropped (N4). A clean editorial apply redirects exactly as before; the
		// slug never changes on edit, so redirect to the original path.
		const notice = mergeNotice(result);
		if (notice) return fail(409, { error: notice });
		redirect(303, '/sources/' + params.slug);
	}
};
