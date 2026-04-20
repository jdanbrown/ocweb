// Compact dirty/ahead indicator: "+2 ~3 ↑1" when nonzero, "clean" when all zero.
// Used in the sidebar (per-session) and top bar (current session).
// Color-coded: staged green, unstaged orange, ahead blue.

export function GitStat({ stat }: { stat: { staged: number; changed: number; ahead: number } }) {
  const { staged, changed, ahead } = stat;
  if (staged === 0 && changed === 0 && ahead === 0) {
    return <span className="git-stat git-stat-clean">clean</span>;
  }
  return (
    <span className="git-stat">
      {staged > 0 && <span className="git-stat-staged">+{staged}</span>}
      {changed > 0 && <span className="git-stat-changed">~{changed}</span>}
      {ahead > 0 && <span className="git-stat-ahead">&#8593;{ahead}</span>}
    </span>
  );
}
