// The "Remember between runs" box on the schedule form (docs/SCHEDULES.md S3.8). Off unless the owner ticks it.

export function MemoryToggle({
  checked,
  background,
  restricted,
  command = false,
  onChange,
}: {
  checked: boolean
  /** The job runs in the background (no live session). It needs a Chronos that supports memory. */
  background: boolean
  /** The job is read-only: it reads past results but has no way to write a note. */
  restricted: boolean
  /** The job is a command: it gets the notepad and the results as files, not in a prompt. */
  command?: boolean
  onChange: (on: boolean) => void
}) {
  const what = command ? 'command' : "job's text"
  return (
    <label className="flex min-h-11 items-start gap-2 text-md">
      <input type="checkbox" className="mt-1" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        Remember between runs
        <span className="block text-sm text-text-2">
          {restricted
            ? `Each run sees this job's last 3 results. Only this job sees them. Changing the ${what} clears them.`
            : `Each run sees this job's last 3 results and a small notepad (up to 2 KB) it can update. Only this job sees them. Changing the ${what} clears them.`}
          {restricted ? " This job reads past results; can't keep notes." : ''}
          {command ? ' The command gets them as files (TALOS_MEMORY_DIR) and may rewrite the notepad.' : ''}
          {background
            ? ` A job that runs in the background needs a Chronos that supports memory; the approval card says if yours does not.${restricted ? '' : ' It runs unattended, with full permissions, so nobody watches it read or rewrite the notepad.'}`
            : ''}
        </span>
      </span>
    </label>
  )
}
