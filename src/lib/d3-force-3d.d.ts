// d3-force-3d ships without TypeScript declarations. These are the force
// factories used by the network layout; each returns a d3 simulation force.
declare module 'd3-force-3d' {
	interface Force {
		(alpha: number): void;
		initialize(nodes: object[], ...args: unknown[]): void;
	}
	interface AxisForce extends Force {
		strength(value: number): this;
	}
	export function forceX(position: number): AxisForce;
	export function forceY(position: number): AxisForce;
	export function forceZ(position: number): AxisForce;
	export function forceCollide<Node>(radius: (node: Node) => number): Force;
}
