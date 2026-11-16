# /p/:id was mounted after the web app's catch-all and /p was not reserved, so page links got index.html

Org pages phase 1 (bf525533) mounted /p/:id after the web app's catch-all and did not add p to RESERVED, so the relay answered page links with the web app. No page bytes leaked, but page links never reached their route. e2e 09-security-surface caught it; fixed in 316f1a28.
