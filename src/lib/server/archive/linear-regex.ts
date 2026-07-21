export type RegexAst =
	| { type: 'empty'; start: number; end: number }
	| { type: 'literal'; value: string; start: number; end: number }
	| { type: 'dot'; start: number; end: number }
	| { type: 'class'; negated: boolean; ranges: [number, number][]; singles: string[]; kinds: RegexClassKind[]; start: number; end: number }
	| { type: 'anchor'; kind: 'start' | 'end'; start: number; end: number }
	| { type: 'sequence'; children: RegexAst[]; start: number; end: number }
	| { type: 'alternation'; branches: RegexAst[]; start: number; end: number }
	| { type: 'repeat'; child: RegexAst; min: number; max: number | null; start: number; end: number };

type RegexClassKind = 'digit' | 'word' | 'space';

export class RegexSyntaxError extends Error {
	constructor(
		message: string,
		readonly position: number
	) {
		super(message);
	}
}

const MAX_PATTERN_LENGTH = 256;
const MAX_REPEAT = 100;
const MAX_STATES = 1024;

export function parseRegexAst(pattern: string): RegexAst {
	if (pattern.length > MAX_PATTERN_LENGTH) throw new RegexSyntaxError(`pattern exceeds ${MAX_PATTERN_LENGTH} characters`, MAX_PATTERN_LENGTH);
	return new RegexParser(pattern).parse();
}

export function extractRegexLiterals(ast: RegexAst): string[] {
	const literals = requiredLiterals(ast).filter((literal) => [...literal].length >= 3);
	return [...new Set(literals)].sort((left, right) => right.length - left.length || left.localeCompare(right));
}

export type LinearRegex = {
	find(text: string, deadline?: number): { start: number; end: number } | null;
};

export function compileLinearRegex(ast: RegexAst): LinearRegex {
	const compiler = new NfaCompiler();
	const accept = compiler.state({ type: 'accept' });
	const start = compiler.compile(ast, accept);
	if (compiler.states.length > MAX_STATES) throw new RegexSyntaxError('pattern expands to too many states', ast.start);
	return {
		find(text, deadline = Number.POSITIVE_INFINITY) {
			return runNfa(compiler.states, start, text, deadline);
		}
	};
}

class RegexParser {
	private index = 0;

	constructor(private readonly pattern: string) {}

	parse(): RegexAst {
		const ast = this.alternation();
		if (this.index < this.pattern.length) throw new RegexSyntaxError(`unexpected '${this.pattern[this.index]}'`, this.index);
		return ast;
	}

	private alternation(): RegexAst {
		const start = this.index;
		const branches = [this.sequence()];
		while (this.peek() === '|') {
			this.index += 1;
			branches.push(this.sequence());
		}
		return branches.length === 1 ? branches[0] : { type: 'alternation', branches, start, end: this.index };
	}

	private sequence(): RegexAst {
		const start = this.index;
		const children: RegexAst[] = [];
		let literal = '';
		let literalStart = this.index;
		const flushLiteral = () => {
			if (!literal) return;
			children.push({ type: 'literal', value: literal, start: literalStart, end: this.index });
			literal = '';
		};
		while (this.index < this.pattern.length && this.peek() !== ')' && this.peek() !== '|') {
			const atomStart = this.index;
			const atom = this.atom();
			const quantifier = this.quantifier(atom);
			if (quantifier.type === 'literal') {
				if (!literal) literalStart = atomStart;
				literal += quantifier.value;
				continue;
			}
			flushLiteral();
			children.push(quantifier);
		}
		flushLiteral();
		if (children.length === 0) return { type: 'empty', start, end: this.index };
		return children.length === 1 ? children[0] : { type: 'sequence', children, start, end: this.index };
	}

