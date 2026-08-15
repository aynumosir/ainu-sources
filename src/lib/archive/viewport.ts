/**
 * Geometry for the scan viewer: how a page image sits inside its stage under a
 * zoom factor, a pan offset and a quarter-turn rotation.
 *
 * Coordinates: the image is drawn centred in the stage, so an offset of (0, 0)
 * means centred and offsets grow to the right and downward. `scale` is CSS
 * pixels per image pixel, which makes 1 the image's own resolution.
 */

export type Size = { width: number; height: number };
export type Point = { x: number; y: number };
export type Rotation = 0 | 90 | 180 | 270;
export type FitMode = 'page' | 'width';

/** Magnification a page of ordinary size reaches, in multiples of its own pixels. */
const MAX_NATIVE_SCALE = 4;
/** Reach kept for a page far smaller than its stage, where 4× is barely a zoom. */
const MAX_FIT_MULTIPLE = 8;

export function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max);
}

/** The footprint a quarter-turned image occupies. */
export function rotateSize(size: Size, rotation: Rotation): Size {
	return rotation === 90 || rotation === 270 ? { width: size.height, height: size.width } : size;
}

export function nextRotation(rotation: Rotation, quarterTurns: number): Rotation {
	const turns = (((rotation / 90 + quarterTurns) % 4) + 4) % 4;
	return (turns * 90) as Rotation;
}

/** The scale at which the image fits the stage — whole page, or width alone. */
export function fitScale(content: Size, stage: Size, rotation: Rotation, mode: FitMode): number {
	const rotated = rotateSize(content, rotation);
	if (rotated.width <= 0 || rotated.height <= 0 || stage.width <= 0 || stage.height <= 0) return 1;
	const byWidth = stage.width / rotated.width;
	if (mode === 'width') return byWidth;
	return Math.min(byWidth, stage.height / rotated.height);
}

/**
 * How far the zoom may travel. The floor is half the fit scale so a page can
 * always be pulled back from the edges; the ceiling allows real magnification
 * even where the stage is larger than the image.
 */
export function scaleBounds(content: Size, stage: Size, rotation: Rotation): { min: number; max: number } {
	const fit = fitScale(content, stage, rotation, 'page');
	return {
		min: Math.min(fit, 1) / 2,
		max: Math.max(MAX_NATIVE_SCALE, fit * MAX_FIT_MULTIPLE)
	};
}

/**
 * The furthest the image may be dragged on each axis. Zero on an axis where the
 * image is smaller than the stage, which pins that axis to the centre.
 */
export function panBounds(content: Size, stage: Size, scale: number, rotation: Rotation): Point {
	const rotated = rotateSize(content, rotation);
	return {
		x: Math.max(0, (rotated.width * scale - stage.width) / 2),
		y: Math.max(0, (rotated.height * scale - stage.height) / 2)
	};
}

export function clampOffset(
	offset: Point,
	content: Size,
	stage: Size,
	scale: number,
	rotation: Rotation
): Point {
	const bounds = panBounds(content, stage, scale, rotation);
	return {
		x: clamp(offset.x, -bounds.x, bounds.x),
		y: clamp(offset.y, -bounds.y, bounds.y)
	};
}

/**
 * The offset that keeps the point under the cursor still while the scale goes
 * from `from` to `to`. `anchor` is measured from the centre of the stage.
 */
export function offsetAfterZoom(offset: Point, from: number, to: number, anchor: Point): Point {
	if (from <= 0) return offset;
	const ratio = to / from;
	return {
		x: anchor.x - (anchor.x - offset.x) * ratio,
		y: anchor.y - (anchor.y - offset.y) * ratio
	};
}

/**
 * Keeps the page the same size on screen when a sharper derivative replaces the
 * one being measured: the pixel count changes, the rendered size does not.
 */
export function scaleForNewContent(scale: number, previous: Size, next: Size): number {
	if (previous.width <= 0 || next.width <= 0) return scale;
	return (scale * previous.width) / next.width;
}

/** Wheel travel as a zoom multiplier, normalised across the delta modes. */
export function wheelZoomFactor(deltaY: number, deltaMode = 0): number {
	const pixels = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 400 : deltaY;
	return Math.exp(clamp(-pixels, -240, 240) * 0.0022);
}
