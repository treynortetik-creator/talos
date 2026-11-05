// Control for review-fixes.test.ts: the same floating rejection with no guard installed.
void Promise.reject(new Error('floating boom'))
setTimeout(() => process.stderr.write('STILL_ALIVE\n'), 200)
