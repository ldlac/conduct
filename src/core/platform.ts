import { existsSync } from "node:fs";

/**
 * Cross-platform shell helpers. conduct hands user-supplied command strings
 * (setup steps, the in-app runner, the interactive `c` handoff) to a system
 * shell so pipes, globs, and `&&` work. The mechanics of "which shell, invoked
 * how" differ between POSIX and Windows, so every place that needs a shell goes
 * through here instead of hardcoding `/bin/sh`/`$SHELL -c`.
 */

/** True on Windows, where there is no `$SHELL` and shells live outside `/bin`. */
const isWindows = process.platform === "win32";

/**
 * Build the spawn arguments to run a single command *string* through the OS
 * shell (so the user's pipes/globs/`&&` are honored). Pass the result straight
 * to `spawn(cmd, args, …)` — no `shell: true` needed, which keeps quoting
 * predictable.
 *
 * - POSIX: the user's `$SHELL` with `-c` (falling back to `/bin/bash`, then
 *   `/bin/sh`), matching how an interactive shell would interpret the command.
 * - Windows: `cmd.exe /d /s /c "<command>"` via `%ComSpec%`. `/d` skips AutoRun
 *   scripts, and `/s /c` makes cmd treat the rest as one command without
 *   mangling embedded quotes.
 */
export function shellInvocation(command: string): {
  cmd: string;
  args: string[];
} {
  if (isWindows) {
    const cmd = process.env.ComSpec || "cmd.exe";
    return { cmd, args: ["/d", "/s", "/c", command] };
  }
  const shell =
    process.env.SHELL || (existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh");
  return { cmd: shell, args: ["-c", command] };
}

/**
 * Pick an *interactive* shell binary to drop the user into (the `c` handoff and
 * the tmux window). Unlike {@link shellInvocation}, this returns a bare shell to
 * spawn with no command, so the user gets a live prompt in the worktree.
 *
 * - POSIX: prefer `$SHELL`, but it can be unset (minimal/login environments) or
 *   point at a binary that isn't on this machine — spawning a missing shell is
 *   exactly the failure that made the old handoff "just die." Fall back to the
 *   first common shell that actually exists, and only as a last resort to a bare
 *   `/bin/sh` name.
 * - Windows: `%ComSpec%` (normally `cmd.exe`), which is always present. We don't
 *   reach for PowerShell — cmd is the safe lowest common denominator.
 */
export function interactiveShell(): string {
  if (isWindows) return process.env.ComSpec || "cmd.exe";
  const preferred = process.env.SHELL;
  if (preferred && existsSync(preferred)) return preferred;
  for (const candidate of [
    "/bin/bash",
    "/bin/zsh",
    "/usr/bin/fish",
    "/bin/sh",
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return preferred || "/bin/sh";
}
