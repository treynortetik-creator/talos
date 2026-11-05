import { enrollDevice, expect, test } from '../harness/fixtures.ts'

test('1. init + enroll: the Mac and the phone show the same four words, y pins the device', async ({
  stack,
  page,
  context,
}) => {
  await stack.startBridge()
  const { cli } = await enrollDevice(stack, page, context)
  expect(await cli.done()).toBe(0)
})