	private atom(): RegexAst {
		const start = this.index;
		const char = this.pattern[this.index++];
		if (char === '(') {
			if (this.peek() === '?') {
				if (this.pattern.slice(this.index, this.index + 2) !== '?:') {
					throw new RegexSyntaxError('lookaround and special groups are unavailable', start);
				}
				this.index += 2;
			}
			const child = this.alternation();
			if (this.peek() !== ')') throw new RegexSyntaxError("missing ')'", this.index);
			this.index += 1;
			return { ...child, start, end: this.index };
		}
		if (char === '[') return this.characterClass(start);
		if (char === '.') return { type: 'dot', start, end: this.index };
		if (char === '^' || char === '$') return { type: 'anchor', kind: char === '^' ? 'start' : 'end', start, end: this.index };
		if (char === '\\') return this.escape(start, false);
		if ('*+?{}'.includes(char)) throw new RegexSyntaxError('quantifier has no target', start);
		return { type: 'literal', value: char, start, end: this.index };
	}

	private characterClass(start: number): RegexAst {
		let negated = false;
		if (this.peek() === '^') {
			negated = true;
			this.index += 1;
		}
		const ranges: [number, number][] = [];
		const singles: string[] = [];
		const kinds: RegexClassKind[] = [];
		let closed = false;
		while (this.index < this.pattern.length) {
			if (this.peek() === ']' && singles.length + ranges.length + kinds.length > 0) {
				this.index += 1;
				closed = true;
				break;
			}
			const left = this.classAtom();
			if (typeof left !== 'string') {
				kinds.push(left);
				continue;
			}
			if (this.peek() === '-' && this.pattern[this.index + 1] !== ']') {
				this.index += 1;
				const right = this.classAtom();
				if (typeof right !== 'string') throw new RegexSyntaxError('character-class range endpoint must be literal', this.index);
				const from = left.codePointAt(0)!;
				const to = right.codePointAt(0)!;
				if (from > to) throw new RegexSyntaxError('character-class range is reversed', this.index);
				ranges.push([from, to]);
			} else {
				singles.push(left);
			}
		}
		if (!closed) throw new RegexSyntaxError("missing ']'", this.index);
		return { type: 'class', negated, ranges, singles, kinds, start, end: this.index };
	}

	private classAtom(): string | RegexClassKind {
		const start = this.index;
		const char = this.pattern[this.index++];
		if (char !== '\\') return char;
		const escaped = this.pattern[this.index++];
		if (escaped === 'd') return 'digit';
		if (escaped === 'w') return 'word';
		if (escaped === 's') return 'space';
		if (escaped === 'p' || escaped === 'P') throw new RegexSyntaxError('Unicode property escapes are unavailable', start);
		return decodeEscape(escaped, this.pattern, () => this.index, (next) => (this.index = next), start);
	}

	private escape(start: number, inClass: boolean): RegexAst {
		const escaped = this.pattern[this.index++];
		if (escaped == null) throw new RegexSyntaxError('trailing escape', start);
		if (/^[1-9]$/u.test(escaped)) throw new RegexSyntaxError('backreferences are unavailable', start);
		if (escaped === 'b' && !inClass) throw new RegexSyntaxError('word-boundary assertions are unavailable', start);
		if (escaped === 'd' || escaped === 'w' || escaped === 's') {
			return { type: 'class', negated: false, ranges: [], singles: [], kinds: [classKind(escaped)], start, end: this.index };
		}
		if (escaped === 'D' || escaped === 'W' || escaped === 'S') {
			return {
				type: 'class',
				negated: true,
				ranges: [],
				singles: [],
				kinds: [classKind(escaped.toLowerCase())],
				start,
				end: this.index
			};
		}
		if (escaped === 'p' || escaped === 'P') throw new RegexSyntaxError('Unicode property escapes are unavailable', start);
		return {
			type: 'literal',
			value: decodeEscape(escaped, this.pattern, () => this.index, (next) => (this.index = next), start),
			start,
			end: this.index
		};
	}

