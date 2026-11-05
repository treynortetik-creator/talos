// Spawned by review-fixes.test.ts: installs the bridge's rejection logger, then leaves a promise rejected.
import { installRejectionLogger } from '../../src/lifecycle.ts'
import { createLogger } from '../../src/log.ts'

installRejectionLogger(createLogger(null, 'error', (line) => process.stderr.write(line)))
void Promise.reject(new Error('floating boom'))
setTimeout(() => process.stderr.write('STILL_ALIVE\n'), 200)
