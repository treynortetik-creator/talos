# Salesforce (work)

Ships **disabled**. **Ask your IT team before connecting these.** An admin builds a Flow with an outbound message whose
endpoint is the connection URL. An outbound message cannot carry a signature or a header, so the checks are the unguessable
connection id in the URL and `OrganizationId` equal to the configured org id (first 15 characters). The SOAP body is parsed
with fast-xml-parser; any document with a DOCTYPE or entity declaration is refused. The reply is the SOAP
`<Ack>true</Ack>` so Salesforce stops retrying; dedup on the notification `Id`.