	private quantifier(child: RegexAst): RegexAst {
		const start = child.start;
		const char = this.peek();
		let min: number;
		let max: number | null;
		if (char === '*') {
			this.index += 1;
			min = 0;
			max = null;
		} else if (char === '+') {
			this.index += 1;
			min = 1;
			max = null;
		} else if (char === '?') {
			this.index += 1;
			min = 0;
			max = 1;
		} else if (char === '{') {
			const match = /^\{(\d+)(?:,(\d*)?)?\}/u.exec(this.pattern.slice(this.index));
			if (!match) throw new RegexSyntaxError('invalid repeat quantifier', this.index);
			this.index += match[0].length;
			min = Number(match[1]);
			max = match[0].includes(',') ? (match[2] === '' || match[2] == null ? null : Number(match[2])) : min;
			if (max != null && max < min) throw new RegexSyntaxError('repeat range is reversed', start);
			if (min > MAX_REPEAT || (max != null && max > MAX_REPEAT)) throw new RegexSyntaxError(`repeat exceeds ${MAX_REPEAT}`, start);
		} else {
			return child;
		}
		if (this.peek() === '?') this.index += 1;
		return { type: 'repeat', child, min, max, start, end: this.index };
	}

	private peek(): string | undefined {
		return this.pattern[this.index];
	}
}

function decodeEscape(
	escaped: string,
	pattern: string,
	getIndex: () => number,
	setIndex: (index: number) => void,
	start: number
): string {
	if (escaped === 'n') return '\n';
	if (escaped === 'r') return '\r';
	if (escaped === 't') return '\t';
	if (escaped === 'f') return '\f';
	if (escaped === 'v') return '\v';
	if (escaped === 'x') {
		const hex = pattern.slice(getIndex(), getIndex() + 2);
		if (!/^[0-9a-f]{2}$/iu.test(hex)) throw new RegexSyntaxError('invalid hexadecimal escape', start);
		setIndex(getIndex() + 2);
		return String.fromCodePoint(Number.parseInt(hex, 16));
	}
	if (escaped === 'u') {
		if (pattern[getIndex()] === '{') {
			const close = pattern.indexOf('}', getIndex() + 1);
			if (close === -1) throw new RegexSyntaxError('invalid Unicode escape', start);
			const hex = pattern.slice(getIndex() + 1, close);
			if (!/^[0-9a-f]{1,6}$/iu.test(hex)) throw new RegexSyntaxError('invalid Unicode escape', start);
			setIndex(close + 1);
			return String.fromCodePoint(Number.parseInt(hex, 16));
		}
		const hex = pattern.slice(getIndex(), getIndex() + 4);
		if (!/^[0-9a-f]{4}$/iu.test(hex)) throw new RegexSyntaxError('invalid Unicode escape', start);
		setIndex(getIndex() + 4);
		return String.fromCodePoint(Number.parseInt(hex, 16));
	}
	return escaped;
}

function classKind(value: string): RegexClassKind {
	return value === 'd' ? 'digit' : value === 'w' ? 'word' : 'space';
}

function requiredLiterals(ast: RegexAst): string[] {
	if (ast.type === 'literal') return [ast.value];
	if (ast.type === 'sequence') return ast.children.flatMap(requiredLiterals);
	if (ast.type === 'alternation') {
		const branchLiterals = ast.branches.map(requiredLiterals);
		if (branchLiterals.some((branch) => branch.every((literal) => [...literal].length < 3))) return [];
		return branchLiterals.flat();
	}
	if (ast.type === 'repeat') {
		if (ast.min === 0) return [];
		if (ast.child.type === 'literal') return [ast.child.value.repeat(ast.min)];
		return requiredLiterals(ast.child);
	}
	return [];
}

type NfaState =
	| { type: 'accept' }
	| { type: 'epsilon'; targets: number[] }
	| { type: 'consume'; target: number; test: (char: string) => boolean }
	| { type: 'assert'; target: number; kind: 'start' | 'end' };

class NfaCompiler {
	readonly states: NfaState[] = [];

	state(state: NfaState): number {
		this.states.push(state);
		return this.states.length - 1;
	}

