// Explicit synthetic limits around application fetches in an injected fixture.
// Awaited JS nesting is not Cloudflare's request-context depth counter. Control
// requests and platform transport are deliberately outside this model.
export function stateEventRequestGuard({ calls = 20, depth = 4 } = {}) {
  let total = 0, active = 0, peak = 0, rejected = 0;
  const paths = [];
  return {
    get total() { return total; },
    get peak() { return peak; },
    get rejected() { return rejected; },
    paths,
    async request(path, send) {
      total++; paths.push(path);
      if (total > calls || active + 1 > depth) {
        rejected++; throw Error("Synthetic application call/depth budget exceeded");
      }
      active++; peak = Math.max(peak, active);
      try { return await send(); } finally { active--; }
    }
  };
}
