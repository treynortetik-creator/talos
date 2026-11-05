# What must never go in this wiki

This is the work knowledge base. It may sync to company storage, and other people
may be able to read it. Treat everything in here as discoverable.

## Never write here

- **Regulated data.** Health records, patient or client information, financial
  account details, student records — whatever your industry protects. If a system
  of record exists for it, this is not that system. **Write a pointer, never a copy.**
- **Credentials.** Keys, tokens, passwords. Those live in `.env`.
- **Anything you would not want quoted back to you** in a deposition, a
  performance review, or a screenshot.
- **Your personal life.** That goes in the private vault, which lives outside
  company storage. See `optional/personal/`.

## The default when unsure

**Leave it out**, or write the pointer instead of the content: *"the numbers are
in the Q3 sheet"* rather than pasting the numbers.

Unclassified is not the same as safe. Treat anything you have not deliberately
classified as confidential.
