# Undo could offer to delete a file that was there before the turn, like an .env git ignores

Undo points (fixed in 341a40e5): a point did not record what git ignored when it was taken, so a file the turn un-ignored, like an .env that was there all along, looked new and was offered for deletion on undo.
