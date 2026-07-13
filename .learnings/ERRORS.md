## [ERR-20260708-001] shell_heredoc_pipeline

**Logged**: 2026-07-08T17:51:52Z
**Priority**: low
**Status**: pending
**Area**: config

### Summary
Shell command failed because a pipeline was accidentally placed inside a Node heredoc body.

### Error
```text
SyntaxError: Unexpected identifier 'curl'
```

### Context
- Attempted to generate an OAuth authorize URL with `node - <<'NODE'` and pipe it to `curl`.
- The heredoc terminator was not isolated from the subsequent pipeline.

### Suggested Fix
Keep heredoc terminators on their own line and run network checks inside Node or in a separate shell command.

### Metadata
- Reproducible: yes
- Related Files: none

---

## [ERR-20260708-002] square_api_probe_created_post

**Logged**: 2026-07-08T19:13:00Z
**Priority**: medium
**Status**: resolved
**Area**: backend

### Summary
An API shape probe accidentally created a real Aicoo Square test post because an empty `subsquare` defaults to `general`.

### Error
```text
POST /api/square with title/content and subsquare: "" returned 201 and created post id 182.
```

### Context
- Attempted to discover Square post validation fields with a payload expected to fail.
- The created test post was immediately deleted with `DELETE /api/square/182`.

### Suggested Fix
For external write endpoint discovery, avoid sending valid required fields together unless using a dedicated sandbox target or a confirmed dry-run endpoint.

### Metadata
- Reproducible: yes
- Related Files: api/_aicoo.js

---
