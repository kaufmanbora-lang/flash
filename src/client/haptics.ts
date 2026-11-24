// Тактильная отдача там, где устройство её поддерживает.
// Android: Vibration API. iPhone: Vibration API нет, но системный переключатель
// (<input type="checkbox" switch>) даёт настоящий тактильный «тик» в Safari 17.4+.

type Kind = "light" | "medium" | "success" | "warning";

const PATTERNS: Record<Kind, number | number[]> = {
  light: 8,
  medium: 16,
  success: [10, 40, 14],
  warning: [18, 60, 18],
};

let iosLabel: HTMLLabelElement | null = null;

function isIos(): boolean {
  return (
    /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

function iosTick(): void {
  if (!iosLabel) {
    const label = document.createElement("label");
    label.setAttribute("aria-hidden", "true");
    label.style.cssText = "position:fixed;left:-200px;top:-200px;width:1px;height:1px;opacity:0;pointer-events:none;";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.setAttribute("switch", "");
    input.tabIndex = -1;
    label.appendChild(input);
    document.body.appendChild(label);
    iosLabel = label;
  }
  iosLabel.click();
}

export function haptic(kind: Kind = "light"): void {
  if (typeof navigator === "undefined") return;
  try {
    if (typeof navigator.vibrate === "function") {
      navigator.vibrate(PATTERNS[kind]);
      return;
    }
    if (isIos()) {
      iosTick();
      if (kind === "success" || kind === "warning") setTimeout(iosTick, 90);
    }
  } catch {
    /* отдача — приятное дополнение, а не обязательная часть действия */
  }
}
