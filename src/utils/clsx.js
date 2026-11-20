/**
 * Minimal class-name joiner (replaces the `clsx` package to keep the dependency
 * surface small and auditable). Accepts strings, arrays and objects.
 */
export function clsx(...args) {
  const out = [];
  const push = (value) => {
    if (!value) return;
    if (typeof value === 'string' || typeof value === 'number') {
      out.push(String(value));
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(push);
      return;
    }
    if (typeof value === 'object') {
      Object.entries(value).forEach(([key, enabled]) => {
        if (enabled) out.push(key);
      });
    }
  };
  args.forEach(push);
  return out.join(' ');
}

export default clsx;
