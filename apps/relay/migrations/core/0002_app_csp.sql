-- MCP Apps (AP2): the CSP the owner approved for an app page, sealed (AAD core_media_csp:<id>). NULL = not an app page,
-- so GET /media/:id/app answers 404. Additive: an older build ignores the column.
alter table core_media add column app_csp blob;
