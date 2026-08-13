/**
 * The machine this process runs on, as far as anything above needs to know it.
 *
 * A port because these are facts about the operating system — which process holds
 * the run lock, on which machine, whether that process still exists, and where
 * this user's files live — and a use case that read `process.pid` or
 * `process.env.HOME` directly could only ever be driven by one caller and tested
 * by none.
 *
 * Deliberately small, and it grew by exactly one member for MVP 2. An earlier
 * version of this comment said three members were the limit because a fourth
 * would be an invitation to reach for the environment. The fourth is `homeDir`,
 * and it is here for the opposite reason: MVP 2 §7.1 puts Agent Flow's worktrees
 * and its empty hooks directory under the user's home, and requires that `~` be
 * resolved through this port *rather than* from `process.env.HOME`. Declaring it
 * is what makes the alternative — every adapter resolving home for itself — the
 * thing an architecture test can see.
 */
export interface Host {
  /** This process. */
  readonly pid: number;
  /** This machine, as it identifies itself. Used to refuse to judge another one. */
  readonly hostname: string;
  /**
   * The current user's home directory, absolute.
   *
   * Agent Flow's machine-wide state lives under `<homeDir>/.agent-flow` (§7.1):
   * the worktree root and the owned empty hooks directory. A test supplies a
   * temporary directory here, which is the only reason the worktree adapter's
   * integration tests can create and destroy real worktrees without writing into
   * the developer's actual home.
   */
  readonly homeDir: string;
  /**
   * `byteLength` bytes from a cryptographic source, as lowercase hex.
   *
   * Here rather than in a utility module because it is a fact about the machine
   * — the operating system's entropy pool — and because `gitRunKey` depends on
   * it being genuinely unpredictable (§5.2). The suffix exists so a new run
   * cannot adopt the refs of a deleted run with the same id; a `Math.random`
   * behind this signature would look unpredictable and would not be, and the
   * failure would be invisible until two runs collided.
   *
   * A port rather than a direct `randomBytes` call for one practical reason:
   * a test can make it deterministic, which is the only way to assert that two
   * runs refuse to share a namespace rather than merely observing that they
   * happened not to.
   */
  randomHex(byteLength: number): string;
  /**
   * The longest **pathname** this machine accepts, in the unit it counts in.
   *
   * **Excluding the NUL terminator.** `PATH_MAX` and `MAX_PATH` both bound a
   * NUL-terminated buffer, so their documented figures are one more than the
   * longest name that fits; this is the usable width, and a caller compares
   * `projected > maxPathLength` with no further adjustment. One semantic,
   * applied once, where the platform fact lives — the alternative is an
   * off-by-one that every call site has to remember and that shows up as a
   * checkout failing at its deepest file.
   *
   * A machine fact, and the one §23's `worktree_path_too_long` is judged
   * against: "the projected worst case … exceeds the platform limit **and long
   * paths are not enabled**". Both halves are answered here, because whether
   * long paths are enabled is a property of the operating system rather than a
   * policy Agent Flow gets to have an opinion about.
   */
  readonly maxPathLength: number;
  /**
   * How long a path is, in the unit {@link maxPathLength} is expressed in.
   *
   * Here rather than at the call site because the unit is a platform fact and
   * getting it wrong is invisible: `PATH_MAX` on Linux and macOS bounds a byte
   * string, so a path of accented or CJK characters is longer than its
   * JavaScript length — while `MAX_PATH` on Windows bounds UTF-16 units, where
   * the two agree. A projection measured in the wrong unit under-reports
   * precisely the repositories most likely to be near a limit.
   */
  measurePathLength(value: string): number;
  /**
   * Whether a process id currently exists on *this* machine.
   *
   * Only meaningful for a lock written by this hostname. Asking about a pid from
   * another machine would answer a question about a local process that happens to
   * share the number — which is worse than not knowing.
   */
  isAlive(pid: number): boolean;
}
