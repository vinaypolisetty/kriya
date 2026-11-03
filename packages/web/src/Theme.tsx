/**
 * The Theme picker in the header. Auto follows the device; Light and Dark stay
 * put. The choice is this browser's, like a graph's layout: index.html applies
 * it before the first paint, and style.css holds both sets of colours.
 */
import { useState } from "react";

const KEY = "kriya.theme";

export function ThemePicker() {
  const root = document.documentElement;
  const [theme, setTheme] = useState(root.dataset.theme ?? "auto");
  const pick = (next: string) => {
    setTheme(next);
    if (next === "auto") delete root.dataset.theme;
    else root.dataset.theme = next;
    try {
      if (next === "auto") localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, next);
    } catch {
      // Storage can be off in a private window: the theme still holds until the page closes.
    }
  };
  return (
    <select className="theme" aria-label="Theme" value={theme} onChange={(e) => pick(e.target.value)}>
      <option value="auto">Theme: Auto</option>
      <option value="light">Theme: Light</option>
      <option value="dark">Theme: Dark</option>
    </select>
  );
}
