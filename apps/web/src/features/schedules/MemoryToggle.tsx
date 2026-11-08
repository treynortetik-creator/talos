// The "Remember between runs" box on the schedule form (docs/SCHEDULES.md S3.8). Off unless the owner ticks it.

export function MemoryToggle({
  checked,
  background,
  onChange,
}: {
  checked: boolean
  /** The job runs in the background, which does not get memory yet. */
  background: boolean
  onChange: (on: boolean) => void
}) {
  return (
    <label className="flex min-h-11 items-start gap-2 text-md">
      <input type="checkbox" className="mt-1" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        Remember between runs
        <span className="block text-sm text-text-2">
          Each run sees this job's last 3 results and a small notepad (up to 2 KB) it can update. Only this job sees
          them. Changing the job's text clears them.
          {background ? ' A job that runs in the background does not get this yet.' : ''}
        </span>
      </span>
    </label>
  )
}
