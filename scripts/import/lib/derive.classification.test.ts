import { describe, expect, it } from 'vitest';
import { classifyAcademic, META_LANG } from './derive';

describe('verified academic bibliographic forms', () => {
 it.each([
  ['Changing ways of talking about the Ainu language? A corpus-based analysis of Japan’s National Diet discourse', 'article'],
  ['近世末期のアイヌ語辞書～『番人円吉蝦夷記』', 'article'],
  ['Language Attitudes of Ainu People', 'thesis']
 ])('preserves the verified form of %s', (title, type) => {
  expect(classifyAcademic({ title, type, category: 'secondary' })).toEqual({ category: 'secondary', type });
 });
 it('still infers a corpus for an unclassified harvest record', () => {
  expect(classifyAcademic({ title: 'Ainu corpus', type: 'article' })).toEqual({ category: 'corpus', type: 'corpus-text' });
 });
 it('normalizes legacy bibliographic form names', () => {
  expect(classifyAcademic({ title: 'Study', type: 'grammar-article', category: 'secondary' })).toEqual({ category: 'secondary', type: 'article' });
 });
});

it('preserves Finnish publication language', () => {
 expect(META_LANG.fi).toBe('fin');
 expect(META_LANG.fin).toBe('fin');
});
