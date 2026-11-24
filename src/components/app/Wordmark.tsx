import clsx from "clsx";

/** Логотип: «flash» антиквой и салатовая точка. */
export function Wordmark({ className, light = false }: { className?: string; light?: boolean }) {
  return (
    <span className={clsx("wordmark inline-block select-none", light ? "text-white" : "text-ink", className)} aria-label="Flash">
      <span aria-hidden="true">flash</span>
      <span aria-hidden="true" className="text-leaf">
        .
      </span>
    </span>
  );
}
