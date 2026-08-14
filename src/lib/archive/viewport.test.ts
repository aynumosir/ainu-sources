import { describe, expect, it } from 'vitest';
import {
	clampOffset,
	fitScale,
	nextRotation,
	offsetAfterZoom,
	panBounds,
	rotateSize,
	scaleBounds,
	scaleForNewContent,
	wheelZoomFactor
} from './viewport';

const page = { width: 1200, height: 1800 };
const stage = { width: 800, height: 600 };

describe('rotateSize', () => {
	it('swaps the axes on a quarter turn', () => {
		expect(rotateSize(page, 90)).toEqual({ width: 1800, height: 1200 });
		expect(rotateSize(page, 270)).toEqual({ width: 1800, height: 1200 });
	});

	it('leaves upright and upside-down pages alone', () => {
		expect(rotateSize(page, 0)).toEqual(page);
		expect(rotateSize(page, 180)).toEqual(page);
	});
});

describe('nextRotation', () => {
	it('turns in both directions and wraps', () => {
		expect(nextRotation(0, 1)).toBe(90);
		expect(nextRotation(270, 1)).toBe(0);
		expect(nextRotation(0, -1)).toBe(270);
		expect(nextRotation(180, -2)).toBe(0);
	});
});

describe('fitScale', () => {
	it('fits the whole page inside the stage', () => {
		expect(fitScale(page, stage, 0, 'page')).toBeCloseTo(600 / 1800);
	});

	it('fills the stage width, letting the page run past the bottom', () => {
		expect(fitScale(page, stage, 0, 'width')).toBeCloseTo(800 / 1200);
	});

	it('measures the rotated footprint', () => {
		expect(fitScale(page, stage, 90, 'page')).toBeCloseTo(800 / 1800);
	});

	it('falls back to 1 before the image or the stage is measured', () => {
		expect(fitScale({ width: 0, height: 0 }, stage, 0, 'page')).toBe(1);
		expect(fitScale(page, { width: 0, height: 0 }, 0, 'page')).toBe(1);
	});
});

describe('scaleBounds', () => {
	it('reaches four times the image resolution', () => {
		expect(scaleBounds(page, stage, 0).max).toBe(4);
	});

	it('allows deeper zoom where the stage dwarfs the image', () => {
		const thumbnail = { width: 100, height: 100 };
		expect(scaleBounds(thumbnail, stage, 0).max).toBeCloseTo((600 / 100) * 8);
	});

	it('stops the page from shrinking below half its fit size', () => {
		expect(scaleBounds(page, stage, 0).min).toBeCloseTo(600 / 1800 / 2);
	});

	it('never lets an image smaller than the stage shrink below half its own size', () => {
		expect(scaleBounds({ width: 100, height: 100 }, stage, 0).min).toBe(0.5);
	});
});

describe('panBounds', () => {
	it('is zero on an axis that fits, and half the overflow on one that does not', () => {
		// At the fit-width scale the page is 800 wide and 1200 tall.
		const bounds = panBounds(page, stage, 800 / 1200, 0);
		expect(bounds.x).toBe(0);
		expect(bounds.y).toBeCloseTo(300);
	});

	it('follows the rotated footprint', () => {
		const bounds = panBounds(page, stage, 1, 90);
		expect(bounds.x).toBeCloseTo((1800 - 800) / 2);
		expect(bounds.y).toBeCloseTo((1200 - 600) / 2);
	});
});

describe('the top of a page fitted to the width', () => {
	const topOf = (content: { width: number; height: number }) =>
		panBounds(content, stage, fitScale(content, stage, 0, 'width'), 0).y;

	it('sits further from the centre the taller the page is', () => {
		expect(topOf({ width: 1200, height: 2400 })).toBeGreaterThan(
			topOf({ width: 1200, height: 1500 })
		);
	});

	it('is the centre for a page no taller than the stage', () => {
		expect(topOf({ width: 1200, height: 600 })).toBe(0);
	});
});

describe('clampOffset', () => {
	it('holds the page inside its pan range', () => {
		expect(clampOffset({ x: 900, y: -900 }, page, stage, 1, 0)).toEqual({ x: 200, y: -600 });
	});

	it('recentres an axis with nothing to pan', () => {
		expect(clampOffset({ x: 50, y: 50 }, page, stage, 0.1, 0)).toEqual({ x: 0, y: 0 });
	});
});

describe('offsetAfterZoom', () => {
	it('keeps the point under the cursor in place', () => {
		const anchor = { x: 120, y: -40 };
		const before = { x: 30, y: 10 };
		const after = offsetAfterZoom(before, 1, 2, anchor);
		// The image point under the anchor lands back under the anchor.
		const imagePointBefore = { x: (anchor.x - before.x) / 1, y: (anchor.y - before.y) / 1 };
		const imagePointAfter = { x: (anchor.x - after.x) / 2, y: (anchor.y - after.y) / 2 };
		expect(imagePointAfter.x).toBeCloseTo(imagePointBefore.x);
		expect(imagePointAfter.y).toBeCloseTo(imagePointBefore.y);
	});

	it('zooming about the centre leaves a centred page centred', () => {
		expect(offsetAfterZoom({ x: 0, y: 0 }, 1, 3, { x: 0, y: 0 })).toEqual({ x: 0, y: 0 });
	});
});

describe('scaleForNewContent', () => {
	it('holds the rendered size when a sharper derivative arrives', () => {
		const preview = { width: 300, height: 450 };
		const full = { width: 1200, height: 1800 };
		expect(scaleForNewContent(2, preview, full)).toBeCloseTo(0.5);
	});

	it('leaves the scale alone when a size is missing', () => {
		expect(scaleForNewContent(2, { width: 0, height: 0 }, page)).toBe(2);
	});
});

describe('wheelZoomFactor', () => {
	it('magnifies on upward travel and shrinks on downward', () => {
		expect(wheelZoomFactor(-100)).toBeGreaterThan(1);
		expect(wheelZoomFactor(100)).toBeLessThan(1);
	});

	it('treats line and page deltas as larger steps', () => {
		expect(wheelZoomFactor(-3, 1)).toBeGreaterThan(wheelZoomFactor(-3, 0));
		expect(wheelZoomFactor(-1, 2)).toBeGreaterThan(wheelZoomFactor(-1, 1));
	});

	it('caps one violent flick', () => {
		expect(wheelZoomFactor(-10000)).toBeCloseTo(wheelZoomFactor(-240));
	});
});