	compile(ast: RegexAst, next: number): number {
		if (ast.type === 'empty') return next;
		if (ast.type === 'literal') {
			let current = next;
			for (const char of [...ast.value].reverse()) current = this.state({ type: 'consume', target: current, test: (input) => input === char });
			return current;
		}
		if (ast.type === 'dot') return this.state({ type: 'consume', target: next, test: (char) => char !== '\n' && char !== '\r' });
		if (ast.type === 'class') return this.state({ type: 'consume', target: next, test: classPredicate(ast) });
		if (ast.type === 'anchor') return this.state({ type: 'assert', target: next, kind: ast.kind });
		if (ast.type === 'sequence') {
			let current = next;
			for (const child of [...ast.children].reverse()) current = this.compile(child, current);
			return current;
		}
		if (ast.type === 'alternation') return this.state({ type: 'epsilon', targets: ast.branches.map((branch) => this.compile(branch, next)) });
		return this.repeat(ast, next);
	}

	private repeat(ast: Extract<RegexAst, { type: 'repeat' }>, next: number): number {
		let current = next;
		if (ast.max == null) {
			const split = this.state({ type: 'epsilon', targets: [next] });
			const loop = this.compile(ast.child, split);
			(this.states[split] as Extract<NfaState, { type: 'epsilon' }>).targets.push(loop);
			current = split;
		} else {
			for (let count = ast.min; count < ast.max; count += 1) {
				const optional = this.compile(ast.child, current);
				current = this.state({ type: 'epsilon', targets: [current, optional] });
			}
		}
		for (let count = 0; count < ast.min; count += 1) current = this.compile(ast.child, current);
		return current;
	}
}

function classPredicate(ast: Extract<RegexAst, { type: 'class' }>): (char: string) => boolean {
	return (char) => {
		const codePoint = char.codePointAt(0)!;
		const matches =
			ast.singles.includes(char) ||
			ast.ranges.some(([from, to]) => codePoint >= from && codePoint <= to) ||
			ast.kinds.some((kind) =>
				kind === 'digit' ? /^\p{N}$/u.test(char) : kind === 'word' ? /^[\p{L}\p{N}_]$/u.test(char) : /^\s$/u.test(char)
			);
		return ast.negated ? !matches : matches;
	};
}

function runNfa(states: NfaState[], startState: number, text: string, deadline: number): { start: number; end: number } | null {
	let active = new Map<number, number>();
	const positions = [0];
	for (const char of text) positions.push(positions.at(-1)! + char.length);
	for (let positionIndex = 0; positionIndex < positions.length; positionIndex += 1) {
		if (Date.now() > deadline) throw new Error('regex time budget exceeded');
		const position = positions[positionIndex];
		if (!active.has(startState)) active.set(startState, position);
		active = epsilonClosure(states, active, position, text.length);
		const accepts = [...active.entries()].filter(([state]) => states[state].type === 'accept');
		if (accepts.length > 0) return { start: Math.min(...accepts.map(([, matchStart]) => matchStart)), end: position };
		if (positionIndex === positions.length - 1) break;
		const char = text.slice(position, positions[positionIndex + 1]);
		const next = new Map<number, number>();
		for (const [stateIndex, matchStart] of active) {
			const state = states[stateIndex];
			if (state.type === 'consume' && state.test(char)) {
				const previous = next.get(state.target);
				if (previous == null || matchStart < previous) next.set(state.target, matchStart);
			}
		}
		active = next;
	}
	return null;
}

function epsilonClosure(states: NfaState[], initial: Map<number, number>, position: number, textLength: number): Map<number, number> {
	const closure = new Map(initial);
	const stack = [...initial.keys()];
	while (stack.length > 0) {
		const stateIndex = stack.pop()!;
		const state = states[stateIndex];
		const targets =
			state.type === 'epsilon'
				? state.targets
				: state.type === 'assert' && (state.kind === 'start' ? position === 0 : position === textLength)
					? [state.target]
					: [];
		for (const target of targets) {
			const matchStart = closure.get(stateIndex)!;
			const previous = closure.get(target);
			if (previous == null || matchStart < previous) {
				closure.set(target, matchStart);
				stack.push(target);
			}
		}
	}
	return closure;
}
