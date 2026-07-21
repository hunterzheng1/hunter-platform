# Validation evidence

This directory is the destination for reproducible Phase 0 evidence. A claim in
research or upstream documentation is not a verified Hunter capability until a
dated validation record captures:

- the exact product and version;
- operating system and relevant environment inventory;
- redacted commands or protocol requests;
- observed outputs, exit reasons, logs, and artifacts;
- the expected result and the actual result;
- a pass, fail, or needs-attention conclusion;
- cleanup and recovery observations.

Do not commit access tokens, credentials, complete environment dumps, private
repository contents, or raw command lines that expose secrets. Large or
sensitive evidence belongs in the local content-addressed store; the Markdown
record should retain a hash and a safe summary.
