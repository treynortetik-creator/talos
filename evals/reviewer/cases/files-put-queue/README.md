# An upload's 50 MB fetch ran on the bridge's one read queue, holding every search and listing behind it

Fable on the upload feature (fixed before it landed in f33ad64a): an upload ran on the bridge's serial read queue, so its download held up every other read the Mac answers.
