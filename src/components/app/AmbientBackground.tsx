/**
 * Фон приложения: молочный свет и расфокусированная листва по углам.
 * Листья нарисованы в SVG и размыты один раз; анимируется только сдвиг готового слоя,
 * поэтому фон не нагружает устройство.
 */

const LEAF = "M0 0 C 26 -36, 88 -36, 114 0 C 88 36, 26 36, 0 0 Z";

interface Leaf {
  x: number;
  y: number;
  r: number;
  s: number;
  fill: string;
  o: number;
  /** Ближние листья размыты слабее — так появляется глубина. */
  near?: boolean;
}

const TOP: Leaf[] = [
  { x: 150, y: 10, r: 28, s: 1.5, fill: "#8BC65B", o: 0.42 },
  { x: 205, y: 62, r: 62, s: 1.2, fill: "#B5DF83", o: 0.6 },
  { x: 120, y: 78, r: -8, s: 1.0, fill: "#A6D873", o: 0.36 },
  { x: 228, y: 138, r: 96, s: 1.35, fill: "#7DBB4D", o: 0.34 },
  { x: 176, y: 150, r: 40, s: 0.85, fill: "#CDEBA6", o: 0.6 },
  { x: 86, y: 6, r: 12, s: 0.9, fill: "#CDEBA6", o: 0.5 },
  { x: 168, y: 36, r: 48, s: 0.95, fill: "#8BC65B", o: 0.5, near: true },
  { x: 214, y: 104, r: 78, s: 0.8, fill: "#9AD068", o: 0.46, near: true },
];

const BOTTOM: Leaf[] = [
  { x: 10, y: 210, r: -34, s: 1.45, fill: "#B5DF83", o: 0.5 },
  { x: -30, y: 150, r: -70, s: 1.2, fill: "#8BC65B", o: 0.3 },
  { x: 60, y: 252, r: -12, s: 1.0, fill: "#CDEBA6", o: 0.58 },
  { x: -14, y: 96, r: -98, s: 0.95, fill: "#A6D873", o: 0.28 },
  { x: 24, y: 236, r: -40, s: 0.85, fill: "#9AD068", o: 0.4, near: true },
];

function Leaves({ leaves, id }: { leaves: Leaf[]; id: string }) {
  const draw = (leaf: Leaf, i: number) => (
    <path key={i} d={LEAF} fill={leaf.fill} opacity={leaf.o} transform={`translate(${leaf.x} ${leaf.y}) rotate(${leaf.r}) scale(${leaf.s})`} />
  );
  return (
    // overflow: visible — иначе размытые края обрезаются по рамке SVG прямой линией.
    <svg viewBox="0 0 280 280" width="100%" height="100%" aria-hidden="true" focusable="false" style={{ overflow: "visible" }}>
      <defs>
        <filter id={`${id}-far`} x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="11" />
        </filter>
        <filter id={`${id}-near`} x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="4.5" />
        </filter>
      </defs>
      <g filter={`url(#${id}-far)`}>{leaves.filter((l) => !l.near).map(draw)}</g>
      <g filter={`url(#${id}-near)`}>{leaves.filter((l) => l.near).map(draw)}</g>
    </svg>
  );
}

export function AmbientBackground({ calm = false }: { calm?: boolean }) {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 -z-10 overflow-hidden bg-milk"
      style={{
        backgroundImage:
          "radial-gradient(70% 42% at 96% -4%, rgb(181 223 131 / 0.3), transparent 72%)," +
          "radial-gradient(60% 38% at -6% 104%, rgb(226 242 208 / 0.9), transparent 70%)," +
          "radial-gradient(90% 50% at 50% 40%, rgb(255 255 255 / 0.7), transparent 75%)",
      }}
    >
      <div
        className={`absolute -right-[20vmin] -top-[14vmin] size-[80vmin] max-h-[560px] max-w-[560px] will-change-transform ${calm ? "" : "animate-drift"}`}
      >
        <Leaves leaves={TOP} id="leaf-top" />
      </div>
      <div
        className={`absolute -bottom-[16vmin] -left-[22vmin] size-[74vmin] max-h-[520px] max-w-[520px] will-change-transform ${calm ? "" : "animate-drift-slow"}`}
      >
        <Leaves leaves={BOTTOM} id="leaf-bottom" />
      </div>
    </div>
  );
}
