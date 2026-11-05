# Gmail on a work account (work)

Ships **disabled**. **Ask your IT team before connecting these.** The same Apps Script as [Gmail](gmail.md), run inside the
work Google account, sending a short preview of each new message to your relay. Some workplaces block Apps Script or
outside requests; if Google refuses, stop. Events use the `gmail_work` source and go to the work thread (falling back to
the Inbox). Signing, claim code, filters and quota are exactly as in [gmail.md](gmail.md).
