# The app took AGENTS.md text from the relay without checking it against its sha, so forged lines could be signed in the next save

Fable on the AGENTS.md editor (fixed before it landed in 36f4a9b6): the app took the file's text and sha from the relay without checking one against the other, so a relay could slip instructions into the text and have the owner sign them in the next save.
